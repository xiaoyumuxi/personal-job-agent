import { existsSync, readdirSync, accessSync, constants } from "node:fs";
import { basename, join, isAbsolute } from "node:path";
import { homedir } from "node:os";
import {
  ConfigSchema,
  saveConfig,
  loadSites,
  profileDir,
  type Config,
} from "../config.js";
import {
  importProfile,
  loadProfile,
  saveProfile,
  type ProfileImportInfo,
} from "../profile.js";
import type { Store } from "../db.js";
import type { Vault } from "../vault.js";
import type { Profile } from "../types.js";
import { FeishuCLI } from "../feishu/cli.js";
import { scheduleStatus } from "../schedule.js";
import { jobsFromGrid, readJobs } from "../jobs.js";
export async function importJobsFile(
  store: Store,
  config: Config,
  dir: string,
  file?: string,
  text?: string,
  columns = {},
) {
  const grids = await readJobs(file, text);
  const imports = grids.flatMap((g) =>
    jobsFromGrid(g, loadSites(config, dir), columns),
  );
  const results = store.transaction(() => imports.map((j) => store.addJob(j)));
  return {
    imported: results.filter((r) => !r.duplicate).length,
    duplicates: results.filter((r) => r.duplicate).length,
    results,
  };
}
export async function importProfileFile(
  store: Store,
  vault: Vault,
  dir: string,
  file?: string,
  text?: string,
) {
  let extraction: ProfileImportInfo | undefined;
  const draft = await importProfile(file, text, dir, (info) => {
      extraction = info;
    }),
    old = await loadProfile(vault);
  for (const [k, f] of Object.entries(draft.facts)) {
    const prior = old.facts[k];
    if (prior?.state === "confirmed" && f.state === "missing")
      draft.facts[k] = prior;
    else if (
      prior?.state === "confirmed" &&
      f.value !== undefined &&
      JSON.stringify(prior.value) !== JSON.stringify(f.value)
    )
      draft.facts[k] = {
        state: "conflict",
        candidates: [prior.value!, f.value],
        discloseTo: [],
      };
    else if (
      prior?.state === "confirmed" &&
      JSON.stringify(prior.value) === JSON.stringify(f.value)
    )
      draft.facts[k] = prior;
  }
  const merged: Profile = {
    ...old,
    ...draft,
    facts: { ...old.facts, ...draft.facts },
    records: {
      education: [
        ...new Set([...old.records.education, ...draft.records.education]),
      ],
      experience: [
        ...new Set([...old.records.experience, ...draft.records.experience]),
      ],
    },
    resume: draft.resume ?? old.resume,
  };
  await saveProfile(vault, store, merged);
  store.setMeta("profileVersion", {
    at: new Date().toISOString(),
    file: file ? basename(file) : "粘贴文本",
    extraction,
    revision:
      (store.getMeta<{ revision: number }>("profileVersion")?.revision ?? 0) +
      1,
  });
  return loadProfile(vault);
}
export function executable(path: string) {
  try {
    if (!isAbsolute(path)) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
export function discoverCLI(current: string) {
  if (isAbsolute(current)) return current;
  const paths = (process.env.PATH || "").split(":").filter(Boolean);
  paths.push(
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(homedir(), ".local/bin"),
  );
  const nvm = join(homedir(), ".nvm/versions/node");
  if (existsSync(nvm))
    for (const dir of readdirSync(nvm).sort().reverse())
      paths.push(join(nvm, dir, "bin"));
  return paths.map((p) => join(p, "lark-cli")).find(executable) || current;
}
export async function doctor(
  store: Store,
  config: Config,
  dir: string,
  vault: Vault,
) {
  const cliPath = discoverCLI(config.feishu.cli);
  if (cliPath !== config.feishu.cli && executable(cliPath)) {
    config.feishu.cli = cliPath;
    saveConfig(dir, config);
  }
  const result = {
    at: new Date().toISOString(),
    node: process.version,
    home: dir,
    chrome: existsSync(config.browser.executablePath),
    chromePath: config.browser.executablePath,
    chromeProfile: profileDir(dir),
    feishuCLIPath: cliPath,
    feishuCLI: "不可用",
    feishuUserAuth: "UNKNOWN",
    feishuTable: "NOT_TESTED",
    feishuConfigured:
      config.feishu.enabled &&
      !!config.feishu.baseToken &&
      !!config.feishu.tableId,
    modelConfigured:
      config.model.enabled && config.model.consent && !!config.model.name,
    modelKeyPresent: false,
    modelConnection: store.getMeta("modelCheck") ?? { status: "NOT_TESTED" },
    keychain: "不可用",
    schedule: await scheduleStatus(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    daily: store.task("daily") ?? null,
    sites: loadSites(config, dir).map((s) => ({
      id: s.id,
      name: s.name,
      fill: s.capabilities.fill,
      track: s.capabilities.track,
    })),
  };
  try {
    await vault.get("doctor-nonexistent");
    result.keychain = "可访问";
    result.modelKeyPresent = !!(await vault.get("model-key"));
  } catch {}
  const cli = new FeishuCLI(config.feishu);
  try {
    const v = await cli.raw(["--version"]);
    if (v.code === 0 && v.stdout.includes("lark-cli version"))
      result.feishuCLI = v.stdout.trim().slice(0, 120);
  } catch {}
  try {
    await cli.auth();
    result.feishuUserAuth = "VALID";
  } catch {
    result.feishuUserAuth =
      result.feishuCLI === "不可用" ? "UNKNOWN" : "AUTH_REQUIRED";
  }
  if (result.feishuConfigured && result.feishuUserAuth === "VALID") {
    try {
      await cli.check();
      result.feishuTable = "VALID";
    } catch {
      result.feishuTable = "FAILED";
    }
  }
  store.setMeta("doctor", result);
  return result;
}
export async function checkModel(store: Store, c: Config, vault: Vault) {
  const key = await vault.get("model-key");
  let status = "NOT_CONFIGURED";
  if (c.model.enabled && c.model.consent && key && c.model.name) {
    if (new URL(c.model.endpoint).protocol !== "https:")
      throw new Error("模型端点必须为 HTTPS");
    try {
      const res = await fetch(c.model.endpoint, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30000),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: c.model.name,
          messages: [
            {
              role: "user",
              content:
                "Reply OK. This is a connectivity check; no personal data is included.",
            },
          ],
          max_tokens: 8,
        }),
      });
      const payload = (await res.json()) as {
        choices?: { message?: { content?: unknown } }[];
      };
      status =
        res.ok && typeof payload.choices?.[0]?.message?.content === "string"
          ? "VALID"
          : "FAILED";
    } catch {
      status = "FAILED";
    }
  }
  const check = { status, at: new Date().toISOString() };
  store.setMeta("modelCheck", check);
  return check;
}
