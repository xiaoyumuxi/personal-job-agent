import { describe, it, expect } from "vitest";
import type { Snapshot, Row } from "../desktop/contract.js";
import {
  presentJob,
  selectJobs,
  evidenceLabel,
  runForJob,
} from "../desktop/renderer/jobPresentation.js";
function row(id = "job"): Row {
  return {
    job: {
      id,
      company: "测试公司",
      title: "开发",
      batch: "",
      jobCode: "",
      url: "https://example.invalid/job",
      tenant: "",
      account: "",
      referral: "",
      source: "test",
      channel: "READY",
    },
    permissions: { apply: true, track: true, open: true, login: true },
    attention: "NORMAL",
  };
}
function application(
  r: Row,
  state: NonNullable<Row["application"]>["state"] = "SUBMITTED",
) {
  r.application = {
    id: "app",
    jobId: r.job.id,
    state,
    rawStatus: "面试安排中",
    stage: "INTERVIEW",
    outcome: "IN_PROGRESS",
    authStatus: "VALID",
    queryStatus: "OK",
    syncStatus: "OK",
    lastAttempt: null,
    lastSuccess: null,
    submittedAt: null,
    evidence: null,
    nextAction: "",
    queryError: "",
    syncError: "",
    queryRetries: 0,
    syncRetries: 0,
    priority: "",
    paused: false,
    note: "",
    deadline: "",
    revision: 0,
  };
  return r.application;
}
const snapshot = (rows: Row[]): Snapshot => ({
  rows,
  busy: false,
  lock: false,
  events: [],
  dataDir: "test",
});
describe("action-first job presentation", () => {
  it("gives empty data and a nonmatching search distinct zero counts", () => {
    expect(selectJobs(snapshot([]), "", "all").counts).toEqual({
      all: 0,
      attention: 0,
      todo: 0,
      progress: 0,
      done: 0,
    });
    expect(selectJobs(snapshot([row()]), "other", "all").rows).toEqual([]);
    expect(selectJobs(snapshot([row()]), " 测试 ", "all").counts.todo).toBe(1);
  });
  it("uses permission and workspace locks for starting, but keeps details accessible", () => {
    const r = row(),
      s = snapshot([r]);
    expect(presentJob(r, s)).toMatchObject({
      action: "apply",
      title: "准备填写",
      disabledReason: undefined,
    });
    s.lock = true;
    expect(presentJob(r, s).disabledReason).toContain("另一任务");
    s.lock = false;
    r.permissions.apply = false;
    expect(presentJob(r, s).disabledReason).toContain("不允许");
    r.job.url = "";
    expect(presentJob(r, s)).toMatchObject({
      action: "task",
      title: "补充链接",
    });
  });
  it.each(["confirm", "login", "review"] as const)(
    "derives the current %s request, not an independent UI state",
    (kind) => {
      const r = row(),
        s = snapshot([r]);
      application(r, "UNKNOWN_RESULT");
      s.busy = true;
      s.lock = true;
      s.run = {
        runId: "run",
        jobId: r.job.id,
        state: "WAIT_REVIEW",
        operation: "apply",
        at: "",
        step: "",
        request: { kind, message: "", requestId: "request" },
      };
      const p = presentJob(r, s);
      expect(p).toMatchObject({
        group: "attention",
        action: "task",
        disabledReason: undefined,
      });
      expect(p.title).toBe(
        kind === "confirm"
          ? "确认本次操作"
          : kind === "login"
            ? "继续登录"
            : "继续审核",
      );
    },
  );
  it.each(["PAUSING", "PAUSED", "CANCELLING"] as const)(
    "never labels %s as another control state",
    (state) => {
      const r = row(),
        s = snapshot([r]);
      s.busy = true;
      s.run = {
        runId: "run",
        jobId: r.job.id,
        state,
        operation: "apply",
        at: "",
        step: "",
        request: { kind: "review", requestId: "request", message: "" },
      };
      expect(presentJob(r, s).title).toBe(
        state === "PAUSING"
          ? "查看暂停进度"
          : state === "PAUSED"
            ? "恢复任务"
            : "查看停止进度",
      );
    },
  );
  it("does not use a stale ended request or another job's active run", () => {
    const r = row(),
      s = snapshot([r]);
    application(r, "UNKNOWN_RESULT");
    s.run = {
      runId: "run",
      jobId: r.job.id,
      state: "COMPLETED",
      operation: "track",
      at: "",
      step: "",
      request: { kind: "review", requestId: "old", message: "" },
    };
    expect(presentJob(r, s).title).toBe("核查结果");
    s.busy = true;
    expect(presentJob(r, s).title).toBe("核查结果"); // A profile write must not revive an ended request.
    s.run.jobId = "other";
    expect(presentJob(r, s).title).toBe("核查结果");
    expect(runForJob(s, r)).toBeUndefined();
    expect(runForJob(s)).toBeUndefined();
    delete s.run.jobId;
    expect(runForJob(s)).toBe(s.run);
  });
  it("unknown results cannot become reapply actions even if permissions are inconsistent", () => {
    const r = row();
    application(r, "UNKNOWN_RESULT");
    r.job.url = "";
    expect(presentJob(r, snapshot([r]))).toMatchObject({
      title: "核查结果",
      action: "task",
    });
  });
  it("labels manual evidence separately from official receipt verification", () => {
    const r = row();
    application(r).evidence = "manual-confirmation";
    expect(evidenceLabel(r)).toBe("本人核查记录 · 非官网回执");
  });
  it("retains recruitment progress when Feishu authorization expires", () => {
    const r = row(),
      a = application(r);
    a.syncStatus = "AUTH_REQUIRED";
    expect(presentJob(r, snapshot([r]))).toMatchObject({
      group: "progress",
      title: "处理同步",
    });
    expect(a.stage).toBe("INTERVIEW");
    expect(a.state).toBe("SUBMITTED");
    a.syncStatus = "NOT_CONFIGURED";
    expect(presentJob(r, snapshot([r])).group).toBe("progress");
  });
  it("partitions overlapping signals with attention before preparation, tracking and outcomes", () => {
    const a = row("attention"),
      b = row("todo"),
      c = row("progress"),
      d = row("done");
    const aa = application(a, "UNKNOWN_RESULT");
    aa.authStatus = "AUTH_REQUIRED";
    aa.syncStatus = "AUTH_REQUIRED";
    aa.outcome = "REJECTED";
    application(c).syncStatus = "AUTH_REQUIRED";
    application(d).outcome = "REJECTED";
    const s = snapshot([a, b, c, d]),
      { counts } = selectJobs(s, "", "all");
    expect(counts).toEqual({
      all: 4,
      attention: 1,
      todo: 1,
      progress: 1,
      done: 1,
    });
    expect(
      selectJobs(s, "", "attention").rows.map(({ row }) => row.job.id),
    ).toEqual([a.job.id]);
  });
});
