import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { Config, ROOT, privateDir, writePrivate } from "./config.js";
import { Store, now } from "./db.js";
import { runFile } from "./process.js";
export const LABEL = "dev.jobagent.daily";
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function dueDates(
  last: string | undefined,
  start: string,
  hour: number,
  minute: number,
  nowDate = new Date(),
) {
  const today = localDate(nowDate);
  const before =
    nowDate.getHours() * 60 + nowDate.getMinutes() < hour * 60 + minute;
  const end = new Date(nowDate);
  if (before) end.setDate(end.getDate() - 1);
  const endDate = localDate(end);
  const cursor = new Date((last ?? start) + "T12:00:00");
  if (last) cursor.setDate(cursor.getDate() + 1);
  const result: string[] = [];
  while (localDate(cursor) <= endDate && result.length < 3660) {
    result.push(localDate(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return result.filter((d) => d <= today);
}
export function schedulePlan(dir: string, c: Config) {
  const entry = join(ROOT, "dist/src/cli.js");
  if (!existsSync(entry)) throw new Error("请先 npm run build");
  const args = [process.execPath, entry, "--home", dir, "daily"];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array>${args.map((a) => `<string>${esc(a)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${esc(ROOT)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${esc(process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin")}</string></dict>
<key>StartCalendarInterval</key><dict><key>Hour</key><integer>${c.schedule.hour}</integer><key>Minute</key><integer>${c.schedule.minute}</integer></dict>
<key>StartInterval</key><integer>900</integer><key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>${esc(join(dir, "logs/daily.log"))}</string>
<key>StandardErrorPath</key><string>${esc(join(dir, "logs/daily-error.log"))}</string>
<key>Umask</key><integer>63</integer>
</dict></plist>\n`;
}
export function schedulePath() {
  return join(homedir(), "Library/LaunchAgents", LABEL + ".plist");
}
export async function installSchedule(dir: string, c: Config) {
  if (process.platform !== "darwin") throw new Error("launchd 仅支持 macOS");
  const path = schedulePath();
  if (existsSync(path))
    throw new Error("已有定时配置；请先查看或卸载，避免覆盖");
  const plist = schedulePlan(dir, c);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writePrivate(path, plist);
  const r = await runFile("/bin/launchctl", [
    "bootstrap",
    `gui/${process.getuid!()}`,
    path,
  ]);
  if (r.code !== 0) {
    unlinkSync(path);
    throw new Error("launchd 安装失败，未注册后台任务");
  }
  return path;
}
export async function scheduleStatus() {
  const r = await runFile("/bin/launchctl", [
    "print",
    `gui/${process.getuid!()}/${LABEL}`,
  ]);
  return {
    installed: r.code === 0,
    plistExists: existsSync(schedulePath()),
    path: schedulePath(),
  };
}
export async function uninstallSchedule() {
  const state = await scheduleStatus();
  if (state.installed) {
    const r = await runFile("/bin/launchctl", [
      "bootout",
      `gui/${process.getuid!()}/${LABEL}`,
    ]);
    if (r.code !== 0) throw new Error("卸载失败，配置保留");
  }
  if (existsSync(schedulePath())) unlinkSync(schedulePath());
}
export async function dailyRun(
  store: Store,
  config: Config,
  work: () => Promise<void>,
  date = new Date(),
) {
  const start = store.getMeta<string>("createdDate") ?? localDate(date);
  const dates = dueDates(
    store.getMeta<string>("lastDailyDate"),
    start,
    config.schedule.hour,
    config.schedule.minute,
    date,
  );
  if (!dates.length) return { ran: false, dates: [] };
  store.task("daily", { status: "RUNNING", started: now(), dueDates: dates });
  try {
    await work();
    store.setMeta("lastDailyDate", dates.at(-1));
    store.task("daily", {
      status: "COMPLETED",
      finished: now(),
      coalescedDates: dates,
    });
    return { ran: true, dates };
  } catch (e) {
    store.task("daily", { status: "FAILED", finished: now(), dueDates: dates });
    throw e;
  }
}
