import { chromium, type BrowserContext, type Page } from "playwright";
import { profileDir, privateDir, safeUrl } from "../config.js";
import type { Site } from "../types.js";
import { AgentError } from "../errors.js";
export async function openChrome(
  dir: string,
  headless = false,
): Promise<BrowserContext> {
  const p = profileDir(dir);
  privateDir(p);
  return chromium.launchPersistentContext(p, {
    channel: "chrome",
    headless,
    acceptDownloads: false,
    // Playwright defaults otherwise disable native macOS credential encryption.
    ignoreDefaultArgs: ["--use-mock-keychain", "--password-store=basic"],
    viewport: null,
    timeout: 30_000,
  });
}
export async function navigate(page: Page, url: string) {
  safeUrl(url);
  const r = await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  if (r && r.status() >= 500)
    throw new AgentError("TRANSIENT", "SITE_SERVICE_UNAVAILABLE");
  if (r?.status() === 429) throw new AgentError("TRANSIENT", "SITE_RATE_LIMIT");
}
export function allowedPage(page: Page, origins: string[]) {
  try {
    return origins.includes(new URL(page.url()).origin);
  } catch {
    return false;
  }
}
export async function verifySession(
  page: Page,
  site?: Site,
): Promise<"VALID" | "AUTH_REQUIRED" | "UNKNOWN"> {
  if (!site?.login) return "UNKNOWN";
  if (!allowedPage(page, site.origins)) return "UNKNOWN";
  const login = site.login;
  if (
    (site.account !== "default" ||
      login.accountSelector ||
      login.accountText) &&
    (!login.accountSelector || !login.accountText)
  )
    return "UNKNOWN";
  const yes = await page
    .locator(login.authenticated)
    .isVisible()
    .catch(() => false);
  const no = login.unauthenticated
    ? await page
        .locator(login.unauthenticated)
        .isVisible()
        .catch(() => false)
    : false;
  if (yes && no) return "UNKNOWN";
  if (no) return "AUTH_REQUIRED";
  if (!yes) return "UNKNOWN";
  if (login.accountSelector && login.accountText) {
    const account = page.locator(login.accountSelector);
    if (
      (await account.count()) !== 1 ||
      (await account.innerText()).trim() !== login.accountText
    )
      return "UNKNOWN";
  }
  return "VALID";
}
export async function verifyAtApplications(page: Page, site: Site) {
  if (!site.login) return "UNKNOWN" as const;
  await navigate(page, site.login.url);
  return verifySession(page, site);
}
