import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/db.js";
import { initialize, readConfig, saveConfig } from "../src/config.js";
import { KeychainVault } from "../src/vault.js";
import type { Snapshot } from "../desktop/contract.js";
test.describe.configure({ mode: "serial" });
let home: string, vault: KeychainVault, client: ElectronApplication | undefined;
let authenticated = false,
  lastName = "",
  appUrl = "",
  jobId = "";
const server = createServer((req, res) => {
  if (req.url === "/test/login") {
    authenticated = true;
    res.end("test only");
    return;
  }
  if (req.url?.startsWith("/test/value?")) {
    lastName =
      new URL(req.url, "http://local.test").searchParams.get("name") || "";
    res.end("ok");
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(
    `<!doctype html><html lang="zh"><title>客户端验收专用测试表单</title><h1>本地测试，非真实企业</h1>${authenticated ? `<div data-auth="valid">测试账户有效</div><form><h2 data-step="basic">基本资料</h2><section data-section="基本信息"><label>姓名<input id="name" required oninput="fetch('/test/value?name='+encodeURIComponent(this.value))"></label></section><p>测试不会自动提交</p></form>` : `<div data-auth="expired">测试会话未登录</div><a href="/test/login">模拟本人登录</a>`}</html>`,
  );
});
async function launch(packaged = false) {
  const executablePath = packaged
    ? resolve(
        `release/JobAgent-darwin-${process.arch}/JobAgent.app/Contents/MacOS/JobAgent`,
      )
    : undefined;
  client = await electron.launch({
    executablePath,
    args: packaged ? [] : ["."],
    env: {
      ...process.env,
      JOBAGENT_HOME: home,
      PATH: "/usr/bin:/bin",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "",
    },
    timeout: 30000,
  });
  const page = await client.firstWindow();
  await expect(
    page.getByRole("heading", { name: "投递工作台", exact: true }),
  ).toBeVisible();
  return page;
}
async function stopClient() {
  if (!client) return;
  const p = client.windows()[0];
  if (p) {
    try {
      const s = (await p.evaluate(() =>
        window.jobagent.invoke({ method: "snapshot" }),
      )) as Snapshot;
      if (s.busy && s.run)
        await p.evaluate(
          (runId) =>
            window.jobagent.invoke({
              method: "control",
              runId,
              action: "cancel",
            }),
          s.run.runId,
        );
      await expect
        .poll(
          async () =>
            (
              (await p.evaluate(() =>
                window.jobagent.invoke({ method: "snapshot" }),
              )) as Snapshot
            ).busy,
        )
        .toBe(false);
    } catch {}
  }
  await client.close().catch(() => {});
  client = undefined;
}
test.beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "jobagent-desktop-e2e-"));
  initialize(home);
  process.env.JOBAGENT_KEYCHAIN_HELPER = resolve(
    ".desktop-runtime/keychain-helper",
  );
  vault = new KeychainVault(home);
  await vault.set("profile", JSON.stringify({ version: 1, facts: {} }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  appUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const rule = {
    id: "desktop-test",
    name: "客户端验收专用测试",
    origins: [appUrl],
    tenant: "test",
    capabilities: { fill: true, track: false },
    login: {
      url: appUrl,
      authenticated: "[data-auth=valid]",
      unauthenticated: "[data-auth=expired]",
    },
  };
  writeFileSync(join(home, "site.json"), JSON.stringify(rule));
  const config = readConfig(home);
  config.siteFiles = ["site.json"];
  config.notifications = false;
  saveConfig(home, config);
  const store = new Store(home);
  jobId = store.addJob({
    company: "客户端验收专用公司",
    title: "测试岗位（不会真实投递）",
    batch: "test",
    jobCode: "TEST-001",
    url: appUrl,
    tenant: "test",
    account: "default",
    referral: "",
    source: "显式客户端测试",
    channel: "READY",
  }).id;
  store.close();
});
test.afterAll(async () => {
  await stopClient();
  server.close();
  await vault?.delete("profile");
  const store = new Store(home);
  for (const a of store.applications())
    await vault?.delete("application:" + a.id);
  store.close();
  rmSync(home, { recursive: true, force: true });
});
test("existing SQLite → one task → login yellow → answer → pause/resume → sync failure → refresh/reopen", async () => {
  const page = await launch();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const read = () =>
    page.evaluate(() =>
      window.jobagent.invoke({ method: "snapshot" }),
    ) as Promise<Snapshot>;
  expect((await read()).rows).toHaveLength(1);
  await page.getByRole("button", { name: "辅助填写", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "我已核对，继续", exact: true }),
  ).toBeVisible();
  const initial = await read();
  expect(initial.run?.operation).toBe("apply");
  const duplicate = await page.evaluate(async (jobId) => {
    try {
      await window.jobagent.invoke({
        method: "start",
        operation: "apply",
        jobId,
      });
      return false;
    } catch {
      return true;
    }
  }, jobId);
  expect(duplicate).toBe(true);
  await page
    .getByRole("button", { name: "我已核对，继续", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "已完成登录，重新检查" }),
  ).toBeVisible();
  await expect(page.locator("tr.attention-AUTH_REQUIRED")).toHaveCount(1);
  const loginRun = await read();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "投递工作台", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "详情", exact: true }).click();
  expect((await read()).run?.runId).toBe(loginRun.run?.runId);
  await page.getByRole("button", { name: "已完成登录，重新检查" }).click();
  await expect
    .poll(async () => (await read()).run?.request?.requestId)
    .not.toBe(loginRun.run?.request?.requestId);
  expect((await read()).rows[0]!.application?.authStatus).toBe("AUTH_REQUIRED");
  await fetch(appUrl + "/test/login");
  await page.getByRole("button", { name: "已完成登录，重新检查" }).click();
  await expect(
    page.getByRole("button", { name: "确认答案并继续" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "暂停任务", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "恢复任务", exact: true }),
  ).toBeVisible();
  expect((await read()).run?.state).toBe("PAUSED");
  await page.getByRole("button", { name: "恢复任务", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "确认答案并继续" }),
  ).toBeEnabled();
  await page.getByLabel("姓名", { exact: true }).fill("仅供测试姓名");
  await page.getByRole("button", { name: "确认答案并继续" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect.poll(() => lastName).toBe("仅供测试姓名");
  await expect(
    page.getByRole("button", { name: "确认尚未提交，结束本次填写" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "确认尚未提交，结束本次填写" })
    .click();
  await expect.poll(async () => (await read()).busy).toBe(false);
  await page.getByRole("button", { name: "关闭任务详情" }).click();
  await page.getByRole("button", { name: "同步飞书", exact: true }).click();
  await expect
    .poll(async () => (await read()).rows[0]!.application?.syncStatus)
    .toBe("NOT_CONFIGURED");
  await expect.poll(async () => (await read()).run?.state).toBe("FAILED");
  const before = await read();
  expect(before.events.filter((e) => e.kind === "TASK_STARTED")).toHaveLength(
    2,
  );
  await page.getByRole("button", { name: "关闭任务详情" }).click();
  await page.getByRole("button", { name: "我的资料", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "我的资料", exact: true }),
  ).toBeVisible();
  await page.locator('[id="basic.name"]').fill("确认的测试资料");
  await page
    .locator("form.fact")
    .filter({ has: page.locator('[id="basic.name"]') })
    .getByRole("button", { name: "确认并保存" })
    .click();
  await expect(page.getByRole("status")).toContainText("回读验证");
  await page.getByRole("button", { name: "设置与连接", exact: true }).click();
  await expect(
    page.getByText("最近检测：尚无记录", { exact: false }),
  ).toBeVisible();
  const settings = (await page.evaluate(() =>
    window.jobagent.invoke({ method: "settings" }),
  )) as { schedule: { installed: boolean } };
  expect(settings.schedule.installed).toBe(false);
  const security = await client!.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]!;
    const p = (
      w.webContents as unknown as {
        getLastWebPreferences(): {
          nodeIntegration: boolean;
          contextIsolation: boolean;
          sandbox: boolean;
        };
      }
    ).getLastWebPreferences();
    return {
      node: p.nodeIntegration,
      context: p.contextIsolation,
      sandbox: p.sandbox,
    };
  });
  expect(security).toEqual({ node: false, context: true, sandbox: true });
  expect(await page.evaluate(() => typeof (window as any).require)).toBe(
    "undefined",
  );
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  await page.screenshot({ path: "/private/tmp/jobagent-desktop-settings.png" });
  expect(errors).toEqual([]);
  await stopClient();
  const reopened = await launch();
  const after = (await reopened.evaluate(() =>
    window.jobagent.invoke({ method: "snapshot" }),
  )) as Snapshot;
  expect(after.rows[0]!.application?.id).toBe(before.rows[0]!.application?.id);
  expect(after.busy).toBe(false);
  expect(after.events.filter((e) => e.kind === "TASK_STARTED")).toHaveLength(2);
  await reopened.screenshot({
    path: "/private/tmp/jobagent-desktop-workbench.png",
  });
  await stopClient();
});
test("native import bridge, real retry exhaustion colors, unknown-result guard and window lifecycle", async () => {
  const page = await launch();
  const csv = join(home, "jobs-test.csv");
  writeFileSync(
    csv,
    `公司,岗位,批次,岗位编号,投递入口\n客户端导入测试,客户端导入岗位,test,TEST-002,${appUrl}\n`,
  );
  await client!.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, csv);
  await page.getByRole("button", { name: "＋ 导入岗位", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("导入 1 个岗位");
  await expect(
    page.getByRole("button", { name: "客户端导入测试 客户端导入岗位" }),
  ).toBeVisible();
  const fakeCLI = join(home, "test-only-lark-cli");
  writeFileSync(
    fakeCLI,
    `#!/usr/bin/env node\nconst args=process.argv.slice(2);if(args.includes('--version')) console.log('lark-cli version test-only');else if(args.includes('--help')) console.log('--filter-json --offset --field-id --record-id --json');else if(args[0]==='auth') console.log(JSON.stringify({identities:{user:{available:true,status:'ready',verified:true}},verified:true}));else {console.log(JSON.stringify({ok:false,error:{type:'network',code:'503'}}));process.exitCode=1;}`,
    { mode: 0o700 },
  );
  const c = readConfig(home);
  c.feishu = {
    enabled: true,
    cli: fakeCLI,
    baseToken: "TEST_ONLY_BASE",
    tableId: "TEST_ONLY_TABLE",
  };
  saveConfig(home, c);
  await page.getByRole("button", { name: "同步飞书", exact: true }).click();
  await expect
    .poll(
      async () =>
        (
          (await page.evaluate(() =>
            window.jobagent.invoke({ method: "snapshot" }),
          )) as Snapshot
        ).busy,
      { timeout: 20000 },
    )
    .toBe(false);
  await expect(page.locator("tr.attention-RETRY_EXHAUSTED")).toHaveCount(1);
  await page.getByRole("button", { name: "关闭任务详情" }).click();
  await page
    .getByRole("button", {
      name: "客户端验收专用公司 测试岗位（不会真实投递）",
    })
    .click();
  await expect(
    page.getByText("同步故障：FEISHU_TEMPORARY_ERROR。", { exact: false }),
  ).toBeVisible();
  await page.screenshot({ path: "/private/tmp/jobagent-desktop-retry.png" });
  const store = new Store(home);
  const a = store.app(jobId);
  a.state = "UNKNOWN_RESULT";
  a.nextAction = "测试未知提交结果";
  store.save(a, "TEST_UNKNOWN_RESULT");
  store.close();
  await page.getByRole("button", { name: "刷新工作台" }).click();
  const rejected = await page.evaluate(async (id) => {
    try {
      await window.jobagent.invoke({
        method: "start",
        operation: "apply",
        jobId: id,
      });
      return false;
    } catch {
      return true;
    }
  }, jobId);
  expect(rejected).toBe(true);
  await expect(
    page.getByRole("button", { name: "记录核查结果" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭任务详情" }).click();
  // Closing an idle window keeps the app available in the Dock; activation reopens it.
  await client!.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.close(),
  );
  await expect
    .poll(
      async () =>
        await client!.evaluate(
          ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
        ),
    )
    .toBe(0);
  const newWindow = client!.waitForEvent("window");
  await client!.evaluate(({ app }) => app.emit("activate"));
  const reopened = await newWindow;
  await expect(
    reopened.getByRole("heading", { name: "投递工作台", exact: true }),
  ).toBeVisible();
  expect(
    (
      (await reopened.evaluate(() =>
        window.jobagent.invoke({ method: "snapshot" }),
      )) as Snapshot
    ).rows,
  ).toHaveLength(2);
  // An active-task exit asks first; the cancel choice keeps the run alive.
  await reopened
    .getByRole("button", { name: "客户端导入测试 客户端导入岗位" })
    .click();
  await reopened.getByRole("button", { name: "打开官网", exact: true }).click();
  await expect(
    reopened.getByRole("button", { name: "我已核对，继续", exact: true }),
  ).toBeVisible();
  await client!.evaluate(({ dialog, app }) => {
    (globalThis as any).exitPrompt = "";
    dialog.showMessageBox = async (...args: any[]) => {
      (globalThis as any).exitPrompt = args.at(-1).message;
      return { response: 0, checkboxChecked: false };
    };
    app.quit();
  });
  await expect
    .poll(async () => client!.evaluate(() => (globalThis as any).exitPrompt))
    .toBe("退出前停止当前任务？");
  expect(
    (
      (await reopened.evaluate(() =>
        window.jobagent.invoke({ method: "snapshot" }),
      )) as Snapshot
    ).busy,
  ).toBe(true);
  await stopClient();
});
test("packaged app starts with Finder-like PATH, core resources and SQLite", async () => {
  test.skip(
    !process.env.JOBAGENT_TEST_PACKAGE,
    "需先构建 .app，再启用显式安装包验收",
  );
  const page = await launch(true);
  const snap = (await page.evaluate(() =>
    window.jobagent.invoke({ method: "snapshot" }),
  )) as Snapshot;
  expect(snap.dataDir).toBe(home);
  expect(snap.rows).toHaveLength(2);
  const profile = (await page.evaluate(() =>
    window.jobagent.invoke({ method: "profile" }),
  )) as { fields: unknown[] };
  expect(profile.fields.length).toBeGreaterThan(3);
  await page.getByRole("button", { name: "设置与连接", exact: true }).click();
  await page.getByRole("button", { name: "检测连接", exact: true }).click();
  await expect
    .poll(
      async () =>
        (
          (await page.evaluate(() =>
            window.jobagent.invoke({ method: "snapshot" }),
          )) as Snapshot
        ).busy,
      { timeout: 30000 },
    )
    .toBe(false);
  const settings = (await page.evaluate(() =>
    window.jobagent.invoke({ method: "settings" }),
  )) as any;
  expect(settings.doctor.chrome).toBe(true);
  expect(settings.doctor.keychain).toBe("可访问");
  expect(settings.doctor.feishuCLIPath.startsWith("/")).toBe(true);
  const plan = (await page.evaluate(() =>
    window.jobagent.invoke({ method: "schedule", action: "plan" }),
  )) as { plist: string };
  expect(plan.plist).toContain(".desktop-runtime/node");
  expect(plan.plist).toContain(".desktop-runtime/keychain-helper");
  expect(settings.schedule.installed).toBe(false);
  expect(await client!.evaluate(({ app }) => app.isPackaged)).toBe(true);
  await stopClient();
});
