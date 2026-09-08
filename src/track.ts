import { createHash } from "node:crypto";
import type { Page, BrowserContext } from "playwright";
import type { Site, Application } from "./types.js";
import type { Config } from "./config.js";
import { findSite } from "./config.js";
import { Store, now } from "./db.js";
import { AgentError, classify, failureState, delay } from "./errors.js";
import {
  navigate,
  verifySession,
  openChrome,
  allowedPage,
} from "./browser/session.js";
import { alert, clearAlert } from "./notify.js";
export interface RemoteApplication {
  jobCode: string;
  batch: string;
  rawStatus: string;
}
export interface ReadResult {
  records: RemoteApplication[];
  coverage: "complete" | "partial";
  evidence: string;
}
export async function readApplications(
  page: Page,
  site: Site,
): Promise<ReadResult> {
  const t = site.tracking;
  if (!site.capabilities.track || !t)
    throw new AgentError("PERMANENT", "NEEDS_ADAPTER");
  await navigate(page, t.url);
  let auth = await verifySession(page, site);
  if (auth === "AUTH_REQUIRED")
    throw new AgentError("AUTH_REQUIRED", "SITE_LOGIN_REQUIRED");
  if (auth !== "VALID") throw new AgentError("PERMANENT", "SESSION_UNKNOWN");
  const records: RemoteApplication[] = [];
  const signatures = new Set<string>();
  let complete = false;
  for (let n = 0; n < t.maxPages; n++) {
    if (!allowedPage(page, site.origins))
      throw new AgentError("PERMANENT", "UNEXPECTED_ORIGIN");
    auth = await verifySession(page, site);
    if (auth === "AUTH_REQUIRED")
      throw new AgentError("AUTH_REQUIRED", "SITE_LOGIN_REQUIRED");
    if (auth !== "VALID") throw new AgentError("PERMANENT", "SESSION_UNKNOWN");
    await page.locator(t.ready).waitFor({ state: "visible", timeout: 10_000 });
    const batch: RemoteApplication[] = [];
    for (const row of await page.locator(t.rows).all()) {
      const code = row.locator(t.jobCode),
        status = row.locator(t.status);
      if ((await code.count()) !== 1 || (await status.count()) !== 1)
        return {
          records,
          coverage: "partial",
          evidence: site.id + ":unrecognized-row",
        };
      batch.push({
        jobCode: (await code.innerText()).trim(),
        batch: t.batch ? (await row.locator(t.batch).innerText()).trim() : "",
        rawStatus: (await status.innerText()).trim().slice(0, 200),
      });
    }
    const marker = t.pageMarker
      ? await page.locator(t.pageMarker).innerText()
      : "";
    const sig = createHash("sha256")
      .update(JSON.stringify([marker, batch]))
      .digest("hex");
    if (signatures.has(sig)) break;
    signatures.add(sig);
    records.push(...batch);
    if (
      t.end &&
      (await page
        .locator(t.end)
        .isVisible()
        .catch(() => false))
    ) {
      complete = true;
      break;
    }
    if (!t.next) {
      complete =
        !!t.end &&
        (await page
          .locator(t.end)
          .isVisible()
          .catch(() => false));
      break;
    }
    const next = page.locator(t.next);
    if (
      (await next.count()) === 1 &&
      (!(await next.isEnabled()) ||
        (await next.getAttribute("aria-disabled")) === "true")
    ) {
      complete = true;
      break;
    }
    if (!t.nextSafe || (await next.count()) !== 1 || !(await next.isVisible()))
      break;
    if (
      (await next.getAttribute("type")) !== "button" &&
      (await next.evaluate((e) => e.tagName)) !== "A"
    )
      break;
    if (
      /提交|投递|预约|同意|submit|apply now|accept|schedule interview/i.test(
        await next.innerText(),
      )
    )
      break;
    await next.click();
    // Wait for changed rendered contents (URL may stay the same).
    const old = JSON.stringify(batch);
    await page
      .waitForFunction(
        ({ rows, code, status, batchSel, old }) =>
          JSON.stringify(
            [...document.querySelectorAll(rows)].map((r) => ({
              jobCode: r.querySelector(code)?.textContent?.trim() ?? "",
              batch: batchSel
                ? (r.querySelector(batchSel)?.textContent?.trim() ?? "")
                : "",
              rawStatus: r.querySelector(status)?.textContent?.trim() ?? "",
            })),
          ) !== old,
        {
          rows: t.rows,
          code: t.jobCode,
          status: t.status,
          batchSel: t.batch,
          old,
        },
        { timeout: 5000 },
      )
      .catch(() => {});
  }
  return {
    records,
    coverage: complete ? "complete" : "partial",
    evidence: `${site.id}:${new URL(t.url).origin}${new URL(t.url).pathname}#${t.rows}`,
  };
}
export function applyObservation(
  store: Store,
  a: Application,
  site: Site,
  result: ReadResult,
) {
  const job = store.job(a.jobId);
  a.lastAttempt = now();
  a.authStatus = "VALID";
  a.queryError = "";
  a.queryRetries = 0;
  const matches = result.records.filter(
    (r) =>
      r.jobCode === job.jobCode &&
      !!job.jobCode &&
      (!site.tracking?.batch || r.batch === job.batch),
  );
  const ambiguousLocal =
    store.applications().filter((other) => {
      const j = store.job(other.jobId);
      return (
        j.id !== job.id &&
        j.tenant === job.tenant &&
        j.account === job.account &&
        j.jobCode === job.jobCode &&
        (!site.tracking?.batch || j.batch === job.batch)
      );
    }).length > 0;
  if (matches.length === 1 && !ambiguousLocal) {
    const r = matches[0]!;
    a.rawStatus = r.rawStatus;
    const mapped = site.tracking?.statusMap[r.rawStatus];
    a.stage = mapped?.stage ?? "UNKNOWN";
    a.outcome = mapped?.outcome ?? "UNKNOWN";
    a.lastSuccess = now();
    a.evidence = result.evidence;
    a.queryStatus = result.coverage === "complete" ? "OK" : "PARTIAL";
    a.nextAction = mapped ? "等待官网后续进度" : "人工确认官网原始状态含义";
  } else {
    a.queryStatus =
      result.coverage === "partial"
        ? "PARTIAL"
        : matches.length === 0
          ? "NOT_FOUND"
          : "UNKNOWN";
    a.nextAction = "人工核查列表覆盖或岗位关联；保留上次可靠进度";
  }
  store.observe(a, {
    coverage: result.coverage,
    queryStatus: a.queryStatus,
    rawStatus: matches.length === 1 ? matches[0]!.rawStatus : null,
    evidence: result.evidence,
  });
  store.save(a, "TRACK_OBSERVATION", {
    queryStatus: a.queryStatus,
    coverage: result.coverage,
  });
}
interface QueryTask {
  failures: number;
  status: string;
  nextAt: number;
}
export async function track(
  store: Store,
  config: Config,
  sites: Site[],
  dir: string,
  wait = delay,
  checkpoint: () => Promise<unknown> = async () => {},
  jobIds?: string[],
) {
  const active = store
    .applications()
    .filter(
      (a) =>
        (!jobIds || jobIds.includes(a.jobId)) &&
        !a.paused &&
        ["SUBMITTED", "UNKNOWN_RESULT"].includes(a.state),
    );
  const groups = new Map<string, { site: Site; apps: Application[] }>();
  for (const a of active) {
    const job = store.job(a.jobId),
      site = job.url ? findSite(sites, job.url) : undefined;
    if (
      !site?.capabilities.track ||
      !site.tracking ||
      !site.login ||
      site.account !== job.account
    ) {
      a.queryStatus = "NEEDS_ADAPTER";
      a.lastAttempt = now();
      a.nextAction = "配置该租户与账户的进度读取规则";
      store.save(a, "TRACK_NEEDS_ADAPTER");
      await alert(
        store,
        dir,
        `site:${job.tenant}:${job.account}`,
        "NEEDS_ADAPTER",
        config.notifications,
      );
      continue;
    }
    const key = `${site.id}:${site.tenant}:${job.account}`;
    if (!groups.has(key)) groups.set(key, { site, apps: [] });
    groups.get(key)!.apps.push(a);
  }
  if (!groups.size) return;
  let context: BrowserContext;
  try {
    context = await openChrome(dir);
  } catch {
    for (const [key, { apps }] of groups) {
      store.task("track:" + key, { status: "STOPPED", failures: 0, nextAt: 0 });
      for (const a of apps) {
        a.lastAttempt = now();
        a.queryStatus = "STOPPED";
        a.queryError = "CHROME_UNAVAILABLE";
        a.nextAction =
          "检查 Chrome 与专用目录占用，再用 retry --operation track";
        store.save(a, "TRACK_BROWSER_UNAVAILABLE");
      }
      await alert(
        store,
        dir,
        "site:" + key,
        "CHROME_UNAVAILABLE",
        config.notifications,
      );
    }
    return;
  }
  const page = await context.newPage();
  // Read-only daily run: no POST/PUT/PATCH/DELETE requests, including in child frames.
  let blocked = 0;
  await context.route("**/*", (route) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(route.request().method())) {
      blocked++;
      return route.abort();
    }
    return route.continue();
  });
  try {
    for (const [key, { site, apps }] of groups) {
      let task = store.task<QueryTask>("track:" + key) ?? {
        failures: 0,
        status: "PENDING",
        nextAt: 0,
      };
      if (
        ["RETRY_EXHAUSTED", "STOPPED"].includes(task.status) ||
        task.nextAt > Date.now()
      )
        continue;
      for (;;) {
        await checkpoint();
        try {
          const before = blocked;
          const result = await readApplications(page, site);
          if (blocked > before) result.coverage = "partial";
          for (const a of apps) applyObservation(store, a, site, result);
          task = { failures: 0, status: "OK", nextAt: 0 };
          store.task("track:" + key, task);
          clearAlert(store, "site:" + key);
          break;
        } catch (error) {
          const e = classify(error);
          const failure = failureState(e, task.failures, config.maxRetries);
          task = {
            failures: failure.failures,
            status: failure.status,
            nextAt:
              failure.status === "RETRY_PENDING"
                ? Date.now() + 1000 * 2 ** Math.max(0, failure.failures - 1)
                : 0,
          };
          store.task("track:" + key, task);
          for (const a of apps) {
            a.lastAttempt = now();
            a.queryStatus =
              e.code === "SESSION_UNKNOWN"
                ? "UNKNOWN"
                : (failure.status as Application["queryStatus"]);
            a.authStatus =
              e.kind === "AUTH_REQUIRED" ? "AUTH_REQUIRED" : "UNKNOWN";
            a.queryError = e.code;
            a.queryRetries = failure.retries;
            a.nextAction =
              e.kind === "AUTH_REQUIRED"
                ? "运行 login，在专用 Chrome 登录后重新查询"
                : "检查站点配置或使用 retry 恢复";
            store.save(a, "TRACK_FAILED", { code: e.code });
          }
          await alert(
            store,
            dir,
            "site:" + key,
            e.kind === "AUTH_REQUIRED" ? "AUTH_REQUIRED" : failure.status,
            config.notifications,
          );
          if (failure.status !== "RETRY_PENDING") break;
          await wait(Math.max(0, task.nextAt - Date.now()));
        }
      }
    }
  } finally {
    await context.close();
  }
}
