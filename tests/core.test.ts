import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { testState, selected, site } from "./helpers.js";
import { attention, Store } from "../src/db.js";
import { draftFromText, importProfile, saveProfile } from "../src/profile.js";
import { MemoryVault } from "../src/vault.js";
import { readJobs, jobsFromGrid, resolveHeaders } from "../src/jobs.js";
import { failureState, AgentError } from "../src/errors.js";
import { applyObservation } from "../src/track.js";
import { acquireLock } from "../src/lock.js";
import { dueDates, dailyRun } from "../src/schedule.js";
import { runFile } from "../src/process.js";
import { ConfigSchema, ROOT, safeUrl } from "../src/config.js";
const resources: ReturnType<typeof testState>[] = [];
const setup = () => {
  const s = testState();
  resources.push(s);
  return s;
};
afterEach(() => {
  for (const r of resources.splice(0)) r.dispose();
});
describe("本地数据与隐私", () => {
  it("文本提取只产生待确认/冲突，缺失不等于没有", () => {
    const p = draftFromText(
      "姓名：测试人\na@example.invalid b@example.invalid\n13812345678",
    );
    expect(p.facts["basic.name"]?.state).toBe("pending");
    expect(p.facts["basic.email"]?.state).toBe("conflict");
    expect(draftFromText("没有信息").facts["basic.phone"]?.state).toBe(
      "missing",
    );
  });
  it("JSON 不能自行赋予确认或披露权限，SQLite 不保存个人值", async () => {
    const s = setup(),
      file = join(s.dir, "input.json");
    writeFileSync(
      file,
      JSON.stringify({
        facts: {
          "basic.name": {
            state: "confirmed",
            value: "SENSITIVE_UNIQUE_VALUE",
            discloseTo: ["*"],
          },
        },
      }),
    );
    const p = await importProfile(file, undefined, s.dir);
    expect(p.facts["basic.name"]?.state).toBe("pending");
    expect(p.facts["basic.name"]?.discloseTo).toEqual([]);
    const vault = new MemoryVault();
    await saveProfile(vault, s.store, p);
    expect(
      readFileSync(join(s.dir, "state.sqlite")).includes(
        Buffer.from("SENSITIVE_UNIQUE_VALUE"),
      ),
    ).toBe(false);
    expect(s.store.getMeta("profileRef")).toBeUndefined();
  });
  it("Keychain 故障不写入明文，也不假装导入成功", async () => {
    const s = setup();
    await expect(
      saveProfile(
        {
          get: async () => undefined,
          set: async () => {
            throw new Error("locked");
          },
        },
        s.store,
        draftFromText("姓名：测试"),
      ),
    ).rejects.toThrow();
    expect(s.store.getMeta("profileRef")).toBeUndefined();
  });
  it("受限数据目录与数据库权限，锁拒绝第二实例", () => {
    const s = setup();
    expect(statSync(s.dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(s.dir, "state.sqlite")).mode & 0o777).toBe(0o600);
    const release = acquireLock(s.dir);
    expect(() => acquireLock(s.dir)).toThrow("BUSY");
    release();
    acquireLock(s.dir)();
  });
  it("SQLite 重启保留业务状态与 outbox", () => {
    const s = setup();
    const a = selected(s.store);
    const second = new Store(s.dir);
    try {
      expect(second.app(a.id).state).toBe("SUBMITTED");
      expect(second.pending()).toHaveLength(1);
    } finally {
      second.close();
    }
  });
  it("只允许 HTTP(S) 目标，拒绝内嵌凭证", () => {
    expect(() => safeUrl("javascript:alert(1)")).toThrow();
    expect(() => safeUrl("https://u:password@example.com")).toThrow();
    expect(ROOT).toContain("/agent/");
  });
});
describe("岗位导入", () => {
  it("CSV/粘贴表格保留内推参数，缺入口 NEEDS_CHANNEL；不创建申请", async () => {
    const s = setup();
    const [g] = await readJobs(
      undefined,
      "公司\t岗位\t招聘批次\t岗位编号\t投递链接\n甲\t工程师\t2026\tA\thttps://example.com/apply?ref=a%2Bb&x=2\n乙\t设计师\t2026\tB\t",
    );
    const jobs = jobsFromGrid(g!, []);
    expect(jobs[0]?.url).toBe("https://example.com/apply?ref=a%2Bb&x=2");
    expect(jobs[1]?.channel).toBe("NEEDS_CHANNEL");
    jobs.forEach((j) => s.store.addJob(j));
    expect(s.store.applications()).toHaveLength(0);
  });
  it("XLSX 提取真实 hyperlink 与公式链接并保存来源单元格行", async () => {
    const s = setup(),
      wb = new ExcelJS.Workbook(),
      sheet = wb.addWorksheet("岗位");
    sheet.addRow(["公司", "岗位", "招聘批次", "岗位编号", "投递入口"]);
    sheet.addRow([
      "测试",
      "开发",
      "2026",
      "A",
      { text: "点此申请", hyperlink: "https://example.com/?ref=KEEP" },
    ]);
    sheet.addRow([
      "测试",
      "设计",
      "2026",
      "B",
      {
        formula: 'HYPERLINK("https://example.com/b?ref=KEEP","申请")',
        result: "申请",
      },
    ]);
    const file = join(s.dir, "jobs.xlsx");
    await wb.xlsx.writeFile(file);
    const grids = await readJobs(file);
    const jobs = jobsFromGrid(grids[0]!, []);
    expect(jobs.map((j) => j.url)).toEqual([
      "https://example.com/?ref=KEEP",
      "https://example.com/b?ref=KEEP",
    ]);
    expect(jobs[0]?.source).toBe("jobs.xlsx#岗位:2");
  });
  it("强标识去重，弱标识不合并，歧义表头要求映射", () => {
    const s = setup();
    const a = selected(s.store);
    const { id, ...j } = s.store.job(a.jobId);
    expect(s.store.addJob(j).duplicate).toBe(true);
    expect(s.store.addJob({ ...j, jobCode: "" }).duplicate).toBe(false);
    expect(s.store.addJob({ ...j, jobCode: "" }).duplicate).toBe(false);
    expect(() =>
      resolveHeaders([
        { text: "公司" },
        { text: "岗位" },
        { text: "链接" },
        { text: "官网链接" },
      ]),
    ).toThrow("歧义");
    expect(
      resolveHeaders(
        [
          { text: "公司" },
          { text: "岗位" },
          { text: "链接" },
          { text: "官网链接" },
        ],
        { 链接: "ignore" },
      ).url,
    ).toBe(3);
  });
});
describe("进度与有限重试", () => {
  it("首次失败加三次重试，第四次失败耗尽", () => {
    const e = new AgentError("TRANSIENT", "NETWORK");
    let failures = 0;
    const statuses = [];
    for (let n = 0; n < 4; n++) {
      const f = failureState(e, failures, 3);
      failures = f.failures;
      statuses.push(f.status);
    }
    expect(statuses).toEqual([
      "RETRY_PENDING",
      "RETRY_PENDING",
      "RETRY_PENDING",
      "RETRY_EXHAUSTED",
    ]);
  });
  it("授权缺失不消耗重试，独立耗尽故障优先红色", () => {
    expect(failureState(new AgentError("AUTH_REQUIRED", "AUTH"), 0, 3)).toEqual(
      { status: "AUTH_REQUIRED", failures: 0, retries: 0 },
    );
    const s = setup(),
      a = selected(s.store);
    a.authStatus = "AUTH_REQUIRED";
    expect(attention(a)).toBe("AUTH_REQUIRED");
    a.syncStatus = "RETRY_EXHAUSTED";
    expect(attention(a)).toBe("RETRY_EXHAUSTED");
    expect(a.authStatus).toBe("AUTH_REQUIRED");
  });
  it("partial/查询缺失不覆盖上次可靠招聘进度", () => {
    const s = setup(),
      a = selected(s.store);
    applyObservation(s.store, a, site, {
      records: [
        { jobCode: "J001", batch: "fixture-2026", rawStatus: "面试中" },
      ],
      coverage: "complete",
      evidence: "fixture:p2",
    });
    const before = s.store.app(a.id);
    applyObservation(s.store, a, site, {
      records: [],
      coverage: "partial",
      evidence: "fixture:p1",
    });
    const after = s.store.app(a.id);
    expect(after.stage).toBe("INTERVIEW");
    expect(after.lastSuccess).toBe(before.lastSuccess);
    expect(after.queryStatus).toBe("PARTIAL");
    expect(after.outcome).toBe("PENDING");
  });
  it("未知状态保留原文，不推断拒绝", () => {
    const s = setup(),
      a = selected(s.store);
    applyObservation(s.store, a, site, {
      records: [
        { jobCode: "J001", batch: "fixture-2026", rawStatus: "等待内部排期" },
      ],
      coverage: "complete",
      evidence: "fixture",
    });
    expect(s.store.app(a.id)).toMatchObject({
      rawStatus: "等待内部排期",
      stage: "UNKNOWN",
      outcome: "UNKNOWN",
    });
  });
});
describe("调度与安全子进程", () => {
  it("漏跑日期去重并合并一次当前查询，不虚构历史", async () => {
    const s = setup();
    s.store.setMeta("createdDate", "2026-09-01");
    const dates = dueDates(
      "2026-09-05",
      "2026-09-01",
      9,
      0,
      new Date("2026-09-08T10:00:00"),
    );
    expect(dates).toEqual(["2026-09-06", "2026-09-07", "2026-09-08"]);
    let calls = 0;
    const date = new Date("2026-09-08T10:00:00");
    await dailyRun(
      s.store,
      s.config,
      async () => {
        calls++;
      },
      date,
    );
    await dailyRun(
      s.store,
      s.config,
      async () => {
        calls++;
      },
      date,
    );
    expect(calls).toBe(1);
  });
  it("未到今日执行时间不提前查询；失败不会被标记完成", async () => {
    const s = setup();
    expect(
      dueDates(
        "2026-09-07",
        "2026-09-01",
        9,
        0,
        new Date("2026-09-08T08:00:00"),
      ),
    ).toEqual([]);
    await expect(
      dailyRun(
        s.store,
        s.config,
        async () => {
          throw new Error("fail");
        },
        new Date("2026-09-08T10:00:00"),
      ),
    ).rejects.toThrow();
    expect(s.store.getMeta("lastDailyDate")).toBeUndefined();
  });
  it("execFile/spawn 参数不会执行 Shell 注入，正确识别超时", async () => {
    const payload = '$(touch /tmp/SHOULD_NOT_EXIST); `id` "line"\n岗位';
    const r = await runFile(process.execPath, [
      "-e",
      "process.stdout.write(process.argv[1])",
      payload,
    ]);
    expect(r.stdout).toBe(payload);
    const timed = await runFile(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      { timeout: 30 },
    );
    expect(timed.timedOut).toBe(true);
  });
});
