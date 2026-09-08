import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { runFeishuCLI } from "./cli.js";

export function executable(path: string) {
  try {
    if (!isAbsolute(path) || !statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface CLIProbe {
  status: "AVAILABLE" | "NOT_FOUND" | "INVALID";
  path: string;
  at: string;
  version?: string;
  message: string;
}

// Search known installation locations, never run a login shell or read shell rc files.
export function cliCandidates(
  current: string,
  searchAgain = false,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
) {
  if (isAbsolute(current) && !searchAgain) return [current];
  const dirs = [
    ...(env.PATH || "").split(":"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".local/bin"),
    join(home, ".npm-global/bin"),
    join(home, ".volta/bin"),
    join(home, ".asdf/shims"),
    join(home, ".local/share/mise/shims"),
    env.PNPM_HOME || join(home, "Library/pnpm"),
    ...(env.npm_config_prefix ? [join(env.npm_config_prefix, "bin")] : []),
  ].filter(isAbsolute);
  const nvmRoots = new Set([
    ...(env.NVM_DIR && isAbsolute(env.NVM_DIR) ? [env.NVM_DIR] : []),
    join(home, ".nvm"),
  ]);
  for (const root of nvmRoots) {
    try {
      const versions = readdirSync(join(root, "versions/node"))
        .filter((name) => /^v\d+\.\d+\.\d+$/.test(name))
        .sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
      for (const version of versions)
        dirs.push(join(root, "versions/node", version, "bin"));
    } catch {
      // Missing or unreadable version managers must not prevent other candidates.
    }
  }
  return [
    ...new Set([
      ...(isAbsolute(current) ? [current] : []),
      ...dirs.map((dir) => join(dir, "lark-cli")),
    ]),
  ];
}

export async function probeCLI(
  path: string,
  timeout = 3000,
): Promise<CLIProbe> {
  const base = { path, at: new Date().toISOString() };
  if (!executable(path))
    return {
      ...base,
      status: "NOT_FOUND",
      message: "路径不存在或不是可执行文件。可重新查找，或手动选择。",
    };
  try {
    const result = await runFeishuCLI(path, ["--version"], timeout);
    // Do not expose arbitrary stdout/stderr, which may contain local configuration.
    const version = result.stdout
      .match(/^lark-cli version [\w.+-]{1,80}\s*$/m)?.[0]
      ?.trim();
    if (result.code === 0 && !result.timedOut && version)
      return {
        ...base,
        status: "AVAILABLE",
        version,
        message: "可执行文件已验证",
      };
    return {
      ...base,
      status: "INVALID",
      message: result.timedOut
        ? "版本检测超时，请重新查找或选择可用的 CLI。"
        : /env:.*node:.*(?:No such file|not found)/i.test(result.stderr)
          ? "已找到 CLI，但启动时找不到 Node；请检查客户端附带的运行环境。"
          : "已找到文件，但未通过飞书官方 CLI 版本验证；请检查安装或重新选择。",
    };
  } catch {
    return {
      ...base,
      status: "INVALID",
      message: "文件无法启动，请检查执行权限或重新选择。",
    };
  }
}

export async function findCLI(
  current: string,
  searchAgain = false,
): Promise<CLIProbe> {
  let failure: CLIProbe | undefined;
  const deadline = Date.now() + 9000;
  for (const candidate of cliCandidates(current, searchAgain)) {
    if (!executable(candidate)) continue;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const result = await probeCLI(candidate, Math.min(3000, remaining));
    if (result.status === "AVAILABLE") return result;
    failure ??= result;
  }
  return (
    failure ?? {
      status: "NOT_FOUND",
      path: current,
      at: new Date().toISOString(),
      message:
        isAbsolute(current) && !searchAgain
          ? "已保存的 CLI 路径失效，可重新查找，或手动选择。"
          : "未在 PATH、Homebrew、nvm 等常见安装目录找到飞书 CLI。请先安装官方 CLI，或手动选择。",
    }
  );
}
