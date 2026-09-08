import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { privateDir } from "./config.js";
export function acquireLock(dir: string) {
  privateDir(dir);
  const path = join(realpathSync(dir), "runner.lock");
  const token = randomUUID();
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        "BUSY：专用 Chrome / 同步任务被另一个实例占用。稍后再试；异常退出后用 unlock 检查并清锁",
      );
    throw e;
  }
  writeFileSync(
    join(path, "owner.json"),
    JSON.stringify({
      pid: process.pid,
      token,
      started: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  return () => {
    try {
      const owner = JSON.parse(readFileSync(join(path, "owner.json"), "utf8"));
      if (owner.token === token) rmSync(path, { recursive: true });
    } catch {
      /* Chrome profile lock remains the second guard. */
    }
  };
}
export function unlock(dir: string) {
  const path = join(realpathSync(dir), "runner.lock");
  const owner = JSON.parse(readFileSync(join(path, "owner.json"), "utf8"));
  try {
    process.kill(owner.pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") {
      rmSync(path, { recursive: true });
      return;
    }
    throw e;
  }
  throw new Error("执行实例仍在运行，拒绝清锁");
}
