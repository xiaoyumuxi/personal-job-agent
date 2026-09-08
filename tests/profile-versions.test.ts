import { afterEach, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testState } from "./helpers.js";
import { MemoryVault } from "../src/vault.js";
import { importProfileFile } from "../src/application/services.js";
import { confirmFact, loadProfile, saveProfile } from "../src/profile.js";
import {
  profileSelection,
  switchProfile,
  renameProfile,
} from "../src/profile-library.js";
import { DesktopService } from "../desktop/service.js";
import { acquireLock } from "../src/lock.js";
import { applyJob } from "../src/apply.js";
import { ProfileSchema } from "../src/types.js";

const resources: ReturnType<typeof testState>[] = [];
const setup = () => {
  const s = testState();
  resources.push(s);
  return { ...s, vault: new MemoryVault() };
};
afterEach(() => resources.splice(0).forEach((s) => s.dispose()));
const backend =
  "姓名：测试本人\nEmail: backend@example.invalid\n项目经历\n2024.01 - 2024.05 测试后端项目\n负责接口设计和数据库实现";
const agent =
  "姓名：测试本人\nEmail: agent@example.invalid\n项目经历\n2025.01 - 2025.05 测试 Agent 项目\n负责知识检索和工具调用";
it("different resumes isolate facts, records and confirmations; switching and renaming persist", async () => {
  const { store, vault, dir } = setup();
  await importProfileFile(store, vault, dir, undefined, backend);
  const a = await profileSelection(vault, store);
  confirmFact(a.profile, "basic.email", "backend@example.invalid");
  await saveProfile(vault, store, a.profile, a.selected.id);
  await renameProfile(vault, store, a.selected.id, "后端版");
  await importProfileFile(store, vault, dir, undefined, agent);
  const b = await profileSelection(vault, store);
  expect(b.versions).toHaveLength(2);
  expect(b.profile.facts["basic.email"]?.state).toBe("pending");
  expect(b.profile.records.project).not.toEqual(a.profile.records.project);
  expect(JSON.stringify(b.profile)).not.toContain("backend@example.invalid");
  await switchProfile(vault, store, a.selected.id);
  expect((await loadProfile(vault)).facts["basic.email"]?.state).toBe(
    "confirmed",
  );
  expect((await profileSelection(vault, store)).selected.name).toBe("后端版");
  // An editor opened for B must never overwrite A after the default changes.
  confirmFact(b.profile, "preference.location", "仅 B 的偏好");
  await saveProfile(vault, store, b.profile, b.selected.id);
  expect(
    (await loadProfile(vault)).facts["preference.location"],
  ).toBeUndefined();
  expect((await profileSelection(vault, store)).activeId).toBe(a.selected.id);
  expect(
    readFileSync(join(dir, "state.sqlite")).includes(
      Buffer.from("backend@example.invalid"),
    ),
  ).toBe(false);
});
it("legacy profile remains intact as backup when the first alternate resume is added", async () => {
  const { store, vault, dir } = setup();
  const legacy = ProfileSchema.parse({
    facts: { "basic.name": { state: "confirmed", value: "原资料敏感值" } },
  });
  await vault.set("profile", JSON.stringify(legacy));
  await importProfileFile(store, vault, dir, undefined, backend);
  expect(await vault.get("profile")).toBe(JSON.stringify(legacy));
  expect(
    (await profileSelection(vault, store)).versions.map((v) => v.id),
  ).toContain("legacy");
  await switchProfile(vault, store, "legacy");
  expect(await loadProfile(vault)).toEqual(legacy);
  confirmFact(legacy, "basic.name", "修改后的旧版");
  await saveProfile(vault, store, legacy, "legacy");
  expect(await vault.get("profile")).toContain("原资料敏感值");
});
it("duplicate content reuses its own version while explicit updates keep conflict checks", async () => {
  const { store, vault, dir } = setup();
  const file = join(dir, "first.txt"),
    copy = join(dir, "renamed.txt");
  writeFileSync(file, backend);
  writeFileSync(copy, backend);
  await importProfileFile(store, vault, dir, file);
  const a = await profileSelection(vault, store);
  confirmFact(a.profile, "basic.email", "backend@example.invalid");
  await saveProfile(vault, store, a.profile, a.selected.id);
  await importProfileFile(store, vault, dir, undefined, agent);
  await importProfileFile(store, vault, dir, copy);
  expect((await profileSelection(vault, store)).selected.id).toBe(
    a.selected.id,
  );
  expect((await profileSelection(vault, store)).versions).toHaveLength(2);
  expect((await loadProfile(vault)).facts["basic.email"]?.state).toBe(
    "confirmed",
  );
  await importProfileFile(
    store,
    vault,
    dir,
    undefined,
    backend.replace("backend@", "updated@"),
    "update",
  );
  expect((await loadProfile(vault)).facts["basic.email"]?.state).toBe(
    "conflict",
  );
});
it("failed profile writes leave active pointer and previous data unchanged", async () => {
  const { store, vault, dir } = setup();
  await importProfileFile(store, vault, dir, undefined, backend);
  const before = await profileSelection(vault, store),
    raw = await vault.get("profile-catalog");
  const failing = {
    get: vault.get.bind(vault),
    set: async (key: string, value: string) => {
      if (key === "profile-catalog") throw new Error("Keychain locked");
      await vault.set(key, value);
    },
  };
  await expect(
    importProfileFile(store, failing, dir, undefined, agent),
  ).rejects.toThrow("Keychain locked");
  expect(await vault.get("profile-catalog")).toBe(raw);
  expect(await profileSelection(vault, store)).toEqual(before);
  await expect(
    switchProfile(vault, store, "no-such-version"),
  ).rejects.toThrow();
  await expect(
    renameProfile(vault, store, before.selected.id, "  "),
  ).rejects.toThrow();
});
it("desktop rejects version mutations under the existing cross-process lock", async () => {
  const { store, vault, dir } = setup();
  await importProfileFile(store, vault, dir, undefined, backend);
  const chosen = await profileSelection(vault, store);
  const service = new DesktopService(() => {}, dir, vault);
  const release = acquireLock(dir);
  try {
    await expect(
      service.handle({
        method: "renameProfile",
        profileId: chosen.selected.id,
        name: "新名称",
      }),
    ).rejects.toThrow();
  } finally {
    release();
    service.store.close();
  }
});
it("apply selects the requested profile without changing the default and rejects changed resume on recovery", async () => {
  const { store, vault, dir, config } = setup();
  await importProfileFile(store, vault, dir, undefined, backend);
  const a = await profileSelection(vault, store);
  await importProfileFile(store, vault, dir, undefined, agent);
  const b = await profileSelection(vault, store);
  await renameProfile(vault, store, a.selected.id, "后端版");
  const { id } = store.addJob({
    company: "Test only",
    title: "Test",
    batch: "",
    jobCode: "",
    url: "https://example.invalid/form",
    tenant: "test",
    account: "default",
    referral: "",
    source: "test",
    channel: "READY",
  });
  let disclosed = "";
  await applyJob(
    id,
    store,
    config,
    dir,
    vault,
    {
      request: async (q) => {
        disclosed = q.message;
        return { action: "confirm", accepted: false };
      },
      checkpoint: async () => false,
      step: () => {},
      browser: () => {},
    },
    a.selected.id,
  );
  expect(disclosed).toContain("后端版");
  expect((await profileSelection(vault, store)).activeId).toBe(b.selected.id);
  const application = store.ensureApplication(id);
  application.state = "REVIEW";
  application.profileId = a.selected.id;
  application.profileRevision = a.selected.revision - 1;
  store.save(application, "TEST_ONLY");
  await expect(
    applyJob(
      id,
      store,
      config,
      dir,
      vault,
      {
        request: async () => ({ action: "confirm", accepted: true }),
        checkpoint: async () => false,
        step: () => {},
        browser: () => {
          throw new Error("must not open browser");
        },
      },
      a.selected.id,
    ),
  ).rejects.toThrow("简历版本已变更");
});

it("a reader follows the committed replacement if a concurrent save retires its data key", async () => {
  const { store, vault, dir } = setup();
  await importProfileFile(store, vault, dir, undefined, backend);
  const before = await profileSelection(vault, store);
  const key = JSON.parse((await vault.get("profile-catalog"))!).entries[0].key;
  let intercepted = false;
  const reader = {
    set: vault.set.bind(vault),
    get: async (k: string) => {
      if (k === key && !intercepted) {
        intercepted = true;
        confirmFact(before.profile, "basic.name", "并发保存后的资料");
        await saveProfile(vault, store, before.profile, before.selected.id);
      }
      return vault.get(k);
    },
  };
  const actual = await profileSelection(reader, store);
  expect(actual.selected.revision).toBe(before.selected.revision + 1);
  expect(actual.profile.facts["basic.name"]?.value).toBe("并发保存后的资料");
});
