import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initialize } from "../src/config.js";
import { Store } from "../src/db.js";
import { KeychainVault } from "../src/vault.js";
import type { ProfileView, Snapshot } from "../desktop/contract.js";
import { textPDF } from "./pdf-fixture.js";

for (const packaged of [false, true])
  test(`multiple PDF versions select the matching profile and upload (${packaged ? "packaged" : "development"})`, async () => {
    test.skip(
      packaged && !process.env.JOBAGENT_TEST_PACKAGE,
      "Set JOBAGENT_TEST_PACKAGE=1 to test the bundle",
    );
    const home = mkdtempSync(join(tmpdir(), "jobagent-profile-e2e-"));
    initialize(home);
    let captured: { name?: string; bytes?: string } = {};
    const server = createServer((req, res) => {
      if (req.url === "/capture") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          captured = { ...captured, ...JSON.parse(body) };
          res.end("ok");
        });
        return;
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        `<!doctype html><html><title>简历版本本地验收</title><h1>仅供测试</h1><form><section data-section="基本信息"><h2>基本信息</h2><label>姓名<input id="name" required oninput="fetch('/capture',{method:'POST',body:JSON.stringify({name:this.value})})"></label><label>邮箱<input id="email" type="email" required></label><label>简历<input type="file" id="resume" accept=".pdf" onchange="this.files[0].arrayBuffer().then(b=>fetch('/capture',{method:'POST',body:JSON.stringify({bytes:btoa(String.fromCharCode(...new Uint8Array(b)))})}))"></label></section></form></html>`,
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/form`;
    const store = new Store(home);
    const { id: jobId } = store.addJob({
      company: "本地版本验收",
      title: "测试岗位",
      url,
      batch: "",
      jobCode: "",
      tenant: "test",
      account: "default",
      referral: "",
      source: "test-only",
      channel: "READY",
    });
    store.close();
    process.env.JOBAGENT_KEYCHAIN_HELPER = resolve(
      ".desktop-runtime/keychain-helper",
    );
    const vault = new KeychainVault(home);
    let client: ElectronApplication | undefined;
    const launch = async () => {
      client = await electron.launch({
        executablePath: packaged
          ? resolve(
              process.env.JOBAGENT_TEST_PACKAGE_DIR ||
                `release/JobAgent-darwin-${process.arch}/JobAgent.app`,
              "Contents/MacOS/JobAgent",
            )
          : undefined,
        args: [
          ...(packaged ? [] : ["."]),
          `--user-data-dir=${join(home, "isolated-electron")}`,
        ],
        env: {
          ...process.env,
          JOBAGENT_HOME: home,
          PATH: "/usr/bin:/bin",
          NVM_DIR: join(home, "empty-nvm"),
          npm_config_prefix: "",
        },
      });
      const page = await client.firstWindow();
      await expect(
        page.getByRole("heading", { name: "投递工作台", exact: true }),
      ).toBeVisible();
      return page;
    };
    const state = (page: Page) =>
      page.evaluate(() =>
        window.jobagent.invoke({ method: "snapshot" }),
      ) as Promise<Snapshot>;
    const profile = (page: Page) =>
      page.evaluate(() =>
        window.jobagent.invoke({ method: "profile" }),
      ) as Promise<ProfileView>;
    const stop = async () => {
      if (!client) return;
      const p = client.windows()[0];
      if (p) {
        const s = await state(p).catch(() => undefined);
        if (s?.busy && s.run)
          await p
            .evaluate(
              (runId) =>
                window.jobagent.invoke({
                  method: "control",
                  runId,
                  action: "cancel",
                }),
              s.run.runId,
            )
            .catch(() => {});
        await expect.poll(async () => (await state(p)).busy).toBe(false);
      }
      await client.close();
      client = undefined;
    };
    try {
      let page = await launch();
      await page
        .getByRole("button", { name: "简历与资料", exact: true })
        .click();
      const importPDF = async (file: string, email: string) => {
        writeFileSync(file, textPDF(`Email: ${email} Phone: 13812345678`));
        await client!.evaluate(({ dialog }, path) => {
          dialog.showOpenDialog = async () => ({
            canceled: false,
            filePaths: [path],
          });
        }, file);
        await page
          .getByRole("button", { name: "导入简历 / 资料", exact: true })
          .click();
        await expect(page.getByRole("status")).toContainText("导入完成");
        return profile(page);
      };
      const a = await importPDF(
        join(home, "后端开发.pdf"),
        "backend@example.invalid",
      );
      await page.locator('[id="basic.name"]').fill("后端版姓名");
      await page
        .locator('[id="basic.name"]')
        .locator("..")
        .getByRole("button", { name: "确认并保存" })
        .click();
      await expect(page.getByRole("status")).toContainText("回读验证");
      const bFile = join(home, "Agent开发.pdf");
      const b = await importPDF(bFile, "agent@example.invalid");
      expect(b.versions).toHaveLength(2);
      expect(b.profile.facts["basic.name"]?.value).not.toBe("后端版姓名");
      await page.locator('[id="basic.name"]').fill("Agent版姓名");
      await page
        .locator('[id="basic.name"]')
        .locator("..")
        .getByRole("button", { name: "确认并保存" })
        .click();
      await expect(page.getByRole("status")).toContainText("回读验证");
      await page.getByText("版本名称与附件", { exact: true }).click();
      await page.getByLabel("简历版本名称").fill("Agent 专用版");
      await page.getByRole("button", { name: "保存版本名称" }).click();
      await expect(page.getByRole("status")).toContainText("版本名称已保存");
      if (process.env.JOBAGENT_TEST_SCREENSHOTS)
        await page.screenshot({
          path: `/private/tmp/jobagent-profile-${packaged ? "package" : "dev"}.png`,
        });
      await page.getByLabel("当前简历版本").selectOption(a.selected.id);
      await expect(page.locator('[id="basic.name"]')).toHaveValue("后端版姓名");
      await page.reload();
      await page
        .getByRole("button", { name: "简历与资料", exact: true })
        .click();
      await expect(page.getByLabel("当前简历版本")).toHaveValue(a.selected.id);
      await stop();
      page = await launch();
      await page.getByRole("button", { name: "准备填写", exact: true }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      expect((await state(page)).run).toBeUndefined(); // opening the picker never starts a task
      await page.getByLabel("本次投递简历").selectOption(b.selected.id);
      await page.getByRole("button", { name: "使用此版本并继续" }).click();
      await expect(
        page.getByRole("button", { name: "我已核对，继续", exact: true }),
      ).toBeVisible();
      const run = (await state(page)).run!;
      expect(run.profile?.id).toBe(b.selected.id);
      await expect(page.getByText(/本次简历：Agent 专用版/)).toBeVisible();
      const denied = await page.evaluate(async (id) => {
        try {
          await window.jobagent.invoke({
            method: "switchProfile",
            profileId: id,
          });
          return false;
        } catch {
          return true;
        }
      }, a.selected.id);
      expect(denied).toBe(true);
      await page
        .getByRole("checkbox", { name: "我已核对上述目标与本次操作范围" })
        .check();
      await page
        .getByRole("button", { name: "我已核对，继续", exact: true })
        .click();
      await expect(page.getByText(/该网站没有登录验证规则/)).toBeVisible();
      await page
        .getByRole("checkbox", { name: "我已核对上述目标与本次操作范围" })
        .check();
      await page
        .getByRole("button", { name: "我已核对，继续", exact: true })
        .click();
      await expect.poll(() => captured.name).toBe("Agent版姓名");
      await expect
        .poll(() => captured.bytes, { timeout: 15000 })
        .toBe(readFileSync(bFile).toString("base64"));
      expect((await profile(page)).activeId).toBe(a.selected.id);
      await page
        .getByLabel("邮箱", { exact: true })
        .fill("selected-version@example.invalid");
      await page.getByLabel("答案用途").selectOption("general");
      await page.getByRole("button", { name: "确认答案并继续" }).click();
      await expect
        .poll(async () => {
          const v = (await page.evaluate(
            (profileId) =>
              window.jobagent.invoke({ method: "profile", profileId }),
            b.selected.id,
          )) as ProfileView;
          return v.profile.facts["basic.email"]?.value;
        })
        .toBe("selected-version@example.invalid");
      expect((await profile(page)).profile.facts["basic.email"]?.value).toBe(
        "backend@example.invalid",
      );
      await expect
        .poll(async () => (await state(page)).run?.state)
        .toBe("WAIT_REVIEW");
      await page.getByRole("button", { name: "暂停任务", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "恢复任务", exact: true }),
      ).toBeVisible();
      expect((await state(page)).run?.profile?.id).toBe(b.selected.id);
      await page.getByRole("button", { name: "恢复任务", exact: true }).click();
      await page.reload();
      await page.locator(".job-title").first().click();
      expect((await state(page)).run?.runId).toBe(run.runId);
      expect(await page.evaluate(() => localStorage.length)).toBe(0);
      await stop();
      page = await launch();
      const saved = (await state(page)).rows[0]!.application!;
      expect(saved.profileId).toBe(b.selected.id);
      expect((await profile(page)).activeId).toBe(a.selected.id);
      await stop();
    } finally {
      await stop().catch(() => {});
      const catalog = JSON.parse(
        (await vault.get("profile-catalog")) || "null",
      );
      for (const entry of catalog?.entries ?? []) await vault.delete(entry.key);
      const s = new Store(home);
      for (const app of s.applications())
        await vault.delete(
          "application:" +
            app.id +
            (app.profileId && app.profileId !== "legacy"
              ? ":" + app.profileId
              : ""),
        );
      s.close();
      await vault.delete("profile-catalog");
      await vault.delete("profile");
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(home, { recursive: true, force: true });
    }
  });
