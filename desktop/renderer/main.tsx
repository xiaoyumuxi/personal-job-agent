import { ProfilePicker, type ProfileChoices } from "./ProfilePicker.js";
import {
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  useRef,
} from "react";
import { createRoot } from "react-dom/client";
import type { Command, Snapshot, FileKind } from "../contract.js";
import { api, label, Badge } from "./shared.js";
import { Workbench } from "./Workbench.js";
import { DiscoveryPage } from "./DiscoveryPage.js";
import { TaskWorkspace } from "./TaskWorkspace.js";
import { ProfilePage } from "./ProfilePage.js";
import { SettingsPage } from "./SettingsPage.js";
function App() {
  const [page, setPage] = useState("work"),
    [snapshot, setSnapshot] = useState<Snapshot>(),
    [selected, setSelected] = useState<string>(),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [pending, setPending] = useState(false),
    [profilePick, setProfilePick] = useState<{
      jobId: string;
      choices: ProfileChoices;
    }>();
  const alive = useRef(true),
    queue = useRef<Promise<void>>(Promise.resolve());
  const [visited, setVisited] = useState<string[]>(["work"]);
  const [draftCounts, setDraftCounts] = useState<Record<string, number>>({});
  const workScroll = useRef(0);
  const returnFocus = useRef<HTMLElement | null>(null);
  const pickerFocus = useRef<HTMLElement | null>(null);
  const navigate = (next: string) => {
    if (page === "work" && !selected) workScroll.current = window.scrollY;
    setVisited((pages) => (pages.includes(next) ? pages : [...pages, next]));
    setPage(next);
    if (next === "work") setSelected(undefined);
  };
  const select = (id: string) => {
    if (id === "global" && snapshot?.run?.operation === "discover")
      id = "discover";
    if (id === "discover")
      setVisited((pages) =>
        pages.includes("discover") ? pages : [...pages, "discover"],
      );
    if (page === "work" && !selected) {
      workScroll.current = window.scrollY;
      returnFocus.current = profilePick
        ? pickerFocus.current
        : (document.activeElement as HTMLElement);
    }
    setPage("work");
    setSelected(id);
  };
  useLayoutEffect(() => {
    window.scrollTo(0, page === "work" && !selected ? workScroll.current : 0);
  }, [page, selected]);
  const closeTask = () => {
    setSelected(undefined);
    requestAnimationFrame(() =>
      returnFocus.current?.focus({ preventScroll: true }),
    );
  };
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
  const start = async (
    operation: Extract<Command, { method: "start" }>["operation"],
    jobId?: string,
  ) => {
    if (operation === "apply" && jobId) {
      pickerFocus.current = document.activeElement as HTMLElement;
      const choices = (await perform(() =>
        api.invoke({ method: "profileVersions" }),
      )) as ProfileChoices | undefined;
      if (choices) setProfilePick({ jobId, choices });
      return;
    }
    select(jobId || "global");
    return command({ method: "start", operation, jobId });
  };
  const importFile = (kind: FileKind) =>
    perform(async () => {
      const result = await api.chooseFile(kind);
      if (result && kind === "jobs") {
        const v = result as {
          imported: number;
          duplicates: number;
          needsChannel: number;
        };
        setNotice(
          `导入 ${v.imported} 个岗位，跳过 ${v.duplicates} 个重复项${v.needsChannel ? `；${v.needsChannel} 个岗位需要在详情中补充投递入口` : ""}`,
        );
      } else if (result) setNotice("导入完成，已重新读取验证");
      return result;
    });
  const busy = pending || !!snapshot?.busy || !!snapshot?.lock;
  const row = snapshot?.rows.find((r) => r.job.id === selected);
  return (
    <div className="app">
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
            ["profile", "简历与资料", "▧"],
            ["settings", "设置与连接", "⚙"],
          ].map(([id, text, icon]) => (
            <button
              key={id}
              className={page === id ? "nav active" : "nav"}
              aria-current={page === id ? "page" : undefined}
              aria-label={text}
              onClick={() => navigate(id!)}
            >
              <span aria-hidden>{icon}</span>
              <span className="nav-text">{text}</span>
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
            {snapshot.run && !(page === "work" && selected) && (
              <button
                className="run-strip"
                onClick={() => select(snapshot.run?.jobId || "global")}
              >
                <span className="dot working" />
                <strong>{label(snapshot.run.operation)}</strong>
                <Badge value={snapshot.run.state} />
                <span className="ellipsis">{snapshot.run.step}</span>
                <span>查看任务 →</span>
              </button>
            )}
            <div hidden={page !== "work" || !!selected}>
              <Workbench
                snapshot={snapshot}
                busy={busy}
                select={select}
                start={start}
                importJobs={() => importFile("jobs")}
                refresh={() => command({ method: "snapshot" })}
                settings={() => navigate("settings")}
                profile={() => navigate("profile")}
                discover={() => select("discover")}
              />
            </div>
            {visited.includes("discover") && (
              <div hidden={page !== "work" || selected !== "discover"}>
                <DiscoveryPage
                  active={page === "work" && selected === "discover"}
                  snapshot={snapshot}
                  busy={busy}
                  pending={pending}
                  perform={perform}
                  command={command}
                  drafts={draftCounts}
                  close={closeTask}
                  openJob={select}
                  settings={() => navigate("settings")}
                />
              </div>
            )}
            {page === "work" && selected && selected !== "discover" && (
              <TaskWorkspace
                key={selected}
                snapshot={snapshot}
                row={row}
                pending={pending}
                close={closeTask}
                command={command}
                start={start}
              />
            )}
            {visited.includes("profile") && (
              <div hidden={page !== "profile"}>
                <ProfilePage
                  active={page === "profile"}
                  onDraftCounts={setDraftCounts}
                  busy={busy}
                  perform={perform}
                  importProfile={() => importFile("profile")}
                />
              </div>
            )}
            {visited.includes("settings") && (
              <div hidden={page !== "settings"}>
                <SettingsPage
                  active={page === "settings"}
                  canCheckLock={!pending && !snapshot.busy}
                  busy={busy}
                  runState={snapshot.run?.at}
                  perform={perform}
                  command={command}
                  start={start}
                  choose={importFile}
                />
              </div>
            )}
          </>
        )}
      </main>
      {profilePick &&
        (() => {
          const target = snapshot?.rows.find(
            (r) => r.job.id === profilePick.jobId,
          );
          return target ? (
            <ProfilePicker
              company={target.job.company}
              title={target.job.title}
              choices={profilePick.choices}
              draftCounts={draftCounts}
              previousId={target.application?.profileId}
              busy={busy}
              cancel={() => {
                setProfilePick(undefined);
                requestAnimationFrame(() =>
                  pickerFocus.current?.focus({ preventScroll: true }),
                );
              }}
              choose={async (profileId) => {
                const result = await command({
                  method: "start",
                  operation: "apply",
                  jobId: target.job.id,
                  profileId,
                });
                if (result) {
                  setProfilePick(undefined);
                  select(target.job.id);
                }
              }}
            />
          ) : null;
        })()}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
