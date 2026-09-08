import { createHash } from "node:crypto";
import type { Frame, Page } from "playwright";
import type { Site } from "../types.js";
export interface Field {
  uid: string;
  frame: number;
  label: string;
  section: string;
  type: string;
  name: string;
  options: { value: string; label: string }[];
  optionValue: string;
  visible: boolean;
  editable: boolean;
  required: boolean | "unknown";
  errors: string[];
  value: string | string[] | boolean;
  record: string | null;
  repeatKind: string | null;
  sensitive: boolean;
  configuredPath?: string;
}
export interface Observation {
  fields: Field[];
  navigation: { label: string; type: string }[];
  step: string;
  signature: string;
  coverage: "complete" | "partial";
  warnings: string[];
}
export function fieldLocator(page: Page, field: Field) {
  const frame = page.frames()[field.frame];
  if (!frame) throw new Error("FRAME_CHANGED");
  return frame.locator(`[data-ja-field="${field.uid}"]`);
}
export async function observe(
  page: Page,
  site?: Site,
  allowedOrigins?: string[],
): Promise<Observation> {
  const fields: Field[] = [],
    navigation: { label: string; type: string }[] = [],
    warnings: string[] = [];
  let step = "";
  const origins = allowedOrigins ?? [new URL(page.url()).origin];
  for (const [frameIndex, frame] of page.frames().entries()) {
    if (
      frame !== page.mainFrame() &&
      !origins.some((o) => frame.url().startsWith(o + "/"))
    ) {
      warnings.push(`iframe ${frameIndex} 未覆盖（来源未授权或空白框架）`);
      continue;
    }
    try {
      const result = await collectFrame(frame, site);
      fields.push(
        ...result.fields.map((f) => ({ ...f, frame: frameIndex }) as Field),
      );
      navigation.push(...result.navigation);
      warnings.push(...result.warnings);
      if (frame === page.mainFrame()) step = result.step;
    } catch {
      warnings.push(`frame ${frameIndex} 无法读取`);
    }
  }
  const structure = fields.map(
    ({ label, section, type, options, required, repeatKind, visible }) => ({
      label,
      section,
      type,
      options,
      required,
      repeatKind,
      visible,
    }),
  );
  const signature = createHash("sha256")
    .update(JSON.stringify({ step, structure }))
    .digest("hex");
  return {
    fields,
    navigation,
    step,
    signature,
    coverage: warnings.length ? "partial" : "complete",
    warnings,
  };
}
async function collectFrame(frame: Frame, site?: Site) {
  return frame.evaluate((form) => {
    const warnings: string[] = [];
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return (
        r.width > 0 &&
        r.height > 0 &&
        s.visibility !== "hidden" &&
        s.display !== "none"
      );
    };
    const text = (el: Element | null) =>
      el?.textContent?.trim().replace(/\s+/g, " ").slice(0, 200) ?? "";
    const uid = (el: Element, attr: string) => {
      if (!el.hasAttribute(attr)) el.setAttribute(attr, crypto.randomUUID());
      return el.getAttribute(attr)!;
    };
    const title = (el: Element | null): string =>
      el?.getAttribute("data-section") ||
      el?.getAttribute("aria-label") ||
      text(
        el?.querySelector(
          ":scope > legend, :scope > h1, :scope > h2, :scope > h3, :scope > h4",
        ) ?? null,
      ) ||
      "";
    if (
      document.querySelector(
        "input[type=password], input[autocomplete=one-time-code]",
      )
    )
      warnings.push("存在认证控件；认证信息不采集、不填写");
    if ([...document.querySelectorAll("*")].some((e) => e.shadowRoot))
      warnings.push(
        "存在 Shadow DOM，采集覆盖为 partial；未识别控件请人工处理",
      );
    const custom = [
      ...document.querySelectorAll(
        "[role=combobox], [contenteditable=true], [role=checkbox], [role=radio], canvas",
      ),
    ].filter(visible);
    if (custom.length)
      warnings.push(`存在 ${custom.length} 个自定义控件/区域，需人工接管`);
    const fields = [...document.querySelectorAll("input, textarea, select")]
      .filter(
        (el) =>
          !["hidden", "password", "submit", "button", "reset"].includes(
            (el as HTMLInputElement).type,
          ) && el.getAttribute("autocomplete") !== "one-time-code",
      )
      .map((el) => {
        const input = el as
          HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
        const kind = (input.type || el.tagName.toLowerCase()).toLowerCase();
        const labels = Array.from(input.labels ?? [])
          .map((label) => {
            const copy = label.cloneNode(true) as Element;
            copy
              .querySelectorAll("input,textarea,select")
              .forEach((e) => e.remove());
            return text(copy);
          })
          .join(" ");
        const labelled = el
          .getAttribute("aria-labelledby")
          ?.split(/\s+/)
          .map((id) => text(document.getElementById(id)))
          .join(" ");
        let label =
          el.getAttribute("aria-label") ||
          labelled ||
          labels ||
          el.getAttribute("placeholder") ||
          "";
        let section = "";
        let record: string | null = null;
        let repeatKind: string | null = null;
        for (const repeat of form?.repeats ?? []) {
          const container = el.closest(repeat.container);
          const rec = el.closest(repeat.records);
          if (container && rec && container.contains(rec)) {
            section = repeat.section;
            record = uid(rec, "data-ja-record");
            repeatKind = repeat.kind;
            break;
          }
        }
        if (!record) {
          const rec = el.closest("[data-record], [data-repeat-record]");
          if (rec) {
            record = uid(rec, "data-ja-record");
            repeatKind = rec.getAttribute("data-kind") || null;
          }
        }
        for (const s of form?.sections ?? []) {
          if (el.closest(s.selector)) {
            section = s.name;
            break;
          }
        }
        if (!section) {
          let parent =
            kind === "radio" || kind === "checkbox"
              ? (el.closest("fieldset, [role=group]")?.parentElement ??
                el.parentElement)
              : el.parentElement;
          while (parent && parent !== document.body) {
            if (
              parent.matches(
                "[data-section], fieldset, section, [role=group]",
              ) &&
              title(parent)
            ) {
              section = title(parent);
              break;
            }
            parent = parent.parentElement;
          }
        }
        let options: { value: string; label: string }[] = [];
        if (el instanceof HTMLSelectElement)
          options = Array.from(el.options).map((o) => ({
            value: o.value,
            label: o.label,
          }));
        if (kind === "radio" || kind === "checkbox") {
          const group = el.closest("fieldset, [role=group]");
          const groupLabel = title(group);
          if (
            groupLabel &&
            group !== el.closest("[data-section]") &&
            groupLabel !== section
          ) {
            label = groupLabel;
          }
          options = [
            { value: (input as HTMLInputElement).value, label: labels },
          ];
        }
        const explicit = form?.fields.find((f) => el.matches(f.selector));
        if (explicit?.section) section = explicit.section;
        const required =
          explicit?.required ??
          (input.required || el.getAttribute("aria-required") === "true"
            ? true
            : el.getAttribute("aria-required") === "false" ||
                el.getAttribute("data-optional") === "true"
              ? false
              : "unknown");
        const errors: string[] = [];
        if (input.validationMessage)
          errors.push(input.validationMessage.slice(0, 200));
        for (const id of (el.getAttribute("aria-describedby") ?? "").split(
          /\s+/,
        )) {
          const e = document.getElementById(id);
          if (
            e &&
            visible(e) &&
            e.matches("[role=alert], .error, [data-error]")
          )
            errors.push(text(e));
        }
        if (el.getAttribute("aria-invalid") === "true")
          errors.push("aria-invalid");
        const value =
          kind === "checkbox" || kind === "radio"
            ? (input as HTMLInputElement).checked
            : el instanceof HTMLSelectElement && el.multiple
              ? Array.from(el.selectedOptions).map((o) => o.value)
              : input.value;
        return {
          uid: uid(el, "data-ja-field"),
          label,
          section,
          type: kind,
          name: input.name,
          options,
          optionValue: (input as HTMLInputElement).value,
          visible: visible(el),
          editable: !input.disabled && !("readOnly" in input && input.readOnly),
          required,
          errors,
          value,
          record,
          repeatKind,
          configuredPath: explicit?.path,
          sensitive:
            /声明|承诺|协议|同意|授权|隐私|残疾|健康|民族|宗教|政治|薪资|身份证|护照|犯罪|consent|agree|declar|disab|salary|passport|ssn/i.test(
              section + " " + label + " " + input.name,
            ),
        };
      });
    const navigation = [
      ...document.querySelectorAll(
        "button, input[type=submit], a[href], [role=button]",
      ),
    ]
      .filter(visible)
      .map((e) => ({
        label: text(e) || (e as HTMLInputElement).value || "",
        type: e.getAttribute("type") || e.tagName.toLowerCase(),
      }));
    const stepEl = document.querySelector(form?.stepSelector ?? "[data-step]");
    const step = stepEl?.getAttribute("data-step") || text(stepEl) || "";
    return { fields, navigation, step, warnings };
  }, site?.form);
}
