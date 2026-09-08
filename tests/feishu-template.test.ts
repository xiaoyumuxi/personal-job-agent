import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { testState, selected } from "./helpers.js";
import {
  autoFields,
  initialManualFields,
  applicationStatus,
  submissionDate,
  tableFields,
  legacyTableFields,
  mainColumns,
  templateViews,
  type FieldDefinition,
} from "../src/feishu/schema.js";
import { FeishuCLI, type RemoteRow } from "../src/feishu/cli.js";
import {
  configureTemplateViews,
  createdBaseTarget,
} from "../src/feishu/template.js";
import { sync } from "../src/feishu/sync.js";
import { jobsFromGrid, readJobs } from "../src/jobs.js";
import { AgentError } from "../src/errors.js";

const states: ReturnType<typeof testState>[] = [];
function setup() {
  const state = testState();
  states.push(state);
  return state;
}
afterEach(() => {
  for (const state of states.splice(0)) state.dispose();
});
function remote(schema: FieldDefinition[] = tableFields) {
  const state = setup();
  const fields = schema.map((field, i) => ({ ...field, id: `fld_test_${i}` }));
  const calls: string[][] = [];
  const views: { id: string; name: string; type: string }[] = [];
  const properties = new Map<string, unknown>();
  const rows: RemoteRow[] = [];
  const behavior = {
    corruptReadback: false,
    timeoutCreate: false,
    missingAfterTimeout: false,
  };
  const reply = (data: unknown) => ({
    code: 0,
    stdout: JSON.stringify({ ok: true, identity: "user", data }),
    stderr: "",
    timedOut: false,
  });
  const cli = new FeishuCLI(state.config.feishu, async (_file, args) => {
    calls.push(args);
    const arg = (name: string) => args[args.indexOf(name) + 1]!;
    if (args[0] === "--version")
      return { ...reply({}), stdout: "lark-cli version test-only" };
    if (args.includes("--help"))
      return {
        ...reply({}),
        stdout: "--filter-json --offset --field-id --record-id --json --fields",
      };
    if (args[0] === "auth")
      return {
        ...reply({}),
        stdout: JSON.stringify({
          identities: { user: { available: true, status: "ready" } },
          verified: true,
        }),
      };
    if (args[1] === "+field-list")
      return reply({ fields, total: fields.length });
    if (args[1] === "+view-list") return reply({ views, total: views.length });
    if (args[1] === "+view-create") {
      const view = {
        ...JSON.parse(arg("--json")),
        id: `vew_test_${views.length}`,
      };
      if (!behavior.missingAfterTimeout) views.push(view);
      if (behavior.timeoutCreate)
        throw new AgentError("TRANSIENT", "TEST_VIEW_TIMEOUT");
      return reply({ views: [view] });
    }
    const property = args[1]?.match(/^\+view-(set|get)-(.*)$/);
    if (property) {
      const key = `${arg("--view-id")}:${property[2]}`;
      const wrapper =
        property[2] === "visible-fields" ? "visible_fields" : property[2]!;
      if (property[1] === "set") {
        properties.set(key, JSON.parse(arg("--json")));
        return reply({ [wrapper]: properties.get(key) });
      }
      const body = properties.get(key) as Record<string, unknown[]>;
      const list = Object.values(body)[0]!;
      const id = (name: string) =>
        fields.find((f) => f.name === name)?.id ?? name;
      const values = list.map((value) =>
        typeof value === "string"
          ? id(value)
          : {
              ...(value as object),
              field: id((value as { field: string }).field),
            },
      );
      return reply({
        [wrapper]: {
          [Object.keys(body)[0]!]: behavior.corruptReadback ? [] : values,
        },
      });
    }
    if (args[1] === "+record-list") return reply({ records: rows });
    if (args[1] === "+record-upsert") {
      const payload = JSON.parse(arg("--json"));
      if (args.includes("--record-id")) {
        Object.assign(rows[0]!.fields, payload);
        return reply({ updated: true, record: { id: rows[0]!.id } });
      }
      rows.push({ id: "rec_test", fields: payload });
      return reply({ created: true, record: { id: "rec_test" } });
    }
    throw new Error(`Unexpected test command ${args[1]}`);
  });
  return { ...state, cli, calls, rows, views, behavior };
}

describe("screenshot-style Feishu template", () => {
  it("ships one schema source with the seven leading columns, date/link types, colored statuses and three views", () => {
    expect(tableFields.slice(0, 7).map((f) => f.name)).toEqual(mainColumns);
    expect(tableFields.find((f) => f.name === "投递日期")).toEqual({
      name: "投递日期",
      type: "datetime",
      style: { format: "yyyy-MM-dd" },
    });
    expect(tableFields.find((f) => f.name === "岗位链接")?.style?.type).toBe(
      "url",
    );
    expect(templateViews.map((v) => v.name)).toEqual([
      "Grid",
      "投递状态看板",
      "投递清单",
    ]);
    expect(
      JSON.parse(readFileSync("examples/feishu-fields.json", "utf8")),
    ).toEqual(tableFields);
    expect(
      JSON.parse(readFileSync("examples/feishu-template.json", "utf8")),
    ).toEqual({ version: 2, fields: tableFields, views: templateViews });
  });
  it("maps only known recruitment facts, distinguishes receipt/manual/unknown, and keeps auth and sync separate", () => {
    const state = setup(),
      a = selected(state.store),
      job = state.store.job(a.jobId);
    a.evidence = "site:receipt:J001";
    expect(applicationStatus(a)).toBe("官网已投递");
    a.evidence = "manual-confirmation";
    expect(applicationStatus(a)).toBe("已投递（人工确认）");
    a.state = "UNKNOWN_RESULT";
    a.rawStatus = "测评完成";
    expect(applicationStatus(a)).toBe("提交待核实");
    a.state = "SUBMITTED";
    expect(applicationStatus(a)).toBe("测评完成");
    a.rawStatus = "测评未完成";
    expect(applicationStatus(a)).toBe("待核对阶段");
    a.stage = "INTERVIEW";
    a.authStatus = "AUTH_REQUIRED";
    a.queryStatus = "RETRY_EXHAUSTED";
    expect(autoFields(a, job)).toMatchObject({
      投递状态: "面试中",
      授权状态: "AUTH_REQUIRED",
      attention_status: "RETRY_EXHAUSTED",
    });
    expect(autoFields(a, job)).not.toHaveProperty("备注");
    expect(autoFields(a, job)).not.toHaveProperty("投递渠道");
  });
  it("does not invent dates, handles timezone boundaries, and keeps the original timestamp", () => {
    expect(submissionDate(null)).toBeNull();
    expect(submissionDate("2026-09-07")).toBeNull();
    expect(submissionDate("not a date")).toBeNull();
    expect(submissionDate("2026-09-07T18:20:00Z", "Asia/Shanghai")).toBe(
      "2026-09-08 00:00:00",
    );
    expect(submissionDate("2026-09-07T18:20:00Z", "America/Los_Angeles")).toBe(
      "2026-09-07 00:00:00",
    );
    const state = setup(),
      a = selected(state.store);
    a.submittedAt = "2026-09-07T18:20:00Z";
    expect(autoFields(a, state.store.job(a.jobId))["投递时间"]).toBe(
      a.submittedAt,
    );
  });
  it("imports screenshot headers and explicit channel/notes without treating imported status/date as a receipt", async () => {
    const [grid] = await readJobs(
      undefined,
      "公司,投递岗位,投递渠道,投递日期,投递状态,岗位链接,备注\n模板测试,后端开发,官方网站,2026-09-07,官网已投递,https://example.invalid/job,微信\n",
    );
    const [job] = jobsFromGrid(grid!, []);
    expect(job).toMatchObject({
      title: "后端开发",
      applicationChannel: "官方网站",
      note: "微信",
      url: "https://example.invalid/job",
    });
    const state = setup(),
      id = state.store.addJob(job!).id;
    const a = state.store.ensureApplication(id);
    expect(a.state).toBe("DRAFT");
    expect(a.submittedAt).toBeNull();
    expect(initialManualFields(a, state.store.job(id))).toEqual({
      备注: "微信",
      投递渠道: "官方网站",
    });
    expect(
      initialManualFields(
        { ...a, note: "", applicationChannel: undefined },
        { ...state.store.job(id), note: "", applicationChannel: undefined },
      ),
    ).not.toHaveProperty("投递渠道");
  });
  it("syncs the new schema with real wrapper arguments while preserving edited notes and channels", async () => {
    const r = remote(),
      a = selected(r.store);
    a.note = "初始备注";
    a.applicationChannel = "官方网站";
    r.store.save(a, "TEST_NOTE");
    await sync(r.store, r.config, r.dir, r.cli, async () => {});
    expect(r.cli.templateVersion).toBe(2);
    expect(r.rows[0]!.fields).toMatchObject({
      投递岗位: "Test job",
      备注: "初始备注",
      投递渠道: "官方网站",
    });
    r.rows[0]!.fields.备注 = "飞书人工修改";
    r.rows[0]!.fields.投递渠道 = "内推";
    r.store.save(r.store.app(a.id), "TEST_REQUEUE");
    await sync(r.store, r.config, r.dir, r.cli, async () => {});
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.fields).toMatchObject({
      备注: "飞书人工修改",
      投递渠道: "内推",
    });
    expect(r.store.app(a.id).note).toBe("飞书人工修改");
    const write = r.calls
      .filter((args) => args[1] === "+record-upsert")
      .at(-1)!;
    const payload = JSON.parse(write[write.indexOf("--json") + 1]!);
    expect(payload).not.toHaveProperty("备注");
    expect(payload).not.toHaveProperty("投递渠道");
  });
  it("detects old tables and continues syncing old names and ISO text without mutating their schema", async () => {
    const r = remote(legacyTableFields),
      a = selected(r.store);
    await sync(r.store, r.config, r.dir, r.cli, async () => {});
    expect(r.cli.templateVersion).toBe(1);
    expect(r.rows[0]!.fields).toHaveProperty("岗位", "Test job");
    expect(r.rows[0]!.fields).not.toHaveProperty("投递岗位");
    expect(r.rows[0]!.fields).toHaveProperty("投递时间", "");
    expect(
      r.calls.some((args) =>
        /field-(create|update|delete)/.test(args[1] ?? ""),
      ),
    ).toBe(false);
    await expect(configureTemplateViews(r.store, r.cli)).rejects.toThrow(
      "旧版表格",
    );
    expect(r.calls.some((args) => args[1] === "+view-create")).toBe(false);
    expect(r.store.app(a.id).syncStatus).toBe("OK");
  });
  it("rejects missing status choices rather than writing invalid selects", async () => {
    const fields = structuredClone(tableFields);
    fields.find((f) => f.name === "投递状态")!.options = [];
    const r = remote(fields);
    await expect(r.cli.check()).rejects.toThrow(
      "FEISHU_TEMPLATE_OPTIONS_MISSING",
    );
  });
});

describe("real CLI contract for template view configuration (transport fixture)", () => {
  it("creates the three views, groups/sorts, reads back field IDs, and reuses existing views", async () => {
    const r = remote();
    expect((await configureTemplateViews(r.store, r.cli)).views).toHaveLength(
      3,
    );
    expect(r.store.getMeta("feishuTemplateViews")).toHaveProperty("at");
    await configureTemplateViews(r.store, r.cli);
    expect(r.calls.filter((args) => args[1] === "+view-create")).toHaveLength(
      3,
    );
    expect(
      r.calls.filter((args) => args[1] === "+view-get-visible-fields"),
    ).toHaveLength(6);
    expect(
      r.calls.some(
        (args) =>
          args[1] === "+view-set-group" &&
          args.some((v) => v.includes("投递状态")),
      ),
    ).toBe(true);
    expect(
      r.calls.some(
        (args) =>
          /record-|field-(update|delete)/.test(args[1] ?? "") &&
          !args.includes("--help"),
      ),
    ).toBe(false);
  });
  it("does not mark setup verified when readback differs", async () => {
    const r = remote();
    r.behavior.corruptReadback = true;
    await expect(configureTemplateViews(r.store, r.cli)).rejects.toThrow(
      "FEISHU_VIEW_READBACK_MISMATCH",
    );
    expect(r.store.getMeta("feishuTemplateViews")).toBeNull();
  });
  it("reconciles uncertain view creation and never blindly creates a duplicate", async () => {
    const r = remote();
    r.behavior.timeoutCreate = true;
    await expect(configureTemplateViews(r.store, r.cli)).rejects.toThrow();
    r.behavior.timeoutCreate = false;
    await configureTemplateViews(r.store, r.cli);
    expect(r.calls.filter((args) => args[1] === "+view-create")).toHaveLength(
      3,
    );
    const missing = remote();
    missing.behavior.timeoutCreate = true;
    missing.behavior.missingAfterTimeout = true;
    await expect(
      configureTemplateViews(missing.store, missing.cli),
    ).rejects.toThrow();
    await expect(
      configureTemplateViews(missing.store, missing.cli),
    ).rejects.toThrow("结果未知");
    expect(
      missing.calls.filter((args) => args[1] === "+view-create"),
    ).toHaveLength(1);
  });
  it("uses returned coordinates and stops safely before writes at a cancellation boundary", async () => {
    expect(
      createdBaseTarget({
        base: { app_token: "base_test" },
        table: { id: "tbl_test" },
      }),
    ).toEqual({ baseToken: "base_test", tableId: "tbl_test" });
    expect(() => createdBaseTarget({ created: true })).toThrow(
      "COORDINATES_MISSING",
    );
    const r = remote();
    await expect(
      configureTemplateViews(r.store, r.cli, async () => {
        throw new Error("cancelled");
      }),
    ).rejects.toThrow("cancelled");
    expect(r.calls).toEqual([]);
  });
});
