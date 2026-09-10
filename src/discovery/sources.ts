import { chromium, type Page, type BrowserContext } from "playwright";
import {
  sources,
  type Preferences,
  type PublicJob,
  type SourceId,
} from "./types.js";

export function officialJobUrl(source: SourceId, raw: string) {
  const u = new URL(raw);
  const valid =
    u.origin === sources[source].origin &&
    !u.username &&
    !u.password &&
    (source === "tencent"
      ? u.pathname === "/jobdesc.html" &&
        /^\d{10,30}$/.test(u.searchParams.get("postId") || "")
      : /^\/campus\/position\/\d{10,30}\/detail$/.test(u.pathname));
  if (!valid) throw new Error("岗位链接超出已支持的官网范围");
  const externalId =
    source === "tencent"
      ? u.searchParams.get("postId")!
      : u.pathname.split("/")[3]!;
  return {
    url:
      source === "tencent"
        ? `${u.origin}/jobdesc.html?postId=${externalId}`
        : `${u.origin}${u.pathname}`,
    externalId,
  };
}
export async function readJob(
  page: Page,
  source: SourceId,
): Promise<PublicJob> {
  const titleSelector =
    source === "tencent"
      ? ".job-recruit-title"
      : '.jobDetail [data-test="jobTitle"]';
  await page
    .locator(titleSelector)
    .first()
    .waitFor({ state: "visible", timeout: 18000 });
  const parts = await page.evaluate((source) => {
    const text = (selector: string) =>
      (
        document.querySelector(selector) as HTMLElement | null
      )?.innerText.trim() || "";
    if (source === "tencent")
      return {
        title: text(".job-recruit-title"),
        location: text(".job-recruit-location"),
        metadata: text(".recruit-tips"),
        description: text(".duty .duty-text"),
        requirements: text(".requirement .duty-text"),
        bonus: Array.from(document.querySelectorAll(".work-module"))
          .filter(
            (e) =>
              e.querySelector(".duty-title")?.textContent?.trim() === "加分项",
          )
          .map((e) => (e as HTMLElement).innerText)
          .join("\n"),
      };
    const section = (name: string) =>
      (
        Array.from(document.querySelectorAll(".jobDetail .block-title")).find(
          (e) => e.textContent?.trim() === name,
        )?.nextElementSibling as HTMLElement | undefined
      )?.innerText.trim() || "";
    return {
      title: text('.jobDetail [data-test="jobTitle"]'),
      location: text(".jobDetail .job-info > span:first-child"),
      metadata: text(".jobDetail .job-info"),
      description: section("职位描述"),
      requirements: section("职位要求"),
      bonus: "",
    };
  }, source);
  if (!parts.title || !parts.description || !parts.requirements)
    throw new Error("官网 JD 未完整加载或页面结构已变化");
  if (JSON.stringify(parts).length > 16000)
    throw new Error("官网 JD 超出本次读取上限，需人工查看完整内容");
  return {
    ...parts,
    ...officialJobUrl(source, page.url()),
    source,
    kind:
      source === "tencent"
        ? "experienced"
        : /实习|ByteIntern/i.test(parts.metadata)
          ? "intern"
          : "campus",
    fetchedAt: new Date().toISOString(),
  };
}
export interface CrawlOptions {
  preferences: Preferences;
  executablePath: string;
  signal: AbortSignal;
  checkpoint: () => Promise<unknown>;
  step: (s: string) => void;
  onJob: (job: PublicJob) => Promise<void>;
  onIssue: (issue: string) => void;
}
export type Crawl = (options: CrawlOptions) => Promise<void>;
export async function guardDiscoveryRoutes(
  context: BrowserContext,
  source: SourceId,
) {
  const origin = sources[source].origin;
  await context.route("**/*", async (route) => {
    try {
      const req = route.request();
      // Popup navigation can arrive before a Frame exists. Inspect the URL only.
      if (req.isNavigationRequest()) {
        const u = new URL(req.url());
        const allowed =
          u.origin === origin &&
          (source === "tencent"
            ? ["/search.html", "/jobdesc.html"].includes(u.pathname)
            : u.pathname === "/campus/position" ||
              /^\/campus\/position\/\d+\/detail$/.test(u.pathname));
        if (!allowed) {
          await route.abort();
          return;
        }
      }
      if (["image", "media", "font"].includes(req.resourceType()))
        await route.abort();
      else await route.fallback();
    } catch {
      await route.abort().catch(() => {});
    }
  });
}
export const crawl: Crawl = async (o) => {
  // New anonymous context: no access to the dedicated application login profile.
  const browser = await chromium.launch({
    executablePath: o.executablePath,
    headless: true,
  });
  const abort = () => {
    void browser.close().catch(() => {});
  };
  o.signal.addEventListener("abort", abort, { once: true });
  try {
    o.signal.throwIfAborted();
    for (const source of o.preferences.sources) {
      await o.checkpoint();
      o.signal.throwIfAborted();
      const context = await browser.newContext({
        acceptDownloads: false,
        serviceWorkers: "block",
      });
      const origin = sources[source].origin;
      await guardDiscoveryRoutes(context, source);
      const list = await context.newPage();
      list.setDefaultTimeout(15000);
      try {
        o.step(`读取${sources[source].name}的搜索结果`);
        const url =
          source === "tencent"
            ? `${origin}/search.html?keyword=${encodeURIComponent(o.preferences.keyword)}`
            : `${origin}/campus/position?keywords=${encodeURIComponent(o.preferences.keyword)}&current=1&limit=10`;
        await list.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
        const cards = list.locator(
          source === "tencent"
            ? "a.recruit-list-link"
            : 'a[href^="/campus/position/"][href$="/detail"]',
        );
        // A transient “0” during hydration is never treated as a completed empty search.
        await cards.first().waitFor({ state: "visible", timeout: 20000 });
        const count = Math.min(await cards.count(), o.preferences.maxJobs);
        const seen = new Set<string>();
        for (let i = 0; i < count; i++) {
          await o.checkpoint();
          o.signal.throwIfAborted();
          o.step(
            `${sources[source].name}：读取第 ${i + 1} / ${count} 个完整 JD`,
          );
          let detail: Page | undefined;
          try {
            if (source === "tencent") {
              // Only this observed read-only job card may be clicked; never apply/login buttons.
              const opened = list.waitForEvent("popup", { timeout: 15000 });
              const values = await Promise.allSettled([
                opened,
                cards.nth(i).click(),
              ]);
              if (values[0]!.status === "fulfilled") detail = values[0].value;
              else throw new Error("岗位详情未能打开");
              if (values[1]!.status === "rejected")
                throw new Error("岗位链接读取失败");
              await detail.waitForURL(
                (u) => u.origin === origin && u.pathname === "/jobdesc.html",
                { timeout: 15000 },
              );
            } else {
              const target = officialJobUrl(
                source,
                new URL((await cards.nth(i).getAttribute("href"))!, origin)
                  .href,
              );
              detail = await context.newPage();
              await detail.goto(target.url, {
                waitUntil: "domcontentloaded",
                timeout: 25000,
              });
            }
            const job = await readJob(detail, source);
            if (!seen.has(job.externalId)) {
              seen.add(job.externalId);
              await o.onJob(job);
            }
          } catch {
            o.signal.throwIfAborted();
            o.onIssue(
              `${sources[source].name}第 ${i + 1} 个 JD 未完整读取或保存，已跳过；可缩小关键词后重试。`,
            );
          } finally {
            await detail?.close().catch(() => {});
          }
        }
      } catch {
        o.signal.throwIfAborted();
        o.onIssue(
          `${sources[source].name}搜索未完成：可能无结果、需要验证或官网结构已变化。未将其判为零岗位或岗位下架。`,
        );
      } finally {
        await context.close();
      }
    }
  } finally {
    o.signal.removeEventListener("abort", abort);
    await browser.close().catch(() => {});
  }
};
