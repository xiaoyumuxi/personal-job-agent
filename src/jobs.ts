import ExcelJS from "exceljs";
import { parse } from "csv-parse/sync";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { Job, Site } from "./types.js";
import { safeUrl, findSite } from "./config.js";
export const HEADERS: Record<string, string[]> = {
  company: ["公司", "公司名称", "企业", "company"],
  title: ["岗位", "职位", "岗位名称", "职位名称", "title", "position"],
  batch: ["批次", "招聘批次", "batch"],
  jobCode: ["岗位编号", "职位编号", "岗位id", "jobid", "jobcode"],
  url: [
    "投递入口",
    "投递链接",
    "官网链接",
    "申请链接",
    "链接",
    "url",
    "applyurl",
  ],
  referral: ["内推", "内推信息", "内推码", "referral"],
  account: ["账户", "account"],
  tenant: ["站点租户", "tenant"],
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
    await wb.xlsx.readFile(file);
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
  const ambiguous: string[] = [];
  header.forEach((cell, i) => {
    const label = cell.text.trim();
    const key =
      overrides[label] ??
      Object.keys(HEADERS).find((k) =>
        HEADERS[k]!.includes(label.toLowerCase().replace(/\s/g, "")),
      );
    if (key && key !== "ignore") {
      if (mapping[key] !== undefined) ambiguous.push(key);
      else mapping[key] = i;
    }
  });
  if (ambiguous.length)
    throw new Error(
      "表头映射有歧义：" +
        ambiguous.join(", ") +
        "。使用 --columns 提供明确的 表头:字段 映射，忽略列映射为 ignore",
    );
  if (mapping.company === undefined || mapping.title === undefined)
    throw new Error("缺少公司或岗位列，请使用 --columns JSON 映射");
  return mapping;
}
export function jobsFromGrid(
  grid: Grid,
  sites: Site[],
  columns: Record<string, string> = {},
): Omit<Job, "id">[] {
  const [header, ...rows] = grid.rows;
  if (!header) throw new Error("没有表头");
  const m = resolveHeaders(header, columns);
  return rows.flatMap((row, index) => {
    const get = (k: string) =>
      m[k] === undefined ? "" : (row[m[k]!]?.text.trim() ?? "");
    const company = get("company"),
      title = get("title");
    if (!company && !title) return [];
    const cell = m.url === undefined ? undefined : row[m.url];
    const url = cell?.link ?? get("url");
    let tenant = get("tenant"),
      account = get("account") || "default";
    if (url) {
      const u = safeUrl(url);
      const site = findSite(sites, url);
      tenant = tenant || site?.tenant || u.origin;
      account = get("account") || site?.account || "default";
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
        channel: url ? ("READY" as const) : ("NEEDS_CHANNEL" as const),
      },
    ];
  });
}
