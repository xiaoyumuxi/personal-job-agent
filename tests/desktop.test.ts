import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/db.js";
import { Runtime, type TaskEvent } from "../src/application/runtime.js";
import { DesktopService } from "../desktop/service.js";
import { MemoryVault } from "../src/vault.js";
import { acquireLock } from "../src/lock.js";
import { selected } from "./helpers.js";
import { CommandSchema } from "../desktop/contract.js";
const tick = () => new Promise((r) => setTimeout(r, 0));
describe("desktop uses existing storage and runtime", () => {
  it("reads the same SQLite, attention status and survives reopen without creating applications", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jobagent-desktop-unit-"));
    const store = new Store(dir);
    const a = selected(store);
    a.authStatus = "AUTH_REQUIRED";
    store.save(a, "TEST_AUTH");
    store.close();
    let service = new DesktopService(() => {}, dir, new MemoryVault());
    expect(service.snapshot().rows[0]!.attention).toBe("AUTH_REQUIRED");
    expect(service.snapshot().rows[0]!.permissions.apply).toBe(false);
    const b = service.store.app(a.id);
    b.syncStatus = "RETRY_EXHAUSTED";
    b.syncError = "FEISHU_TEMPORARY_ERROR";
    service.store.save(b, "TEST_RETRY");
    service.close();
    service = new DesktopService(() => {}, dir, new MemoryVault());
    expect(service.snapshot().rows).toHaveLength(1);
    expect(service.snapshot().rows[0]!.attention).toBe("RETRY_EXHAUSTED");
    expect(JSON.stringify(service.diagnostics())).not.toContain("Fixture only");
    const lock = acquireLock(dir);
    await expect(
      service.handle({ method: "start", operation: "sync" }),
    ).rejects.toThrow("BUSY");
    lock();
    service.close();
    rmSync(dir, { recursive: true });
  });
  it("does not falsely report sync success when Feishu is unconfigured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jobagent-desktop-unit-"));
    const s = new DesktopService(() => {}, dir, new MemoryVault());
    selected(s.store);
    await s.handle({ method: "start", operation: "sync" });
    await expect(
      s.handle({ method: "start", operation: "sync" }),
    ).rejects.toThrow("只能执行一个");
    while (s.runtime) await tick();
    expect(s.snapshot().run?.state).toBe("FAILED");
    expect(s.snapshot().rows[0]!.application?.syncStatus).toBe(
      "NOT_CONFIGURED",
    );
    s.close();
    rmSync(dir, { recursive: true });
  });
  it("validates source-shaped commands and profile paths", async () => {
    expect(
      CommandSchema.safeParse({ method: "shell", command: "echo hi" }).success,
    ).toBe(false);
    expect(
      CommandSchema.safeParse({ method: "snapshot", path: "/etc/passwd" })
        .success,
    ).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), "jobagent-desktop-unit-")),
      vault = new MemoryVault(),
      s = new DesktopService(() => {}, dir, vault);
    await expect(
      s.handle({ method: "saveFact", path: "constructor.x", value: "bad" }),
    ).rejects.toThrow("不合法");
    await s.handle({
      method: "saveFact",
      path: "basic.name",
      value: "仅供测试",
    });
    expect((await s.profile()).profile.facts["basic.name"]?.state).toBe(
      "confirmed",
    );
    s.close();
    rmSync(dir, { recursive: true });
  });
});
describe("structured requests and safe pause", () => {
  it("rejects wrong-run, stale and duplicate answers, rotates request on resume", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jobagent-runtime-")),
      store = new Store(dir),
      events: TaskEvent[] = [];
    const r = new Runtime(store, "apply", undefined, (e) => events.push(e));
    const promise = r.request({ kind: "login", message: "登录测试" });
    await tick();
    const id = r.record.request!.requestId;
    expect(() => r.answer("wrong", id, { action: "check" })).toThrow("过期");
    r.control("pause");
    expect(r.record.state).toBe("PAUSED");
    expect(() => r.answer(r.record.runId, id, { action: "check" })).toThrow(
      "过期",
    );
    r.control("resume");
    expect(r.record.request!.requestId).not.toBe(id);
    const next = r.record.request!.requestId;
    r.answer(r.record.runId, next, { action: "check" });
    expect(() => r.answer(r.record.runId, next, { action: "check" })).toThrow(
      "过期",
    );
    expect(await promise).toEqual({ action: "check" });
    r.finish();
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
    store.close();
    rmSync(dir, { recursive: true });
  });
  it("pause stays PAUSING until the backend crosses a boundary; cancellation unblocks it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jobagent-runtime-")),
      store = new Store(dir),
      r = new Runtime(store, "sync", undefined, () => {});
    r.control("pause");
    expect(r.record.state).toBe("PAUSING");
    const boundary = r.checkpoint();
    expect(r.record.state).toBe("PAUSED");
    r.control("cancel");
    await expect(boundary).rejects.toThrow("安全边界");
    r.finish(new Error());
    expect(r.record.state).toBe("CANCELLED");
    store.close();
    rmSync(dir, { recursive: true });
  });
});

describe("desktop crash recovery", () => {
  it("marks a prior waiting run interrupted and blocks re-apply until human verification", () => {
    const dir = mkdtempSync(join(tmpdir(), "jobagent-desktop-recovery-"));
    const store = new Store(dir),
      a = selected(store);
    a.state = "FILLING";
    store.save(a, "TEST_INTERRUPTED");
    store.task("desktop:run", {
      runId: "test-crash",
      operation: "apply",
      jobId: a.jobId,
      state: "WAIT_INPUT",
      step: "填写",
      at: new Date().toISOString(),
      request: { requestId: "old" },
    });
    store.close();
    const service = new DesktopService(() => {}, dir, new MemoryVault());
    expect(service.snapshot().run?.state).toBe("INTERRUPTED");
    expect(service.snapshot().run?.request).toBeUndefined();
    expect(service.snapshot().rows[0]!.application?.state).toBe(
      "UNKNOWN_RESULT",
    );
    expect(service.snapshot().rows[0]!.permissions.apply).toBe(false);
    service.close();
    rmSync(dir, { recursive: true });
  });
});
