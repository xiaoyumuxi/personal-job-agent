import { it, expect, afterEach, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { testState } from "./helpers.js";
import { importProfile } from "../src/profile.js";
import { suggestMappings } from "../src/model.js";
import { MemoryVault } from "../src/vault.js";
import type { Field } from "../src/browser/observe.js";
import { textPDF as pdf } from "./pdf-fixture.js";
import { recognizePDFPages } from "../src/ocr.js";
import { importProfileFile } from "../src/application/services.js";
vi.mock("../src/ocr.js", () => ({ recognizePDFPages: vi.fn() }));
const states: ReturnType<typeof testState>[] = [];
function setup() {
  const s = testState();
  states.push(s);
  return s;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(recognizePDFPages).mockReset();
  states.splice(0).forEach((s) => s.dispose());
});
it("文字 PDF 直接提取；空白 PDF 自动尝试 OCR 后明确报告无文字", async () => {
  const s = setup(),
    file = join(s.dir, "resume.pdf");
  writeFileSync(file, pdf("Email: sample@example.invalid Phone: 13812345678"));
  const p = await importProfile(file, undefined, s.dir);
  expect(p.facts["basic.email"]?.value).toBe("sample@example.invalid");
  expect(p.resume).toContain("/attachments/");
  expect(recognizePDFPages).not.toHaveBeenCalled();
  writeFileSync(file, pdf(""));
  vi.mocked(recognizePDFPages).mockResolvedValue([{ page: 1, text: "" }]);
  await expect(importProfile(file, undefined, s.dir)).rejects.toThrow(
    "本地 OCR 都未识别出足够文字",
  );
  expect(recognizePDFPages).toHaveBeenCalledWith(file, [1], s.dir);
});
it("OCR 识别结果复用原资料 schema，只产生待确认候选并报告识别来源", async () => {
  const s = setup(),
    file = join(s.dir, "scan.pdf");
  writeFileSync(file, pdf(""));
  vi.mocked(recognizePDFPages).mockResolvedValue([
    {
      page: 1,
      text: "姓名：测试本人\nEmail: ocr@example.invalid\nPhone: 13812345678",
    },
  ]);
  const report = vi.fn();
  const profile = await importProfile(file, undefined, s.dir, report);
  expect(profile.facts["basic.name"]?.value).toBe("测试本人");
  expect(profile.facts["basic.email"]?.value).toBe("ocr@example.invalid");
  expect(profile.facts["basic.email"]?.state).toBe("pending");
  expect(profile.facts["basic.email"]?.discloseTo).toEqual([]);
  expect(report).toHaveBeenCalledWith({ format: "pdf", pages: 1, ocrPages: 1 });
});
it("导入部分识别结果不会清空已确认资料，版本只保存非敏感识别统计", async () => {
  const s = setup(),
    vault = new MemoryVault(),
    file = join(s.dir, "scan.pdf");
  await vault.set(
    "profile",
    JSON.stringify({
      facts: { "basic.name": { state: "confirmed", value: "已确认姓名" } },
    }),
  );
  writeFileSync(file, pdf(""));
  vi.mocked(recognizePDFPages).mockResolvedValue([
    { page: 1, text: "Email: ocr@example.invalid Phone: 13812345678" },
  ]);
  const imported = await importProfileFile(s.store, vault, s.dir, file);
  expect(imported.facts["basic.name"]?.value).toBe("已确认姓名");
  expect(imported.facts["basic.name"]?.state).toBe("confirmed");
  const version = s.store.getMeta<{ extraction: unknown }>("profileVersion");
  expect(version?.extraction).toEqual({ format: "pdf", pages: 1, ocrPages: 1 });
  expect(JSON.stringify(version)).not.toContain("ocr@example.invalid");
});
it("模型无授权零调用；只发送标签和字段路径；严格校验返回 schema", async () => {
  const s = setup(),
    vault = new MemoryVault();
  await vault.set("model-key", "test-key");
  s.config.model = {
    enabled: true,
    consent: false,
    name: "test-only",
    endpoint: "https://model.example.invalid/chat/completions",
  };
  const field = {
    uid: "field1",
    label: "姓名",
    section: "基本信息",
    type: "text",
    value: "NEVER_SEND_ME",
  } as Field;
  let body = "";
  const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
    body = String(init.body);
    return new Response(
      JSON.stringify({
        usage: { prompt_tokens: 12, completion_tokens: 8 },
        choices: [
          {
            message: {
              content: JSON.stringify({
                mappings: [{ id: "field1", path: "basic.name" }],
              }),
            },
          },
        ],
      }),
      { status: 200 },
    );
  });
  vi.stubGlobal("fetch", fetch);
  expect(
    await suggestMappings([field], ["basic.name"], s.config, s.store, vault),
  ).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
  s.config.model.consent = true;
  expect(
    await suggestMappings([field], ["basic.name"], s.config, s.store, vault),
  ).toHaveLength(1);
  expect(body).not.toContain("NEVER_SEND_ME");
  expect(body).toContain("basic.name");
  expect(
    s.store.db.prepare("SELECT data FROM events WHERE kind='MODEL_CALL'").get()
      ?.data,
  ).toContain("12");
  fetch.mockImplementationOnce(
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            { message: { content: '{"mappings":[],"code":"process.exit()"}' } },
          ],
        }),
      ),
  );
  expect(
    await suggestMappings([field], ["basic.name"], s.config, s.store, vault),
  ).toEqual([]);
});
