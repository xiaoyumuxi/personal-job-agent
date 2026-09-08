import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ProfileSchema, type Profile } from "./types.js";
import type { Store } from "./db.js";
import type { Vault } from "./vault.js";
import type { ProfileImportInfo } from "./profile.js";

export const ProfileIdSchema = z.union([
  z.literal("legacy"),
  z.string().uuid(),
]);
export interface ProfileVersion {
  id: string;
  name: string;
  file: string;
  revision: number;
  at: string;
  extraction?: ProfileImportInfo;
}
const EntrySchema = z.object({
  id: ProfileIdSchema,
  name: z.string().min(1).max(120),
  file: z.string(),
  revision: z.number().int().nonnegative(),
  at: z.string(),
  extraction: z
    .object({
      format: z.enum(["pdf", "text", "json"]),
      pages: z.number().optional(),
      ocrPages: z.number().optional(),
    })
    .optional(),
  key: z.string().regex(/^(profile|profile-data:[a-f0-9-]{36})$/),
  fingerprint: z.string().optional(),
});
const CatalogSchema = z.object({
  version: z.literal(1),
  activeId: ProfileIdSchema,
  entries: z.array(EntrySchema).min(1).max(100),
});
type Catalog = z.infer<typeof CatalogSchema>;
const catalogKey = "profile-catalog";
async function readCatalog(vault: Vault): Promise<Catalog | undefined> {
  const raw = await vault.get(catalogKey);
  if (!raw) return;
  const c = CatalogSchema.parse(JSON.parse(raw));
  if (
    new Set(c.entries.map((e) => e.id)).size !== c.entries.length ||
    !c.entries.some((e) => e.id === c.activeId)
  )
    throw new Error("简历版本索引损坏，请恢复备份");
  return c;
}
const summary = ({
  key: _key,
  fingerprint: _fingerprint,
  ...v
}: z.infer<typeof EntrySchema>): ProfileVersion => v;
export async function profileSelection(
  vault: Vault,
  store?: Store,
  id?: string,
): Promise<{
  profile: Profile;
  selected: ProfileVersion;
  activeId: string;
  versions: ProfileVersion[];
}> {
  if (id !== undefined) ProfileIdSchema.parse(id);
  const catalog = await readCatalog(vault);
  if (!catalog) {
    if (id && id !== "legacy") throw new Error("简历版本不存在，请重新选择");
    const raw = await vault.get("profile");
    const profile = raw
      ? ProfileSchema.parse(JSON.parse(raw))
      : ProfileSchema.parse({});
    const prior = store?.getMeta<{
      file?: string;
      revision?: number;
      at?: string;
      extraction?: ProfileImportInfo;
    }>("profileVersion");
    const selected: ProfileVersion = {
      id: "legacy",
      name: "原有资料",
      file: prior?.file ?? "",
      revision:
        store?.getMeta<number>("profileLegacyRevision") ?? prior?.revision ?? 0,
      at: prior?.at ?? "",
      extraction: prior?.extraction,
    };
    return { profile, selected, activeId: "legacy", versions: [selected] };
  }
  const entry = catalog.entries.find((e) => e.id === (id ?? catalog.activeId));
  if (!entry) throw new Error("简历版本不存在，请重新选择");
  const raw = await vault.get(entry.key);
  if (!raw) {
    // A concurrent writer may retire this data key after we read the index.
    // Retry only if that same version now points to a newer committed key.
    const latest = (await readCatalog(vault))?.entries.find(
      (e) => e.id === entry.id,
    );
    if (latest && latest.key !== entry.key)
      return profileSelection(vault, store, entry.id);
    throw new Error("该简历版本的 Keychain 资料不可读取，已停止操作");
  }
  return {
    profile: ProfileSchema.parse(JSON.parse(raw)),
    selected: summary(entry),
    activeId: catalog.activeId,
    versions: catalog.entries.map(summary),
  };
}
async function verifiedSet(vault: Vault, key: string, value: string) {
  await vault.set(key, value);
  if ((await vault.get(key)) !== value)
    throw new Error("Keychain 保存后回读不一致");
}
async function writeCatalog(vault: Vault, store: Store, catalog: Catalog) {
  const before = await readCatalog(vault);
  await verifiedSet(
    vault,
    catalogKey,
    JSON.stringify(CatalogSchema.parse(catalog)),
  );
  for (const old of before?.entries ?? [])
    if (
      old.key !== "profile" &&
      !catalog.entries.some((e) => e.key === old.key)
    )
      await vault.delete?.(old.key).catch(() => {});
  if (vault.kind !== "session")
    store.setMeta("profileRef", "keychain:profile-catalog");
  else store.event(null, "PROFILE_SESSION_ONLY");
}
async function initialCatalog(vault: Vault, store: Store): Promise<Catalog> {
  const existing = await readCatalog(vault);
  if (existing) return existing;
  const old = await profileSelection(vault, store);
  // The original Keychain profile remains untouched as the migration backup.
  const key = "profile";
  if (!(await vault.get(key)))
    await verifiedSet(vault, key, JSON.stringify(old.profile));
  return {
    version: 1,
    activeId: "legacy",
    entries: [{ ...old.selected, key }],
  };
}
async function writeData(vault: Vault, profile: Profile) {
  const key = "profile-data:" + randomUUID();
  await verifiedSet(vault, key, JSON.stringify(ProfileSchema.parse(profile)));
  return key;
}
export async function saveVersionProfile(
  vault: Vault,
  store: Store,
  profile: Profile,
  id?: string,
) {
  const catalog = await readCatalog(vault);
  if (!catalog) {
    if (id && id !== "legacy") throw new Error("简历版本不存在，请重新选择");
    const before = await profileSelection(vault, store);
    await verifiedSet(
      vault,
      "profile",
      JSON.stringify(ProfileSchema.parse(profile)),
    );
    store.setMeta("profileLegacyRevision", before.selected.revision + 1);
    if (vault.kind !== "session")
      store.setMeta("profileRef", "keychain:profile");
    else store.event(null, "PROFILE_SESSION_ONLY");
    return (await profileSelection(vault, store)).selected;
  }
  const entry = catalog.entries.find((e) => e.id === (id ?? catalog.activeId));
  if (!entry) throw new Error("简历版本不存在，请重新选择");
  // Copy on write: readers always see a complete profile and matching metadata.
  entry.key = await writeData(vault, profile);
  entry.revision++;
  entry.at = new Date().toISOString();
  await writeCatalog(vault, store, catalog);
  return summary(entry);
}
export async function switchProfile(vault: Vault, store: Store, id: string) {
  await profileSelection(vault, store, id); // validate data before changing the default
  const catalog = await readCatalog(vault);
  if (!catalog) return;
  catalog.activeId = id;
  await writeCatalog(vault, store, catalog);
}
export async function renameProfile(
  vault: Vault,
  store: Store,
  id: string,
  name: string,
) {
  name = z.string().trim().min(1).max(120).parse(name);
  await profileSelection(vault, store, id);
  const catalog = await initialCatalog(vault, store);
  catalog.entries.find((e) => e.id === id)!.name = name;
  await writeCatalog(vault, store, catalog);
}
export async function importedVersion(
  vault: Vault,
  store: Store,
  profile: Profile,
  info: { file: string; fingerprint: string; extraction?: ProfileImportInfo },
  targetId?: string,
) {
  const catalog = await initialCatalog(vault, store);
  const prior = targetId
    ? catalog.entries.find((e) => e.id === targetId)
    : undefined;
  if (targetId && !prior) throw new Error("简历版本不存在，请重新选择");
  if (!prior && catalog.entries.length >= 100)
    throw new Error("简历版本已达 100 份，请先整理资料");
  const entry = {
    ...info,
    id: prior?.id ?? randomUUID(),
    name: prior?.name ?? info.file.replace(/\.[^.]+$/, "").slice(0, 120),
    revision: (prior?.revision ?? 0) + 1,
    at: new Date().toISOString(),
    key: await writeData(vault, profile),
  };
  // Omit an empty pre-import placeholder; preserve any real legacy facts or attachment.
  if (!(await readCatalog(vault)) && !prior) {
    const old = await profileSelection(vault, store);
    if (
      !old.profile.resume &&
      !Object.keys(old.profile.facts).length &&
      !Object.values(old.profile.records).some((v) => v.length)
    )
      catalog.entries = [];
  }
  catalog.entries = prior
    ? catalog.entries.map((e) => (e.id === prior.id ? entry : e))
    : [...catalog.entries, entry];
  catalog.activeId = entry.id;
  await writeCatalog(vault, store, catalog);
  // Keep the old non-sensitive import summary available to existing diagnostics.
  store.setMeta("profileVersion", summary(entry));
  return profileSelection(vault, store);
}
export async function importedProfileId(vault: Vault, fingerprint: string) {
  return (await readCatalog(vault))?.entries.find(
    (e) => e.fingerprint === fingerprint,
  )?.id;
}
