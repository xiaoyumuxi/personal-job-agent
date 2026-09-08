import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { ROOT } from "./config.js";
import { runFile } from "./process.js";

const OutputSchema = z
  .object({
    pages: z
      .array(
        z
          .object({
            page: z.number().int().positive(),
            text: z.string().max(12000),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();

async function prepareOCR(dir: string) {
  if (process.platform !== "darwin")
    throw new Error(
      "扫描 PDF 的本地 OCR 目前需要 macOS，请改用文字版 PDF 或 TXT/JSON",
    );
  const bundled = process.env.JOBAGENT_OCR_HELPER;
  if (bundled) {
    if (!existsSync(bundled))
      throw new Error("OCR 组件缺失，请重新构建客户端后导入");
    return bundled;
  }
  const helper = join(dir, "pdf-ocr-helper");
  if (!existsSync(helper)) {
    const build = await runFile(
      "/usr/bin/swiftc",
      [
        "-module-cache-path",
        join(dir, "swift-cache"),
        join(ROOT, "src/pdf-ocr.swift"),
        "-o",
        helper,
      ],
      { timeout: 60000 },
    );
    if (build.code !== 0 || build.timedOut)
      throw new Error(
        "本地 OCR 组件编译失败，请安装 Apple Command Line Tools，或使用已构建的客户端",
      );
  }
  return helper;
}

export async function recognizePDFPages(
  file: string,
  pages: number[],
  dir: string,
) {
  if (pages.length > 20)
    throw new Error("扫描页超过 20 页，请拆分或精简简历后导入");
  const result = await runFile(await prepareOCR(dir), [], {
    input: JSON.stringify({ file: resolve(file), pages }),
    timeout: 120000,
    maxBytes: 1500000,
  });
  if (result.timedOut)
    throw new Error("本地 OCR 超时，请减少扫描页数或降低 PDF 分辨率后重试");
  if (result.code !== 0)
    throw new Error(
      "本地 OCR 未能完成，请确认 PDF 可以正常打开且未加密，再重新导出后导入",
    );
  const parsed = OutputSchema.safeParse(
    (() => {
      try {
        return JSON.parse(result.stdout);
      } catch {
        return null;
      }
    })(),
  );
  if (
    !parsed.success ||
    parsed.data.pages.length !== pages.length ||
    new Set(parsed.data.pages.map((p) => p.page)).size !== pages.length ||
    parsed.data.pages.some((p) => !pages.includes(p.page))
  )
    throw new Error("本地 OCR 返回结果无效，请重试");
  return parsed.data.pages;
}
