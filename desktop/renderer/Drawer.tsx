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
import type { Snapshot, Row, ProfileView } from "../contract.js";
import type { Answer, Question } from "../../src/interaction.js";
import type { Value } from "../../src/types.js";
export function Drawer({
  snapshot,
  row,
  pending,
  close,
  command,
  start,
}: {
  snapshot: Snapshot;
  row?: Row;
  pending: boolean;
  close: () => void;
  command: Send;
  start: Start;
}) {
  const [channelURL, setChannelURL] = useState("");
  const run =
    snapshot.run && (!row || snapshot.run.jobId === row.job.id)
      ? snapshot.run
      : undefined;
  const [history, setHistory] = useState<
      { id: number; at: string; kind: string }[]
    >([]),
    [resolveOpen, setResolveOpen] = useState(false);
  useEffect(() => {
    let ok = true;
    if (row)
      void api.invoke({ method: "history", jobId: row.job.id }).then((v) => {
        if (ok) setHistory(v as typeof history);
      });
    return () => {
      ok = false;
    };
  }, [row?.job.id, row?.application?.revision]);
  const q = run?.request;
  const [recordLabels, setRecordLabels] = useState<Record<string, string>>({});
  const [recordLabelsError, setRecordLabelsError] = useState(false);
  useEffect(() => {
    let current = true;
    setRecordLabels({});
    setRecordLabelsError(false);
    if (q?.issues?.some((issue) => issue.records?.length)) {
      void api
        .invoke({ method: "profile", profileId: run?.profile?.id })
        .then((result) => {
          if (!current) return;
          const { profile } = result as ProfileView;
          const labels: Record<string, string> = {};
          for (const kind of ["education", "experience", "project"] as const) {
            for (const id of profile.records[kind]) {
              const base = `${kind}.${id}`;
              const value = (field: string) =>
                profile.facts[`${base}.${field}`]?.value;
              const title =
                value(
                  kind === "education"
                    ? "school"
                    : kind === "experience"
                      ? "company"
                      : "name",
                ) || id;
              labels[base] =
                `${title} · ${value("startDate") || "起始时间待补充"} — ${value("endDate") || "结束时间待补充"}`;
            }
          }
          setRecordLabels(labels);
        })
        .catch(() => {
          if (current) setRecordLabelsError(true);
        });
    }
    return () => {
      current = false;
    };
  }, [q?.requestId]);
  const active = !!run && snapshot.busy;
  const send = (answer: Answer) =>
    run && q
      ? command({
          method: "answer",
          runId: run.runId,
          requestId: q.requestId,
          answer,
        })
      : Promise.resolve();
  const controls = (action: "pause" | "resume" | "cancel" | "focus") =>
    run && command({ method: "control", runId: run.runId, action });
  const blocked =
    pending ||
    !active ||
    ["PAUSED", "PAUSING", "CANCELLING"].includes(run?.state || "");
  return (
    <aside className="drawer" aria-label="任务详情">
      <header>
        <div>
          <div className="eyebrow">任务详情</div>
          <h2>{row?.job.company || "工作空间任务"}</h2>
          <p>{row?.job.title || label(run?.operation)}</p>
        </div>
        <button className="icon" aria-label="关闭任务详情" onClick={close}>
          ×
        </button>
      </header>
      <div className="drawer-body">
        {row?.application?.profileId && (
          <p className="hint">
            该申请已选简历：
            {row.application.profileName || row.application.profileId} · 修订{" "}
            {row.application.profileRevision}
          </p>
        )}
        {run && (
          <section>
            <div className="section-title">
              <h3>{label(run.operation)}</h3>
              <Badge value={run.state} />
            </div>
            <p>{run.step}</p>
            {run.profile && (
              <p className="hint">
                本次简历：{run.profile.name} · 修订 {run.profile.revision}
              </p>
            )}
            {run.error && <div className="callout error">{run.error}</div>}
            {active && (
              <div className="actions">
                <button onClick={() => controls("focus")} disabled={pending}>
                  前往受控浏览器
                </button>
                {run.state === "PAUSED" ? (
                  <button onClick={() => controls("resume")} disabled={pending}>
                    恢复任务
                  </button>
                ) : (
                  <button
                    onClick={() => controls("pause")}
                    disabled={
                      pending || ["PAUSING", "CANCELLING"].includes(run.state)
                    }
                  >
                    暂停任务
                  </button>
                )}
                <button
                  onClick={() => controls("cancel")}
                  disabled={pending || run.state === "CANCELLING"}
                >
                  停止后续操作
                </button>
              </div>
            )}
            {run.state === "PAUSING" && (
              <p className="hint">
                正在等待当前页面或网络操作结束，后端确认后才会显示已暂停。
              </p>
            )}
            {run.state === "PAUSED" && (
              <p className="hint">
                任务已在操作边界暂停。恢复后重新观察网页，保留人工修改。
              </p>
            )}
          </section>
        )}
        {q && (
          <section className="request" key={q.requestId}>
            <div className="eyebrow">现在需要你</div>
            <h3>
              {q.kind === "login"
                ? "完成官网登录"
                : q.kind === "confirm"
                  ? "确认本次操作"
                  : "核对并补充表单"}
            </h3>
            <p>{q.message}</p>
            {q.site && <p className="site-url">{q.site}</p>}
            {q.kind === "confirm" && (
              <div className="actions">
                <button
                  className="primary"
                  disabled={blocked}
                  onClick={() => send({ action: "confirm", accepted: true })}
                >
                  我已核对，继续
                </button>
                <button
                  disabled={blocked}
                  onClick={() => send({ action: "confirm", accepted: false })}
                >
                  不继续
                </button>
              </div>
            )}
            {q.kind === "login" && (
              <>
                <p className="hint">
                  完成账号、验证码或扫码登录后，程序会重新访问申请页验证。点击按钮本身不代表登录成功。
                </p>
                <button
                  className="primary full"
                  disabled={blocked}
                  onClick={() => send({ action: "check" })}
                >
                  已完成登录，重新检查
                </button>
              </>
            )}
            {q.kind === "review" && (
              <>
                {recordLabelsError && (
                  <p className="error-text">
                    无法读取经历名称，请到“我的资料”检查资料连接后重试。
                  </p>
                )}
                <div className="issues">
                  {q.issues?.map((issue, index) => (
                    <IssueForm
                      key={index}
                      issue={issue}
                      index={index}
                      paths={q.paths || []}
                      recordLabels={recordLabels}
                      disabled={blocked}
                      send={send}
                    />
                  ))}
                </div>
                <div className="actions">
                  <button
                    disabled={blocked}
                    onClick={() => send({ action: "resume" })}
                  >
                    重新观察并继续
                  </button>
                  {q.canNext && (
                    <button
                      disabled={blocked}
                      onClick={() => send({ action: "next" })}
                    >
                      填写下一步
                    </button>
                  )}
                  {q.canModel && (
                    <button
                      disabled={blocked}
                      onClick={() => send({ action: "model" })}
                    >
                      请求字段映射建议
                    </button>
                  )}
                  {q.additions?.map((section) => (
                    <button
                      key={section}
                      disabled={blocked}
                      onClick={() => send({ action: "add", section })}
                    >
                      新增{section}
                    </button>
                  ))}
                </div>
                <div className="review-box">
                  <strong>最终提交请在官网完成</strong>
                  <p>
                    点击下方按钮只检查回执。没有可验证回执时，将记录“提交结果未知”，禁止重复填写。
                  </p>
                  <button
                    className="primary"
                    disabled={blocked}
                    onClick={() => send({ action: "submitted" })}
                  >
                    我已在官网提交，检查回执
                  </button>
                  <button
                    disabled={blocked}
                    onClick={() => send({ action: "quit" })}
                  >
                    确认尚未提交，结束本次填写
                  </button>
                </div>
              </>
            )}
          </section>
        )}
        {row && (
          <section>
            <h3>申请记录</h3>
            {!row.job.url && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void command(
                    { method: "channel", jobId: row.job.id, url: channelURL },
                    "投递入口已保存",
                  );
                }}
              >
                <label>
                  补充官网投递入口
                  <input
                    type="url"
                    required
                    value={channelURL}
                    onChange={(e) => setChannelURL(e.target.value)}
                  />
                </label>
                <button disabled={pending || snapshot.busy || snapshot.lock}>
                  保存官网入口
                </button>
              </form>
            )}

            <dl className="detail-list">
              <dt>招聘阶段</dt>
              <dd>{label(row.application?.stage)}</dd>
              <dt>提交证据</dt>
              <dd>
                {row.application?.evidence === "manual-confirmation"
                  ? "本人核查记录（非官网回执验证）"
                  : row.application?.evidence || "尚无官网回执"}
              </dd>
              <dt>查询</dt>
              <dd>
                {label(row.application?.queryStatus)} · 已重试{" "}
                {row.application?.queryRetries || 0} 次
              </dd>
              <dt>飞书</dt>
              <dd>
                {label(row.application?.syncStatus)} · 已重试{" "}
                {row.application?.syncRetries || 0} 次
              </dd>
            </dl>
            {row.application?.queryError && (
              <p className="callout warning">
                查询故障：{row.application.queryError}
              </p>
            )}
            {row.application?.syncError && (
              <p className="callout error">
                同步故障：{row.application.syncError}
                。本地已记录；飞书远端可能尚未更新。
              </p>
            )}
            <div className="actions">
              <button
                disabled={pending || !row.permissions.open}
                onClick={() => start("open", row.job.id)}
              >
                打开官网
              </button>
              <button
                disabled={pending || !row.permissions.login}
                onClick={() => start("login", row.job.id)}
              >
                官网登录 / 验证
              </button>
              <button
                disabled={pending || !row.permissions.track}
                onClick={() => start("track", row.job.id)}
              >
                查询此申请
              </button>
              {row.application && (
                <>
                  <button
                    disabled={snapshot.busy || snapshot.lock || pending}
                    onClick={() =>
                      command({
                        method: "application",
                        jobId: row.job.id,
                        action: row.application?.paused
                          ? "resumeTracking"
                          : "pauseTracking",
                      })
                    }
                  >
                    {row.application.paused ? "恢复跟踪" : "暂停跟踪"}
                  </button>
                  <button
                    disabled={snapshot.busy || snapshot.lock || pending}
                    onClick={() => start("retrySync", row.job.id)}
                  >
                    重试飞书同步
                  </button>
                  {["RETRY_EXHAUSTED", "STOPPED"].includes(
                    row.application.queryStatus,
                  ) && (
                    <button
                      disabled={snapshot.busy || snapshot.lock || pending}
                      onClick={() => start("retryTrack", row.job.id)}
                    >
                      重试查询
                    </button>
                  )}
                </>
              )}
            </div>
            {row.application?.state === "UNKNOWN_RESULT" && (
              <div className="callout warning">
                <strong>先核查官网，避免重复申请</strong>
                <p>
                  系统不会对未知提交结果提供盲目重试。核查后可单独记录本人的确认。
                </p>
                <button
                  disabled={snapshot.busy || snapshot.lock}
                  onClick={() => setResolveOpen(!resolveOpen)}
                >
                  记录核查结果
                </button>
                {resolveOpen && (
                  <div className="actions">
                    <button
                      onClick={() =>
                        command({
                          method: "application",
                          jobId: row.job.id,
                          action: "submitted",
                          confirmed: true,
                        })
                      }
                    >
                      本人确认已提交
                    </button>
                    <button
                      onClick={() =>
                        command({
                          method: "application",
                          jobId: row.job.id,
                          action: "notSubmitted",
                          confirmed: true,
                        })
                      }
                    >
                      本人确认尚未提交
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>
        )}
        <section>
          <h3>事件时间线</h3>
          <ol className="timeline">
            {snapshot.events
              .filter((e) => e.runId === run?.runId)
              .slice(-30)
              .reverse()
              .map((e) => (
                <li key={e.id}>
                  <span>{eventLabel(e.kind)}</span>
                  <small>{date(e.at)}</small>
                  <p>{e.step}</p>
                </li>
              ))}
          </ol>
          {!run &&
            history.map((e) => (
              <div className="history" key={e.id}>
                {eventLabel(e.kind)}
                <small>{date(e.at)}</small>
              </div>
            ))}
          {!run && !history.length && <p className="hint">还没有任务事件。</p>}
        </section>
      </div>
    </aside>
  );
}
function eventLabel(kind: string) {
  return (
    (
      {
        TASK_STARTED: "任务开始",
        STEP_CHANGED: "步骤变化",
        WAITING_LOGIN: "等待登录",
        WAITING_INPUT: "等待补充",
        WAITING_REVIEW: "等待审核",
        PAUSE_REQUESTED: "已请求暂停",
        PAUSED: "暂停完成",
        RESUMED: "已恢复",
        CANCEL_REQUESTED: "已请求停止",
        INPUT_ACCEPTED: "答案已接受（不记录资料值）",
        REQUEST_CLOSED: "交互已结束",
        TASK_FAILED: "任务停止或失败",
        TASK_ENDED: "任务结束",
        SYNC_RESULT: "同步结果已记录",
        LOGIN_REQUIRED: "等待官网登录",
        LOGIN_VERIFIED: "官网登录验证通过",
        FORM_PAUSED: "表单等待审核",
        USER_REPORTED_SUBMIT: "本人自述已提交",
        SUBMIT_RECEIPT_CONFIRMED: "官网回执确认",
        SUBMIT_RESULT_UNKNOWN: "尚未验证官网回执",
        SYNC_FAILED: "飞书同步失败",
        SYNC_OK: "飞书已确认写入",
      } as Record<string, string>
    )[kind] || kind
  );
}
function IssueForm({
  issue,
  index,
  paths,
  recordLabels,
  disabled,
  send,
}: {
  issue: NonNullable<Question["issues"]>[number];
  index: number;
  paths: string[];
  recordLabels: Record<string, string>;
  disabled: boolean;
  send: (a: Answer) => Promise<unknown>;
}) {
  const [path, setPath] = useState(issue.path || ""),
    [value, setValue] = useState<Value>(
      issue.type === "checkbox"
        ? false
        : issue.type === "select-multiple"
          ? []
          : "",
    ),
    [scope, setScope] = useState<"application" | "general">("application"),
    [record, setRecord] = useState(issue.records?.[0] || "");
  return (
    <div className="issue">
      <div className="section-title">
        <strong>
          {issue.section} · {issue.label}
        </strong>
        <small>
          {issue.required === true
            ? "必填"
            : issue.required === "unknown"
              ? "必填状态未知"
              : "选填"}
        </small>
      </div>
      <p className="hint">
        {issue.reason} · {issue.type}
      </p>
      {issue.canAnswer && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send({ action: "answer", issue: index, path, value, scope });
          }}
        >
          <label>
            资料字段
            <input
              disabled={disabled}
              aria-label={`${issue.label}资料路径`}
              required
              value={path}
              onChange={(e) => setPath(e.target.value)}
              list={`paths-${index}`}
              placeholder="例如 basic.name"
            />
          </label>
          <datalist id={`paths-${index}`}>
            {paths.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
          <label>
            {issue.label}
            {issue.options.length > 0 && issue.type !== "checkbox" ? (
              <select
                disabled={disabled}
                aria-label={issue.label}
                multiple={issue.type === "select-multiple"}
                value={value as string | string[]}
                onChange={(e) =>
                  setValue(
                    issue.type === "select-multiple"
                      ? Array.from(e.target.selectedOptions).map((o) => o.value)
                      : e.target.value,
                  )
                }
              >
                {issue.type !== "select-multiple" && (
                  <option value="">请选择</option>
                )}
                {issue.options.map((o, n) => (
                  <option key={n} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : issue.type === "checkbox" ? (
              <select
                disabled={disabled}
                aria-label={issue.label}
                value={String(value)}
                onChange={(e) => setValue(e.target.value === "true")}
              >
                <option value="false">否</option>
                <option value="true">是</option>
              </select>
            ) : (
              <input
                disabled={disabled}
                aria-label={issue.label}
                type={
                  ["date", "month", "email", "number", "tel"].includes(
                    issue.type,
                  )
                    ? issue.type
                    : "text"
                }
                value={String(value)}
                onChange={(e) =>
                  setValue(
                    issue.type === "number" && e.target.value !== ""
                      ? Number(e.target.value)
                      : e.target.value,
                  )
                }
                required={issue.required === true}
              />
            )}
          </label>
          <label>
            答案用途
            <select
              disabled={disabled}
              value={scope}
              onChange={(e) => setScope(e.target.value as typeof scope)}
            >
              <option value="application">仅本次申请使用</option>
              <option value="general">保存到本次所选简历</option>
            </select>
          </label>
          <button className="primary" disabled={disabled || !path}>
            确认答案并继续
          </button>
        </form>
      )}
      {issue.records && (
        <div>
          <label>
            将网页经历绑定到
            <select
              disabled={disabled}
              value={record}
              onChange={(e) => setRecord(e.target.value)}
            >
              {issue.records.map((r) => (
                <option key={r} value={r}>
                  {recordLabels[`${issue.recordKind}.${r}`] || r}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={disabled || !record}
            onClick={() => send({ action: "bind", issue: index, record })}
          >
            确认绑定
          </button>
        </div>
      )}
      {!issue.canAnswer && !issue.records && (
        <p className="hint">请前往受控浏览器处理，再重新观察。</p>
      )}
    </div>
  );
}
