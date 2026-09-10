import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { createServer } from "node:http";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  realpathSync,
  mkdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/db.js";
import { initialize, readConfig, saveConfig } from "../src/config.js";
import { KeychainVault } from "../src/vault.js";
import { liveStates } from "../src/application/runtime.js";
import { tableFields } from "../src/feishu/schema.js";
import type { Snapshot, ProfileView } from "../desktop/contract.js";
import { textPDF, scannedPDF } from "./pdf-fixture.js";
import { structuredResume } from "./resume-fixture.js";
test.describe.configure({ mode: "serial" });
let home: string, vault: KeychainVault, client: ElectronApplication | undefined;
let discoveryCLI: string, discoveryLog: string;
let authenticated = false,
  lastName = "",
  lastProjectName = "",
  appUrl = "",
  jobId = "";
const server = createServer((req, res) => {
  if (req.url?.startsWith("/test/project-value?")) {
    lastProjectName =
      new URL(req.url, "http://local.test").searchParams.get("name") || "";
    res.end("ok");
    return;
  }
  if (req.url === "/test/resume-form") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      `<!doctype html><html lang="zh"><h1>本地项目填写测试</h1><div data-auth="valid">测试账户有效</div><section data-section="项目经验"><div data-record="project" data-kind="project"><label>项目名称<input required oninput="fetch('/test/project-value?name='+encodeURIComponent(this.value))"></label></div></section></html>`,
    );
    return;
  }
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
        process.env.JOBAGENT_TEST_PACKAGE_DIR ||
          `release/JobAgent-darwin-${process.arch}/JobAgent.app`,
        "Contents/MacOS/JobAgent",
      )
    : undefined;
  client = await electron.launch({
    executablePath,
    args: [
      ...(packaged ? [] : ["."]),
      `--user-data-dir=${join(home, "electron-test-profile")}`,
    ],
    env: {
      ...process.env,
      JOBAGENT_HOME: home,
      PATH: "/usr/bin:/bin",
      NVM_DIR: join(home, "test-only-nvm"),
      npm_config_prefix: "",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "",
    },
    timeout: 30000,
  });
  const page = await client.firstWindow();
  expect(
    realpathSync(await client.evaluate(({ app }) => app.getPath("userData"))),
  ).toBe(realpathSync(join(home, "electron-test-profile")));
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
      if (s.busy && s.run && liveStates.includes(s.run.state))
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
  discoveryCLI = join(home, "test-only-nvm/versions/node/v24.0.0/bin/lark-cli");
  discoveryLog = join(home, "cli-discovery-calls.jsonl");
  mkdirSync(join(home, "test-only-nvm/versions/node/v24.0.0/bin"), {
    recursive: true,
  });
  writeFileSync(discoveryLog, "");
  writeFileSync(
    discoveryCLI,
    `#!/usr/bin/env node\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(discoveryLog)},JSON.stringify(args)+'\\n');if(args.length===1&&args[0]==='--version') console.log('lark-cli version discovery-test');else if(args[0]==='auth'&&args[1]==='status') console.log(JSON.stringify({identities:{user:{available:false,status:'missing'}},verified:false}));else process.exitCode=1;`,
    { mode: 0o700 },
  );
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
  const profileCatalog = JSON.parse(
    (await vault?.get("profile-catalog")) || "null",
  );
  for (const entry of profileCatalog?.entries ?? [])
    await vault?.delete(entry.key);
  await vault?.delete("profile-catalog");
  await vault?.delete("profile");
  const store = new Store(home);
  for (const a of store.applications())
    await vault?.delete(
      "application:" +
        a.id +
        (a.profileId && a.profileId !== "legacy" ? ":" + a.profileId : ""),
    );
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
  await page.getByRole("button", { name: "准备填写", exact: true }).click();
  await page
    .getByRole("button", { name: "使用此版本并继续", exact: true })
    .click();
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
    .getByRole("checkbox", { name: "我已核对上述目标与本次操作范围" })
    .check();
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
  await page.locator(".job-title").first().click();
  expect((await read()).run?.runId).toBe(loginRun.run?.runId);
  await page.getByRole("button", { name: "已完成登录，重新检查" }).click();
  await expect
    .poll(async () => {
      const run = (await read()).run;
      return (
        run?.state === "WAIT_LOGIN" &&
        !!run.request?.requestId &&
        run.request.requestId !== loginRun.run?.request?.requestId
      );
    })
    .toBe(true);
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
  await page.getByRole("button", { name: "← 返回工作台" }).click();
  await page.getByRole("button", { name: "同步飞书", exact: true }).click();
  await expect
    .poll(async () => (await read()).rows[0]!.application?.syncStatus)
    .toBe("NOT_CONFIGURED");
  await expect.poll(async () => (await read()).run?.state).toBe("FAILED");
  const before = await read();
  expect(before.events.filter((e) => e.kind === "TASK_STARTED")).toHaveLength(
    2,
  );
  await page.getByRole("button", { name: "← 返回工作台" }).click();
  await page.getByRole("button", { name: "简历与资料", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "简历与资料", exact: true }),
  ).toBeVisible();
  await page.locator('[id="basic.name"]').fill("确认的测试资料");
  await page
    .locator("form.fact")
    .filter({ has: page.locator('[id="basic.name"]') })
    .getByRole("button", { name: "确认并保存" })
    .click();
  await expect(page.getByRole("status")).toContainText("回读验证");
  await verifyCLIDiscovery(page);
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
  if (process.env.JOBAGENT_TEST_SCREENSHOTS)
    await page.screenshot({
      path: "/private/tmp/jobagent-desktop-settings.png",
    });
  expect(errors).toEqual([]);
  await stopClient();
  const reopened = await launch();
  const after = (await reopened.evaluate(() =>
    window.jobagent.invoke({ method: "snapshot" }),
  )) as Snapshot;
  expect(after.rows[0]!.application?.id).toBe(before.rows[0]!.application?.id);
  expect(after.busy).toBe(false);
  expect(after.events.filter((e) => e.kind === "TASK_STARTED")).toHaveLength(2);
  if (process.env.JOBAGENT_TEST_SCREENSHOTS)
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
  await expect(page.getByRole("article", { name: "任务工作区" })).toBeVisible();
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
  await page.getByRole("button", { name: "← 返回工作台" }).click();
  await page
    .getByRole("button", {
      name: "客户端验收专用公司 测试岗位（不会真实投递）",
    })
    .click();
  await expect(
    page.getByText("同步故障：FEISHU_TEMPORARY_ERROR。", { exact: false }),
  ).toBeVisible();
  if (process.env.JOBAGENT_TEST_SCREENSHOTS)
    await page.screenshot({ path: "/private/tmp/jobagent-desktop-retry.png" });
  const store = new Store(home);
  const a = store.app(jobId);
  a.state = "UNKNOWN_RESULT";
  a.nextAction = "测试未知提交结果";
  store.save(a, "TEST_UNKNOWN_RESULT");
  store.close();
  // On smaller screens the drawer intentionally overlays the workbench.
  await page.getByRole("button", { name: "← 返回工作台" }).click();
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
  await page
    .getByRole("button", {
      name: "客户端验收专用公司 测试岗位（不会真实投递）",
    })
    .click();
  await expect(
    page.getByRole("button", { name: "记录核查结果" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "← 返回工作台" }).click();
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
async function verifyPDFImport(page: Page, variant: string) {
  const closeDrawer = page.getByRole("button", { name: "← 返回工作台" });
  if (await closeDrawer.isVisible()) await closeDrawer.click();
  await page.getByRole("button", { name: "简历与资料", exact: true }).click();
  const read = () =>
    page.evaluate(() =>
      window.jobagent.invoke({ method: "profile" }),
    ) as Promise<ProfileView>;
  const before = await read();
  const file = join(home, `${variant} 简历.pdf`);
  const email = `${variant}-pdf@example.invalid`;
  writeFileSync(file, textPDF(`Email: ${email} Phone: 13812345678`));
  await client!.evaluate(({ dialog }, path) => {
    (globalThis as any).profileFileFilters = [];
    dialog.showOpenDialog = async (...args: any[]) => {
      (globalThis as any).profileFileFilters = args.at(-1).filters;
      return { canceled: false, filePaths: [path] };
    };
  }, file);
  const importButton = page.getByRole("button", {
    name: "导入简历 / 资料",
    exact: true,
  });
  await expect(importButton).toBeEnabled();
  await importButton.click();
  await expect(page.getByRole("status")).toContainText("导入完成");
  await expect(page.locator('[id="basic.email"]')).toHaveValue(email);
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(
    await client!.evaluate(
      () => (globalThis as any).profileFileFilters[0].extensions,
    ),
  ).toContain("pdf");
  const imported = await read();
  expect(imported.profile.facts["basic.email"]?.state).toBe("pending");
  expect(imported.selected.id).not.toBe(before.selected.id);
  expect(imported.version?.revision).toBe(1);
  expect(imported.version?.file).toBe(`${variant} 简历.pdf`);
  expect(readFileSync(imported.profile.resume!)).toEqual(readFileSync(file));

  // Real Keychain persistence and renderer refresh, not a fabricated UI success.
  await page.reload();
  await page.getByRole("button", { name: "简历与资料", exact: true }).click();
  await expect(page.locator('[id="basic.email"]')).toHaveValue(email);
  expect((await read()).version).toEqual(imported.version);

  // This scan has no text layer; real macOS Vision must recognize its pixels.
  writeFileSync(
    file,
    await scannedPDF([
      "姓名：测试本人",
      `Email: ${email}`,
      "Phone: 13812345678",
    ]),
  );
  await expect(importButton).toBeEnabled();
  await importButton.click();
  await expect(page.getByRole("status")).toContainText("导入完成", {
    timeout: 30000,
  });
  await expect(
    page.getByText("本机 OCR · 1 页", { exact: true }),
  ).toBeVisible();
  await expect(page.locator('[id="basic.email"]')).toHaveValue(email);
  const recognized = await read();
  expect(recognized.version?.extraction?.ocrPages).toBe(1);
  expect(recognized.selected.id).not.toBe(imported.selected.id);
  expect(recognized.version?.revision).toBe(1);
  const name = recognized.profile.facts["basic.name"];
  if (name?.state === "conflict") expect(name.candidates).toContain("测试本人");
  else expect(name?.value).toBe("测试本人");
  expect(readFileSync(recognized.profile.resume!)).toEqual(readFileSync(file));

  // Blank images still fail visibly without replacing the saved profile/version.
  writeFileSync(file, textPDF(""));
  await expect(importButton).toBeEnabled();
  await importButton.click();
  await expect(page.getByRole("alert")).toContainText(
    "本地 OCR 都未识别出足够文字",
    { timeout: 30000 },
  );
  await expect(page.getByRole("status")).toHaveCount(0);
  expect((await read()).profile).toEqual(recognized.profile);
  expect((await read()).version).toEqual(recognized.version);
}

test("PDF import and local OCR use real Electron and Vision; failed recognition preserves saved data", async () => {
  const page = await launch();
  await verifyPDFImport(page, "desktop");
  await stopClient();
});
async function verifyStructuredImport(page: Page) {
  const closeDrawer = page.getByRole("button", { name: "← 返回工作台" });
  if (await closeDrawer.isVisible()) await closeDrawer.click();
  const file = join(home, "结构化经历测试.txt");
  writeFileSync(file, structuredResume);
  await client!.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, file);
  await page.getByRole("button", { name: "简历与资料", exact: true }).click();
  await page
    .getByRole("button", { name: "导入简历 / 资料", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("导入完成");
  const read = () =>
    page.evaluate(() =>
      window.jobagent.invoke({ method: "profile" }),
    ) as Promise<ProfileView>;
  const before = await read();
  expect(before.profile.records.education).toHaveLength(1);
  expect(before.profile.records.experience).toHaveLength(2);
  expect(before.profile.records.project).toHaveLength(1);
  await page
    .getByRole("button", { name: /项目经历 1 · 多协议通信测试框架/ })
    .click();
  await expect(
    page.getByRole("heading", { name: /项目经历 1 · 多协议通信测试框架/ }),
  ).toBeVisible();
  const path = `project.${before.profile.records.project[0]}.description`;
  const input = page.locator(`[id="${path}"]`);
  await expect(input).toHaveJSProperty("tagName", "TEXTAREA");
  await expect(input).toHaveValue(/多协议请求处理/);
  const form = input.locator("..");
  await form.getByRole("button", { name: "确认并保存" }).click();
  await expect(page.getByRole("status")).toContainText("回读验证");
  expect((await read()).profile.facts[path]?.state).toBe("confirmed");
  await page
    .getByRole("button", { name: "导入简历 / 资料", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("导入完成");
  expect((await read()).profile.records).toEqual(before.profile.records);
  expect((await read()).profile.facts[path]?.state).toBe("confirmed");
  await page.reload();
  await page.getByRole("button", { name: "简历与资料", exact: true }).click();
  await page
    .getByRole("button", { name: /项目经历 1 · 多协议通信测试框架/ })
    .click();
  await expect(page.locator(`[id="${path}"]`)).toHaveValue(/多协议请求处理/);
}
test("structured resume records can be edited, confirmed and reimported without duplicates", async () => {
  const page = await launch();
  await verifyStructuredImport(page);
  const profile = (await page.evaluate(() =>
    window.jobagent.invoke({ method: "profile" }),
  )) as ProfileView;
  const project = profile.profile.records.project[0]!;
  await page.evaluate(
    ({ path, value }) =>
      window.jobagent.invoke({ method: "saveFact", path, value }),
    { path: `project.${project}.name`, value: "多协议通信测试框架" },
  );
  const snap = (await page.evaluate(() =>
    window.jobagent.invoke({ method: "snapshot" }),
  )) as Snapshot;
  const target = snap.rows.find((row) => row.job.jobCode === "TEST-002")!;
  await page.evaluate(
    ({ id, url }) =>
      window.jobagent.invoke({ method: "channel", jobId: id, url }),
    { id: target.job.id, url: appUrl + "/test/resume-form" },
  );
  await page.getByRole("button", { name: "投递工作台", exact: true }).click();
  const row = page
    .getByRole("button", { name: "客户端导入测试 客户端导入岗位" })
    .locator("xpath=ancestor::tr");
  await row.getByRole("button", { name: "准备填写", exact: true }).click();
  await page
    .getByRole("button", { name: "使用此版本并继续", exact: true })
    .click();
  await page
    .getByRole("checkbox", { name: "我已核对上述目标与本次操作范围" })
    .check();
  await page
    .getByRole("button", { name: "我已核对，继续", exact: true })
    .click();
  const choices = page.getByRole("combobox", { name: "将网页经历绑定到" });
  await expect(choices).toContainText("多协议通信测试框架 · 2025-07 — 2025-11");
  await page.getByRole("button", { name: "确认绑定", exact: true }).click();
  await expect.poll(() => lastProjectName).toBe("多协议通信测试框架");
  await stopClient();
});
function resetCLIDiscovery() {
  const config = readConfig(home);
  config.feishu.cli = "lark-cli";
  saveConfig(home, config);
  const store = new Store(home);
  store.setMeta("doctor", null);
  store.setMeta("feishuExecutable", null);
  store.setMeta("feishuAuth", null);
  store.close();
}
async function verifyCLIDiscovery(page: Page) {
  await page.getByRole("button", { name: "设置与连接", exact: true }).click();
  await page.getByRole("button", { name: "飞书同步", exact: true }).click();
  await expect(
    page.getByRole("status", { name: "飞书 CLI 检测结果" }),
  ).toContainText("可执行文件已验证 · lark-cli version discovery-test");
  await expect(
    page.getByRole("status", { name: "飞书授权状态" }),
  ).toContainText("尚未登录或授权已失效");
  await expect(page.getByText("表结构：未检测", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "开始官方授权", exact: true }),
  ).toBeEnabled();
  expect(readConfig(home).feishu.cli).toBe(discoveryCLI);
}
test("template views require confirmation and are verified through the real desktop worker", async () => {
  const file = join(home, "template-test-cli"),
    stateFile = join(home, "template-test-state.json");
  writeFileSync(
    stateFile,
    JSON.stringify({ views: [], properties: {}, calls: [] }),
  );
  writeFileSync(
    file,
    `#!/usr/bin/env node
const fs=require('node:fs'), file=${JSON.stringify(stateFile)}, fields=${JSON.stringify(tableFields)}, state=JSON.parse(fs.readFileSync(file,'utf8')), args=process.argv.slice(2), arg=(key)=>args[args.indexOf(key)+1];
state.calls.push(args); let result;
if(args[0]==='--version') result='lark-cli version template-test';
else if(args.includes('--help')) result='--filter-json --offset --field-id --record-id --json';
else if(args[0]==='auth') result=JSON.stringify({identities:{user:{available:true,status:'ready'}},verified:true});
else {
 let data, cmd=args[1], property=cmd.match(/^\\+view-(set|get)-(.*)$/);
 if(cmd==='+field-list') data={fields:fields.map((f,i)=>({...f,id:'fld_'+i})),total:fields.length};
 else if(cmd==='+view-list') data={views:state.views,total:state.views.length};
 else if(cmd==='+view-create'){const v={...JSON.parse(arg('--json')),id:'vew_'+state.views.length};state.views.push(v);data={views:[v]};}
 else if(property){const key=arg('--view-id')+':'+property[2], wrapper=property[2]==='visible-fields'?'visible_fields':property[2];if(property[1]==='set') state.properties[key]=JSON.parse(arg('--json'));data={[wrapper]:state.properties[key]};}
 else {process.exitCode=1;data={};}
 result=JSON.stringify({ok:!process.exitCode,identity:'user',data});
}
fs.writeFileSync(file,JSON.stringify(state));console.log(result);`,
    { mode: 0o700 },
  );
  const config = readConfig(home);
  config.feishu = {
    enabled: false,
    cli: file,
    baseToken: "TEST_ONLY_BASE",
    tableId: "TEST_ONLY_TABLE",
  };
  saveConfig(home, config);
  const page = await launch();
  await page.getByRole("button", { name: "设置与连接", exact: true }).click();
  await page.getByRole("button", { name: "飞书同步", exact: true }).click();
  await expect(
    page.getByRole("status", { name: "飞书 CLI 检测结果" }),
  ).toContainText("template-test");
  await page.getByText("投递跟踪模板与视图", { exact: true }).click();
  await expect(
    page.getByText(
      "公司 · 投递岗位 · 投递渠道 · 投递日期 · 投递状态 · 岗位链接 · 备注",
      { exact: true },
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "配置模板视图", exact: true }).click();
  await expect(
    page.getByText("新增缺少的视图；重设同名视图", { exact: false }),
  ).toBeVisible();
  const state = () => JSON.parse(readFileSync(stateFile, "utf8"));
  expect(state().views).toHaveLength(0);
  expect(
    state().calls.every(
      (args: string[]) =>
        args[0] === "--version" || (args[0] === "auth" && args[1] === "status"),
    ),
  ).toBe(true);
  await page
    .getByRole("checkbox", { name: "我已核对上述目标与本次操作范围" })
    .check();
  await page
    .getByRole("button", { name: "我已核对，继续", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (
          (await page.evaluate(() =>
            window.jobagent.invoke({ method: "snapshot" }),
          )) as Snapshot
        ).run?.state,
    )
    .toBe("COMPLETED");
  expect(state().views.map((v: { name: string }) => v.name)).toEqual([
    "Grid",
    "投递状态看板",
    "投递清单",
  ]);
  expect(
    state().calls.filter(
      (args: string[]) => args[1] === "+view-get-visible-fields",
    ),
  ).toHaveLength(3);
  expect(
    state().calls.some(
      (args: string[]) =>
        args[1] === "+record-upsert" && !args.includes("--help"),
    ),
  ).toBe(false);
  const settings = (await page.evaluate(() =>
    window.jobagent.invoke({ method: "settings" }),
  )) as { feishuTemplate: { verifiedAt?: string } };
  expect(settings.feishuTemplate.verifiedAt).toBeTruthy();
  await stopClient();
});
test("automatically discovers nvm CLI on settings entry without authorizing, persists and avoids duplicate probes on refresh", async () => {
  resetCLIDiscovery();
  const calls = () =>
    readFileSync(discoveryLog, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const beforeCalls = calls().length;
  const page = await launch();
  const before = (await page.evaluate(() =>
    window.jobagent.invoke({ method: "snapshot" }),
  )) as Snapshot;
  await verifyCLIDiscovery(page);
  const checks = [["--version"], ["auth", "status", "--json", "--verify"]];
  expect(calls().slice(beforeCalls)).toEqual(checks);
  await page.getByRole("button", { name: "投递工作台", exact: true }).click();
  await verifyCLIDiscovery(page);
  await page.reload();
  await verifyCLIDiscovery(page);
  expect(calls().length).toBe(beforeCalls + 2);
  await page.getByRole("button", { name: "重新查找", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "开始官方授权", exact: true }),
  ).toBeEnabled();
  expect(calls().length).toBe(beforeCalls + 4);
  const after = (await page.evaluate(() =>
    window.jobagent.invoke({ method: "snapshot" }),
  )) as Snapshot;
  expect(after.run?.runId).toBe(before.run?.runId);
  expect(after.events).toEqual(before.events);
  await stopClient();
  const reopened = await launch();
  await verifyCLIDiscovery(reopened);
  await expect
    .poll(() => calls().slice(beforeCalls))
    .toEqual(Array.from({ length: 3 }, () => checks).flat());
  await stopClient();
});
test("packaged app starts with Finder-like PATH, core resources and SQLite", async () => {
  test.skip(
    !process.env.JOBAGENT_TEST_PACKAGE,
    "需先构建 .app，再启用显式安装包验收",
  );
  resetCLIDiscovery();
  const existing = new Store(home);
  const expectedIds = existing
    .jobs()
    .map((job) => job.id)
    .sort();
  existing.close();
  const page = await launch(true);
  const snap = (await page.evaluate(() =>
    window.jobagent.invoke({ method: "snapshot" }),
  )) as Snapshot;
  expect(snap.dataDir).toBe(home);
  expect(snap.rows.map((row) => row.job.id).sort()).toEqual(expectedIds);
  const profile = (await page.evaluate(() =>
    window.jobagent.invoke({ method: "profile" }),
  )) as { fields: unknown[] };
  expect(profile.fields.length).toBeGreaterThan(3);
  await page.getByRole("button", { name: "官网找岗位", exact: true }).click();
  await page.getByLabel("岗位关键词", { exact: true }).fill("后端");
  await page.getByRole("button", { name: "预览并准备启动" }).click();
  await expect(
    page.getByRole("heading", { name: "确认本次官网读取范围" }),
  ).toBeVisible();
  const discoveryState = await page.evaluate(() =>
    window.jobagent.invoke({ method: "discoveryView" }),
  );
  expect(discoveryState).toBeNull(); // Preview alone neither crawls nor calls a model.
  await page.getByRole("button", { name: "返回投递工作台" }).click();
  await verifyCLIDiscovery(page);
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
  await verifyPDFImport(page, "packaged");
  await verifyStructuredImport(page);
  await stopClient();
});
