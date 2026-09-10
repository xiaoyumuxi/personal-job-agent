import ExcelJS from "exceljs";
import { parse } from "csv-parse/sync";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { Job, Site } from "./types.js";
import { safeUrl, findSite } from "./config.js";
import { compatibleXlsx } from "./xlsx.js";
export const HEADERS: Record<string, string[]> = {
  company: ["公司", "公司名称", "企业", "企业名称", "company"],
  title: [
    "岗位",
    "投递岗位",
    "职位",
    "岗位名称",
    "职位名称",
    "招聘岗位",
    "招聘职位",
    "title",
    "position",
  ],
  batch: ["批次", "招聘批次", "内推类型", "招聘类型", "batch"],
  jobCode: ["岗位编号", "职位编号", "岗位id", "jobid", "jobcode"],
  url: [
    "投递入口",
    "投递链接",
    "官网链接",
    "岗位链接",
    "申请链接",
    "链接",
    "url",
    "applyurl",
    "内推链接/官网",
    "内推链接",
  ],
  referral: ["内推", "内推信息", "内推码", "referral"],
  account: ["账户", "account"],
  tenant: ["站点租户", "tenant"],
  applicationChannel: ["投递渠道"],
  note: ["备注", "人工备注", "投递注意事项"],
};
export interface Cell {
  text: string;
  link?: string;
}
export interface Grid {
  source: string;
  rows: Cell[][];
}
export async function readJobs(file?: string, text?: string): Promise<Grid[]> {
  if (file && extname(file).toLowerCase() === ".xlsx") {
    const wb = new ExcelJS.Workbook();
    const buffer = await readFile(file);
    try {
      await wb.xlsx.load(Uint8Array.from(await compatibleXlsx(buffer)).buffer);
    } catch (cause) {
      throw new Error(
        `无法读取 Excel 文件「${basename(file)}」。请确认文件是有效的 XLSX，或在 Excel 中另存为 XLSX / CSV 后重试。`,
        { cause },
      );
    }
    if (!wb.worksheets.length) throw new Error("Excel 文件没有可读取的工作表");
    const grids: Grid[] = [];
    wb.eachSheet((s) => {
      const rows: Cell[][] = [];
      s.eachRow({ includeEmpty: true }, (r) => {
        const cells: Cell[] = [];
        for (let n = 1; n <= s.columnCount; n++) {
          const c = r.getCell(n);
          const v = c.value;
          let link =
            v && typeof v === "object" && "hyperlink" in v
              ? String(v.hyperlink)
              : undefined;
          if (!link && v && typeof v === "object" && "formula" in v) {
            link = /^HYPERLINK\(\s*"([^"]+)"/i.exec(v.formula ?? "")?.[1];
          }
          cells.push({ text: c.text, link });
        }
        rows.push(cells);
      });
      grids.push({ source: basename(file) + "#" + s.name, rows });
    });
    return grids;
  }
  const content = file ? await readFile(file, "utf8") : text;
  if (!content) throw new Error("岗位数据为空");
  const delimiter = content.split(/\r?\n/)[0]!.includes("\t") ? "\t" : ",";
  return [
    {
      source: file ? basename(file) : "pasted",
      rows: (
        parse(content, {
          bom: true,
          delimiter,
          skip_empty_lines: true,
          relax_column_count: true,
        }) as string[][]
      ).map((row) => row.map((text) => ({ text }))),
    },
  ];
}
export function resolveHeaders(
  header: Cell[],
  overrides: Record<string, string> = {},
) {
  const mapping: Record<string, number> = {};
  const priorities: Record<string, number> = {};
  const ambiguous = new Set<string>();
  header.forEach((cell, i) => {
    const label = cell.text.trim();
    const key =
      overrides[label] ??
      Object.keys(HEADERS).find((k) =>
        HEADERS[k]!.includes(normalizeHeader(label)),
      );
    if (key && key !== "ignore") {
      // Exported Tencent sheets include both a display-label column and the
      // actual URL. Prefer the full address; keep unrelated duplicates explicit.
      const priority = overrides[label]
        ? 2
        : key === "url" && /[（(]完整地址[)）]/.test(label)
          ? 1
          : 0;
      if (mapping[key] === undefined || priority > priorities[key]!) {
        mapping[key] = i;
        priorities[key] = priority;
        ambiguous.delete(key);
      } else if (priority === priorities[key]) ambiguous.add(key);
    }
  });
  if (ambiguous.size)
    throw new Error(
      "表头映射有歧义：" +
        [...ambiguous].join(", ") +
        "。使用 --columns 提供明确的 表头:字段 映射，忽略列映射为 ignore",
    );
  if (mapping.company === undefined || mapping.title === undefined)
    throw new Error(
      "未识别公司或岗位列。支持「公司 / 企业名称」和「岗位 / 投递岗位 / 招聘岗位」等表头；自定义表头可通过 CLI 的 --columns JSON 映射。",
    );
  return mapping;
}
function normalizeHeader(label: string) {
  return label
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/\s/g, "");
}
export function jobsFromGrid(
  grid: Grid,
  sites: Site[],
  columns: Record<string, string> = {},
): Omit<Job, "id">[] {
  const [header, ...rows] = grid.rows;
  if (!header) throw new Error("没有表头");
  const m = resolveHeaders(header, columns);
  const mappedColumns = new Set(Object.values(m));
  return rows.flatMap((row, index) => {
    const get = (k: string) =>
      m[k] === undefined ? "" : (row[m[k]!]?.text.trim() ?? "");
    const company = get("company"),
      title = get("title");
    if (!company && !title) return [];
    const cell = m.url === undefined ? undefined : row[m.url];
    let url = cell?.link?.trim() ?? get("url");
    let importWarning: string | undefined;
    const sourceFields = Object.fromEntries(
      header.flatMap((h, i) => {
        if (mappedColumns.has(i) || columns[h.text.trim()] === "ignore")
          return [];
        const label = h.text.trim();
        const value = row[i]?.text.trim() ?? "";
        const link = row[i]?.link;
        if (!label || (!value && !link)) return [];
        return [
          [label, link && link !== value ? `${value}\n${link}`.trim() : value],
        ];
      }),
    );
    let tenant = get("tenant"),
      account = get("account") || "default";
    if (url) {
      try {
        const u = safeUrl(url);
        const site = findSite(sites, url);
        tenant = tenant || site?.tenant || u.origin;
        account = get("account") || site?.account || "default";
      } catch {
        sourceFields["投递链接（原始值）"] = url;
        importWarning =
          "原表投递链接格式无效，已保留原始值。请核对并补充官网入口。";
        url = "";
      }
    }
    return [
      {
        company,
        title,
        batch: get("batch"),
        jobCode: get("jobCode"),
        url,
        tenant,
        account,
        referral: get("referral"),
        source: `${grid.source}:${index + 2}`,
        ...(get("applicationChannel")
          ? { applicationChannel: get("applicationChannel").slice(0, 100) }
          : {}),
        ...(get("note") ? { note: get("note").slice(0, 2000) } : {}),
        ...(Object.keys(sourceFields).length ? { sourceFields } : {}),
        ...(importWarning ? { importWarning } : {}),
        channel: url ? ("READY" as const) : ("NEEDS_CHANNEL" as const),
      },
    ];
  });
}
