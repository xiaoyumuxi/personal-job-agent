import type { Row, Snapshot } from "../contract.js";

export type JobGroup = "attention" | "todo" | "progress" | "done";
export type JobFilter = "all" | JobGroup;
export interface JobPresentation {
  group: JobGroup;
  action: "task" | "apply" | "settings";
  title: string;
  description: string;
  disabledReason?: string;
  connectionIssue?: string;
}

export function runForJob(snapshot: Snapshot, row?: Row) {
  return snapshot.run?.jobId === row?.job.id ? snapshot.run : undefined;
}

export function isActiveRun(snapshot: Snapshot, run = snapshot.run) {
  // busy also covers profile/settings writes; it cannot revive a completed run.
  return (
    !!run &&
    snapshot.busy &&
    [
      "RUNNING",
      "WAIT_LOGIN",
      "WAIT_INPUT",
      "WAIT_REVIEW",
      "PAUSING",
      "PAUSED",
      "CANCELLING",
    ].includes(run.state)
  );
}

// One exclusive group per job. Connection problems are annotations, not a
// second application lifecycle or a reason to overwrite recruitment progress.
export function presentJob(row: Row, snapshot: Snapshot): JobPresentation {
  const a = row.application;
  const run = runForJob(snapshot, row);
  const connectionIssue =
    a?.syncStatus === "AUTH_REQUIRED"
      ? "飞书需重新授权；本地申请记录已保留"
      : a?.syncError ||
          (a && ["STOPPED", "RETRY_EXHAUSTED"].includes(a.syncStatus))
        ? "飞书同步未完成；远端可能尚未更新"
        : undefined;
  const result = (
    group: JobGroup,
    title: string,
    description: string,
    action: JobPresentation["action"] = "task",
    disabledReason?: string,
  ): JobPresentation => ({
    group,
    title,
    description,
    action,
    disabledReason,
    connectionIssue,
  });
  if (run && isActiveRun(snapshot, run)) {
    if (run.state === "PAUSING")
      return result("progress", "查看暂停进度", "正在等待安全边界，尚未暂停");
    if (run.state === "CANCELLING")
      return result(
        "progress",
        "查看停止进度",
        "正在停止后续操作，等待任务结束",
      );
    if (run.state === "PAUSED")
      return result("attention", "恢复任务", "已暂停；恢复后重新观察网页");
    if (run.request?.kind === "confirm")
      return result("attention", "确认本次操作", "核对本次目标与资料披露范围");
    if (run.request?.kind === "login")
      return result("attention", "继续登录", "完成官网登录后重新验证");
    if (run.request?.kind === "review")
      return result(
        "attention",
        "继续审核",
        run.request.issues?.length
          ? "核对待处理问题，再到官网审核"
          : "在官网审核表单并由本人提交",
      );
    return result("progress", "查看任务", run.step || "任务正在处理");
  }
  if (a?.state === "UNKNOWN_RESULT")
    return result("attention", "核查结果", "先核查官网，避免重复申请");
  if (a?.state === "REVIEW" || a?.state === "FILLING")
    return result(
      "attention",
      "检查上次任务",
      "上次填写未结束，先核查官网和任务记录",
    );
  if (a?.authStatus === "AUTH_REQUIRED" || a?.queryStatus === "AUTH_REQUIRED")
    return result(
      "attention",
      "处理官网登录",
      "登录未验证；招聘进展保持原记录",
    );
  if (a?.outcome && !["UNKNOWN", "PENDING", "IN_PROGRESS"].includes(a.outcome))
    return result("done", "查看记录", "查看招聘结果与记录来源");
  if (!row.job.url || row.job.channel === "NEEDS_CHANNEL")
    return result("todo", "补充链接", "补充官网岗位链接后再准备填写");
  if (!a || a.state === "DRAFT") {
    const disabledReason =
      snapshot.busy || snapshot.lock
        ? "另一任务正在使用工作空间，结束后可准备填写"
        : !row.permissions.apply
          ? "当前站点或申请状态不允许辅助填写，请查看详情"
          : undefined;
    return result(
      "todo",
      "准备填写",
      "选择简历版本并确认本次披露",
      "apply",
      disabledReason,
    );
  }
  if (a.paused)
    return result("progress", "管理跟踪", "此申请已暂停跟踪，可在详情恢复");
  if (
    [
      "STOPPED",
      "RETRY_EXHAUSTED",
      "RETRY_PENDING",
      "PARTIAL",
      "NOT_FOUND",
      "UNKNOWN",
    ].includes(a.queryStatus)
  )
    return result(
      "progress",
      "检查查询记录",
      "进度查询未完成，查看原因与恢复操作",
    );
  if (a.queryStatus === "NEEDS_ADAPTER")
    return result(
      "progress",
      "查看站点规则",
      "进度查询需要配置站点规则",
      "settings",
    );
  if (connectionIssue)
    return result("progress", "处理同步", "查看同步故障与恢复操作");
  return result(
    "progress",
    "查看详情",
    a.nextAction || "等待招聘方反馈，按需查询进度",
  );
}

export function selectJobs(
  snapshot: Snapshot,
  query: string,
  filter: JobFilter,
) {
  const searched = snapshot.rows
    .filter((r) =>
      `${r.job.company} ${r.job.title}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
    )
    .map((row) => ({ row, presentation: presentJob(row, snapshot) }));
  const counts = {
    all: searched.length,
    attention: 0,
    todo: 0,
    progress: 0,
    done: 0,
  };
  for (const { presentation } of searched) counts[presentation.group]++;
  return {
    counts,
    rows: searched.filter(
      ({ presentation }) => filter === "all" || presentation.group === filter,
    ),
  };
}

export function evidenceLabel(row: Row) {
  const a = row.application;
  if (a?.evidence === "manual-confirmation") return "本人核查记录 · 非官网回执";
  if (a?.evidence) return `记录证据：${a.evidence}`;
  if (a?.state === "UNKNOWN_RESULT") return "未获得可靠官网回执";
  return a ? "申请流程记录 · 尚无提交证据" : "岗位导入记录";
}
