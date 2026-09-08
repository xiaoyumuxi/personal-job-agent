import {
  readFileSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  chmodSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { SiteSchema, MappingSchema, type Site } from "./types.js";
export const ROOT = fileURLToPath(
  new URL(import.meta.url.includes("/dist/") ? "../.." : "..", import.meta.url),
);
export const ConfigSchema = z.object({
  version: z.literal(1).default(1),
  maxRetries: z.number().int().min(0).max(3).default(3),
  maxSteps: z.number().int().min(1).max(50).default(15),
  maxActions: z.number().int().min(1).max(300).default(100),
  siteFiles: z.array(z.string()).default([]),
  mappingFile: z.string().optional(),
  feishu: z
    .object({
      enabled: z.boolean().default(false),
      cli: z.string().default("lark-cli"),
      baseToken: z.string().default(""),
      tableId: z.string().default(""),
    })
    .default({ enabled: false, cli: "lark-cli", baseToken: "", tableId: "" }),
  model: z
    .object({
      enabled: z.boolean().default(false),
      endpoint: z
        .string()
        .url()
        .default("https://api.openai.com/v1/chat/completions"),
      name: z.string().default(""),
      consent: z.boolean().default(false),
    })
    .default({
      enabled: false,
      endpoint: "https://api.openai.com/v1/chat/completions",
      name: "",
      consent: false,
    }),
  schedule: z
    .object({
      hour: z.number().int().min(0).max(23).default(9),
      minute: z.number().int().min(0).max(59).default(0),
    })
    .default({ hour: 9, minute: 0 }),
  browser: z
    .object({
      executablePath: z
        .string()
        .default(
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        ),
    })
    .default({
      executablePath:
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    }),
  notifications: z.boolean().default(true),
});
export type Config = z.infer<typeof ConfigSchema>;
export function dataDir(input?: string) {
  return resolve(
    (
      input ||
      process.env.JOBAGENT_HOME ||
      join(homedir(), "Library/Application Support/JobAgent")
    ).replace(/^~(?=\/)/, homedir()),
  );
}
export function privateDir(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}
export function writePrivate(path: string, data: string | Uint8Array) {
  writeFileSync(path, data, { mode: 0o600 });
  chmodSync(path, 0o600);
}
export function initialize(dir: string) {
  privateDir(dir);
  privateDir(join(dir, "attachments"));
  privateDir(join(dir, "logs"));
  if (!existsSync(join(dir, "config.json")))
    writePrivate(
      join(dir, "config.json"),
      JSON.stringify(ConfigSchema.parse({}), null, 2),
    );
}
export function readConfig(dir: string): Config {
  initialize(dir);
  return ConfigSchema.parse(
    JSON.parse(readFileSync(join(dir, "config.json"), "utf8")),
  );
}
export function saveConfig(dir: string, config: Config) {
  writePrivate(
    join(dir, "config.json"),
    JSON.stringify(ConfigSchema.parse(config), null, 2),
  );
}
export function loadSites(config: Config, dir: string): Site[] {
  return config.siteFiles.map((f) =>
    SiteSchema.parse(JSON.parse(readFileSync(resolve(dir, f), "utf8"))),
  );
}
export function findSite(sites: Site[], url: string): Site | undefined {
  const u = safeUrl(url);
  const found = sites.filter(
    (s) => s.origins.includes(u.origin) && u.pathname.startsWith(s.pathPrefix),
  );
  if (found.length > 1)
    throw new Error("站点配置匹配有歧义，请缩小 pathPrefix");
  return found[0];
}
export function safeUrl(url: string): URL {
  const u = new URL(url);
  if (!["https:", "http:"].includes(u.protocol) || u.username || u.password)
    throw new Error("仅支持无内嵌凭证的 HTTP(S) URL");
  return u;
}
export function mappings(config: Config, dir: string) {
  return z
    .array(MappingSchema)
    .parse(
      JSON.parse(
        readFileSync(
          config.mappingFile
            ? resolve(dir, config.mappingFile)
            : join(ROOT, "examples/field-mappings.json"),
          "utf8",
        ),
      ),
    );
}
export function profileDir(dir: string) {
  privateDir(dir);
  const p = join(realpathSync(dir), "chrome-profile");
  const daily = join(homedir(), "Library/Application Support/Google/Chrome");
  if (p === daily || p.startsWith(daily + "/"))
    throw new Error("禁止使用日常 Chrome 资料目录");
  return p;
}
