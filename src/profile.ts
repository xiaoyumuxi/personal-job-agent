import { readFile, copyFile, chmod, stat } from "node:fs/promises";
import { join, extname, resolve, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { ProfileSchema, type Profile, type Fact, type Value } from "./types.js";
import type { Vault } from "./vault.js";
import type { Store } from "./db.js";
import { recognizePDFPages } from "./ocr.js";
import { orderedPDFText } from "./pdf-text.js";
import { parseResumeText } from "./resume-parser.js";
export { parseResumeText as draftFromText } from "./resume-parser.js";
export interface ProfileImportInfo {
  format: "pdf" | "text" | "json";
  pages?: number;
  ocrPages?: number;
}
export const blankProfile = (): Profile => ProfileSchema.parse({});
export async function loadProfile(vault: Vault): Promise<Profile> {
  const raw = await vault.get("profile");
  return raw ? ProfileSchema.parse(JSON.parse(raw)) : blankProfile();
}
export async function saveProfile(vault: Vault, store: Store, p: Profile) {
  await vault.set("profile", JSON.stringify(ProfileSchema.parse(p)));
  if (vault.kind !== "session") store.setMeta("profileRef", "keychain:profile");
  else store.event(null, "PROFILE_SESSION_ONLY");
}
export async function importProfile(
  file: string | undefined,
  text: string | undefined,
  dir: string,
  extracted?: (info: ProfileImportInfo) => void,
): Promise<Profile> {
  let p: Profile;
  if (file) {
    if ((await stat(file)).size > 20 * 1024 * 1024)
      throw new Error("简历超过 20 MB");
    const ext = extname(file).toLowerCase();
    if (ext === ".json") {
      extracted?.({ format: "json" });
      p = ProfileSchema.parse(JSON.parse(await readFile(file, "utf8")));
      // Import never grants confirmation or disclosure, even if input claims otherwise.
      for (const f of Object.values(p.facts)) {
        f.state =
          f.state === "conflict"
            ? "conflict"
            : f.value === undefined
              ? "missing"
              : "pending";
        f.discloseTo = [];
      }
      if (p.resume) {
        const attachment = resolve(file, "..", p.resume);
        p.resume = await storeAttachment(attachment, dir);
      }
    } else {
      if (ext === ".pdf") {
        const { getDocument, GlobalWorkerOptions } =
          await import("pdfjs-dist/legacy/build/pdf.mjs");
        // PDF.js does not recognize Electron utilityProcess as Node, so its
        // automatic worker path is unset there. Resolve the matching bundled
        // worker explicitly; never fetch executable parser code from a CDN.
        GlobalWorkerOptions.workerSrc = import.meta
          .resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
        const task = getDocument({
          data: new Uint8Array(await readFile(file)),
          // This is text extraction in a process without a DOM, not rendering.
          useSystemFonts: true,
          disableFontFace: true,
          isOffscreenCanvasSupported: false,
          isImageDecoderSupported: false,
        });
        const pages: string[] = [];
        try {
          const doc = await task.promise;
          for (let i = 1; i <= doc.numPages; i++) {
            const content = await (await doc.getPage(i)).getTextContent();
            pages.push(orderedPDFText(content.items));
          }
        } finally {
          await task.destroy();
        }
        const scanPages = pages.flatMap((page, index) =>
          page.replace(/\s/g, "").length < 20 ? [index + 1] : [],
        );
        if (scanPages.length) {
          for (const page of await recognizePDFPages(file, scanPages, dir)) {
            // Keep any existing text if OCR returns less useful content.
            if (page.text.trim().length > pages[page.page - 1]!.trim().length)
              pages[page.page - 1] = page.text;
          }
        }
        text = pages.join("\n");
        if (text.trim().length < 20)
          throw new Error(
            "PDF 文字提取和本地 OCR 都未识别出足够文字，请提供更清晰的扫描件，或导入 TXT/JSON",
          );
        extracted?.({
          format: "pdf",
          pages: pages.length,
          ocrPages: scanPages.length,
        });
      } else if ([".txt", ".md"].includes(ext)) {
        text = await readFile(file, "utf8");
        extracted?.({ format: "text" });
      } else
        throw new Error("个人资料仅支持 PDF（文字版或扫描版）、TXT/MD、JSON");
      p = parseResumeText(text ?? "");
      if (ext === ".pdf") p.resume = await storeAttachment(file, dir);
    }
  } else {
    if (!text?.trim()) throw new Error("请提供文件或粘贴文本");
    p = parseResumeText(text);
    extracted?.({ format: "text" });
  }
  return p;
}
export async function storeAttachment(file: string, dir: string) {
  if ((await stat(file)).size > 20 * 1024 * 1024)
    throw new Error("附件超过 20 MB");
  const path = join(
    dir,
    "attachments",
    randomUUID() + extname(file).toLowerCase(),
  );
  await copyFile(file, path);
  await chmod(path, 0o600);
  return path;
}
export function allowedAttachment(path: string, dir: string) {
  const rel = relative(resolve(dir, "attachments"), resolve(path));
  return !!rel && !rel.startsWith("..") && !rel.includes("/../");
}
export function confirmFact(p: Profile, key: string, value: Value) {
  if (
    !/^[a-zA-Z][\w.-]{0,120}$/.test(key) ||
    key.includes("__proto__") ||
    key.includes("constructor")
  )
    throw new Error("资料字段路径不合法");
  const source = p.facts[key]?.source;
  p.facts[key] = {
    state: "confirmed",
    value,
    discloseTo: [],
    ...(source ? { source } : {}),
  };
}
export function factFor(
  p: Profile,
  key: string,
  overrides: Record<string, Fact> = {},
) {
  return overrides[key] ?? p.facts[key];
}
