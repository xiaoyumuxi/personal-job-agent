import { useState, useEffect, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import type { Command, Snapshot, FileKind } from "../contract.js";
import { api, label, Badge } from "./shared.js";
import { Workbench } from "./Workbench.js";
import { Drawer } from "./Drawer.js";
import { ProfilePage } from "./ProfilePage.js";
import { SettingsPage } from "./SettingsPage.js";
function App() {
  const [page, setPage] = useState("work"),
    [snapshot, setSnapshot] = useState<Snapshot>(),
    [selected, setSelected] = useState<string>(),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [pending, setPending] = useState(false);
  const alive = useRef(true),
    queue = useRef<Promise<void>>(Promise.resolve());
  const refresh = useCallback(() => {
    queue.current = queue.current
      .catch(() => {})
      .then(async () => {
        const s = (await api.invoke({ method: "snapshot" })) as Snapshot;
        if (alive.current) setSnapshot(s);
      });
    return queue.current;
  }, []);
  useEffect(() => {
    alive.current = true;
    let dispose: (() => void) | undefined;
    // Snapshot first, one subscription, then catch up anything that changed during attachment.
    void refresh()
      .then(() => {
        if (alive.current) {
          dispose = api.subscribe(() => {
            void refresh().catch((e) => setError(String(e)));
          });
          return refresh();
        }
      })
      .catch((e) => setError(String(e)));
    return () => {
      alive.current = false;
      dispose?.();
    };
  }, [refresh]);
  const perform = async <T,>(fn: () => Promise<T>, success = "") => {
    setPending(true);
    setError("");
    setNotice("");
    try {
      const result = await fn();
      if (success && result !== null) setNotice(success);
      await refresh();
      return result;
    } catch (e) {
      setError(
        (e as Error).message.replace(
          /^Error invoking remote method '[^']+': Error: /,
          "",
        ),
      );
      return undefined;
    } finally {
      setPending(false);
    }
  };
  const command = (c: Command, success = "") =>
    perform(() => api.invoke(c), success);
  const start = (
    operation: Extract<Command, { method: "start" }>["operation"],
    jobId?: string,
  ) => {
    if (jobId) setSelected(jobId);
    else setSelected("global");
    return command({ method: "start", operation, jobId });
  };
  const importFile = (kind: FileKind) =>
    perform(async () => {
      const result = await api.chooseFile(kind);
      if (result && kind === "jobs") {
        const v = result as { imported: number; duplicates: number };
        setNotice(`导入 ${v.imported} 个岗位，跳过 ${v.duplicates} 个重复项`);
      } else if (result) setNotice("导入完成，已重新读取验证");
      return result;
    });
  const busy = pending || !!snapshot?.busy || !!snapshot?.lock;
  const row = snapshot?.rows.find((r) => r.job.id === selected);
  return (
    <div className={`app ${selected ? "with-drawer" : ""}`}>
      <nav className="sidebar" aria-label="主导航">
        <div className="brand">
          <span className="brand-mark">申</span>
          <div>
            个人网申助手<small>本机工作空间</small>
          </div>
        </div>
        <div className="nav-items">
          {[
            ["work", "投递工作台", "▤"],
            ["profile", "我的资料", "▧"],
            ["settings", "设置与连接", "⚙"],
          ].map(([id, text, icon]) => (
            <button
              key={id}
              className={page === id ? "nav active" : "nav"}
              onClick={() => setPage(id!)}
            >
              <span aria-hidden>{icon}</span>
              {text}
            </button>
          ))}
        </div>
        <div className="sidebar-foot">
          <span className={`dot ${snapshot?.busy ? "working" : ""}`} />
          {snapshot?.busy ? "有任务正在处理" : "当前无运行任务"}
          <p>最终提交由你在官网完成</p>
          <small>v0.2 · macOS</small>
        </div>
      </nav>
      <main>
        {error && (
          <div className="banner error" role="alert">
            <span>{error}</span>
            <button aria-label="关闭错误" onClick={() => setError("")}>
              ×
            </button>
          </div>
        )}
        {notice && (
          <div className="banner notice" role="status">
            {notice}
            <button aria-label="关闭提示" onClick={() => setNotice("")}>
              ×
            </button>
          </div>
        )}
        {!snapshot ? (
          <div className="empty">正在读取原有本地数据库…</div>
        ) : (
          <>
            {snapshot.run && (
              <button
                className="run-strip"
                onClick={() => setSelected(snapshot.run?.jobId || "global")}
              >
                <span className="dot working" />
                <strong>{label(snapshot.run.operation)}</strong>
                <Badge value={snapshot.run.state} />
                <span className="ellipsis">{snapshot.run.step}</span>
                <span>查看任务 →</span>
              </button>
            )}
            {page === "work" && (
              <Workbench
                snapshot={snapshot}
                busy={busy}
                selected={selected}
                select={setSelected}
                start={start}
                importJobs={() => importFile("jobs")}
                refresh={() => command({ method: "snapshot" })}
              />
            )}
            {page === "profile" && (
              <ProfilePage
                busy={busy}
                perform={perform}
                importProfile={() => importFile("profile")}
              />
            )}
            {page === "settings" && (
              <SettingsPage
                busy={busy}
                runState={snapshot.run?.at}
                perform={perform}
                command={command}
                start={start}
                choose={importFile}
              />
            )}
          </>
        )}
      </main>
      {selected && snapshot && (
        <Drawer
          snapshot={snapshot}
          row={row}
          pending={pending}
          close={() => setSelected(undefined)}
          command={command}
          start={start}
        />
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
