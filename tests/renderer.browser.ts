import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdirSync } from "node:fs";
import type {
  Snapshot,
  Row,
  ProfileView,
  SettingsView,
  Command,
} from "../desktop/contract.js";
import { ConfigSchema } from "../src/config.js";
import type {
  DiscoveryPreview,
  DiscoveryBatch,
} from "../src/discovery/types.js";

const rows: Row[] = [
  "待审核公司",
  "待准备公司",
  "缺少链接公司",
  "结果待核查公司",
  "面试中公司",
].map((company, i) => ({
  job: {
    id: `job-${i}`,
    company,
    title: "测试开发岗位",
    batch: "测试批次",
    jobCode: "",
    url: i === 2 ? "" : `https://example.invalid/jobs/${i}`,
    tenant: "test",
    account: "default",
    referral: "",
    source: "renderer-test.csv",
    channel: i === 2 ? "NEEDS_CHANNEL" : "READY",
  },
  attention: "NORMAL",
  permissions: { apply: i < 3, track: i >= 3, login: true, open: i !== 2 },
}));
for (const i of [0, 3, 4])
  rows[i]!.application = {
    id: `application-${i}`,
    jobId: rows[i]!.job.id,
    state: i === 0 ? "REVIEW" : i === 3 ? "UNKNOWN_RESULT" : "SUBMITTED",
    rawStatus: i === 4 ? "技术面试安排中" : "",
    stage: i === 4 ? "INTERVIEW" : "UNKNOWN",
    outcome: "IN_PROGRESS",
    authStatus: "VALID",
    queryStatus: "OK",
    syncStatus: i === 4 ? "AUTH_REQUIRED" : "NEVER",
    lastAttempt: "2026-09-10T01:20:00.000Z",
    lastSuccess: null,
    submittedAt: null,
    evidence: i === 4 ? "manual-confirmation" : null,
    nextAction: "",
    queryError: "",
    syncError: "",
    queryRetries: 0,
    syncRetries: 0,
    priority: "",
    paused: false,
    note: "",
    deadline: "",
    revision: 1,
  };
const baseSnapshot: Snapshot = {
  rows,
  busy: false,
  lock: false,
  events: [],
  dataDir: "/test-only",
};
const version = {
  id: "version-a",
  name: "测试简历 A",
  revision: 1,
  file: "test-a.pdf",
  at: "2026-09-10T00:00:00Z",
};
const profiles = ["a", "b"].map((id) => ({
  selected: {
    ...version,
    id: `version-${id}`,
    name: `测试简历 ${id.toUpperCase()}`,
  },
  versions: [version, { ...version, id: "version-b", name: "测试简历 B" }],
  activeId: "version-a",
  profile: {
    version: 1,
    records: { education: ["edu"], experience: [], project: [] },
    facts: {
      "basic.name": {
        state: "confirmed",
        value: `测试姓名 ${id}`,
        discloseTo: [],
      },
      "basic.email": {
        state: "conflict",
        value: "old@example.invalid",
        candidates: ["new@example.invalid", "old@example.invalid"],
        source: { text: "原文邮箱：new@example.invalid" },
        discloseTo: [],
      },
      "education.edu.school": {
        state: "pending",
        value: "测试大学",
        discloseTo: [],
      },
    },
  },
  fields: [
    { path: "basic.name", label: "姓名", section: "基本信息" },
    { path: "basic.email", label: "邮箱", section: "基本信息" },
    {
      path: "education.edu.school",
      label: "学校",
      section: "教育经历 1 · 测试大学",
    },
  ],
})) as ProfileView[];
const settings = {
  home: "/test-only",
  chromeProfile: "/test-only/chrome",
  sites: [
    { id: "example", name: "测试站点", fill: true, login: false, track: false },
  ],
  config: ConfigSchema.parse({}),
  modelConnection: { status: "NOT_TESTED" },
  timezone: "Asia/Singapore",
  schedule: {
    installed: false,
    plistExists: false,
    path: "/test-only/schedule",
  },
  daily: null,
  authPending: false,
  feishuTemplate: { columns: [], views: [] },
} as SettingsView;
interface Harness {
  snapshot: Snapshot;
  calls: Command[];
  profiles: ProfileView[];
  settings: SettingsView;
  failures: string[];
  emit: () => void;
}
declare global {
  interface Window {
    rendererTest: Harness;
  }
}
async function launch(page: Page, snapshot: Snapshot = baseSnapshot) {
  await page.addInitScript(
    ({ snapshot, profiles, settings }) => {
      let activeId = profiles[0]!.selected.id;
      const listeners = new Set<() => void>();
      const harness: Harness = {
        snapshot,
        profiles,
        settings,
        calls: [],
        failures: [],
        emit: () => listeners.forEach((fn) => fn()),
      };
      window.rendererTest = harness;
      const view = (id = activeId) => ({
        ...harness.profiles.find((v) => v.selected.id === id)!,
        activeId,
      });
      window.jobagent = {
        invoke: async (command) => {
          harness.calls.push(command);
          if (command.method === "snapshot")
            return structuredClone(harness.snapshot);
          if (command.method === "profile")
            return structuredClone(view(command.profileId));
          if (command.method === "profileVersions")
            return structuredClone(view());
          if (command.method === "history") return [];
          if (command.method === "settings")
            return structuredClone(harness.settings);
          if (
            command.method === "discoverFeishuCLI" ||
            command.method === "checkFeishuAuth"
          )
            return undefined;
          if (command.method === "switchProfile") {
            activeId = command.profileId;
            return view();
          }
          if (command.method === "saveFact") {
            if (harness.failures.includes(command.path))
              throw new Error("测试保存失败：请重试此字段");
            const v = view(command.profileId);
            v.profile.facts[command.path] = {
              state: "confirmed",
              value: command.value,
              discloseTo: [],
            };
            return structuredClone(v);
          }
          if (command.method === "record") {
            const v = view(command.profileId);
            v.profile.records[command.kind].push(command.id);
            return structuredClone(v);
          }
          if (command.method === "saveSettings") {
            harness.settings.config = {
              ...harness.settings.config,
              feishu: command.feishu,
              model: command.model,
              schedule: command.schedule,
            };
            return true;
          }
          if (command.method === "schedule" && command.action === "plan")
            return { message: "测试计划：每天查询已保存申请" };
          return true;
        },
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        chooseFile: async () => null,
        exportDiagnostics: async () => null,
        chooseDataDirectory: async () => false,
        openFeishuAuth: async () => {},
      };
    },
    { snapshot, profiles, settings },
  );
  await page.goto(pathToFileURL(resolve("desktop-build/index.html")).href);
  await expect(
    page.getByRole("heading", { name: "投递工作台", exact: true }),
  ).toBeVisible();
}
async function setRun(
  page: Page,
  state: NonNullable<Snapshot["run"]>["state"],
  kind?: "confirm" | "login" | "review",
  jobId: string | undefined = "job-0",
) {
  await page.evaluate(
    ({ state, kind, jobId }) => {
      const h = window.rendererTest;
      h.snapshot.busy = true;
      h.snapshot.lock = true;
      h.snapshot.run = {
        runId: "test-run",
        jobId,
        operation: "apply",
        state,
        at: new Date().toISOString(),
        step: "真实合约测试步骤",
        profile: { id: "version-a", name: "任务绑定简历", revision: 7 },
        request: kind
          ? {
              requestId: `request-${state}-${kind}`,
              kind,
              message: "请核对本次目标和资料范围",
              site: "https://example.invalid",
              issues: kind === "review" ? [] : undefined,
            }
          : undefined,
      };
      h.emit();
    },
    { state, kind, jobId },
  );
}
const output = resolve("outputs/ui-redesign");
async function screenshot(page: Page, name: string) {
  mkdirSync(output, { recursive: true });
  await page.screenshot({ path: resolve(output, name), fullPage: true });
}

test("workbench uses five columns, real attention counts, safe actions and preserves search on return", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await launch(page);
  await expect(page.getByRole("columnheader")).toHaveCount(5);
  await expect(page.getByRole("region", { name: "待我接管" })).toContainText(
    "先处理这 2 件事",
  );
  await expect(page.getByText("技术面试安排中", { exact: true })).toBeVisible();
  await screenshot(page, "01-workbench.png");
  await page
    .getByRole("button", { name: /待准备/, exact: false })
    .filter({ hasText: "2" })
    .click();
  await page.getByLabel("搜索公司或岗位").fill("缺少链接");
  await page.getByRole("button", { name: "补充链接", exact: true }).click();
  await expect(page.getByLabel("补充官网投递入口")).toBeVisible();
  await page.getByRole("button", { name: "← 返回工作台" }).click();
  await expect(page.getByLabel("搜索公司或岗位")).toHaveValue("缺少链接");
  await expect(
    page.getByRole("button", { name: /待准备/ }).filter({ hasText: "1" }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("搜索公司或岗位").fill("没有这家公司");
  await expect(
    page.getByRole("heading", { name: "没有匹配的岗位" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "清除搜索与筛选" }).click();
  await page.evaluate(() => {
    const h = window.rendererTest,
      seed = h.snapshot.rows[1]!;
    h.snapshot.rows = Array.from({ length: 35 }, (_, i) => ({
      ...seed,
      job: { ...seed.job, id: `scroll-${i}`, company: `滚动测试 ${i}` },
    }));
    h.emit();
  });
  const target = page.locator(".job-title").nth(25);
  await target.scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(0);
  await target.click();
  await page.getByRole("button", { name: "← 返回工作台" }).click();
  await expect
    .poll(async () =>
      Math.abs((await page.evaluate(() => window.scrollY)) - before),
    )
    .toBeLessThan(2);
});

test("task workspace separates browser focus, receipts, consent and pause transitions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await launch(page);
  await setRun(page, "WAIT_REVIEW", "confirm");
  await page.locator(".job-title").first().click();
  const confirm = page.getByRole("button", {
    name: "我已核对，继续",
    exact: true,
  });
  await expect(confirm).toBeDisabled();
  await page
    .getByRole("checkbox", { name: "我已核对上述目标与本次操作范围" })
    .check();
  await confirm.click();
  expect(
    await page.evaluate(() =>
      window.rendererTest.calls.filter((c) => c.method === "answer"),
    ),
  ).toEqual([
    {
      method: "answer",
      runId: "test-run",
      requestId: "request-WAIT_REVIEW-confirm",
      answer: { action: "confirm", accepted: true },
    },
  ]);
  await screenshot(page, "05-disclosure.png");
  await setRun(page, "WAIT_REVIEW", "review");
  await page
    .getByRole("button", { name: "前往官网审核并提交", exact: true })
    .click();
  expect(
    await page.evaluate(() =>
      window.rendererTest.calls.filter((c) => c.method === "control").at(-1),
    ),
  ).toEqual({ method: "control", runId: "test-run", action: "focus" });
  await page
    .getByRole("button", { name: "我已提交，检查回执", exact: true })
    .click();
  expect(
    await page.evaluate(() =>
      window.rendererTest.calls.filter((c) => c.method === "answer").at(-1),
    ),
  ).toMatchObject({ answer: { action: "submitted" } });
  await screenshot(page, "02-task-workspace.png");
  await setRun(page, "PAUSING", "review");
  await expect(
    page.getByRole("button", { name: "我已提交，检查回执", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "恢复任务", exact: true }),
  ).toHaveCount(0);
  await setRun(page, "PAUSED", "review");
  await page.getByRole("button", { name: "恢复任务", exact: true }).click();
  expect(
    await page.evaluate(() =>
      window.rendererTest.calls.filter((c) => c.method === "control").at(-1),
    ),
  ).toMatchObject({ action: "resume" });
  await setRun(page, "WAIT_LOGIN", "login");
  await page.getByRole("button", { name: "已完成登录，重新检查" }).click();
  await expect(
    page.getByRole("heading", { name: "完成官网登录", exact: true }),
  ).toBeVisible(); // No optimistic login success.
});

test("unknown submissions keep manual evidence explicit; global requests are reachable", async ({
  page,
}) => {
  await launch(page);
  await page.getByRole("button", { name: "核查结果", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "选择简历并准备填写" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "记录核查结果" }).click();
  await page
    .getByRole("button", { name: "本人确认已提交", exact: true })
    .click();
  expect(
    await page.evaluate(() =>
      window.rendererTest.calls
        .filter((c) => c.method === "application")
        .at(-1),
    ),
  ).toMatchObject({ action: "submitted", confirmed: true, jobId: "job-3" });
  await page.getByRole("button", { name: "← 返回工作台" }).click();
  await page.locator(".job-title").filter({ hasText: "面试中公司" }).click();
  await expect(
    page.getByText("本人核查记录（非官网回执验证）", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "← 返回工作台" }).click();
  await setRun(page, "WAIT_REVIEW", "confirm", "global-placeholder");
  await page.evaluate(() => {
    delete window.rendererTest.snapshot.run!.jobId;
    window.rendererTest.emit();
  });
  await page.getByRole("button", { name: /处理工作空间任务/ }).click();
  await expect(
    page.getByRole("heading", { name: "工作空间任务", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "我已核对，继续", exact: true }),
  ).toBeDisabled();
});

test("profile candidates remain drafts, failed fields stay pending, drafts survive groups and versions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await launch(page);
  await page.getByRole("button", { name: "简历与资料", exact: true }).click();
  await expect(page.getByText("1 / 3 项已确认", { exact: true })).toBeVisible();
  await page.locator('[id="basic.email"]').focus();
  await page
    .getByRole("button", { name: "new@example.invalid", exact: true })
    .click();
  await expect(page.locator('[id="basic.email"]')).toHaveValue(
    "new@example.invalid",
  );
  expect(
    await page.evaluate(() =>
      window.rendererTest.calls.filter((c) => c.method === "saveFact"),
    ),
  ).toHaveLength(0);
  await page.locator('[id="basic.name"]').fill("尚未保存姓名");
  await expect(page.getByText("0 / 3 项已确认", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.rendererTest.failures = ["basic.name"];
  });
  await page
    .locator("form.fact")
    .filter({ has: page.locator('[id="basic.name"]') })
    .getByRole("button", { name: "确认并保存" })
    .click();
  await expect(page.locator('[id="basic.name"]')).toHaveValue("尚未保存姓名");
  await expect(
    page
      .locator("form.fact")
      .filter({ has: page.locator('[id="basic.name"]') }),
  ).toContainText("测试保存失败");
  await page
    .locator("form.fact")
    .filter({ has: page.locator('[id="basic.email"]') })
    .getByRole("button", { name: "确认并保存" })
    .click();
  await expect(page.getByText("1 / 3 项已确认", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /教育经历 1/ }).click();
  await page.getByRole("button", { name: /基本信息/ }).click();
  await expect(page.locator('[id="basic.name"]')).toHaveValue("尚未保存姓名");
  await page.getByLabel("当前简历版本").selectOption("version-b");
  await expect(page.locator('[id="basic.name"]')).toHaveValue("测试姓名 b");
  await page.getByLabel("当前简历版本").selectOption("version-a");
  await expect(page.locator('[id="basic.name"]')).toHaveValue("尚未保存姓名");
  await page.getByRole("button", { name: "投递工作台", exact: true }).click();
  await page.getByRole("button", { name: "简历与资料", exact: true }).click();
  await expect(page.locator('[id="basic.name"]')).toHaveValue("尚未保存姓名");
  await screenshot(page, "03-profile.png");
  await page.getByRole("button", { name: "投递工作台", exact: true }).click();
  await page.getByRole("button", { name: "准备填写", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "此版本有 1 项未确认草稿",
  );
  await expect(
    page.getByRole("button", { name: "使用此版本并继续" }),
  ).toBeDisabled();
  await page.getByLabel("本次投递简历").selectOption("version-b");
  await expect(
    page.getByRole("button", { name: "使用此版本并继续" }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "简历与资料", exact: true }).click();
  await page.getByRole("button", { name: "放弃本次修改", exact: true }).click();
  await expect(page.locator('[id="basic.name"]')).toHaveValue("测试姓名 a");
});

test("settings keep drafts across categories and optional features do not pretend to be verified", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await launch(page);
  await page.getByRole("button", { name: "设置与连接", exact: true }).click();
  await expect(page.getByRole("button", { name: /专用 Chrome/ })).toContainText(
    "未检测",
  );
  await expect(
    page
      .getByRole("button", { name: /模型辅助/ })
      .filter({ has: page.locator("p") }),
  ).toContainText("可选 · 未启用");
  await screenshot(page, "04-settings.png");
  await page.getByRole("button", { name: "模型辅助", exact: true }).click();
  await page.getByLabel("模型名称", { exact: true }).fill("draft-model");
  await page.getByRole("button", { name: "飞书同步", exact: true }).click();
  await page.getByLabel("目标 Table ID", { exact: true }).fill("draft-table");
  await page.getByRole("button", { name: "模型辅助", exact: true }).click();
  await expect(page.getByLabel("模型名称", { exact: true })).toHaveValue(
    "draft-model",
  );
  expect(
    await page.evaluate(() => window.rendererTest.settings.config.model.name),
  ).not.toBe("draft-model");
  await page.getByRole("button", { name: "每日查询", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "确认上述影响并安装…", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "预览已保存时间的调度" }).click();
  await expect(
    page.getByRole("button", { name: "确认上述影响并安装…", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      window.rendererTest.calls.some(
        (c) => c.method === "schedule" && c.action === "install",
      ),
    ),
  ).toBe(false);
  await page.getByRole("button", { name: "站点规则", exact: true }).click();
  await expect(
    page.getByText("登录验证：待配置", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("进度查询：待配置", { exact: true }),
  ).toBeVisible();
});

test("empty onboarding, dialog keyboard behavior and responsive pages do not overflow", async ({
  page,
}) => {
  await launch(page, { ...baseSnapshot, rows: [] });
  await expect(
    page.getByRole("region", { name: "首次使用准备" }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "待我接管" })).toHaveCount(0);
  await screenshot(page, "06-first-use.png");
  await page.evaluate((rows) => {
    window.rendererTest.snapshot.rows = rows;
    window.rendererTest.emit();
  }, rows);
  await page.getByRole("button", { name: "准备填写", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() => !!document.activeElement?.closest("dialog")),
    ).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "准备填写", exact: true }),
  ).toBeFocused();
  for (const width of [1440, 1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const name of ["投递工作台", "简历与资料", "设置与连接"]) {
      await page.getByRole("button", { name, exact: true }).click();
      await expect(
        page.getByRole("heading", { name, exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    }
    await page.getByRole("button", { name: "投递工作台", exact: true }).click();
    await setRun(page, "WAIT_REVIEW", "review");
    await page.locator(".job-title").first().click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    if (width === 1280 || width === 390)
      await screenshot(page, `task-${width}.png`);
  }
});

test("official discovery previews independent consent, keeps drafts and wires explicit selections", async ({
  page,
}) => {
  await launch(page);
  await page.evaluate(() => {
    const original = window.jobagent.invoke;
    let preview: DiscoveryPreview | undefined;
    let batch: DiscoveryBatch | null = null;
    window.jobagent.invoke = async (c) => {
      if (
        ![
          "discoveryView",
          "discoveryPreview",
          "discoveryDecision",
          "discoveryOpen",
        ].includes(c.method) &&
        !(c.method === "start" && c.operation === "discover")
      )
        return original(c);
      window.rendererTest.calls.push(c);
      if (c.method === "discoveryView") return structuredClone(batch);
      if (c.method === "discoveryPreview") {
        preview = {
          id: "preview-test",
          expiresAt: Date.now() + 60000,
          profile: window.rendererTest.profiles[0]!.selected,
          preferences: c.preferences,
          facts: [{ id: "F1", label: "技能", value: "Python 后端服务开发" }],
          omitted: 3,
          ...(c.preferences.mode === "ai"
            ? {
                model: {
                  name: "fixture",
                  endpoint: "https://model.example.invalid/chat",
                },
              }
            : {}),
        };
        return structuredClone(preview);
      }
      if (c.method === "start" && preview) {
        batch = {
          id: "batch-test",
          at: new Date().toISOString(),
          profile: preview.profile,
          preferences: preview.preferences,
          facts: preview.facts,
          status: "completed",
          issues: [],
          stale: false,
          results: [
            {
              id: "result-test",
              job: {
                source: "bytedance",
                externalId: "7682636037198694709",
                url: "https://jobs.bytedance.com/campus/position/7682636037198694709/detail",
                title: "后端工程师 · 合约测试",
                location: "深圳",
                metadata: "2027届校园招聘",
                kind: "campus",
                description: "开发服务",
                requirements: "熟悉 Python",
                bonus: "",
                fetchedAt: new Date().toISOString(),
              },
              grade: "consider",
              analysis: "ai",
              rules: [],
              assessment: {
                grade: "consider",
                summary: "有相关经验，毕业要求仍需确认",
                evidence: [
                  {
                    kind: "match",
                    reason: "技能相关",
                    jdQuote: "熟悉 Python",
                    factId: "F1",
                    factQuote: "Python",
                  },
                ],
              },
            },
          ],
        };
        window.rendererTest.snapshot.run = {
          runId: batch.id,
          operation: "discover",
          state: "COMPLETED",
          step: "已保存 1 个岗位及其判断依据",
          at: new Date().toISOString(),
        };
        window.rendererTest.emit();
        return true;
      }
      if (c.method === "discoveryDecision" && batch) {
        const item = batch.results[0]!;
        item.decision = c.decision;
        if (c.decision === "keep") item.jobId = "job-1";
        return structuredClone(item);
      }
      return true;
    };
  });
  await page.getByRole("button", { name: "官网找岗位", exact: true }).click();
  await page.getByLabel("岗位关键词", { exact: true }).fill("后端");
  await page.getByLabel("意向城市", { exact: true }).fill("深圳，上海");
  await page.getByRole("button", { name: "设置与连接", exact: true }).click();
  await page.getByRole("button", { name: "投递工作台", exact: true }).click();
  await page.getByRole("button", { name: "官网找岗位", exact: true }).click();
  await expect(page.getByLabel("岗位关键词", { exact: true })).toHaveValue(
    "后端",
  );
  await page.getByLabel("判断方式", { exact: true }).selectOption("ai");
  await page.getByRole("button", { name: "预览并准备启动" }).click();
  await expect(
    page.getByRole("heading", { name: "确认这次交给 AI 的资料" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "开始读取与筛选" }),
  ).toBeDisabled();
  await page
    .getByRole("checkbox", {
      name: "我已核对以上内容，同意本次发送到这个模型服务",
    })
    .check();
  await page.getByRole("button", { name: "开始读取与筛选" }).click();
  await expect(
    page.getByRole("heading", { name: "已读取 1 个岗位" }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "岗位判断依据" })).toHaveCount(
    0,
  );
  await expect(page.getByText("JD 原文", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() =>
      window.rendererTest.calls.filter(
        (c) => c.method === "start" && c.operation === "discover",
      ),
    ),
  ).toEqual([
    {
      method: "start",
      operation: "discover",
      previewId: "preview-test",
      cloudConsent: true,
    },
  ]);
  expect(
    await page.evaluate(() =>
      window.rendererTest.calls.some((c) => c.method === "discoveryDecision"),
    ),
  ).toBe(false);
  await page.getByRole("button", { name: "在浏览器查看官网" }).click();
  expect(
    await page.evaluate(() =>
      window.rendererTest.calls.some((c) => c.method === "discoveryOpen"),
    ),
  ).toBe(true);
  for (const width of [1440, 1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    if (width === 1280) await screenshot(page, "07-job-discovery.png");
  }
  await page.getByRole("button", { name: "加入工作台", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "前往工作台继续" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "前往工作台继续" }).click();
  await expect(page.getByRole("button", { name: "返回工作台" })).toBeVisible();
});
