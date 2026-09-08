import { join } from "node:path";
import type { Store } from "./db.js";
import { now, attention } from "./db.js";
import { writePrivate } from "./config.js";
import { runFile } from "./process.js";
export async function alert(
  store: Store,
  dir: string,
  key: string,
  code: string,
  enabled = true,
) {
  const existing = store.db
    .prepare("SELECT code,active FROM alerts WHERE key=?")
    .get(key);
  const changed = !existing || existing.code !== code || !existing.active;
  store.db
    .prepare(
      "INSERT INTO alerts VALUES(?,?,?,1) ON CONFLICT(key) DO UPDATE SET code=excluded.code,at=excluded.at,active=1",
    )
    .run(key, code, now());
  writeReport(store, dir);
  if (changed) {
    console.error(`JobAgent 异常：${code}（${key}）；详情见 status`);
    if (enabled && process.platform === "darwin") {
      const r = await runFile(
        "/usr/bin/osascript",
        [
          "-e",
          'on run argv\n display notification (item 1 of argv) with title "JobAgent 网申助手"\nend run',
          "检测到需要处理的异常，请运行 jobagent status 查看。",
        ],
        { timeout: 10_000 },
      ).catch(() => null);
      store.event(null, "NOTIFICATION", { delivered: r?.code === 0, code });
    }
  }
}
export function clearAlert(store: Store, key: string) {
  store.db.prepare("UPDATE alerts SET active=0 WHERE key=?").run(key);
}
export function writeReport(store: Store, dir: string) {
  const data = {
    at: now(),
    applications: store.applications().map((a) => ({
      id: a.id,
      state: a.state,
      query: a.queryStatus,
      sync: a.syncStatus,
      attention: attention(a),
      error: [a.queryError, a.syncError].filter(Boolean),
      nextAction: a.nextAction,
    })),
    alerts: store.db
      .prepare("SELECT key,code,at FROM alerts WHERE active=1")
      .all(),
    pending: store.pending(),
  };
  writePrivate(join(dir, "status.json"), JSON.stringify(data, null, 2));
  return data;
}
