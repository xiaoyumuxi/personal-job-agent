import { useState, useEffect, useRef } from "react";
import {
  api,
  label,
  date,
  Badge,
  type Start,
  type Perform,
  type Send,
} from "./shared.js";
import type { SettingsView, FileKind } from "../contract.js";
export function SettingsPage({
  busy,
  active,
  canCheckLock,
  runState,
  perform,
  command,
  start,
  choose,
}: {
  busy: boolean;
  active: boolean;
  canCheckLock: boolean;
  runState?: string;
  perform: Perform;
  command: Send;
  start: Start;
  choose: (kind: FileKind) => Promise<unknown>;
}) {
  const [view, setView] = useState<SettingsView>(),
    [draft, setDraft] = useState<SettingsView["config"]>(),
    [key, setKey] = useState(""),
    [plan, setPlan] = useState(""),
    [discovering, setDiscovering] = useState(false),
    [loadError, setLoadError] = useState("");
  const [category, setCategory] = useState("overview");
  const discoveryStarted = useRef(false),
    alive = useRef(true),
    revision = useRef(0);
  const receive = (v: SettingsView) => {
    if (!alive.current) return;
    setLoadError("");
    setView(v);
    setDraft((d) =>
      d
        ? {
            ...d,
            feishu: { ...d.feishu, cli: v.config.feishu.cli },
            browser: v.config.browser,
          }
        : v.config,
    );
  };
  const load = async () => {
    const id = ++revision.current;
    const v = (await api.invoke({ method: "settings" })) as SettingsView;
    if (id === revision.current) receive(v);
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!active) return;
    let current = true;
    const id = ++revision.current;
    void api
      .invoke({ method: "settings" })
      .then((v) => {
        if (current && id === revision.current) receive(v as SettingsView);
      })
      .catch(() => {
        if (current) setLoadError("配置读取失败，请重新打开设置页。");
      });
    return () => {
      current = false;
    };
  }, [runState, active]);
  const discover = (refresh = false) => {
    setDiscovering(true);
    return perform(async () => {
      const cli = (await api.invoke({
        method: "discoverFeishuCLI",
        refresh,
      })) as SettingsView["feishuExecutable"];
      if (cli?.status === "AVAILABLE")
        await api.invoke({ method: "checkFeishuAuth", refresh });
      await load();
    }).finally(() => {
      if (alive.current) setDiscovering(false);
    });
  };
  useEffect(() => {
    if (!active || category !== "feishu" || busy || discoveryStarted.current)
      return;
    discoveryStarted.current = true;
    void discover();
  }, [busy, active, category]);
  if (loadError)
    return (
      <div className="empty" role="alert">
        {loadError}
      </div>
    );
  if (!view || !draft) return <div className="empty">正在读取现有配置…</div>;
  const d = view.doctor,
    localCLI = view.feishuExecutable,
    auth = view.feishuAuth;
  const save = () =>
    perform(async () => {
      await api.invoke({
        method: "saveSettings",
        feishu: draft.feishu,
        model: draft.model,
        schedule: draft.schedule,
        key: key || undefined,
      });
      setKey("");
      setPlan("");
      await load();
    }, "配置已保存；已有飞书授权保留，变更的连接配置需重新检测");
  const pick = (kind: FileKind) =>
    perform(async () => {
      await choose(kind);
      if (kind === "feishuCLI")
        await api.invoke({ method: "checkFeishuAuth", refresh: true });
      const v = (await api.invoke({ method: "settings" })) as SettingsView;
      receive(v);
    });
  const dirty =
    key !== "" ||
    JSON.stringify([draft.feishu, draft.model, draft.schedule]) !==
      JSON.stringify([
        view.config.feishu,
        view.config.model,
        view.config.schedule,
      ]);
  const modelOptional = !view.config.model.enabled;
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">本地环境与官方连接</div>
          <h1>设置与连接</h1>
          <p>先准备核心环境，飞书同步与模型辅助按需开启。</p>
        </div>
        <button
          className="primary"
          disabled={busy}
          onClick={() => start("doctor")}
        >
          检测连接
        </button>
      </header>
      <nav className="settings-tabs" aria-label="设置分类">
        {[
          ["overview", "连接概览"],
          ["sites", "站点规则"],
          ["feishu", "飞书同步"],
          ["model", "模型辅助"],
          ["schedule", "每日查询"],
          ["data", "数据与隐私"],
        ].map(([id, title]) => (
          <button
            key={id}
            aria-pressed={category === id}
            className={category === id ? "selected" : ""}
            onClick={() => setCategory(id!)}
          >
            {title}
          </button>
        ))}
      </nav>
      {dirty && (
        <p className="callout warning" role="status">
          有未保存的配置。分类切换会保留草稿；连接检测、授权和调度预览使用已保存的配置。
        </p>
      )}
      {category === "overview" && (
        <div className="connection-grid">
          <button
            className="connection-card"
            onClick={() =>
              document
                .getElementById("chrome-settings")
                ?.scrollIntoView({ block: "center" })
            }
          >
            <span className="eyebrow">核心环境</span>
            <strong>专用 Chrome</strong>
            <Badge value={d ? (d.chrome ? "VALID" : "FAILED") : "NOT_TESTED"} />
            <p>浏览器可用后，在对应岗位中登录官网。</p>
          </button>
          <button
            className="connection-card"
            onClick={() => setCategory("sites")}
          >
            <span className="eyebrow">按站点配置</span>
            <strong>站点规则</strong>
            <span className="stage-label">{view.sites.length} 个站点规则</span>
            <p>填写、登录验证与进度查询分别配置。</p>
          </button>
          <button
            className="connection-card"
            onClick={() => setCategory("feishu")}
          >
            <span className="eyebrow">可选连接</span>
            <strong>飞书同步</strong>
            <span className="stage-label">
              {view.config.feishu.enabled ? "已启用 · 查看验证阶段" : "未启用"}
            </span>
            <p>
              CLI：{localCLI?.status === "AVAILABLE" ? "可用" : "尚未验证"} ·
              授权：{auth?.status ? label(auth.status) : "未检测"}
              <br />
              目标表：{label(d?.feishuTable || "NOT_TESTED")}
            </p>
          </button>
          <button
            className="connection-card"
            onClick={() => setCategory("model")}
          >
            <span className="eyebrow">可选连接</span>
            <strong>模型辅助</strong>
            <Badge
              value={
                modelOptional ? "NOT_CONFIGURED" : view.modelConnection.status
              }
              text={modelOptional ? "可选 · 未启用" : undefined}
            />
            <p>未配置也可使用规则填写和人工补充。</p>
          </button>
        </div>
      )}
      <p className="hint">
        最近检测：{date(d?.at)}。未检测的连接不会显示正常。
      </p>
      <section
        className="panel"
        id="chrome-settings"
        hidden={category !== "overview"}
      >
        <div className="section-title">
          <h2>Chrome · 核心环境</h2>
          <Badge value={d ? (d.chrome ? "VALID" : "FAILED") : "NOT_TESTED"} />
        </div>
        <p className="mono">{view.config.browser.executablePath}</p>
        <p>
          专用资料目录：
          <span className="mono">{view.chromeProfile}</span>
        </p>
        <div className="actions">
          <button disabled={busy} onClick={() => pick("chrome")}>
            选择 Chrome
          </button>
        </div>
        <p className="hint">
          官网登录在岗位任务中处理。专用 Chrome
          独立于日常浏览器，客户端不会迁移登录数据。
        </p>
      </section>
      <section className="panel" hidden={category !== "sites"}>
        <div className="section-title">
          <h2>站点能力</h2>
          <button disabled={busy} onClick={() => pick("site")}>
            导入站点规则
          </button>
        </div>
        <p className="hint">
          规则已配置不等于官网验证通过。登录状态需要在对应岗位任务中重新检查。
        </p>
        {view.sites.length ? (
          view.sites.map((s) => (
            <div className="site-capabilities" key={s.id}>
              <strong>{s.name}</strong>
              <span>辅助填写：{s.fill ? "规则已配置" : "未启用"}</span>
              <span>登录验证：{s.login ? "规则已配置" : "待配置"}</span>
              <span>进度查询：{s.track ? "规则已配置" : "待配置"}</span>
            </div>
          ))
        ) : (
          <p className="hint">
            站点规则待配置：通用规则可辅助填写；官网登录验证、可靠进度查询需要站点适配。
          </p>
        )}
      </section>
      <section className="panel" hidden={category !== "feishu"}>
        <div className="section-title">
          <h2>飞书官方 CLI · 可选同步</h2>
          <Badge
            value={
              localCLI?.status === "AVAILABLE"
                ? "VALID"
                : localCLI
                  ? "FAILED"
                  : "NOT_TESTED"
            }
          />
        </div>
        <ol className="connection-stages">
          <li>1 · 本机 CLI 可用</li>
          <li>2 · 本人完成官方授权</li>
          <li>3 · 验证目标表权限</li>
        </ol>
        <p>
          CLI：<span className="mono">{view.config.feishu.cli}</span>
        </p>
        <p role="status" aria-label="飞书 CLI 检测结果">
          {discovering
            ? "正在检测飞书 CLI 并验证已有登录…"
            : localCLI
              ? `${localCLI.message}${localCLI.version ? ` · ${localCLI.version}` : ""}`
              : busy
                ? "等待当前任务结束后自动查找 CLI"
                : "等待自动查找 CLI"}
        </p>
        {localCLI && (
          <p className="hint">可执行文件最近检测：{date(localCLI.at)}</p>
        )}
        <p role="status" aria-label="飞书授权状态">
          飞书授权：{auth?.message ?? label(d?.feishuUserAuth || "NOT_TESTED")}
        </p>
        {auth && <p className="hint">授权最近验证：{date(auth.at)}</p>}
        <p>表结构：{label(d?.feishuTable || "NOT_TESTED")}</p>
        <div className="actions">
          <button disabled={busy || discovering} onClick={() => discover(true)}>
            重新查找
          </button>
          <button disabled={busy} onClick={() => pick("feishuCLI")}>
            选择可执行文件
          </button>
          <button
            disabled={busy || discovering || localCLI?.status !== "AVAILABLE"}
            onClick={() => start("feishuAuth")}
          >
            开始官方授权
          </button>
          {view.authPending && (
            <button onClick={() => perform(() => api.openFeishuAuth())}>
              打开飞书授权页
            </button>
          )}
          <button
            disabled={busy || discovering || localCLI?.status !== "AVAILABLE"}
            onClick={() => start("feishuComplete")}
          >
            {view.authPending ? "完成本次授权" : "验证已有授权"}
          </button>
        </div>
        <p className="hint">
          登录由飞书官方 CLI
          保存，退出客户端后会保留。打开设置时自动验证已有登录；表格权限可通过“检测连接”单独检测。
        </p>
        {view.authPending && (
          <p className="hint">
            本次授权尚未完成：请在飞书授权页确认，再点击“完成本次授权”。
          </p>
        )}
        <p className="hint">
          与招聘网站登录相互独立。需本人在飞书授权页确认；CLI
          本身尚未完成应用配置时，请先按飞书官方流程配置。本版客户端不支持创建飞书应用或代填应用密钥。
        </p>
        <div className="settings-grid">
          <label>
            目标 Base token
            <input
              value={draft.feishu.baseToken}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  feishu: { ...draft.feishu, baseToken: e.target.value },
                })
              }
            />
          </label>
          <label>
            目标 Table ID
            <input
              value={draft.feishu.tableId}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  feishu: { ...draft.feishu, tableId: e.target.value },
                })
              }
            />
          </label>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.feishu.enabled}
            onChange={(e) =>
              setDraft({
                ...draft,
                feishu: { ...draft.feishu, enabled: e.target.checked },
              })
            }
          />
          启用同步，允许向该表同步岗位与申请进度
        </label>
        <details>
          <summary>投递跟踪模板与视图</summary>
          <p>{view.feishuTemplate.columns.join(" · ")}</p>
          <p>
            视图：{view.feishuTemplate.views.join("、")}
            。看板按投递状态分组，清单按投递日期倒序。
          </p>
          <p className="hint">
            投递状态与登录、查询、同步状态独立；备注和投递渠道保留人工修改。没有可靠投递日期时留空。
          </p>
          <button
            disabled={
              busy ||
              localCLI?.status !== "AVAILABLE" ||
              !view.config.feishu.baseToken ||
              !view.config.feishu.tableId
            }
            onClick={() => start("feishuViews")}
          >
            配置模板视图
          </button>
          <p className="hint">
            使用已保存的目标表，先在任务详情中确认影响，再执行配置。视图最近回读验证：
            {date(view.feishuTemplate.verifiedAt)}。
          </p>
        </details>
        <p className="hint">
          本地标色不代表飞书已更新；只有远端写入确认后才显示同步成功。新建表仍可使用现有
          CLI，客户端暂不支持。
        </p>
      </section>
      <section className="panel" hidden={category !== "model"}>
        <div className="section-title">
          <h2>可选模型</h2>
          <Badge
            value={
              modelOptional ? "NOT_CONFIGURED" : view.modelConnection.status
            }
            text={modelOptional ? "可选 · 未启用" : undefined}
          />
        </div>
        <p>
          已配置：
          {d
            ? d.modelConfigured && d.modelKeyPresent
              ? "是"
              : "否"
            : "未检测"}{" "}
          · Keychain：{d?.keychain || "未检测"}
        </p>
        <div className="settings-grid">
          <label>
            HTTPS 完整请求地址
            <input
              value={draft.model.endpoint}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  model: { ...draft.model, endpoint: e.target.value },
                })
              }
            />
          </label>
          <label>
            模型名称
            <input
              value={draft.model.name}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  model: { ...draft.model, name: e.target.value },
                })
              }
            />
          </label>
          <label>
            新 API Key（留空保留已有密钥）
            <input
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.model.enabled && draft.model.consent}
            onChange={(e) =>
              setDraft({
                ...draft,
                model: {
                  ...draft.model,
                  enabled: e.target.checked,
                  consent: e.target.checked,
                },
              })
            }
          />
          允许发送字段标签和字段路径进行映射；不发送个人资料值
        </label>
        <button disabled={busy} onClick={() => start("modelCheck")}>
          检测已保存模型（少量请求，可能计费）
        </button>
        <p className="hint">
          未配置模型也能使用现有规则匹配与人工补充。已有密钥不会回显。
        </p>
      </section>
      <section className="panel" hidden={category !== "schedule"}>
        <div className="section-title">
          <h2>每日查询</h2>
          <Badge value={view.schedule.installed ? "VALID" : "NOT_CONFIGURED"} />
        </div>
        <p>时区：{view.timezone}（跟随 macOS 本机时区）</p>
        <div className="inline-form">
          <label>
            小时
            <input
              type="number"
              min="0"
              max="23"
              value={draft.schedule.hour}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  schedule: { ...draft.schedule, hour: Number(e.target.value) },
                })
              }
            />
          </label>
          <label>
            分钟
            <input
              type="number"
              min="0"
              max="59"
              value={draft.schedule.minute}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  schedule: {
                    ...draft.schedule,
                    minute: Number(e.target.value),
                  },
                })
              }
            />
          </label>
        </div>
        <p className="hint">
          保存时间不会修改已安装的任务。更改已有调度需先卸载，再预览并安装；关闭客户端不会卸载
          launchd。
        </p>
        <p>
          最近执行：{view.daily ? JSON.stringify(view.daily) : "尚无执行记录"}
        </p>
        <div className="actions">
          <button
            disabled={busy}
            onClick={() =>
              perform(async () => {
                const v = (await api.invoke({
                  method: "schedule",
                  action: "plan",
                })) as { message: string };
                setPlan(v.message);
              })
            }
          >
            预览已保存时间的调度
          </button>
          <button
            disabled={busy || !view.schedule.plistExists}
            onClick={() =>
              command({
                method: "schedule",
                action: "uninstall",
                confirmed: true,
              }).then(load)
            }
          >
            卸载调度…
          </button>
        </div>
        {plan && (
          <div className="callout warning">
            <p>{plan}</p>
            <button
              disabled={busy || view.schedule.plistExists}
              onClick={() =>
                command({
                  method: "schedule",
                  action: "install",
                  confirmed: true,
                }).then(load)
              }
            >
              确认上述影响并安装…
            </button>
          </div>
        )}
      </section>
      <div
        className="save-bar"
        hidden={!dirty && !["feishu", "model", "schedule"].includes(category)}
      >
        <span>
          {dirty
            ? "草稿待保存。保存后再检测连接或预览调度。"
            : "配置与检测结果分别记录。保存时间不会安装调度。"}
        </span>
        <button className="primary" disabled={busy} onClick={save}>
          保存配置
        </button>
      </div>
      <section className="panel" hidden={category !== "data"}>
        <h2>本地数据与诊断</h2>
        <p className="mono">{view.home}</p>
        <div className="actions">
          <button
            disabled={busy}
            onClick={() => perform(() => api.chooseDataDirectory())}
          >
            连接现有数据目录…
          </button>
          <button
            onClick={() =>
              perform(() => api.exportDiagnostics(), "脱敏诊断已导出")
            }
          >
            导出脱敏诊断
          </button>
          <button
            disabled={!canCheckLock}
            onClick={() => command({ method: "unlock" }, "已清理失效锁")}
          >
            检查并清理失效任务锁
          </button>
        </div>
        <p className="hint">
          导出仅包含计数、状态和重试次数，不包含资料、URL、密钥、公司岗位名称或完整数据库。仅已退出进程的锁可清理。
        </p>
      </section>
    </>
  );
}
