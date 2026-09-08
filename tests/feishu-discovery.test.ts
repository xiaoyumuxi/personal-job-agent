import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  cliCandidates,
  executable,
  findCLI,
  probeCLI,
} from "../src/feishu/discovery.js";
import { resolveFeishuCLI } from "../src/application/services.js";
import { readConfig, saveConfig } from "../src/config.js";
import { Store } from "../src/db.js";
import { DesktopService } from "../desktop/service.js";
import { MemoryVault } from "../src/vault.js";
import { acquireLock } from "../src/lock.js";
import { CommandSchema, type SettingsView } from "../desktop/contract.js";

const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "jobagent-cli-discovery-"));
  dirs.push(dir);
  const file = join(dir, "CLI with spaces");
  const log = join(dir, "calls.jsonl");
  writeFileSync(
    file,
    `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n');setTimeout(()=>console.log('lark-cli version test-only'),50);`,
    { mode: 0o700 },
  );
  return {
    dir,
    file,
    calls: () =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
  };
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("local Feishu executable discovery", () => {
  it("finds default and custom nvm locations without shell PATH and sorts versions numerically", () => {
    const { dir } = fixture();
    const home = join(dir, "synthetic home");
    for (const version of ["v9.0.0", "v24.14.0"])
      mkdirSync(join(home, ".nvm/versions/node", version, "bin"), {
        recursive: true,
      });
    const custom = join(dir, "custom nvm");
    mkdirSync(join(custom, "versions/node/v25.0.0/bin"), { recursive: true });
    const candidates = cliCandidates(
      "lark-cli",
      false,
      { PATH: "/usr/bin:/bin:.:", NVM_DIR: custom },
      home,
    );
    expect(candidates).toContain(
      join(home, ".nvm/versions/node/v24.14.0/bin/lark-cli"),
    );
    expect(
      candidates.indexOf(join(custom, "versions/node/v25.0.0/bin/lark-cli")),
    ).toBeLessThan(
      candidates.indexOf(
        join(home, ".nvm/versions/node/v24.14.0/bin/lark-cli"),
      ),
    );
    expect(
      candidates.indexOf(
        join(home, ".nvm/versions/node/v24.14.0/bin/lark-cli"),
      ),
    ).toBeLessThan(
      candidates.indexOf(join(home, ".nvm/versions/node/v9.0.0/bin/lark-cli")),
    );
    expect(candidates.every((p) => p.startsWith("/"))).toBe(true);
    expect(new Set(candidates).size).toBe(candidates.length);
    expect(
      cliCandidates("lark-cli", false, { NVM_DIR: join(dir, "missing") }, dir)
        .length,
    ).toBeGreaterThan(0);
  });
  it("validates a real executable and symlink with only --version", async () => {
    const { dir, file, calls } = fixture();
    const link = join(dir, "lark-cli");
    symlinkSync(file, link);
    expect(executable(dir)).toBe(false);
    expect(await probeCLI(link)).toMatchObject({
      status: "AVAILABLE",
      path: link,
      version: "lark-cli version test-only",
    });
    expect(calls()).toEqual([["--version"]]);
  });
  it("preserves a broken configured absolute path until the user asks to search again", async () => {
    const { dir } = fixture();
    const missing = join(dir, "removed-cli");
    expect(cliCandidates(missing)).toEqual([missing]);
    expect(cliCandidates(missing, true).length).toBeGreaterThan(1);
    expect(await findCLI(missing)).toMatchObject({
      status: "NOT_FOUND",
      path: missing,
    });
  });
  it("rejects wrong programs, missing Node and timeouts without exposing their output", async () => {
    const { file } = fixture();
    writeFileSync(
      file,
      "#!/bin/sh\necho 'PRIVATE_TEST_TOKEN'; echo 'env: node: No such file or directory' >&2; exit 127\n",
      { mode: 0o700 },
    );
    const failed = await probeCLI(file);
    expect(failed.status).toBe("INVALID");
    expect(failed.message).toContain("Node");
    expect(JSON.stringify(failed)).not.toContain("PRIVATE_TEST_TOKEN");
    writeFileSync(file, `#!${process.execPath}\nsetTimeout(()=>{},30000);`, {
      mode: 0o700,
    });
    expect(await probeCLI(file, 80)).toMatchObject({
      status: "INVALID",
      message: expect.stringContaining("超时"),
    });
  });
  it("never saves an invalid candidate and invalidates stale connection results", async () => {
    const { dir, file } = fixture();
    const store = new Store(dir);
    try {
      const config = readConfig(dir);
      config.feishu.cli = file;
      saveConfig(dir, config);
      store.setMeta("doctor", { feishuUserAuth: "VALID" });
      rmSync(file);
      expect(await resolveFeishuCLI(store, config, dir)).toMatchObject({
        status: "NOT_FOUND",
        configuredPath: file,
      });
      expect(readConfig(dir).feishu.cli).toBe(file);
      expect(store.getMeta("doctor")).toBeNull();
    } finally {
      store.close();
    }
  });
  it("coalesces concurrent requests, caches refreshes, rechecks on reopen, and never authorizes or starts a task", async () => {
    const { dir, file, calls } = fixture();
    const config = readConfig(dir);
    config.feishu.cli = file;
    saveConfig(dir, config);
    let service = new DesktopService(() => {}, dir, new MemoryVault());
    try {
      await Promise.all(
        Array.from({ length: 5 }, () =>
          service.handle({ method: "discoverFeishuCLI" }),
        ),
      );
      expect(calls()).toEqual([["--version"]]);
      const settings = (await service.handle({
        method: "settings",
      })) as SettingsView;
      expect(settings.feishuExecutable?.status).toBe("AVAILABLE");
      expect(settings.doctor).toBeUndefined();
      expect(settings.authPending).toBe(false);
      expect(service.snapshot().events).toEqual([]);
      await service.handle({ method: "discoverFeishuCLI" });
      expect(calls()).toHaveLength(1);
      await service.handle({ method: "discoverFeishuCLI", refresh: true });
      expect(calls()).toHaveLength(2);
      service.close();
      service = new DesktopService(() => {}, dir, new MemoryVault());
      await service.handle({ method: "discoverFeishuCLI" });
      expect(calls()).toHaveLength(3);
      expect(service.snapshot().run).toBeUndefined();
    } finally {
      await service.stop();
      service.close();
    }
  });
  it("honors the CLI/launchd lock and rejects renderer-supplied paths", async () => {
    const { dir, file } = fixture();
    const config = readConfig(dir);
    config.feishu.cli = file;
    saveConfig(dir, config);
    const service = new DesktopService(() => {}, dir, new MemoryVault());
    const unlock = acquireLock(dir);
    try {
      await expect(
        service.handle({ method: "discoverFeishuCLI" }),
      ).rejects.toThrow("BUSY");
      expect(
        CommandSchema.safeParse({
          method: "discoverFeishuCLI",
          path: "/bin/sh",
        }).success,
      ).toBe(false);
      unlock();
      await expect(
        service.handle({ method: "discoverFeishuCLI" }),
      ).resolves.toMatchObject({ status: "AVAILABLE" });
    } finally {
      unlock();
      await service.stop();
      service.close();
    }
  });
});
