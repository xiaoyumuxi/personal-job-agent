import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { runFile } from "./process.js";
import { ROOT } from "./config.js";
import { AgentError } from "./errors.js";
export interface Vault {
  kind?: "keychain" | "session";
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}
export class MemoryVault implements Vault {
  kind = "session" as const;
  private data = new Map<string, string>();
  async get(k: string) {
    return this.data.get(k);
  }
  async set(k: string, v: string) {
    this.data.set(k, v);
  }
}
export class KeychainVault implements Vault {
  kind = "keychain" as const;
  private service: string;
  constructor(private dir: string) {
    this.service =
      "dev.jobagent." +
      createHash("sha256").update(dir).digest("hex").slice(0, 16);
  }
  async prepare() {
    if (process.platform !== "darwin")
      throw new AgentError("PERMANENT", "KEYCHAIN_MACOS_REQUIRED");
    const bin = join(this.dir, "keychain-helper");
    if (
      !existsSync(bin) &&
      process.env.JOBAGENT_KEYCHAIN_HELPER &&
      existsSync(process.env.JOBAGENT_KEYCHAIN_HELPER)
    )
      return process.env.JOBAGENT_KEYCHAIN_HELPER;
    if (!existsSync(bin)) {
      const result = await runFile(
        "/usr/bin/swiftc",
        [
          "-module-cache-path",
          join(this.dir, "swift-cache"),
          join(ROOT, "src/keychain.swift"),
          "-o",
          bin,
        ],
        { timeout: 60_000 },
      );
      if (result.code !== 0)
        throw new AgentError("PERMANENT", "KEYCHAIN_HELPER_BUILD_FAILED");
    }
    return bin;
  }
  private async call(op: string, account: string, value?: string) {
    const r = await runFile(await this.prepare(), [], {
      input: JSON.stringify({ op, service: this.service, account, value }),
      timeout: 30_000,
    });
    if (r.code !== 0 || r.timedOut)
      throw new AgentError("PERMANENT", "KEYCHAIN_UNAVAILABLE");
    try {
      return JSON.parse(r.stdout) as {
        found?: boolean;
        value?: string;
        ok?: boolean;
      };
    } catch {
      throw new AgentError("PERMANENT", "KEYCHAIN_INVALID_RESPONSE");
    }
  }
  async get(key: string) {
    return (await this.call("get", key)).value;
  }
  async delete(key: string) {
    await this.call("delete", key);
  }
  async set(key: string, value: string) {
    if (Buffer.byteLength(value) > 128 * 1024)
      throw new Error("Keychain 资料过大，请精简资料");
    await this.call("set", key, value);
  }
}
