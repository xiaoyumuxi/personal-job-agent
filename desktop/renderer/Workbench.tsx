import { useState } from "react";
import { label, date, type Start } from "./shared.js";
import type { Snapshot } from "../contract.js";
import {
  presentJob,
  isActiveRun,
  selectJobs,
  evidenceLabel,
  type JobFilter,
} from "./jobPresentation.js";

export function Workbench({
  snapshot,
  busy,
  select,
  start,
  importJobs,
  refresh,
  settings,
  profile,
  discover,
}: {
  snapshot: Snapshot;
  busy: boolean;
  select: (id: string) => void;
  start: Start;
  importJobs: () => unknown;
  refresh: () => unknown;
  settings: () => void;
  profile: () => void;
  discover: () => void;
}) {
  const [query, setQuery] = useState(""),
    [filter, setFilter] = useState<JobFilter>("all");
  const { rows, counts } = selectJobs(snapshot, query, filter);
  const attention = snapshot.rows
    .map((row) => ({ row, presentation: presentJob(row, snapshot) }))
    .filter(({ presentation }) => presentation.group === "attention")
    .sort(
      (a, b) =>
        Number(isActiveRun(snapshot) && snapshot.run?.jobId === b.row.job.id) -
        Number(isActiveRun(snapshot) && snapshot.run?.jobId === a.row.job.id),
    );
  const globalAttention =
    isActiveRun(snapshot) &&
    snapshot.run &&
    !snapshot.run.jobId &&
    (snapshot.run.request || snapshot.run.state === "PAUSED");
  const attentionCount = attention.length + (globalAttention ? 1 : 0);
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">岗位与申请</div>
          <h1>投递工作台</h1>
          <p>先处理需要你接管的事项，再继续下一条申请。</p>
        </div>
        <div className="actions">
          <button className="primary" onClick={discover}>
            官网找岗位
          </button>
          <button onClick={importJobs} disabled={busy}>
            ＋ 导入岗位
          </button>
        </div>
      </header>
      {attentionCount > 0 && (
        <section className="action-queue" aria-label="待我接管">
          <div className="section-title">
            <h2>先处理这 {attentionCount} 件事</h2>
            <span className="hint">来自全部岗位与当前任务</span>
          </div>
          <div className="priority-grid">
            {globalAttention && (
              <button
                className="priority-card"
                onClick={() => select("global")}
              >
                <span className="priority-icon" aria-hidden>
                  ◎
                </span>
                <span>
                  <strong>处理工作空间任务</strong>
                  <small>
                    {label(snapshot.run!.operation)} ·{" "}
                    {label(snapshot.run!.state)}
                  </small>
                </span>
                <span aria-hidden>→</span>
              </button>
            )}
            {attention.slice(0, 6).map(({ row, presentation: p }) => (
              <button
                key={row.job.id}
                className="priority-card"
                onClick={() => select(row.job.id)}
              >
                <span className="priority-icon" aria-hidden>
                  {row.application?.state === "UNKNOWN_RESULT" ? "!" : "→"}
                </span>
                <span>
                  <strong>{p.title}</strong>
                  <small>
                    {row.job.company} · {row.job.title}
                  </small>
                </span>
                <span aria-hidden>›</span>
              </button>
            ))}
          </div>
          {attention.length > 6 && (
            <button
              className="text-button"
              onClick={() => {
                setQuery("");
                setFilter("attention");
              }}
            >
              查看全部 {attention.length} 个待接管岗位
            </button>
          )}
        </section>
      )}
      {!snapshot.rows.length && (
        <section className="onboarding panel" aria-label="首次使用准备">
          <div className="section-title">
            <h2>从这三步开始</h2>
            <span className="hint">飞书与模型按需配置</span>
          </div>
          <ol className="setup-steps">
            <li>
              <span>1</span>
              <div>
                <strong>检查核心环境</strong>
                <p>选择专用 Chrome，并检测本机环境。</p>
                <button onClick={settings}>检查环境</button>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <strong>准备简历与资料</strong>
                <p>导入简历，核对识别内容并逐项确认。</p>
                <button onClick={profile}>准备资料</button>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <strong>导入目标岗位</strong>
                <p>导入只建立清单，由你选择何时开始。</p>
                <button onClick={importJobs} disabled={busy}>
                  选择岗位文件
                </button>
              </div>
            </li>
          </ol>
        </section>
      )}
      {snapshot.lock && !snapshot.busy && (
        <div className="banner warning">
          其他进程正在使用工作空间，或上次退出留下锁。
          <button onClick={settings}>前往设置检查</button>
        </div>
      )}
      <section className="jobs-panel" aria-label="岗位清单">
        <div className="toolbar">
          <input
            aria-label="搜索公司或岗位"
            className="search"
            placeholder="搜索公司或岗位"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            onClick={() => start("track")}
            disabled={busy}
            title={busy ? "当前任务结束后可查询" : undefined}
          >
            批量查询进度
          </button>
          <button
            onClick={() => start("sync")}
            disabled={busy}
            title={busy ? "当前任务结束后可同步" : undefined}
          >
            同步飞书
          </button>
          <button onClick={refresh} aria-label="刷新工作台">
            刷新
          </button>
        </div>
        <div className="filters" role="group" aria-label="岗位筛选">
          {(
            [
              ["all", "全部"],
              ["attention", "待我接管"],
              ["todo", "待准备"],
              ["progress", "跟进中"],
              ["done", "已结束"],
            ] as const
          ).map(([id, text]) => (
            <button
              key={id}
              aria-pressed={filter === id}
              className={filter === id ? "selected" : ""}
              onClick={() => setFilter(id)}
            >
              {text} <span className="count">{counts[id]}</span>
            </button>
          ))}
          <span>
            {query.trim() ? "搜索范围内" : "全部本地岗位"} · {rows.length} 条
          </span>
        </div>
        <div className="table-wrap">
          <table className="jobs-table">
            <thead>
              <tr>
                <th>公司 / 岗位</th>
                <th>招聘进展</th>
                <th>下一步</th>
                <th>最近记录 / 来源</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ row: r, presentation: p }) => (
                <tr key={r.job.id} className={`attention-${r.attention}`}>
                  <td data-label="公司 / 岗位">
                    <div className="company-cell">
                      <span className="company-mark" aria-hidden>
                        {r.job.company.slice(0, 1)}
                      </span>
                      <div>
                        <button
                          className="job-title"
                          onClick={() => select(r.job.id)}
                        >
                          <strong>{r.job.company}</strong>
                          <span>{r.job.title}</span>
                        </button>
                        <small>{r.job.batch || "未标注批次"}</small>
                      </div>
                    </div>
                  </td>
                  <td data-label="招聘进展">
                    <span className="stage-label">
                      {r.application?.stage && r.application.stage !== "UNKNOWN"
                        ? label(r.application.stage)
                        : "尚无官网进展"}
                    </span>
                    <small>
                      {r.application?.rawStatus ||
                        (r.application ? "暂无官网状态原文" : "岗位已导入")}
                    </small>
                  </td>
                  <td data-label="下一步">
                    <span
                      className={
                        p.group === "attention"
                          ? "next-action needs-you"
                          : "next-action"
                      }
                    >
                      {p.description}
                    </span>
                    {p.connectionIssue && (
                      <button className="connection-note" onClick={settings}>
                        {p.connectionIssue} →
                      </button>
                    )}
                  </td>
                  <td data-label="最近记录 / 来源">
                    <span>
                      {r.application?.lastAttempt
                        ? `最近尝试：${date(r.application.lastAttempt)}`
                        : "尚无执行时间记录"}
                    </span>
                    <small>{evidenceLabel(r)}</small>
                    <small className="source-origin">
                      导入来源：{r.job.source || "未记录"}
                    </small>
                  </td>
                  <td data-label="操作">
                    <div className="row-actions">
                      <button
                        className={
                          p.group === "attention" ? "primary subtle" : ""
                        }
                        disabled={
                          p.action === "apply" && (busy || !!p.disabledReason)
                        }
                        title={
                          p.disabledReason ||
                          (busy && p.action === "apply"
                            ? "正在处理其他操作"
                            : undefined)
                        }
                        onClick={() =>
                          p.action === "apply"
                            ? start("apply", r.job.id)
                            : p.action === "settings"
                              ? settings()
                              : select(r.job.id)
                        }
                      >
                        {p.title}
                      </button>
                      {p.action !== "task" && (
                        <button
                          className="text-button"
                          onClick={() => select(r.job.id)}
                        >
                          详情
                        </button>
                      )}
                      {p.disabledReason && (
                        <small className="disabled-reason">
                          {p.disabledReason}
                        </small>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && (
            <div className="empty">
              <span className="empty-symbol" aria-hidden>
                ▤
              </span>
              <h2>
                {snapshot.rows.length
                  ? "没有匹配的岗位"
                  : "把你的岗位清单带进来"}
              </h2>
              <p>
                {snapshot.rows.length
                  ? "尝试调整关键词或筛选条件。"
                  : "支持 CSV、TSV 和 XLSX，识别企业名称、招聘岗位、内推类型和链接。导入不会自动投递。"}
              </p>
              {snapshot.rows.length > 0 && (
                <button
                  onClick={() => {
                    setQuery("");
                    setFilter("all");
                  }}
                >
                  清除搜索与筛选
                </button>
              )}
            </div>
          )}
        </div>
      </section>
      <p className="footnote">
        每个岗位只计入一个分组；待接管优先于申请进展。官网回执、本人核查与飞书同步分别记录。
      </p>
    </>
  );
}
