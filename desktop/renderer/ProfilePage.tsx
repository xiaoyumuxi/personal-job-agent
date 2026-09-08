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
import type { ProfileView } from "../contract.js";
import type { Fact, Value, RecordKind } from "../../src/types.js";
export function ProfilePage({
  busy,
  perform,
  importProfile,
}: {
  busy: boolean;
  perform: Perform;
  importProfile: () => Promise<unknown>;
}) {
  const [view, setView] = useState<ProfileView>(),
    [customPath, setCustomPath] = useState(""),
    [customValue, setCustomValue] = useState(""),
    [kind, setKind] = useState<RecordKind>("education"),
    [recordId, setRecordId] = useState(""),
    [versionName, setVersionName] = useState(""),
    [importing, setImporting] = useState(false);
  const load = async () => {
    const v = (await api.invoke({ method: "profile" })) as ProfileView;
    setView(v);
    setVersionName(v.selected.name);
  };
  useEffect(() => {
    void perform(load);
  }, []);
  const groups = [...new Set(view?.fields.map((f) => f.section))];
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">本人确认的资料</div>
          <h1>我的资料</h1>
          <p>每份简历独立保存资料与确认状态。选择适合岗位的版本后再填写。</p>
        </div>
        <button
          className="primary"
          disabled={busy || importing}
          onClick={() =>
            perform(async () => {
              setImporting(true);
              try {
                await importProfile();
                await load();
              } finally {
                setImporting(false);
              }
            })
          }
        >
          {importing ? "正在导入，请稍候…" : "导入简历 / 资料"}
        </button>
      </header>
      {view && (
        <section className="panel" aria-label="简历版本管理">
          <h2>简历版本（{view.versions.length}）</h2>
          <div className="inline-form">
            <label>
              当前编辑 / 默认简历
              <select
                aria-label="当前简历版本"
                value={view.selected.id}
                disabled={busy || importing}
                onChange={(e) =>
                  perform(async () => {
                    await api.invoke({
                      method: "switchProfile",
                      profileId: e.target.value,
                    });
                    await load();
                  }, "已切换简历版本，并重新读取资料")
                }
              >
                {view.versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </label>
            <input
              aria-label="简历版本名称"
              value={versionName}
              maxLength={120}
              onChange={(e) => setVersionName(e.target.value)}
              placeholder="例如：后端开发版、Agent 开发版"
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
                  await load();
                }, "版本名称已保存")
              }
            >
              保存版本名称
            </button>
          </div>
          <p className="hint">
            导入不同文件会创建独立版本；相同内容重复导入会更新对应版本，保留已确认资料。编辑只影响当前版本。填写任务启动后不能切换资料。
          </p>
        </section>
      )}
      <div className="summary-line">
        <div>
          <small>当前简历附件</small>
          <strong>
            {view?.profile.resume
              ? view.selected.file || "原有 PDF 附件"
              : "未导入 PDF 附件"}
          </strong>
        </div>
        <div>
          <small>当前版本修订</small>
          <strong>
            {view?.version
              ? `v${view.version.revision} · ${view.version.file}`
              : "暂无导入记录"}
          </strong>
          <small>{view?.version ? date(view.version.at) : ""}</small>
          {view?.version?.extraction?.format === "pdf" && (
            <small>
              {view.version.extraction.ocrPages
                ? `本机 OCR · ${view.version.extraction.ocrPages} 页`
                : "PDF 文字提取"}
            </small>
          )}
        </div>
      </div>
      <p className="hint">
        支持文字版和扫描版 PDF、TXT/MD、JSON。扫描页自动使用 macOS 本地 OCR，
        不上传云端，可能需要数十秒。自动拆分教育、工作/实习和项目经历，保留起止时间与原文描述；缺失或不确定的字段仍需补充。
      </p>
      {view && (
        <p className="hint">
          当前资料：教育 {view.profile.records.education.length} 段 · 工作/实习{" "}
          {view.profile.records.experience.length} 段 · 项目{" "}
          {view.profile.records.project.length}{" "}
          段。请逐项核对并确认，未确认值不会用于填写。
        </p>
      )}
      {groups.map((group) => (
        <section className="panel" key={group}>
          <h2>{group}</h2>
          <div className="profile-grid">
            {view!.fields
              .filter((f) => f.section === group)
              .map((f) => (
                <FactEditor
                  key={
                    view!.selected.id +
                    f.path +
                    JSON.stringify(view!.profile.facts[f.path])
                  }
                  path={f.path}
                  text={f.label}
                  fact={view!.profile.facts[f.path]}
                  disabled={busy || importing}
                  save={(value) =>
                    perform(async () => {
                      await api.invoke({
                        method: "saveFact",
                        profileId: view!.selected.id,
                        path: f.path,
                        value,
                      });
                      await load();
                    }, "已保存到 Keychain，并回读验证")
                  }
                />
              ))}
          </div>
        </section>
      ))}
      <section className="panel">
        <h2>添加经历与资料字段</h2>
        <div className="inline-form">
          <select
            aria-label="经历类别"
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            <option value="education">教育经历</option>
            <option value="experience">工作 / 实习经历</option>
            <option value="project">项目经历</option>
          </select>
          <input
            aria-label="经历记录ID"
            placeholder="稳定记录 ID，例如 bachelor"
            value={recordId}
            onChange={(e) => setRecordId(e.target.value)}
          />
          <button
            disabled={busy || !recordId}
            onClick={() =>
              perform(async () => {
                await api.invoke({
                  method: "record",
                  profileId: view!.selected.id,
                  kind,
                  id: recordId,
                });
                await load();
                setRecordId("");
              })
            }
          >
            添加经历
          </button>
        </div>
        <p className="hint">
          同一官网上的多段教育、实习或项目，需要在任务抽屉中选择对应的资料记录后填写。求职偏好也可补充
          preference.location 等字段。
        </p>
        <div className="inline-form">
          <input
            aria-label="新资料路径"
            placeholder="资料路径，例如 preference.location"
            value={customPath}
            onChange={(e) => setCustomPath(e.target.value)}
          />
          <input
            aria-label="新资料值"
            placeholder="本人确认的值"
            value={customValue}
            onChange={(e) => setCustomValue(e.target.value)}
          />
          <button
            disabled={busy || !customPath || !customValue}
            onClick={() =>
              perform(async () => {
                await api.invoke({
                  method: "saveFact",
                  profileId: view!.selected.id,
                  path: customPath,
                  value: customValue,
                });
                await load();
                setCustomPath("");
                setCustomValue("");
              }, "资料已保存并重新读取")
            }
          >
            确认添加
          </button>
        </div>
      </section>
    </>
  );
}
function FactEditor({
  path,
  text,
  fact,
  disabled,
  save,
}: {
  path: string;
  text: string;
  fact?: Fact;
  disabled: boolean;
  save: (v: Value) => Promise<unknown>;
}) {
  const [value, setValue] = useState(
      typeof fact?.value === "string"
        ? fact.value
        : fact?.value === undefined
          ? ""
          : JSON.stringify(fact.value),
    ),
    [type, setType] = useState(
      Array.isArray(fact?.value)
        ? "array"
        : typeof fact?.value === "boolean"
          ? "boolean"
          : typeof fact?.value === "number"
            ? "number"
            : "text",
    ),
    [error, setError] = useState("");
  return (
    <form
      className={`fact${/(?:description|responsibilities)$/.test(path) ? " fact-long" : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        setError("");
        try {
          let parsed: Value = value;
          if (type === "number") {
            parsed = Number(value);
            if (!Number.isFinite(parsed)) throw new Error();
          }
          if (type === "boolean") {
            if (!["true", "false"].includes(value)) throw new Error();
            parsed = value === "true";
          }
          if (type === "array") {
            parsed = JSON.parse(value);
            if (
              !Array.isArray(parsed) ||
              !parsed.every((v) => typeof v === "string")
            )
              throw new Error();
          }
          void save(parsed);
        } catch {
          setError(
            "请按所选类型输入：数组使用 JSON 字符串数组，布尔值使用 true / false",
          );
        }
      }}
    >
      <div className="section-title">
        <label htmlFor={path}>{text}</label>
        <Badge value={fact?.state || "missing"} />
      </div>
      {fact?.candidates && (
        <div className="candidates">
          候选：
          {fact.candidates.map((v, n) => (
            <button
              type="button"
              key={n}
              onClick={() =>
                setValue(typeof v === "string" ? v : JSON.stringify(v))
              }
            >
              {typeof v === "string" ? v : JSON.stringify(v)}
            </button>
          ))}
        </div>
      )}
      {/(?:description|responsibilities)$/.test(path) ? (
        <textarea
          id={path}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={6}
          required
        />
      ) : (
        <input
          id={path}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          required
        />
      )}
      {fact?.source && (
        <details className="hint">
          <summary>查看简历中的识别依据</summary>
          <p style={{ whiteSpace: "pre-wrap" }}>{fact.source.text}</p>
        </details>
      )}
      <div className="field-actions">
        <select
          aria-label={`${text}值类型`}
          value={type}
          onChange={(e) => setType(e.target.value)}
        >
          <option value="text">文本</option>
          <option value="number">数字</option>
          <option value="boolean">布尔值</option>
          <option value="array">字符串数组</option>
        </select>
        <button disabled={disabled || !value}>确认并保存</button>
      </div>
      {error && <p className="error-text">{error}</p>}
    </form>
  );
}
