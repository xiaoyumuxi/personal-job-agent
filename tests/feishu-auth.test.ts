import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DesktopService } from "../desktop/service.js";
import type { SettingsView } from "../desktop/contract.js";
import { readConfig, saveConfig } from "../src/config.js";
import { MemoryVault } from "../src/vault.js";
import { checkFeishuAuth } from "../src/application/services.js";
import type { ProcessResult } from "../src/process.js";

const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "jobagent-auth-"));
  dirs.push(dir);
  const file = join(dir, "fake-lark-cli"),
    log = join(dir, "calls.jsonl"),
    status = join(dir, "status.json");
  writeFileSync(log, "");
  writeFileSync(
    status,
    JSON.stringify({
      identities: { user: { available: true, status: "ready" } },
      verified: true,
      privateTestToken: "NEVER_COPY_CREDENTIALS",
    }),
  );
  writeFileSync(
    file,
    `#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
if(args[0]==='--version') console.log('lark-cli version auth-test');
else if(args[0]==='auth'&&args[1]==='status') console.log(fs.readFileSync(${JSON.stringify(status)},'utf8'));
else if(args.includes('--no-wait')) console.log(JSON.stringify({device_code:'PRIVATE_TEST_DEVICE',verification_uri:'https://accounts.feishu.cn/test-only',expires_in:600}));
else if(args.includes('--device-code')) console.log('{}');
else process.exitCode=1;`,
    { mode: 0o700 },
  );
  const config = readConfig(dir);
  config.feishu.cli = file;
  saveConfig(dir, config);
  return {
    dir,
    file,
    status,
    service: () => new DesktopService(() => {}, dir, new MemoryVault()),
    calls: (): string[][] =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
}
const settings = async (s: DesktopService) =>
  (await s.handle({ method: "settings" })) as SettingsView;
async function run(
  s: DesktopService,
  operation: "feishuAuth" | "feishuComplete",
) {
  await s.handle({ method: "start", operation });
  await expect.poll(() => s.snapshot().busy).toBe(false);
  expect(s.snapshot().run?.state).toBe("COMPLETED");
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("saved Feishu authorization", () => {
  it("retains the display result through settings saves and exit, then verifies existing CLI login again", async () => {
    const f = fixture();
    let s = f.service();
    try {
      await s.handle({ method: "checkFeishuAuth" });
      const auth = (await settings(s)).feishuAuth;
      expect(auth?.status).toBe("VALID");
      const config = readConfig(f.dir);
      await s.handle({
        method: "saveSettings",
        feishu: config.feishu,
        model: config.model,
        schedule: { ...config.schedule, hour: 9 },
      });
      expect((await settings(s)).feishuAuth).toEqual(auth);
      await s.stop();
      s.close();
      s = f.service();
      expect((await settings(s)).feishuAuth).toEqual(auth);
      expect((await settings(s)).authPending).toBe(false);
      await s.handle({ method: "checkFeishuAuth" });
      await run(s, "feishuComplete");
      expect(s.snapshot().run?.step).toContain("飞书已授权，验证通过");
      expect(f.calls().filter((a) => a[1] === "status")).toHaveLength(3);
      expect(f.calls().some((a) => a[1] === "login")).toBe(false);
      expect(JSON.stringify(s.store.getMeta("feishuAuth"))).not.toContain(
        "NEVER_COPY_CREDENTIALS",
      );
    } finally {
      await s.stop();
      s.close();
    }
  });
  it("coalesces automatic checks, supports explicit refresh and detects revoked login after reopening", async () => {
    const f = fixture();
    let s = f.service();
    try {
      await Promise.all([
        s.handle({ method: "checkFeishuAuth" }),
        s.handle({ method: "checkFeishuAuth" }),
      ]);
      await s.handle({ method: "checkFeishuAuth" });
      expect(f.calls()).toHaveLength(1);
      await s.handle({ method: "checkFeishuAuth", refresh: true });
      expect(f.calls()).toHaveLength(2);
      expect(s.snapshot().run).toBeUndefined();
      expect(s.snapshot().events).toHaveLength(0);
      await s.stop();
      s.close();
      writeFileSync(
        f.status,
        JSON.stringify({
          identities: { user: { available: false, status: "missing" } },
          verified: false,
        }),
      );
      s = f.service();
      await s.handle({ method: "checkFeishuAuth" });
      expect((await settings(s)).feishuAuth?.status).toBe("AUTH_REQUIRED");
      expect(f.calls()).toHaveLength(3);
    } finally {
      await s.stop();
      s.close();
    }
  });
  it("completes a pending device flow and leaves a success message with no pending authorization", async () => {
    const f = fixture(),
      s = f.service();
    try {
      await run(s, "feishuAuth");
      expect((await settings(s)).authPending).toBe(true);
      await run(s, "feishuComplete");
      expect((await settings(s)).authPending).toBe(false);
      expect((await settings(s)).feishuAuth?.status).toBe("VALID");
      expect(s.snapshot().run?.step).not.toContain("等待");
      expect(f.calls().filter((a) => a.includes("--device-code"))).toHaveLength(
        1,
      );
      expect(JSON.stringify(s.snapshot())).not.toContain("PRIVATE_TEST_DEVICE");
    } finally {
      await s.stop();
      s.close();
    }
  });
  it("invalidates the display when a different CLI is selected", async () => {
    const f = fixture(),
      other = fixture(),
      s = f.service();
    try {
      await s.handle({ method: "checkFeishuAuth" });
      await s.importFile("feishuCLI", other.file);
      expect((await settings(s)).feishuAuth).toBeUndefined();
      await s.handle({ method: "checkFeishuAuth" });
      expect((await settings(s)).feishuAuth?.configuredPath).toBe(other.file);
      expect(other.calls().filter((a) => a[1] === "status")).toHaveLength(1);
    } finally {
      await s.stop();
      s.close();
    }
  });
  it.each([
    {
      code: 1,
      stdout: "",
      stderr: JSON.stringify({ error: { type: "network" } }),
      timedOut: false,
    },
    { code: 1, stdout: "", stderr: "", timedOut: true },
    { code: 0, stdout: "invalid output", stderr: "", timedOut: false },
    { code: 0, stdout: "{}", stderr: "", timedOut: false },
  ])(
    "does not present an inconclusive check as lost authorization: %j",
    async (result: ProcessResult) => {
      const f = fixture(),
        s = f.service();
      try {
        const checked = await checkFeishuAuth(
          s.store,
          readConfig(f.dir),
          async () => result,
        );
        expect(checked.status).toBe("CHECK_FAILED");
        expect(checked.message).not.toContain("重新授权");
      } finally {
        s.close();
      }
    },
  );
});
