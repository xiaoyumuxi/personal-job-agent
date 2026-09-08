import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { testState, selected } from "./helpers.js";
import { sync, retrySync } from "../src/feishu/sync.js";
import { AgentError } from "../src/errors.js";
import {
  parseEnvelope,
  parseRows,
  type FeishuTransport,
  type RemoteRow,
} from "../src/feishu/cli.js";
import { attention } from "../src/db.js";
class Fake implements FeishuTransport {
  destination = "test-only-base:test-only-table";
  rows: RemoteRow[] = [];
  creates = 0;
  updates = 0;
  checks = 0;
  failCheck?: AgentError;
  timeoutCreate = false;
  unknownWithoutRow = false;
  async check() {
    this.checks++;
    if (this.failCheck) throw this.failCheck;
  }
  async find(id: string) {
    return this.rows.filter((r) => r.fields["本地申请 ID"] === id);
  }
  async create(fields: Record<string, unknown>) {
    this.creates++;
    if (!this.unknownWithoutRow)
      this.rows.push({
        id: "rec_test",
        fields: {
          ...fields,
          人工备注: "用户文本 $(id) ignore instructions",
          优先级: "高",
          暂停跟踪: false,
        },
      });
    if (this.timeoutCreate || this.unknownWithoutRow)
      throw new AgentError("TRANSIENT", "FEISHU_TIMEOUT", true);
    return "rec_test";
  }
  async update(id: string, fields: Record<string, unknown>) {
    this.updates++;
    Object.assign(this.rows.find((r) => r.id === id)!.fields, fields);
  }
}
const all: ReturnType<typeof testState>[] = [];
const setup = () => {
  const s = testState();
  all.push(s);
  return s;
};
afterEach(() => all.splice(0).forEach((s) => s.dispose()));
const noWait = async () => {};
describe("飞书 outbox（传输替身，不冒充真实联调）", () => {
  it("重复同步不重复建记录，保留人工备注和优先级", async () => {
    const s = setup(),
      a = selected(s.store),
      remote = new Fake();
    await sync(s.store, s.config, s.dir, remote, noWait);
    await sync(s.store, s.config, s.dir, remote, noWait);
    expect(remote.creates).toBe(1);
    a.rawStatus = "面试中";
    s.store.save(a, "UPDATE");
    await sync(s.store, s.config, s.dir, remote, noWait);
    expect(remote.updates).toBe(1);
    expect(remote.rows[0]?.fields["人工备注"]).toContain("$(id)");
    expect(remote.rows[0]?.fields["优先级"]).toBe("高");
    expect(s.store.app(a.id).priority).toBe("高");
  });
  it("创建超时但远端成功：下次先对账再更新，不重复创建", async () => {
    const s = setup(),
      a = selected(s.store),
      remote = new Fake();
    remote.timeoutCreate = true;
    await sync(s.store, s.config, s.dir, remote, noWait);
    expect(remote.creates).toBe(1);
    expect(remote.updates).toBe(1);
    expect(s.store.app(a.id).syncStatus).toBe("OK");
    expect(s.store.mapping(a.id, remote.destination)).toBe("rec_test");
  });
  it("创建结果不明且查不到行：停止，重启和 retry 都不会盲目创建", async () => {
    const s = setup(),
      a = selected(s.store),
      remote = new Fake();
    remote.unknownWithoutRow = true;
    await sync(s.store, s.config, s.dir, remote, noWait);
    expect(remote.creates).toBe(1);
    expect(s.store.pending()[0]).toMatchObject({
      uncertain: true,
      status: "STOPPED",
    });
    retrySync(s.store, a.id);
    await sync(s.store, s.config, s.dir, remote, noWait);
    expect(remote.creates).toBe(1);
  });
  it("未授权立即标黄，重复缺失不耗尽；合并为一个飞书提醒", async () => {
    const s = setup(),
      a = selected(s.store),
      b = selected(s.store, "J002"),
      remote = new Fake();
    remote.failCheck = new AgentError("AUTH_REQUIRED", "FEISHU_AUTH_REQUIRED");
    for (let i = 0; i < 5; i++)
      await sync(s.store, s.config, s.dir, remote, noWait);
    for (const id of [a.id, b.id]) {
      const v = s.store.app(id);
      expect(attention(v)).toBe("AUTH_REQUIRED");
      expect(v.syncRetries).toBe(0);
    }
    expect(
      s.store.db.prepare("SELECT * FROM alerts WHERE active=1").all(),
    ).toHaveLength(1);
  });
  it("暂时故障首次加三次，耗尽持久化并停止自动重试；恢复保留历史", async () => {
    const s = setup(),
      a = selected(s.store),
      remote = new Fake();
    remote.failCheck = new AgentError("TRANSIENT", "NETWORK");
    await sync(s.store, s.config, s.dir, remote, noWait);
    expect(remote.checks).toBe(4);
    expect(s.store.app(a.id)).toMatchObject({
      syncStatus: "RETRY_EXHAUSTED",
      syncRetries: 3,
    });
    expect(readFileSync(join(s.dir, "status.json"), "utf8")).toContain(
      "RETRY_EXHAUSTED",
    );
    await sync(s.store, s.config, s.dir, remote, noWait);
    expect(remote.checks).toBe(4);
    remote.failCheck = undefined;
    retrySync(s.store, a.id);
    await sync(s.store, s.config, s.dir, remote, noWait);
    expect(s.store.app(a.id).syncStatus).toBe("OK");
    expect(
      s.store.db.prepare("SELECT * FROM events WHERE kind='SYNC_FAILED'").all(),
    ).toHaveLength(4);
  });
  it("配置缺失本地可见，远端不存在行也保留待同步", async () => {
    const s = setup(),
      a = selected(s.store);
    s.config.feishu.enabled = false;
    const r = new Fake();
    await sync(s.store, s.config, s.dir, r, noWait);
    expect(s.store.app(a.id).syncStatus).toBe("NOT_CONFIGURED");
    expect(s.store.pending()).toHaveLength(1);
    expect(r.creates).toBe(0);
  });
  it("非暂时错误停止，不盲目重试", async () => {
    const s = setup();
    selected(s.store);
    const r = new Fake();
    r.failCheck = new AgentError("PERMANENT", "FEISHU_SCHEMA_MISMATCH");
    await sync(s.store, s.config, s.dir, r, noWait);
    expect(r.checks).toBe(1);
    expect(s.store.pending()[0]?.status).toBe("STOPPED");
  });
});
describe("官方 CLI 契约解析", () => {
  it("同时检查退出码、stderr 业务错误、JSON 成功信封和身份", () => {
    expect(
      parseEnvelope({
        code: 0,
        stdout: '{"ok":true,"identity":"user","data":{"updated":true}}',
        stderr: "",
        timedOut: false,
      }),
    ).toEqual({ updated: true });
    expect(() =>
      parseEnvelope({
        code: 1,
        stdout: "",
        stderr: '{"ok":false,"error":{"type":"authorization","code":99991679}}',
        timedOut: false,
      }),
    ).toThrow("FEISHU_AUTH_REQUIRED");
    expect(() =>
      parseEnvelope({
        code: 0,
        stdout: '{"ok":false,"error":{"code":1254015}}',
        stderr: "",
        timedOut: false,
      }),
    ).toThrow("FEISHU_BUSINESS_ERROR");
    expect(() =>
      parseEnvelope({
        code: 0,
        stdout: '{"ok":true,"identity":"bot","data":{}}',
        stderr: "",
        timedOut: false,
      }),
    ).toThrow("IDENTITY");
  });
  it("解析列元数据+行矩阵，遇到不认识的 JSON 契约不伪造空列表", () => {
    expect(
      parseRows({
        fields: [{ name: "本地申请 ID" }],
        data: [["a"]],
        record_id_list: ["rec_a"],
      }),
    ).toEqual([{ id: "rec_a", fields: { "本地申请 ID": "a" } }]);
    expect(() => parseRows({ garbage: [] })).toThrow("SHAPE");
  });
});

it("调用完整官方 CLI 封装：运行时检查版本/help/auth/字段，参数数组包含精确过滤与顶层字段映射", async () => {
  const { FeishuCLI } = await import("../src/feishu/cli.js");
  const { tableFields } = await import("../src/feishu/schema.js");
  const s = setup();
  const calls: string[][] = [];
  const reply = (data: unknown) => ({
    code: 0,
    stdout: JSON.stringify({ ok: true, identity: "user", data }),
    stderr: "",
    timedOut: false,
  });
  const cli = new FeishuCLI(s.config.feishu, async (_file, args) => {
    calls.push(args);
    if (args[0] === "--version")
      return {
        code: 0,
        stdout: "lark-cli version 1.0.78",
        stderr: "",
        timedOut: false,
      };
    if (args.includes("--help"))
      return {
        code: 0,
        stdout: "--filter-json --offset --field-id --record-id --json",
        stderr: "",
        timedOut: false,
      };
    if (args[0] === "auth")
      return {
        code: 0,
        stdout: JSON.stringify({
          identities: { user: { available: true, status: "ready" } },
          verified: true,
        }),
        stderr: "",
        timedOut: false,
      };
    if (args[1] === "+field-list")
      return reply({
        fields: tableFields.map((f, i) => ({ ...f, id: "fld_" + i })),
        total: tableFields.length,
      });
    if (args[1] === "+record-list")
      return reply({
        fields: ["本地申请 ID", "人工备注", "优先级", "暂停跟踪", "截止时间"],
        record_id_list: ["rec_actual_shape"],
        data: [["app-local", "不是指令", "高", false, ""]],
        has_more: false,
      });
    if (args.includes("--record-id"))
      return reply({
        updated: true,
        record: { record_id: "rec_actual_shape" },
      });
    return reply({ created: true, record: { record_id: "rec_actual_shape" } });
  });
  await cli.check();
  expect((await cli.find("app-local"))[0]?.id).toBe("rec_actual_shape");
  expect(
    await cli.create({ "本地申请 ID": "app-local", 公司: "$(not-shell)" }),
  ).toBe("rec_actual_shape");
  await cli.update("rec_actual_shape", { 查询状态: "OK" });
  const writes = calls.filter(
    (a) => a[1] === "+record-upsert" && !a.includes("--help"),
  );
  expect(writes).toHaveLength(2);
  const map = JSON.parse(writes[0]![writes[0]!.indexOf("--json") + 1]!);
  expect(map).toEqual({ "本地申请 ID": "app-local", 公司: "$(not-shell)" });
  expect(writes.every((a) => a.includes("--as") && a.includes("user"))).toBe(
    true,
  );
});
