import { it, expect, afterEach, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { testState } from "./helpers.js";
import { importProfile } from "../src/profile.js";
import { suggestMappings } from "../src/model.js";
import { MemoryVault } from "../src/vault.js";
import type { Field } from "../src/browser/observe.js";
const states: ReturnType<typeof testState>[] = [];
function setup() {
  const s = testState();
  states.push(s);
  return s;
}
afterEach(() => {
  vi.unstubAllGlobals();
  states.splice(0).forEach((s) => s.dispose());
});
function pdf(text: string) {
  const stream = `BT /F1 12 Tf 50 700 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return out;
}
it("实际解析文本 PDF，空白/扫描型无文本 PDF 明确拒绝 OCR", async () => {
  const s = setup(),
    file = join(s.dir, "resume.pdf");
  writeFileSync(file, pdf("Email: sample@example.invalid Phone: 13812345678"));
  const p = await importProfile(file, undefined, s.dir);
  expect(p.facts["basic.email"]?.value).toBe("sample@example.invalid");
  expect(p.resume).toContain("/attachments/");
  writeFileSync(file, pdf(""));
  await expect(importProfile(file, undefined, s.dir)).rejects.toThrow(
    "不做 OCR",
  );
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
