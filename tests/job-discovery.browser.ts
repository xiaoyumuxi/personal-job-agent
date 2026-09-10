import { test, expect } from "@playwright/test";
import { readJob, guardDiscoveryRoutes } from "../src/discovery/sources.js";
test("official ByteDance JD parser excludes related jobs and application controls", async ({
  page,
}) => {
  const url =
    "https://jobs.bytedance.com/campus/position/7682636037198694709/detail";
  await page.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: '<div class="jobDetail"><span data-test="jobTitle">后端实习生</span><div class="job-info"><span>深圳</span><span>实习 ByteIntern</span></div><div class="block-title">职位描述</div><div class="block-content">开发后端服务</div><div class="block-title">职位要求</div><div class="block-content">掌握 Python，2027届毕业</div><button onclick="document.body.dataset.submitted=\'yes\'">投递</button></div><div>相关职位：其他职位要求</div>',
    }),
  );
  await page.goto(url);
  const job = await readJob(page, "bytedance");
  expect(job.kind).toBe("intern");
  expect(job.location).toBe("深圳");
  expect(job.requirements).toBe("掌握 Python，2027届毕业");
  expect(JSON.stringify(job)).not.toContain("相关职位");
  expect(await page.locator("body").getAttribute("data-submitted")).toBeNull();
});
test("Tencent JD parser keeps requirements and bonus distinct, fails closed on missing JD", async ({
  page,
}) => {
  await page.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: '<span class="job-recruit-title">测试开发</span><span class="job-recruit-location">深圳</span><p class="recruit-tips">技术 两年以上工作经验</p><div class="duty"><div class="duty-text">保证软件质量</div></div><div class="requirement"><div class="duty-text">3 年以上测试开发经验</div></div><div class="work-module"><div class="duty-title">加分项</div>Agent 经验优先</div>',
    }),
  );
  await page.goto(
    "https://careers.tencent.com/jobdesc.html?postId=2078028283043299328",
  );
  const job = await readJob(page, "tencent");
  expect(job.requirements).not.toContain("优先");
  expect(job.bonus).toContain("Agent");
  expect(job.kind).toBe("experienced");
  await page.locator(".requirement").evaluate((e) => e.remove());
  await expect(readJob(page, "tencent")).rejects.toThrow("未完整加载");
});

test("read-only routing accepts Tencent popups before Frame creation and blocks apply navigation", async ({
  context,
  page,
}) => {
  const visited: string[] = [];
  await context.route("**/*", (route) => {
    visited.push(route.request().url());
    return route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: route.request().url().includes("search.html")
        ? '<a class="recruit-list-link" href="https://careers.tencent.com/jobdesc.html?postId=2078028283043299328" target="_blank">测试岗位</a>'
        : "<h1>只读详情</h1>",
    });
  });
  await guardDiscoveryRoutes(context, "tencent");
  await page.goto("https://careers.tencent.com/search.html?keyword=test");
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("link", { name: "测试岗位" }).click();
  const popup = await popupPromise;
  await expect(popup.getByRole("heading", { name: "只读详情" })).toBeVisible();
  await expect(
    page.goto("https://careers.tencent.com/apply.html"),
  ).rejects.toThrow();
  expect(visited.some((s) => s.includes("apply.html"))).toBe(false);
});
