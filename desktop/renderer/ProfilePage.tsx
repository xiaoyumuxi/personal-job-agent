import { useState, useEffect, useRef } from "react";
import { api, date, Badge, type Perform } from "./shared.js";
import type { ProfileView } from "../contract.js";
import type { Fact, Value, RecordKind } from "../../src/types.js";

type Draft = { value: string; type: "text" | "number" | "boolean" | "array" };
function draftFor(value?: Value): Draft {
  return {
    value: Array.isArray(value)
      ? value.join("\n")
      : value === undefined
        ? ""
        : String(value),
    type: Array.isArray(value)
      ? "array"
      : typeof value === "number"
        ? "number"
        : typeof value === "boolean"
          ? "boolean"
          : "text",
  };
}
function parseDraft(draft: Draft): Value {
  if (draft.type === "number") {
    if (!draft.value.trim() || !Number.isFinite(Number(draft.value)))
      throw new Error("请输入有效数字");
    return Number(draft.value);
  }
  if (draft.type === "boolean") {
    if (!["true", "false"].includes(draft.value))
      throw new Error("请选择是或否");
    return draft.value === "true";
  }
  if (draft.type === "array")
    return draft.value
      .split("\n")
      .map((v) => v.trim())
      .filter(Boolean);
  if (!draft.value.trim()) throw new Error("请填写本人确认的内容");
  return draft.value;
}
function groupId(field: ProfileView["fields"][number]) {
  if (field.label === field.path) return "advanced";
  const record = /^(education|experience|project)\.([^.]+)\./.exec(field.path);
  return record ? `${record[1]}.${record[2]}` : field.section;
}

export function ProfilePage({
  busy,
  active,
  perform,
  importProfile,
  onDraftCounts,
}: {
  busy: boolean;
  active: boolean;
  perform: Perform;
  importProfile: () => Promise<unknown>;
  onDraftCounts: (counts: Record<string, number>) => void;
}) {
  const [view, setView] = useState<ProfileView>();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [group, setGroup] = useState("");
  const [focused, setFocused] = useState("");
  const [versionNames, setVersionNames] = useState<Record<string, string>>({});
  const [importing, setImporting] = useState(false);
  const [kind, setKind] = useState<RecordKind>("education");
  const [customPath, setCustomPath] = useState(""),
    [customValue, setCustomValue] = useState("");
  const loadId = useRef(0);
  const load = async () => {
    const id = ++loadId.current;
    const v = (await api.invoke({ method: "profile" })) as ProfileView;
    if (id === loadId.current) setView(v);
  };
  useEffect(() => {
    if (active) void perform(load);
    return () => {
      loadId.current++;
    };
  }, [active]);
  useEffect(() => {
    const counts: Record<string, number> = {};
    for (const key of Object.keys(drafts)) {
      const id = key.split(":")[0]!;
      counts[id] = (counts[id] || 0) + 1;
    }
    onDraftCounts(counts);
  }, [drafts, onDraftCounts]);
  const versionName = view
    ? (versionNames[view.selected.id] ?? view.selected.name)
    : "";
  const fields = view
    ? [...new Map(view.fields.map((f) => [f.path, f])).values()]
    : [];
  const groups = [
    ...new Map(
      fields.map((f) => [
        groupId(f),
        groupId(f) === "advanced" ? "高级资料" : f.section,
      ]),
    ).entries(),
  ];
  const current = groups.some(([id]) => id === group) ? group : groups[0]?.[0];
  const visible = fields.filter((f) => groupId(f) === current);
  const sourceField =
    visible.find((f) => f.path === focused) ||
    visible.find((f) => view?.profile.facts[f.path]?.state === "conflict") ||
    visible[0];
  const sourceFact = sourceField && view?.profile.facts[sourceField.path];
  const keyFor = (path: string) => `${view!.selected.id}:${path}`;
  const confirmed = fields.filter(
    (f) =>
      view?.profile.facts[f.path]?.state === "confirmed" &&
      !drafts[keyFor(f.path)],
  ).length;
  const pendingDrafts = view
    ? Object.keys(drafts).filter((key) =>
        key.startsWith(`${view.selected.id}:`),
      ).length
    : 0;
  const edit = (path: string, draft: Draft) => {
    setDrafts((d) => ({ ...d, [keyFor(path)]: draft }));
    setErrors((e) => ({ ...e, [keyFor(path)]: "" }));
  };
  const discard = (path: string) => {
    const key = keyFor(path);
    setDrafts((d) => {
      const next = { ...d };
      delete next[key];
      return next;
    });
    setErrors((e) => ({ ...e, [key]: "" }));
  };
  const save = async (path: string, fact?: Fact) => {
    const key = keyFor(path),
      draft = drafts[key] || draftFor(fact?.value);
    setErrors((e) => ({ ...e, [key]: "" }));
    await perform(async () => {
      try {
        const v = (await api.invoke({
          method: "saveFact",
          profileId: view!.selected.id,
          path,
          value: parseDraft(draft),
        })) as ProfileView;
        // saveFact returns the backend's read-back view. Only this field's draft
        // is cleared; a failed field never inherits another field's success.
        setView(v);
        setDrafts((d) => {
          const next = { ...d };
          delete next[key];
          return next;
        });
      } catch (e) {
        setErrors((errors) => ({ ...errors, [key]: (e as Error).message }));
        throw e;
      }
    }, "本字段已保存到 Keychain，并回读验证");
  };
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">本人确认的资料</div>
          <h1>简历与资料</h1>
          <p>选择一个版本，核对原文，再确认可用于填写的资料。</p>
        </div>
        <button
          className="primary"
          disabled={busy || importing}
          onClick={async () => {
            setImporting(true);
            try {
              await importProfile();
              await load();
            } catch (e) {
              await perform(() => Promise.reject(e));
            } finally {
              setImporting(false);
            }
          }}
        >
          {importing ? "正在导入，请稍候…" : "导入简历 / 资料"}
        </button>
      </header>
      {view ? (
        <>
          <div className="profile-progress">
            <div>
              <strong>
                {confirmed} / {fields.length} 项已确认
              </strong>
              <p className="hint">
                统计当前版本全部列出的资料字段（含高级资料）。未确认或已修改的草稿不计入。
              </p>
            </div>
            <progress
              value={confirmed}
              max={fields.length || 1}
              aria-label="资料确认进度"
            />
          </div>
          {pendingDrafts > 0 && (
            <p className="callout warning">
              当前版本有 {pendingDrafts}{" "}
              项待确认草稿。切换分组、版本或页面会保留草稿；仅确认并保存的资料可用于填写。
            </p>
          )}
          <div className="profile-layout">
            <aside className="profile-rail" aria-label="版本与资料分组">
              <section className="panel" aria-label="简历版本管理">
                <h2>简历版本（{view.versions.length}）</h2>
                <label>
                  当前编辑 / 默认简历
                  <select
                    aria-label="当前简历版本"
                    value={view.selected.id}
                    disabled={busy || importing}
                    onChange={(e) => {
                      const profileId = e.target.value;
                      void perform(async () => {
                        await api.invoke({
                          method: "switchProfile",
                          profileId,
                        });
                        await load();
                        setGroup("");
                        setFocused("");
                      }, "已切换简历版本，并重新读取资料");
                    }}
                  >
                    {view.versions.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                </label>
                <details className="version-details">
                  <summary>版本名称与附件</summary>
                  <input
                    aria-label="简历版本名称"
                    value={versionName}
                    maxLength={120}
                    disabled={busy}
                    onChange={(e) =>
                      setVersionNames((names) => ({
                        ...names,
                        [view.selected.id]: e.target.value,
                      }))
                    }
                  />
                  <button
                    disabled={busy || importing || !versionName.trim()}
                    onClick={() =>
                      perform(async () => {
                        await api.invoke({
                          method: "renameProfile",
                          profileId: view.selected.id,
                          name: versionName,
                        });
                        setVersionNames((names) => {
                          const next = { ...names };
                          delete next[view.selected.id];
                          return next;
                        });
                        await load();
                      }, "版本名称已保存")
                    }
                  >
                    保存版本名称
                  </button>
                  <p className="hint">
                    {view.profile.resume
                      ? view.selected.file || "原有 PDF 附件"
                      : "未导入 PDF 附件"}
                  </p>
                  <p className="hint">
                    修订 {view.selected.revision} · {date(view.version?.at)}
                  </p>
                </details>
                {view.version?.extraction?.format === "pdf" && (
                  <p className="hint">
                    {view.version.extraction.ocrPages
                      ? `本机 OCR · ${view.version.extraction.ocrPages} 页`
                      : "PDF 文字提取"}
                  </p>
                )}
              </section>
              <nav className="section-nav" aria-label="资料分组">
                {groups.map(([id, text]) => {
                  const list = fields.filter((f) => groupId(f) === id);
                  const count = list.filter(
                    (f) =>
                      view.profile.facts[f.path]?.state === "confirmed" &&
                      !drafts[keyFor(f.path)],
                  ).length;
                  return (
                    <button
                      key={id}
                      aria-pressed={current === id}
                      className={current === id ? "selected" : ""}
                      onClick={() => {
                        setGroup(id);
                        setFocused("");
                      }}
                    >
                      <span>{text}</span>
                      <small>
                        {count}/{list.length}
                      </small>
                    </button>
                  );
                })}
              </nav>
              <section className="panel add-record">
                <h3>添加经历</h3>
                <select
                  aria-label="经历类别"
                  value={kind}
                  disabled={busy}
                  onChange={(e) => setKind(e.target.value as RecordKind)}
                >
                  <option value="education">教育经历</option>
                  <option value="experience">工作 / 实习经历</option>
                  <option value="project">项目经历</option>
                </select>
                <button
                  disabled={busy}
                  onClick={() =>
                    perform(async () => {
                      const id = crypto.randomUUID();
                      const v = (await api.invoke({
                        method: "record",
                        profileId: view.selected.id,
                        kind,
                        id,
                      })) as ProfileView;
                      setView(v);
                      setGroup(`${kind}.${id}`);
                      setFocused("");
                    })
                  }
                >
                  添加经历
                </button>
              </section>
              <p className="hint">
                编辑只影响当前版本。已启动的任务继续使用绑定的资料版本与修订。
              </p>
            </aside>
            <section className="panel profile-editor" aria-label="当前分组资料">
              <div className="section-title">
                <h2>
                  {groups.find(([id]) => id === current)?.[1] || "基本资料"}
                </h2>
                <span className="hint">逐项确认并保存</span>
              </div>
              {!view.selected.file && (
                <p className="hint">
                  可先填写基础资料，也可导入 PDF、TXT/MD、JSON。扫描版 PDF
                  使用本机 OCR。
                </p>
              )}
              <div className="profile-grid">
                {visible.map((f) => (
                  <FactEditor
                    key={keyFor(f.path)}
                    path={f.path}
                    text={f.label}
                    fact={view.profile.facts[f.path]}
                    draft={drafts[keyFor(f.path)]}
                    error={errors[keyFor(f.path)]}
                    disabled={busy || importing}
                    focus={() => setFocused(f.path)}
                    change={(d) => edit(f.path, d)}
                    discard={() => discard(f.path)}
                    save={() => save(f.path, view.profile.facts[f.path])}
                  />
                ))}
              </div>
              <details className="advanced-fields">
                <summary>高级：自定义资料字段与记录标识</summary>
                <p className="hint">
                  已有记录标识由程序生成：
                  {[
                    ...view.profile.records.education,
                    ...view.profile.records.experience,
                    ...view.profile.records.project,
                  ].join("、") || "尚无经历"}
                </p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void perform(async () => {
                      const v = (await api.invoke({
                        method: "saveFact",
                        profileId: view.selected.id,
                        path: customPath,
                        value: customValue,
                      })) as ProfileView;
                      setView(v);
                      setCustomPath("");
                      setCustomValue("");
                    }, "资料已保存并重新读取");
                  }}
                >
                  <label>
                    新资料路径
                    <input
                      aria-label="新资料路径"
                      placeholder="例如 preference.location"
                      value={customPath}
                      onChange={(e) => setCustomPath(e.target.value)}
                      required
                    />
                  </label>
                  <label>
                    本人确认的值
                    <input
                      aria-label="新资料值"
                      value={customValue}
                      onChange={(e) => setCustomValue(e.target.value)}
                      required
                    />
                  </label>
                  <button disabled={busy || !customPath || !customValue}>
                    确认添加
                  </button>
                </form>
              </details>
            </section>
            <aside className="panel source-panel" aria-label="识别依据对照">
              <div className="eyebrow">对照原文再确认</div>
              <h2>{sourceField?.label || "识别依据"}</h2>
              {sourceFact?.source ? (
                <blockquote>{sourceFact.source.text}</blockquote>
              ) : (
                <p className="hint">该字段暂无识别原文，请对照本人简历核查。</p>
              )}
              {sourceFact?.candidates?.length ? (
                <div className="candidates">
                  <h3>识别候选</h3>
                  {sourceFact.candidates.map((v, i) => (
                    <button
                      key={i}
                      disabled={busy}
                      onClick={() => edit(sourceField!.path, draftFor(v))}
                    >
                      {Array.isArray(v) ? v.join("、") : String(v)}
                    </button>
                  ))}
                </div>
              ) : null}
              <p className="hint">
                采用候选只更新草稿。请核对内容，再点击对应字段的“确认并保存”。
              </p>
            </aside>
          </div>
        </>
      ) : (
        <div className="empty">正在读取简历资料…</div>
      )}
    </>
  );
}

function FactEditor({
  path,
  text,
  fact,
  draft,
  error,
  disabled,
  focus,
  change,
  save,
  discard,
}: {
  path: string;
  text: string;
  fact?: Fact;
  draft?: Draft;
  error?: string;
  disabled: boolean;
  focus: () => void;
  change: (d: Draft) => void;
  save: () => Promise<unknown>;
  discard: () => void;
}) {
  const d = draft || draftFor(fact?.value);
  const multiline =
    /(?:description|responsibilities)$/.test(path) || d.type === "array";
  const inputType =
    d.type === "number"
      ? "number"
      : /email$/.test(path)
        ? "email"
        : /phone$/.test(path)
          ? "tel"
          : /Date$/.test(path) && /^\d{4}-\d{2}-\d{2}$/.test(d.value)
            ? "date"
            : /Date$/.test(path) && /^\d{4}-\d{2}$/.test(d.value)
              ? "month"
              : "text";
  return (
    <form
      className={`fact${multiline ? " fact-long" : ""}`}
      onFocus={focus}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="section-title">
        <label htmlFor={path}>{text}</label>
        <Badge
          value={draft ? "pending" : fact?.state || "missing"}
          text={draft ? "已修改 · 待确认" : undefined}
        />
      </div>
      {d.type === "boolean" ? (
        <select
          id={path}
          disabled={disabled}
          value={d.value}
          onChange={(e) => change({ ...d, value: e.target.value })}
        >
          <option value="">请选择</option>
          <option value="true">是</option>
          <option value="false">否</option>
        </select>
      ) : multiline ? (
        <textarea
          id={path}
          value={d.value}
          disabled={disabled}
          rows={5}
          required
          onChange={(e) => change({ ...d, value: e.target.value })}
          placeholder={d.type === "array" ? "每行填写一项" : undefined}
        />
      ) : (
        <input
          id={path}
          type={inputType}
          value={d.value}
          disabled={disabled}
          required
          onChange={(e) => change({ ...d, value: e.target.value })}
        />
      )}
      {fact?.state === "conflict" && (
        <p className="hint">存在不同识别结果，请在依据面板中对照候选。</p>
      )}
      <div className="field-actions">
        {draft && (
          <button
            className="text-button"
            type="button"
            disabled={disabled}
            onClick={discard}
          >
            放弃本次修改
          </button>
        )}
        <button disabled={disabled || !d.value}>确认并保存</button>
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <details className="field-advanced">
        <summary>高级字段信息</summary>
        <code>{path}</code>
        <label>
          值类型
          <select
            aria-label={`${text}值类型`}
            value={d.type}
            disabled={disabled}
            onChange={(e) =>
              change({ ...d, type: e.target.value as Draft["type"] })
            }
          >
            <option value="text">文本</option>
            <option value="number">数字</option>
            <option value="boolean">是 / 否</option>
            <option value="array">多项文本（每行一项）</option>
          </select>
        </label>
      </details>
    </form>
  );
}
