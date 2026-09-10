import { afterEach, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { SaxesParser } from "saxes";
import { jobsFromGrid, readJobs, resolveHeaders } from "../src/jobs.js";
import { compatibleXlsx } from "../src/xlsx.js";
import { DesktopService } from "../desktop/service.js";
import { MemoryVault } from "../src/vault.js";
import { testState } from "./helpers.js";

const resources: ReturnType<typeof testState>[] = [];
const setup = () => {
  const state = testState();
  resources.push(state);
  return state;
};
afterEach(() => resources.splice(0).forEach((state) => state.dispose()));
const headers = [
  "企业名称",
  "行业",
  "内推类型",
  "招聘岗位",
  "工作地点",
  "（跳转之后复制到浏览器打开）内推链接/官网",
  "内推码（区分大小码）",
  "投递注意事项",
  "毕业时间要求",
  "内推链接/官网（完整地址）",
  "笔试安排&校招日历（附件地址）",
];
const row = [
  "示例公司(9.1开启)",
  "机器人/自动驾驶/AI硬件类",
  "27届正式批",
  "算法类、研发类",
  "上海、杭州",
  "官网链接（请填写内推码）",
  "AbC123",
  "先选择岗位\n再填写内推码",
  "2026年11月—2027年10月",
  "https://example.com/campus?ref=a%2Bb&x=2",
  "https://example.com/calendar.png",
];

async function workbookFixture(file: string) {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("招聘表");
  sheet.addTable({
    name: "Recruitment",
    ref: "A1",
    headerRow: true,
    columns: headers.map((name) => ({ name })),
    rows: [row],
  });
  sheet.getCell("F2").value = { text: row[5]!, hyperlink: row[9]! };
  await wb.xlsx.writeFile(file);
  const zip = await JSZip.loadAsync(await readFile(file));
  // Exercise the exact dialect that previously failed: prefixed spreadsheet
  // tags and relationship tags, plus an absolute internal table target.
  for (const entry of Object.values(zip.files)) {
    if (
      entry.dir ||
      !/^xl\/(workbook\.xml|sharedStrings\.xml|styles\.xml|worksheets\/sheet\d+\.xml|tables\/table\d+\.xml)$/.test(
        entry.name,
      )
    )
      continue;
    const xml = (await entry.async("string"))
      .replace(
        'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
        'xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
      )
      .replace(/<(\/?)([A-Za-z][\w-]*)(?=[\s/>])/g, "<$1x:$2");
    zip.file(entry.name, xml);
  }
  const relPath = "xl/worksheets/_rels/sheet1.xml.rels";
  const rels = (await zip.file(relPath)!.async("string"))
    .replace(
      'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"',
      'xmlns:p="http://schemas.openxmlformats.org/package/2006/relationships"',
    )
    .replace(/<(\/?)(Relationships?)(?=[\s/>])/g, "<$1p:$2")
    .replace('Target="../tables/table1.xml"', 'Target="/xl/tables/table1.xml"');
  zip.file(relPath, rels);
  await writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));
}

describe("招聘表导入兼容", () => {
  it("读取带命名空间前缀和绝对表格关系的 XLSX，保留文本、换行和超链接", async () => {
    const state = setup();
    const file = join(state.dir, "招聘.xlsx");
    await workbookFixture(file);
    const before = await readFile(file);
    const [grid] = await readJobs(file);
    expect(grid!.rows[1]![5]).toEqual({ text: row[5], link: row[9] });
    const [job] = jobsFromGrid(grid!, []);
    expect(job).toMatchObject({
      company: row[0],
      title: row[3],
      batch: row[2],
      referral: "AbC123",
      url: row[9],
      note: row[7],
      channel: "READY",
    });
    expect(job!.sourceFields).toMatchObject({
      行业: row[1],
      工作地点: row[4],
      毕业时间要求: row[8],
    });
    expect(await readFile(file)).toEqual(before);
    const compatible = await compatibleXlsx(before);
    const zip = await JSZip.loadAsync(compatible);
    for (const entry of Object.values(zip.files)) {
      if (!entry.dir && /\.(xml|rels)$/.test(entry.name))
        new SaxesParser({ xmlns: true })
          .write(await entry.async("string"))
          .close();
    }
  });
  it("桌面导入使用同一映射；坏链接不阻断有效岗位，不创建申请", async () => {
    const state = setup();
    const file = join(state.dir, "招聘.csv");
    const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const bad = [...row];
    bad[0] = "链接待补充公司";
    bad[9] = "https:// https://example.com/jobs";
    await writeFile(
      file,
      "\uFEFF" +
        [headers, row, bad]
          .map((values) => values.map(quote).join(","))
          .join("\r\n"),
    );
    const service = new DesktopService(() => {}, state.dir, new MemoryVault());
    try {
      expect(await service.importFile("jobs", file)).toMatchObject({
        imported: 2,
        duplicates: 0,
        needsChannel: 1,
      });
    } finally {
      service.close();
    }
    expect(state.store.jobs()).toHaveLength(2);
    expect(state.store.applications()).toHaveLength(0);
    expect(state.store.jobs()[1]).toMatchObject({
      url: "",
      channel: "NEEDS_CHANNEL",
      sourceFields: { "投递链接（原始值）": bad[9] },
    });
    const selected = state.store.ensureApplication(state.store.jobs()[0]!.id);
    expect(selected.note).toBe(row[7]);
  });
  it("完整地址优先于显示文案；全半角备注兼容，显式映射仍可覆盖", () => {
    const gridHeaders = headers.map((text) => ({ text }));
    expect(resolveHeaders(gridHeaders)).toMatchObject({
      company: 0,
      batch: 2,
      title: 3,
      url: 9,
      referral: 6,
    });
    expect(resolveHeaders([...gridHeaders].reverse()).url).toBe(1);
    expect(resolveHeaders(gridHeaders, { [headers[5]!]: "url" }).url).toBe(5);
    const withoutFull = headers
      .slice(0, 9)
      .map((text) => ({ text: text.normalize("NFKC") }));
    expect(resolveHeaders(withoutFull).url).toBe(5);
  });
  it("无效或不安全的地址保留为待补充，不赋予可打开的入口", () => {
    for (const address of [
      "javascript:alert(1)",
      "file:///tmp/private",
      "https://name:secret@example.com/",
      "点此申请",
    ]) {
      const values = [...row];
      values[9] = address;
      const [job] = jobsFromGrid(
        {
          source: "test",
          rows: [
            headers.map((text) => ({ text })),
            values.map((text) => ({ text })),
          ],
        },
        [],
      );
      expect(job).toMatchObject({
        url: "",
        channel: "NEEDS_CHANNEL",
        sourceFields: { "投递链接（原始值）": address },
      });
    }
  });
  it("损坏的 XLSX 返回可操作的错误", async () => {
    const state = setup();
    const file = join(state.dir, "broken.xlsx");
    await writeFile(file, "not a zip file");
    await expect(readJobs(file)).rejects.toThrow(
      "无法读取 Excel 文件「broken.xlsx」",
    );
  });
});
