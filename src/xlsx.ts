import JSZip from "jszip";
import { SaxesParser, type SaxesTagNS } from "saxes";
import { posix } from "node:path";

const spreadsheetNS =
  "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const packageNS =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const relationshipNS =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const unprefixed = new Set([spreadsheetNS, packageNS]);
const escapeText = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttribute = (value: string) =>
  escapeText(value)
    .replace(/"/g, "&quot;")
    .replace(/\r/g, "&#13;")
    .replace(/\n/g, "&#10;")
    .replace(/\t/g, "&#9;");

// ExcelJS matches literal tag names, so valid <x:workbook> and prefixed
// Relationships are otherwise skipped. Normalize only the known OOXML
// namespaces in memory; preserve extension namespaces and all cell values.
function compatibleXML(xml: string, entryName: string): string {
  const parser = new SaxesParser({ xmlns: true });
  const output: string[] = [];
  let changed = false;
  const name = (tag: SaxesTagNS) =>
    unprefixed.has(tag.uri) ? tag.local : tag.name;
  parser.on("xmldecl", () =>
    output.push('<?xml version="1.0" encoding="UTF-8"?>'),
  );
  parser.on("opentag", (tag) => {
    const attributes: Record<string, string> = {};
    for (const attribute of Object.values(tag.attributes)) {
      const key =
        attribute.uri === relationshipNS
          ? `r:${attribute.local}`
          : attribute.name;
      attributes[key] = attribute.value;
      if (key !== attribute.name) {
        changed = true;
        attributes["xmlns:r"] = relationshipNS;
      }
    }
    if (name(tag) !== tag.name) {
      changed = true;
      attributes.xmlns = tag.uri;
    }
    // ExcelJS also indexes table relationships by a relative target.
    if (
      tag.uri === packageNS &&
      tag.local === "Relationship" &&
      attributes.TargetMode !== "External" &&
      attributes.Target?.startsWith("/")
    ) {
      attributes.Target = posix.relative(
        posix.dirname(posix.dirname(entryName)),
        attributes.Target.slice(1),
      );
      changed = true;
    }
    output.push(
      `<${name(tag)}${Object.entries(attributes)
        .map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`)
        .join("")}${tag.isSelfClosing ? "/" : ""}>`,
    );
  });
  parser.on("closetag", (tag) => {
    if (!tag.isSelfClosing) output.push(`</${name(tag)}>`);
  });
  parser.on("text", (value) => output.push(escapeText(value)));
  parser.on("cdata", (value) => output.push(`<![CDATA[${value}]]>`));
  parser.on("comment", (value) => output.push(`<!--${value}-->`));
  parser.on("processinginstruction", ({ target, body }) =>
    output.push(`<?${target} ${body}?>`),
  );
  parser.on("doctype", () => {
    throw new Error("不支持含 DTD 的 XLSX 文件");
  });
  parser.write(xml).close();
  return changed ? output.join("") : xml;
}

export async function compatibleXlsx(buffer: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer);
  let changed = false;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || !/\.(xml|rels)$/i.test(entry.name)) continue;
    const xml = await entry.async("string");
    const normalized = compatibleXML(xml, entry.name);
    if (xml !== normalized) {
      zip.file(entry.name, normalized);
      changed = true;
    }
  }
  return changed ? zip.generateAsync({ type: "nodebuffer" }) : buffer;
}
