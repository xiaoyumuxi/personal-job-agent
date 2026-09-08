import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  utilityProcess,
  shell,
  Menu,
  type UtilityProcess,
  type IpcMainInvokeEvent,
} from "electron";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFile, readFile, mkdir, stat } from "node:fs/promises";
import { CommandSchema, FileKindSchema, type Snapshot } from "./contract.js";
import { liveStates } from "../src/application/runtime.js";
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const entry = pathToFileURL(join(root, "desktop-build/index.html")).href;
let window: BrowserWindow | undefined, worker: UtilityProcess;
let exiting = false,
  closePrompt = false;
let latest: Snapshot | undefined;
const waiting = new Map<
  string,
  { resolve: (v: any) => void; reject: (e: Error) => void }
>();
function rpc(method: string, value?: unknown): Promise<any> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, method, value });
  });
}
function sender(event: IpcMainInvokeEvent) {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    event.senderFrame?.url !== entry
  )
    throw new Error("拒绝非客户端主窗口请求");
}
function createWindow() {
  window = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 980,
    minHeight: 640,
    title: "个人网申助手",
    backgroundColor: "#f5f7fa",
    webPreferences: {
      preload: join(root, "desktop-build/preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      devTools: !app.isPackaged,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (e) => e.preventDefault());
  window.webContents.on("will-attach-webview", (e) => e.preventDefault());
  window.webContents.session.setPermissionRequestHandler(
    (_wc, _permission, cb) => cb(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.on("closed", () => {
    window = undefined;
  });
  window.on("close", (e) => {
    if (exiting) return;
    e.preventDefault();
    if (closePrompt) return;
    closePrompt = true;
    void (async () => {
      try {
        const state: Snapshot = await rpc("command", { method: "snapshot" });
        if (state.busy) {
          const answer = await dialog.showMessageBox(window!, {
            type: "question",
            buttons: [
              "继续使用",
              "停止任务并关闭窗口",
              "关闭窗口，保留任务运行",
            ],
            defaultId: 0,
            cancelId: 0,
            message: "当前有任务正在运行",
            detail:
              "关闭窗口与退出应用不同。保留任务运行时，Dock 图标仍可重新打开窗口；需要补充资料时任务会等待。停止会等待简历导入、OCR 和资料保存完成；已发出的网页操作无法撤回。",
          });
          if (answer.response === 0) return;
          if (answer.response === 1) {
            if (state.run && liveStates.includes(state.run.state))
              await rpc("command", {
                method: "control",
                runId: state.run.runId,
                action: "cancel",
              });
            await waitIdle();
          }
        }
        window?.destroy();
        window = undefined;
      } finally {
        closePrompt = false;
      }
    })().catch(() => {
      closePrompt = false;
    });
  });
  void window.loadURL(entry);
}
async function waitIdle() {
  // Lifecycle wait only; daily scheduling remains exclusively launchd.
  while (((await rpc("command", { method: "snapshot" })) as Snapshot).busy)
    await new Promise((r) => setTimeout(r, 200));
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (!window) createWindow();
    window?.show();
    window?.focus();
  });
  app.on("activate", () => {
    if (!window) createWindow();
    window?.show();
  });
  app.on("window-all-closed", () => {});
  app.on("before-quit", (event) => {
    if (exiting || !worker) return;
    event.preventDefault();
    if (closePrompt) return;
    closePrompt = true;
    void (async () => {
      try {
        const state: Snapshot = await rpc("command", { method: "snapshot" });
        if (state.busy) {
          const a = await dialog.showMessageBox({
            type: "question",
            buttons: ["继续使用", "安全停止并退出"],
            defaultId: 0,
            cancelId: 0,
            message: "退出前停止当前任务？",
            detail:
              "会等待当前网页、网络操作或简历导入（包括 OCR）结束并保存真实状态；已发出的操作无法撤回。原有 launchd 调度保持原状。",
          });
          if (a.response !== 1) return;
        }
        await rpc("shutdown");
        exiting = true;
        worker.kill();
        app.quit();
      } finally {
        closePrompt = false;
      }
    })().catch(() => {
      closePrompt = false;
    });
  });
  void app
    .whenReady()
    .then(async () => {
      const runtimeRoot = app.isPackaged
        ? join(process.resourcesPath, ".desktop-runtime")
        : join(root, ".desktop-runtime");
      let savedHome: string | undefined;
      const locationFile = join(app.getPath("userData"), "data-location.json");
      try {
        const loc = JSON.parse(await readFile(locationFile, "utf8"));
        if (typeof loc.home === "string") savedHome = loc.home;
      } catch {}
      const env = {
        ...process.env,
        ...(process.env.JOBAGENT_HOME || !savedHome
          ? {}
          : { JOBAGENT_HOME: savedHome }),
        JOBAGENT_NODE: join(runtimeRoot, "node"),
        JOBAGENT_KEYCHAIN_HELPER: join(runtimeRoot, "keychain-helper"),
        JOBAGENT_OCR_HELPER: join(runtimeRoot, "pdf-ocr-helper"),
        PATH: [
          join(runtimeRoot),
          "/opt/homebrew/bin",
          "/usr/local/bin",
          "/usr/bin",
          "/bin",
          process.env.PATH || "",
        ].join(":"),
      };
      worker = utilityProcess.fork(join(here, "worker.js"), [], {
        env,
        cwd: root,
        stdio: "ignore",
        serviceName: "个人网申助手业务任务",
      });
      worker.on("exit", () => {
        for (const p of waiting.values())
          p.reject(
            new Error(
              "业务进程已退出，请重新打开客户端；未确认的提交结果需要核查",
            ),
          );
        waiting.clear();
        if (!exiting)
          void dialog.showMessageBox({
            type: "error",
            message: "业务进程已停止",
            detail:
              "界面不能继续执行任务。请退出后重开，已有记录会从原数据库恢复。",
          });
      });
      worker.on("message", (data) => {
        if (data.type === "changed") {
          if (window && !window.isDestroyed())
            window.webContents.send("jobagent:changed");
          return;
        }
        const p = waiting.get(data.id);
        if (!p) return;
        waiting.delete(data.id);
        if (data.ok) p.resolve(data.result);
        else p.reject(new Error(data.error));
      });
      await new Promise<void>((resolve) =>
        worker.on("message", (data) => {
          if (data.type === "ready") resolve();
        }),
      );
      ipcMain.handle("jobagent:command", async (e, raw) => {
        sender(e);
        const c = CommandSchema.parse(raw);
        if (c.method === "schedule" && c.action !== "plan") {
          const plan =
            c.action === "install"
              ? await rpc("command", { method: "schedule", action: "plan" })
              : undefined;
          const a = await dialog.showMessageBox(window!, {
            type: "question",
            buttons: [
              "取消",
              c.action === "install"
                ? "安装 launchd 调度"
                : "卸载 launchd 调度",
            ],
            defaultId: 0,
            cancelId: 0,
            message:
              c.action === "install"
                ? "安装每日查询与同步？"
                : "停止原有每日查询与同步？",
            detail:
              plan?.message ||
              "卸载后关闭客户端不会再由该 launchd 任务自动查询。已有岗位和申请记录保留。",
          });
          if (a.response !== 1) return null;
          c.confirmed = true;
        }
        const result = await rpc("command", c);
        if (c.method === "snapshot") latest = result;
        return result;
      });
      ipcMain.handle("jobagent:file", async (e, raw) => {
        sender(e);
        const kind = FileKindSchema.parse(raw);
        const state: Snapshot = await rpc("command", { method: "snapshot" });
        if (state.busy || state.lock) throw new Error("先完成或停止当前任务");
        const extensions =
          kind === "jobs"
            ? ["csv", "tsv", "xlsx"]
            : kind === "profile"
              ? ["pdf", "txt", "md", "json"]
              : ["json"];
        const selection = await dialog.showOpenDialog(window!, {
          title:
            "选择" +
            {
              jobs: "岗位文件",
              profile: "个人资料",
              site: "站点规则",
              feishuCLI: "飞书官方 CLI 可执行文件",
              chrome: "Google Chrome",
            }[kind],
          properties: ["openFile"],
          ...(!["feishuCLI", "chrome"].includes(kind)
            ? { filters: [{ name: "支持的文件", extensions }] }
            : {}),
        });
        if (selection.canceled) return null;
        return rpc("import", { kind, file: selection.filePaths[0] });
      });
      ipcMain.handle("jobagent:data-dir", async (e) => {
        sender(e);
        const s: Snapshot = await rpc("command", { method: "snapshot" });
        if (s.busy || s.lock)
          throw new Error("请先完成当前任务或等待外部任务结束");
        if (process.env.JOBAGENT_HOME)
          throw new Error(
            "本次由 JOBAGENT_HOME 指定数据目录；先移除启动环境中的覆盖设置，才能切换",
          );
        const chosen = await dialog.showOpenDialog(window!, {
          title: "选择现有 JobAgent 数据目录",
          properties: ["openDirectory"],
        });
        if (chosen.canceled) return false;
        const home = chosen.filePaths[0]!;
        if (
          !(await stat(join(home, "state.sqlite"))).isFile() ||
          !(await stat(join(home, "config.json"))).isFile()
        )
          throw new Error(
            "此目录没有现有的 state.sqlite 和 config.json，拒绝创建空资料库",
          );
        const a = await dialog.showMessageBox(window!, {
          type: "question",
          buttons: ["取消", "连接此目录并重启"],
          defaultId: 0,
          cancelId: 0,
          message: "连接现有数据目录？",
          detail:
            home +
            "\n只保存目录位置，不移动或迁移数据库。CLI 继续用原来的 --home 或 JOBAGENT_HOME。现有 launchd 任务仍指向原来配置的目录。",
        });
        if (a.response !== 1) return false;
        await mkdir(app.getPath("userData"), { recursive: true });
        await writeFile(locationFile, JSON.stringify({ home }), {
          mode: 0o600,
        });
        app.relaunch();
        app.quit();
        return true;
      });
      ipcMain.handle("jobagent:diagnostics", async (e) => {
        sender(e);
        const data = await rpc("diagnostics");
        const dest = await dialog.showSaveDialog(window!, {
          defaultPath: "jobagent-diagnostics.json",
          filters: [{ name: "脱敏诊断", extensions: ["json"] }],
        });
        if (dest.canceled || !dest.filePath) return null;
        await writeFile(dest.filePath, JSON.stringify(data, null, 2), {
          mode: 0o600,
        });
        return dest.filePath;
      });
      ipcMain.handle("jobagent:auth-link", async (e) => {
        sender(e);
        const url = new URL(await rpc("authUrl"));
        if (
          url.protocol !== "https:" ||
          !/(^|\.)(feishu\.cn|larksuite\.com)$/.test(url.hostname)
        )
          throw new Error("不受支持的官方授权域名");
        await shell.openExternal(await rpc("authUrl"));
      });
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: "个人网申助手",
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "hide" },
              { role: "unhide" },
              { role: "quit" },
            ],
          },
          {
            label: "编辑",
            submenu: [
              { role: "undo" },
              { role: "redo" },
              { type: "separator" },
              { role: "cut" },
              { role: "copy" },
              { role: "paste" },
              { role: "selectAll" },
            ],
          },
          {
            label: "窗口",
            submenu: [
              { role: "minimize" },
              { role: "front" },
              ...(!app.isPackaged ? [{ role: "reload" as const }] : []),
            ],
          },
        ]),
      );
      createWindow();
    })
    .catch((error) => {
      dialog.showErrorBox(
        "客户端启动失败",
        error instanceof Error ? error.message : "启动失败",
      );
      exiting = true;
      app.quit();
    });
}
