import { useEffect, useState } from "react";
import type { Snapshot } from "../contract.js";
import type { ProfileVersion } from "../../src/profile-library.js";
import {
  sources,
  gradeLabels,
  type DiscoveryBatch,
  type DiscoveryPreview,
  type Preferences,
  type Recommendation,
} from "../../src/discovery/types.js";
import { api, Badge, date, type Perform, type Send } from "./shared.js";

export function DiscoveryPage({
  active,
  snapshot,
  busy,
  pending,
  perform,
  command,
  drafts,
  close,
  openJob,
  settings,
}: {
  active: boolean;
  snapshot: Snapshot;
  busy: boolean;
  pending: boolean;
  perform: Perform;
  command: Send;
  drafts: Record<string, number>;
  close: () => void;
  openJob: (id: string) => void;
  settings: () => void;
}) {
  const [versions, setVersions] = useState<ProfileVersion[]>([]),
    [profileId, setProfileId] = useState("");
  const [preferences, setPreferences] = useState<Preferences>({
    sources: ["bytedance"],
    keyword: "",
    cities: [],
    kind: "any",
    maxJobs: 5,
    mode: "local",
  });
  const [cities, setCities] = useState("");
  const [preview, setPreview] = useState<DiscoveryPreview>(),
    [consent, setConsent] = useState(false);
  const [batch, setBatch] = useState<DiscoveryBatch | null>(null),
    [selected, setSelected] = useState("");
  const [filter, setFilter] = useState("all"),
    [loadError, setLoadError] = useState("");
  const run = snapshot.run?.operation === "discover" ? snapshot.run : undefined;
  const running = !!run && snapshot.busy;
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void Promise.all([
        api.invoke({ method: "profileVersions" }),
        api.invoke({ method: "discoveryView" }),
      ])
        .then(([choices, result]) => {
          if (cancelled) return;
          const v = choices as { activeId: string; versions: ProfileVersion[] };
          setVersions(v.versions);
          setProfileId((id) => id || v.activeId);
          setBatch(result as DiscoveryBatch | null);
          setLoadError("");
        })
        .catch(() => {
          if (!cancelled)
            setLoadError(
              "岗位结果或简历版本未能读取，请检查 Keychain 后重试。",
            );
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, snapshot.run?.at, snapshot.busy]);
  const change = (value: Partial<Preferences>) => {
    setPreferences((p) => ({ ...p, ...value }));
    setPreview(undefined);
    setConsent(false);
  };
  const order = { recommended: 0, consider: 1, insufficient: 2, unsuitable: 3 };
  const items = (batch?.results || [])
    .filter(
      (r) =>
        filter === "all" ||
        (filter === "skipped"
          ? r.decision === "skip"
          : r.grade === filter && r.decision !== "skip"),
    )
    .sort(
      (a, b) =>
        Number(a.decision === "skip") - Number(b.decision === "skip") ||
        order[a.grade] - order[b.grade],
    );
  const item = items.find((r) => r.id === selected) || items[0];
  const version = versions.find((v) => v.id === profileId);
  const load = async () => {
    const result = await perform(() => api.invoke({ method: "discoveryView" }));
    if (result !== undefined) setBatch(result as DiscoveryBatch | null);
  };
  const decide = async (result: Recommendation, decision: "keep" | "skip") => {
    const value = await command(
      {
        method: "discoveryDecision",
        batchId: batch!.id,
        id: result.id,
        decision,
      },
      decision === "keep"
        ? "已加入工作台，可继续选择简历并辅助填写"
        : "已暂时跳过，可在筛选中重新查看",
    );
    if (value) await load();
  };
  return (
    <section aria-label="官网找岗位">
      <button className="back-link" onClick={close}>
        ← 返回投递工作台
      </button>
      <header className="page-head">
        <div>
          <div className="eyebrow">发现 → 判断 → 选择</div>
          <h1>先找到值得投的岗位</h1>
          <p>从官网读取完整 JD，对照你的资料，再决定哪些加入工作台。</p>
        </div>
        <button onClick={load} disabled={pending}>
          刷新结果
        </button>
      </header>
      {loadError && (
        <p className="callout warning" role="alert">
          {loadError}
        </p>
      )}
      <div className="discovery-setup">
        <form
          className="discovery-form card"
          onSubmit={async (e) => {
            e.preventDefault();
            const value = await perform(() =>
              api.invoke({
                method: "discoveryPreview",
                profileId,
                preferences: {
                  ...preferences,
                  cities: cities
                    .split(/[,，、\n]/)
                    .map((s) => s.trim())
                    .filter(Boolean),
                },
              }),
            );
            if (value) {
              setPreview(value as DiscoveryPreview);
              setConsent(false);
            }
          }}
        >
          <h2>这次想找什么</h2>
          <fieldset disabled={busy}>
            <legend>招聘官网</legend>
            {Object.entries(sources).map(([id, source]) => (
              <label className="check-line" key={id}>
                <input
                  type="checkbox"
                  checked={preferences.sources.includes(
                    id as keyof typeof sources,
                  )}
                  onChange={(e) =>
                    change({
                      sources: e.target.checked
                        ? [...preferences.sources, id as keyof typeof sources]
                        : preferences.sources.filter((s) => s !== id),
                    })
                  }
                />
                {source.name}
              </label>
            ))}
          </fieldset>
          <div className="discovery-fields">
            <label>
              岗位关键词
              <input
                required
                maxLength={60}
                value={preferences.keyword}
                disabled={busy}
                placeholder="例如：后端、Agent、数据开发"
                onChange={(e) => change({ keyword: e.target.value })}
              />
            </label>
            <label>
              意向城市
              <input
                value={cities}
                maxLength={300}
                disabled={busy}
                placeholder="如：深圳，上海；留空不限"
                onChange={(e) => {
                  setCities(e.target.value);
                  setPreview(undefined);
                  setConsent(false);
                }}
              />
            </label>
            <label>
              招聘类型
              <select
                aria-label="招聘类型"
                value={preferences.kind}
                disabled={busy}
                onChange={(e) =>
                  change({ kind: e.target.value as Preferences["kind"] })
                }
              >
                <option value="any">不限</option>
                <option value="campus">校招</option>
                <option value="intern">实习</option>
                <option value="experienced">社招</option>
              </select>
            </label>
            <label>
              毕业届别（可选）
              <input
                type="number"
                min={2000}
                max={2100}
                value={preferences.graduationYear ?? ""}
                disabled={busy}
                placeholder="例如 2027"
                onChange={(e) =>
                  change({
                    graduationYear: e.target.value
                      ? Number(e.target.value)
                      : undefined,
                  })
                }
              />
            </label>
            <label>
              相关经验年数（可选）
              <input
                type="number"
                min={0}
                max={60}
                step={0.5}
                value={preferences.experienceYears ?? ""}
                disabled={busy}
                onChange={(e) =>
                  change({
                    experienceYears: e.target.value
                      ? Number(e.target.value)
                      : undefined,
                  })
                }
              />
            </label>
            <label>
              每站读取上限
              <select
                aria-label="每站读取上限"
                value={preferences.maxJobs}
                disabled={busy}
                onChange={(e) => change({ maxJobs: Number(e.target.value) })}
              >
                {[3, 5, 10].map((n) => (
                  <option key={n} value={n}>
                    {n} 个完整 JD
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            用于判断的简历
            <select
              aria-label="用于判断的简历"
              value={profileId}
              disabled={busy}
              onChange={(e) => {
                setProfileId(e.target.value);
                setPreview(undefined);
                setConsent(false);
              }}
            >
              {!version && <option value="">请选择版本</option>}
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} · 修订 {v.revision}
                </option>
              ))}
            </select>
          </label>
          {!!drafts[profileId] && (
            <p className="callout warning">
              此版本有未确认草稿，请先回资料页确认或放弃修改。
            </p>
          )}
          <label>
            判断方式
            <select
              aria-label="判断方式"
              value={preferences.mode}
              disabled={busy}
              onChange={(e) =>
                change({ mode: e.target.value as Preferences["mode"] })
              }
            >
              <option value="local">先按本地条件筛选</option>
              <option value="ai">AI 对照 JD 与已确认资料</option>
            </select>
          </label>
          <p className="hint">
            每站读取搜索首页前 N 条，最多 20 个
            JD；不是全网岗位覆盖。再次采集会替换上次结果，已加入工作台的岗位保留。
          </p>
          <div className="actions">
            <button
              className="primary"
              type="submit"
              disabled={
                busy ||
                !version ||
                !preferences.sources.length ||
                !!drafts[profileId]
              }
            >
              预览并准备启动
            </button>
            <button type="button" onClick={settings}>
              模型设置
            </button>
          </div>
        </form>
        <div className="discovery-preview card" aria-live="polite">
          {preview ? (
            <>
              <div className="eyebrow">启动前确认</div>
              <h2>
                {preview.model
                  ? "确认这次交给 AI 的资料"
                  : "确认本次官网读取范围"}
              </h2>
              <p>
                {preview.profile.name} · 修订 {preview.profile.revision} ·
                每站最多 {preview.preferences.maxJobs} 个 JD
              </p>
              <p>
                {preview.preferences.sources
                  .map((s) => sources[s].name)
                  .join("、")}{" "}
                · 关键词：{preview.preferences.keyword}
              </p>
              {preview.model ? (
                <>
                  <p className="callout">
                    模型：{preview.model.name}
                    <br />
                    <span className="break-all">{preview.model.endpoint}</span>
                  </p>
                  <p>
                    只发送下面列出的已确认资料、筛选条件与公开
                    JD。姓名、电话、邮箱、附件和识别来源不在字段范围内；请核对经历文字中是否仍有你不想发送的内容。
                  </p>
                  <div className="discovery-facts">
                    {preview.facts.map((f) => (
                      <div key={f.id}>
                        <strong>{f.label}</strong>
                        <p>{f.value}</p>
                      </div>
                    ))}
                  </div>
                  <p className="hint">
                    已排除 {preview.omitted}{" "}
                    项未确认或不在范围内的字段；长资料按预览截取。需要调整时，先返回资料页编辑确认，再重新预览。
                  </p>
                  <label className="check-line">
                    <input
                      type="checkbox"
                      checked={consent}
                      disabled={busy}
                      onChange={(e) => setConsent(e.target.checked)}
                    />
                    我已核对以上内容，同意本次发送到这个模型服务
                  </label>
                </>
              ) : (
                <p className="callout">
                  本次不调用模型。会读取官网完整
                  JD，并检查城市、类型、届别和明确的经验条件；技能与经历匹配留待你判断。
                </p>
              )}
              <div className="actions">
                <button
                  className="primary"
                  disabled={
                    busy ||
                    !!drafts[preview.profile.id] ||
                    (!!preview.model && !consent)
                  }
                  onClick={async () => {
                    const result = await command({
                      method: "start",
                      operation: "discover",
                      previewId: preview.id,
                      cloudConsent: consent,
                    });
                    if (result) {
                      setPreview(undefined);
                      setConsent(false);
                      setSelected("");
                    }
                  }}
                >
                  开始读取与筛选
                </button>
                <button disabled={busy} onClick={() => setPreview(undefined)}>
                  返回修改
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="eyebrow">读原文，再作判断</div>
              <h2>让每条建议都有出处</h2>
              <ol className="discovery-steps">
                <li>
                  <strong>官网读取</strong>
                  <p>保留岗位来源、读取时间、职责与要求。</p>
                </li>
                <li>
                  <strong>对照资料</strong>
                  <p>确定条件先筛选，AI 解释匹配点、差距和待确认问题。</p>
                </li>
                <li>
                  <strong>由你选择</strong>
                  <p>查看依据后加入工作台，继续原有审核与提交流程。</p>
                </li>
              </ol>
            </>
          )}
          {run && (
            <div className="discovery-progress">
              <Badge value={run.state} />
              <p role="status">{run.step}</p>
              {run.error && <p className="callout warning">{run.error}</p>}
              {running && (
                <div className="actions">
                  {run.state === "RUNNING" && (
                    <button
                      disabled={pending}
                      onClick={() =>
                        command({
                          method: "control",
                          runId: run.runId,
                          action: "pause",
                        })
                      }
                    >
                      暂停
                    </button>
                  )}
                  {run.state === "PAUSED" && (
                    <button
                      disabled={pending}
                      onClick={() =>
                        command({
                          method: "control",
                          runId: run.runId,
                          action: "resume",
                        })
                      }
                    >
                      继续
                    </button>
                  )}
                  <button
                    disabled={pending || run.state === "CANCELLING"}
                    onClick={() =>
                      command({
                        method: "control",
                        runId: run.runId,
                        action: "cancel",
                      })
                    }
                  >
                    停止，保留结果
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {batch && (
        <section className="discovery-results" aria-label="岗位筛选结果">
          <div className="section-title">
            <div>
              <h2>已读取 {batch.results.length} 个岗位</h2>
              <p className="hint">
                {batch.profile.name} · 修订 {batch.profile.revision} ·{" "}
                {date(batch.at)} ·{" "}
                {
                  {
                    running: "读取中",
                    completed: "本次读取完成",
                    partial: "部分完成",
                    failed: "未完成",
                    cancelled: "已停止",
                    interrupted: "上次采集中断",
                  }[batch.status]
                }
              </p>
            </div>
            <label>
              显示结果
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="all">全部岗位</option>
                {Object.entries(gradeLabels).map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
                <option value="skipped">已跳过</option>
              </select>
            </label>
          </div>
          {batch.stale && (
            <p className="callout warning">
              资料或模型配置已经变化，下面是上一次条件下的结果。请重新采集与判断。
            </p>
          )}
          {!!batch.issues.length && (
            <details className="callout warning">
              <summary>有 {new Set(batch.issues).size} 类问题需要核查</summary>
              {[...new Set(batch.issues)].map((s) => (
                <p key={s}>{s}</p>
              ))}
            </details>
          )}
          {!items.length ? (
            <p className="empty">
              当前筛选下没有岗位；可以更换筛选或调整关键词重新读取。
            </p>
          ) : (
            <div className="discovery-comparison">
              <div className="discovery-list">
                {items.map((r) => (
                  <button
                    key={r.id}
                    className={`discovery-job ${item?.id === r.id ? "selected" : ""}`}
                    aria-pressed={item?.id === r.id}
                    onClick={() => setSelected(r.id)}
                  >
                    <span className={`discovery-grade grade-${r.grade}`}>
                      {gradeLabels[r.grade]}
                    </span>
                    <strong>{r.job.title}</strong>
                    <span>
                      {sources[r.job.source].company} · {r.job.location}
                    </span>
                    <small>
                      {r.jobId
                        ? "已加入工作台"
                        : r.decision === "skip"
                          ? "已暂时跳过"
                          : r.analysis === "ai"
                            ? "AI 判断 · 查看原文依据"
                            : r.analysis === "failed"
                              ? "AI 未完成 · 需核查"
                              : "本地条件筛选"}
                    </small>
                  </button>
                ))}
              </div>
              {item && (
                <article
                  className="discovery-evidence card"
                  aria-label="岗位判断依据"
                >
                  <div className="eyebrow">JD × 你的资料</div>
                  <h2>{item.job.title}</h2>
                  <p>
                    {item.job.location} · {item.job.metadata}
                  </p>
                  <p className="hint">
                    读取于 {date(item.job.fetchedAt)} · 建议不代表录用概率
                  </p>
                  <div className="actions">
                    <button
                      disabled={pending}
                      onClick={() =>
                        command({
                          method: "discoveryOpen",
                          batchId: batch.id,
                          id: item.id,
                        })
                      }
                    >
                      在浏览器查看官网
                    </button>
                    {item.jobId ? (
                      <button
                        className="primary"
                        onClick={() => openJob(item.jobId!)}
                      >
                        前往工作台继续
                      </button>
                    ) : (
                      <>
                        <button
                          className="primary"
                          disabled={busy}
                          onClick={() => decide(item, "keep")}
                        >
                          加入工作台
                        </button>
                        <button
                          disabled={busy || item.decision === "skip"}
                          onClick={() => decide(item, "skip")}
                        >
                          暂时跳过
                        </button>
                      </>
                    )}
                  </div>
                  {item.rules.map((rule) => (
                    <div className="discovery-rule" key={rule.name}>
                      <strong>
                        {rule.name} ·{" "}
                        {
                          { pass: "符合", fail: "不符", unknown: "待核查" }[
                            rule.status
                          ]
                        }
                      </strong>
                      <p>{rule.reason}</p>
                      {rule.quote && <blockquote>{rule.quote}</blockquote>}
                    </div>
                  ))}
                  {item.issue && (
                    <p className="callout warning">{item.issue}</p>
                  )}
                  {item.assessment ? (
                    <>
                      <h3>AI 的判断</h3>
                      <p>{item.assessment.summary}</p>
                      {item.assessment.evidence.map((e, i) => (
                        <div className="discovery-rule" key={i}>
                          <strong>
                            {
                              {
                                match: "匹配依据",
                                gap: "可能的差距",
                                question: "需要确认",
                              }[e.kind]
                            }{" "}
                            · {e.reason}
                          </strong>
                          <blockquote>
                            <small>JD 原文</small>
                            <p>{e.jdQuote}</p>
                          </blockquote>
                          {e.factQuote && (
                            <blockquote className="profile-quote">
                              <small>已确认资料</small>
                              <p>{e.factQuote}</p>
                            </blockquote>
                          )}
                        </div>
                      ))}
                    </>
                  ) : (
                    <p className="hint">
                      {item.grade === "unsuitable"
                        ? "已发现与你填写条件明确不符的项，未调用 AI。你仍可查看原文并自行选择。"
                        : "尚未作技能与经历匹配判断，请阅读原文，或切换 AI 模式重新运行。"}
                    </p>
                  )}
                  <details className="discovery-jd">
                    <summary>查看完整 JD</summary>
                    <h3>职责</h3>
                    <p>{item.job.description}</p>
                    <h3>要求</h3>
                    <p>{item.job.requirements}</p>
                    {item.job.bonus && (
                      <>
                        <h3>加分项</h3>
                        <p>{item.job.bonus}</p>
                      </>
                    )}
                  </details>
                </article>
              )}
            </div>
          )}
        </section>
      )}
    </section>
  );
}
