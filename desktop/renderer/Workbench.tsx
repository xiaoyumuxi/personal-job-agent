import { useState, useEffect } from "react";
import {
  api,
  label,
  date,
  Badge,
  type Start,
  type Perform,
  type Send,
} from "./shared.js";
import type { Snapshot } from "../contract.js";
export function Workbench({
  snapshot,
  busy,
  selected,
  select,
  start,
  importJobs,
  refresh,
}: {
  snapshot: Snapshot;
  busy: boolean;
  selected?: string;
  select: (id: string) => void;
  start: Start;
  importJobs: () => unknown;
  refresh: () => unknown;
}) {
  const [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all");
  const rows = snapshot.rows
    .filter((r) =>
      `${r.job.company} ${r.job.title}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    )
    .filter((r) => {
      if (filter === "all") return true;
      const a = r.application;
      if (filter === "todo") return !a || a.state === "DRAFT";
      if (filter === "attention")
        return (
          r.attention !== "NORMAL" ||
          (a &&
            (["UNKNOWN_RESULT", "REVIEW"].includes(a.state) ||
              [a.queryStatus, a.syncStatus].some((s) =>
                ["STOPPED", "NEEDS_ADAPTER", "NOT_CONFIGURED"].includes(s),
              )))
        );
      if (filter === "done")
        return (
          a?.outcome &&
          !["UNKNOWN", "PENDING", "IN_PROGRESS"].includes(a.outcome)
        );
      return !!a && ["FILLING", "REVIEW", "SUBMITTED"].includes(a.state);
    });
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">岗位与申请</div>
          <h1>投递工作台</h1>
          <p>选择一个岗位开始辅助填写，随时接管浏览器。</p>
        </div>
        <button className="primary" onClick={importJobs} disabled={busy}>
          ＋ 导入岗位
        </button>
      </header>
      <div className="toolbar">
        <input
          aria-label="搜索公司或岗位"
          className="search"
          placeholder="搜索公司或岗位"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button onClick={() => start("track")} disabled={busy}>
          批量查询进度
        </button>
        <button onClick={() => start("sync")} disabled={busy}>
          同步飞书
        </button>
        <button onClick={refresh} aria-label="刷新工作台">
          刷新
        </button>
      </div>
      <div className="filters" role="group" aria-label="岗位筛选">
        {[
          ["all", "全部"],
          ["todo", "待投递"],
          ["progress", "进行中"],
          ["attention", "需要处理"],
          ["done", "已完成"],
        ].map(([id, text]) => (
          <button
            key={id}
            aria-pressed={filter === id}
            className={filter === id ? "selected" : ""}
            onClick={() => setFilter(id!)}
          >
            {text}
          </button>
        ))}
        <span>{rows.length} 个岗位</span>
      </div>
      {snapshot.lock && !snapshot.busy && (
        <div className="banner warning">
          CLI 或 launchd
          正在使用专用浏览器，或上次退出留下锁。可在设置中检查失效锁。
        </div>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>公司 / 岗位</th>
              <th>招聘阶段</th>
              <th>官网登录</th>
              <th>执行状态</th>
              <th>飞书同步</th>
              <th>最近查询 / 待办</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.job.id}
                className={`attention-${r.attention} ${selected === r.job.id ? "current" : ""}`}
              >
                <td>
                  <button
                    className="job-title"
                    onClick={() => select(r.job.id)}
                  >
                    <strong>{r.job.company}</strong>
                    <span>{r.job.title}</span>
                  </button>
                  <small>{r.job.batch || "未标注批次"}</small>
                </td>
                <td>
                  {r.application?.stage && r.application.stage !== "UNKNOWN"
                    ? label(r.application.stage)
                    : "未知阶段"}
                  <small>{r.application?.rawStatus || "尚无官网进度"}</small>
                </td>
                <td>
                  <Badge
                    value={r.application?.authStatus}
                    text={
                      r.application?.authStatus === "AUTH_REQUIRED"
                        ? "需要官网登录"
                        : undefined
                    }
                  />
                </td>
                <td>
                  <Badge
                    value={
                      snapshot.run?.jobId === r.job.id && snapshot.busy
                        ? snapshot.run.state
                        : r.application?.state || "DRAFT"
                    }
                  />
                  <small>
                    查询：{label(r.application?.queryStatus || "NEVER")}
                  </small>
                  {r.attention !== "NORMAL" && (
                    <small className="reason">
                      {r.attention === "AUTH_REQUIRED"
                        ? "需要处理登录或飞书授权"
                        : "查询或同步已重试耗尽"}
                    </small>
                  )}
                </td>
                <td>
                  <Badge
                    value={r.application?.syncStatus || "NEVER"}
                    text={
                      r.application?.syncStatus === "AUTH_REQUIRED"
                        ? "需要飞书授权"
                        : undefined
                    }
                  />
                  {r.application?.syncError && (
                    <small className="reason">远端可能尚未更新</small>
                  )}
                </td>
                <td>
                  <small>{date(r.application?.lastAttempt)}</small>
                  <span className="todo">
                    {r.application?.nextAction ||
                      (r.job.channel === "READY"
                        ? "确认资料后启动填写"
                        : "缺少投递入口；在详情中补充")}
                  </span>
                </td>
                <td>
                  <div className="row-actions">
                    <button
                      className="primary subtle"
                      disabled={busy || !r.permissions.apply}
                      onClick={() => start("apply", r.job.id)}
                    >
                      辅助填写
                    </button>
                    <button onClick={() => select(r.job.id)}>详情</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && (
          <div className="empty">
            <span className="empty-symbol">▤</span>
            <h2>
              {snapshot.rows.length ? "没有匹配的岗位" : "把你的岗位清单带进来"}
            </h2>
            <p>
              {snapshot.rows.length
                ? "尝试调整关键词或筛选条件。"
                : "支持 CSV、TSV 和 XLSX。导入只记录岗位，不会自动投递。"}
            </p>
            {!snapshot.rows.length && (
              <button className="primary" disabled={busy} onClick={importJobs}>
                选择岗位文件
              </button>
            )}
          </div>
        )}
      </div>
      <p className="footnote">
        批量查询只读取已有申请进度。官网回执、本人核查结果与飞书同步状态分别记录。
      </p>
    </>
  );
}
