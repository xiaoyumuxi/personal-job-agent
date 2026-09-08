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
  runState,
  perform,
  command,
  start,
  choose,
}: {
  busy: boolean;
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
  const discoveryStarted = useRef(false),
    alive = useRef(true),
    revision = useRef(0);
  const receive = (v: SettingsView) => {
    if (!alive.current) return;
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
  }, [runState]);
  const discover = (refresh = false) => {
    setDiscovering(true);
    return perform(async () => {
      await api.invoke({ method: "discoverFeishuCLI", refresh });
      await load();
    }).finally(() => {
      if (alive.current) setDiscovering(false);
    });
  };
  useEffect(() => {
    if (busy || discoveryStarted.current) return;
    discoveryStarted.current = true;
    void discover();
  }, [busy]);
  if (loadError)
    return (
      <div className="empty" role="alert">
        {loadError}
      </div>
    );
  if (!view || !draft) return <div className="empty">正在读取现有配置…</div>;
  const d = view.doctor,
    localCLI = view.feishuExecutable;
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
    }, "配置已保存；验证结果需重新检测");
  const pick = (kind: FileKind) =>
    perform(async () => {
      await choose(kind);
      const v = (await api.invoke({ method: "settings" })) as SettingsView;
      setView(v);
      setDraft(v.config);
    });
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">本地环境与官方连接</div>
          <h1>设置与连接</h1>
          <p>配置保存与连接验证分别记录，打开客户端不会安装调度。</p>
        </div>
        <button
          className="primary"
          disabled={busy}
          onClick={() => start("doctor")}
        >
          检测连接
        </button>
      </header>
      <p className="hint">
        最近检测：{date(d?.at)}。未检测的连接不会显示正常。
      </p>
      <section className="panel">
        <div className="section-title">
          <h2>Chrome 与站点规则</h2>
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
          <button disabled={busy} onClick={() => pick("site")}>
            导入站点规则
          </button>
        </div>
        <p className="hint">
          官网登录在岗位任务中处理。专用 Chrome
          独立于日常浏览器，客户端不会迁移登录数据。
        </p>
        {view.sites.length ? (
          view.sites.map((s) => (
            <p key={s.id}>
              {s.name} · 填写{s.fill ? "已配置" : "不支持"} · 查询
              {s.track ? "已配置" : "不支持"}
            </p>
          ))
        ) : (
          <p className="hint">
            站点规则待配置：通用规则可辅助填写；官网登录验证、可靠进度查询需要站点适配。
          </p>
        )}
      </section>
      <section className="panel">
        <div className="section-title">
          <h2>飞书官方 CLI</h2>
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
        <p>
          CLI：<span className="mono">{view.config.feishu.cli}</span>
        </p>
        <p role="status" aria-label="飞书 CLI 检测结果">
          {discovering
            ? "正在自动查找并验证飞书 CLI…"
            : localCLI
              ? `${localCLI.message}${localCLI.version ? ` · ${localCLI.version}` : ""}`
              : busy
                ? "等待当前任务结束后自动查找 CLI"
                : "等待自动查找 CLI"}
        </p>
        {localCLI && (
          <p className="hint">可执行文件最近检测：{date(localCLI.at)}</p>
        )}
        <p>
          飞书授权：{label(d?.feishuUserAuth || "NOT_TESTED")} · 表结构：
          {label(d?.feishuTable || "NOT_TESTED")}
        </p>
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
          <button
            disabled={!view.authPending}
            onClick={() => perform(() => api.openFeishuAuth())}
          >
            打开飞书授权页
          </button>
          <button
            disabled={busy || !view.authPending}
            onClick={() => start("feishuComplete")}
          >
            已授权，重新验证
          </button>
        </div>
        <p className="hint">
          自动查找只验证本机可执行文件，不代表飞书已授权；授权和表格权限请点击“检测连接”验证。
        </p>
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
        <p className="hint">
          本地标色不代表飞书已更新；只有远端写入确认后才显示同步成功。新建表仍可使用现有
          CLI，客户端暂不支持。
        </p>
      </section>
      <section className="panel">
        <div className="section-title">
          <h2>可选模型</h2>
          <Badge value={view.modelConnection.status} />
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
      <section className="panel">
        <div className="section-title">
          <h2>每日查询 · launchd</h2>
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
      <div className="save-bar">
        <span>修改配置后先保存，再检测或安装。</span>
        <button className="primary" disabled={busy} onClick={save}>
          保存配置
        </button>
      </div>
      <section className="panel">
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
            disabled={busy}
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
