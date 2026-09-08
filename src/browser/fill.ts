import type { Page } from "playwright";
import { createHash } from "node:crypto";
import type { Fact, MappingRule, Profile, Site, Value } from "../types.js";
import { factFor, allowedAttachment } from "../profile.js";
import {
  observe,
  fieldLocator,
  type Field,
  type Observation,
} from "./observe.js";
import { allowedPage } from "./session.js";
export interface FillIssue {
  field?: Field;
  path?: string;
  reason: string;
}
const norm = (s: string) => s.toLowerCase().replace(/[\s*：:()（）]/g, "");
const empty = (v: unknown) =>
  v === "" || v === false || (Array.isArray(v) && v.length === 0);
export function matchField(f: Field, rules: MappingRule[]): string | undefined {
  if (f.configuredPath) return f.configuredPath;
  const hits = rules.filter(
    (r) =>
      [r.section, ...(r.sectionAliases ?? [])].some(
        (s) => norm(s) === norm(f.section),
      ) && r.aliases.some((a) => norm(a) === norm(f.label)),
  );
  const paths = [...new Set(hits.map((r) => r.path))];
  return paths.length === 1 ? paths[0] : undefined;
}
export function cacheKey(
  site: Site | undefined,
  url: string,
  ob: Observation,
  f: Field,
) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        site?.tenant ?? new URL(url).origin,
        site?.account ?? "default",
        new URL(url).pathname,
        ob.step,
        ob.signature,
        f.section,
        f.label,
        f.type,
        f.repeatKind,
      ]),
    )
    .digest("hex");
}
export class FillEngine {
  bindings = new Map<string, string>();
  private protectedFields = new Set<string>();
  private written = new Map<string, unknown>();
  private approved = new Map<string, string>();
  private previous?: Observation;
  private actionCount = 0;
  private nextCount = 0;
  private states = new Map<string, number>();
  constructor(
    public page: Page,
    public profile: Profile,
    public rules: MappingRule[],
    public site: Site | undefined,
    public origins: string[],
    public dir: string,
    public overrides: Record<string, Fact> = {},
    public maxActions = 100,
    public maxSteps = 15,
    private checkpoint: () => Promise<boolean> = async () => false,
  ) {}
  approveMapping(field: Field, path: string) {
    this.approved.set(field.uid, path);
  }
  bind(record: string, profileId: string) {
    if (
      [...this.bindings.entries()].some(
        ([k, v]) => k !== record && v === profileId,
      )
    )
      throw new Error("该资料记录已绑定到另一条经历，请核查");
    this.bindings.set(record, profileId);
  }
  async observation() {
    if (
      !allowedPage(this.page, this.origins) ||
      (this.site &&
        !new URL(this.page.url()).pathname.startsWith(this.site.pathPrefix))
    )
      throw new Error("页面跳转到未授权来源或租户路径，停止填写");
    const ob = await observe(this.page, this.site, this.origins);
    return ob;
  }
  async adoptManual() {
    const current = await this.observation();
    for (const f of current.fields) {
      const old = this.previous?.fields.find(
        (x) => x.uid === f.uid && x.frame === f.frame,
      );
      if (
        !empty(f.value) ||
        (old && JSON.stringify(old.value) !== JSON.stringify(f.value))
      )
        this.protectedFields.add(f.uid);
      this.written.delete(f.uid);
    }
    this.previous = current;
    return current;
  }
  async pass(): Promise<{
    ob: Observation;
    issues: FillIssue[];
    filled: number;
  }> {
    let filled = 0;
    for (; this.actionCount < this.maxActions;) {
      if (await this.checkpoint()) await this.adoptManual();
      const ob = await this.observation();
      this.previous = ob;
      const issues: FillIssue[] = [];
      if (ob.warnings.some((w) => w.includes("认证控件")))
        return {
          ob,
          issues: [
            { reason: "存在认证控件，请本人先完成登录；不自动填写认证页面" },
          ],
          filled,
        };
      for (const f of ob.fields) {
        if (
          this.written.has(f.uid) &&
          JSON.stringify(this.written.get(f.uid)) !== JSON.stringify(f.value)
        ) {
          this.protectedFields.add(f.uid);
          this.written.delete(f.uid);
          issues.push({
            field: f,
            reason: "页面/上传改变了已填写内容，请人工核查",
          });
        }
      }
      if (issues.length) return { ob, issues, filled };
      let candidate: { f: Field; path: string; fact: Fact } | undefined;
      for (const f of ob.fields) {
        if (!f.visible || !f.editable || this.protectedFields.has(f.uid))
          continue;
        if (this.written.has(f.uid)) continue;
        if (!empty(f.value)) {
          if (f.errors.length)
            issues.push({ field: f, reason: "已有输入校验失败，请人工修改" });
          continue;
        }
        if (f.sensitive) {
          issues.push({ field: f, reason: "声明/协议/敏感披露须本人处理" });
          continue;
        }
        if (f.record && !this.bindings.has(f.record)) {
          issues.push({ field: f, reason: "先将本页经历绑定到具体资料记录" });
          continue;
        }
        let path =
          f.configuredPath ??
          this.approved.get(f.uid) ??
          matchField(f, this.rules);
        if (path?.includes("$")) {
          const binding = f.record ? this.bindings.get(f.record) : undefined;
          if (!binding) {
            issues.push({ field: f, reason: "重复经历缺少明确绑定" });
            continue;
          }
          path = path.replace("$", binding);
        }
        if (!path) {
          if (f.required !== false)
            issues.push({
              field: f,
              reason: "必填或必填状态未知，字段含义未识别",
            });
          continue;
        }
        const fact =
          f.type === "file" && this.profile.resume
            ? {
                state: "confirmed" as const,
                value: this.profile.resume,
                discloseTo: this.origins,
              }
            : factFor(this.profile, path, this.overrides);
        if (!fact || fact.state !== "confirmed" || fact.value === undefined) {
          if (f.required !== false)
            issues.push({
              field: f,
              path,
              reason:
                fact?.state === "conflict" ? "资料冲突" : "缺少已确认资料",
            });
          continue;
        }
        if (
          f.required !== true &&
          !fact.discloseTo.some((o) => this.origins.includes(o))
        ) {
          continue;
        }
        if (
          f.type === "date" &&
          /^\d{4}(?:-\d{2})?$/.test(String(fact.value))
        ) {
          issues.push({
            field: f,
            path,
            reason: "简历日期只有年或月，请补充具体日期；不会擅自补成每月 1 日",
          });
          continue;
        }
        if (["date", "month"].includes(f.type) && fact.value === "至今") {
          issues.push({
            field: f,
            path,
            reason: "此经历仍在进行，请在官网选择至今或补充结束日期",
          });
          continue;
        }
        if (f.type === "radio") {
          const group = ob.fields.filter(
            (g) =>
              g.frame === f.frame &&
              g.type === "radio" &&
              g.name === f.name &&
              g.section === f.section &&
              g.record === f.record,
          );
          if (group.some((g) => g.value === true && !this.written.has(g.uid)))
            continue;
          const desired = String(fact.value);
          const matches = group.filter(
            (g) =>
              g.optionValue === desired ||
              g.options.some((o) => o.label === desired),
          );
          if (matches.length !== 1) {
            issues.push({
              field: f,
              path,
              reason: "单选答案未匹配唯一选项，请人工选择",
            });
            continue;
          }
          if (matches[0]!.uid !== f.uid) continue;
        }
        candidate = { f, path, fact };
        break;
      }
      if (!candidate) return { ob, issues, filled };
      const { f, fact } = candidate;
      if (await this.checkpoint()) {
        await this.adoptManual();
        continue;
      }
      try {
        await this.execute(f, fact.value!);
        this.actionCount++;
        filled++;
        const after = await this.observation();
        const updated = after.fields.find(
          (x) => x.uid === f.uid && x.frame === f.frame,
        );
        if (!updated)
          return {
            ob: after,
            issues: [{ field: f, reason: "填写后控件结构改变，请人工核查" }],
            filled,
          };
        this.written.set(f.uid, updated.value);
        if (updated.errors.length)
          return {
            ob: after,
            issues: [
              {
                field: updated,
                path: candidate.path,
                reason: "填写后出现校验错误，请人工核查",
              },
            ],
            filled,
          };
      } catch {
        return {
          ob: await this.observation(),
          issues: [
            {
              field: f,
              path: candidate.path,
              reason: "控件执行或回读失败，请人工接管",
            },
          ],
          filled,
        };
      }
    }
    return {
      ob: await this.observation(),
      issues: [{ reason: "达到最大自动动作次数" }],
      filled,
    };
  }
  private async execute(f: Field, value: Value) {
    if (!allowedPage(this.page, this.origins))
      throw new Error("ORIGIN_CHANGED");
    const loc = fieldLocator(this.page, f);
    if (
      (await loc.count()) !== 1 ||
      !(await loc.isVisible()) ||
      !(await loc.isEnabled())
    )
      throw new Error("FIELD_CHANGED");
    if (f.type === "file") {
      if (typeof value !== "string" || !allowedAttachment(value, this.dir))
        throw new Error("UNTRUSTED_ATTACHMENT");
      await loc.setInputFiles(value);
      return;
    }
    if (f.type.startsWith("select")) {
      const wanted = Array.isArray(value) ? value : [String(value)];
      const options = wanted.map((v) =>
        f.options.filter((o) => o.value === v || o.label === v),
      );
      if (options.some((x) => x.length !== 1))
        throw new Error("AMBIGUOUS_OPTION");
      const values = options.map((o) => o[0]!.value);
      const selected = await loc.selectOption(values);
      if (JSON.stringify(selected.sort()) !== JSON.stringify(values.sort()))
        throw new Error("SELECT_VERIFY_FAILED");
      return;
    }
    if (f.type === "radio" || f.type === "checkbox") {
      let checked: boolean;
      if (typeof value === "boolean") checked = value;
      else {
        const vals = Array.isArray(value) ? value : [String(value)];
        checked = vals.some(
          (v) => v === f.optionValue || f.options.some((o) => o.label === v),
        );
        if (f.type === "radio" && !checked) return;
      }
      await loc.setChecked(checked);
      if ((await loc.isChecked()) !== checked)
        throw new Error("CHECK_VERIFY_FAILED");
      return;
    }
    if (
      ![
        "text",
        "email",
        "tel",
        "url",
        "search",
        "number",
        "date",
        "month",
        "datetime-local",
        "textarea",
      ].includes(f.type)
    )
      throw new Error("UNSUPPORTED_CONTROL");
    if (Array.isArray(value) || typeof value === "boolean")
      throw new Error("VALUE_TYPE_MISMATCH");
    await loc.fill(String(value));
    if ((await loc.inputValue()) !== String(value))
      throw new Error("INPUT_VERIFY_FAILED");
  }
  async addRecord(section: string) {
    const r = this.site?.form?.repeats.find((r) => r.section === section);
    if (!r?.add) throw new Error("未配置安全的新增经历按钮");
    const before = await this.observation();
    const loc = this.page.locator(r.container).locator(r.add);
    if (
      (await loc.count()) !== 1 ||
      (await loc.getAttribute("type")) !== "button"
    )
      throw new Error("新增按钮不明确或可能提交");
    if (await this.checkpoint()) return this.adoptManual();
    await loc.click();
    const after = await this.observation();
    this.actionCount++;
    if (
      new Set(after.fields.map((f) => f.record).filter(Boolean)).size <=
      new Set(before.fields.map((f) => f.record).filter(Boolean)).size
    )
      throw new Error("新增经历未得到可验证结果");
    return after;
  }
  async next() {
    const before = await this.observation();
    const action = this.site?.form?.next.find(
      (n) => n.from === before.step && n.safe,
    );
    if (!action) throw new Error("未知导航动作，不自动执行；请在浏览器中操作");
    if (this.nextCount >= this.maxSteps) throw new Error("达到最大步骤数");
    const loc = this.page.locator(action.selector);
    if ((await loc.count()) !== 1) throw new Error("导航按钮不唯一");
    const label = (await loc.innerText()).trim();
    if (
      /提交|投递|发送申请|完成申请|submit|send application|apply now|finish/i.test(
        label,
      ) ||
      (await loc.getAttribute("type")) !== "button"
    )
      throw new Error("疑似提交动作，必须人工执行");
    if (await this.checkpoint()) return this.adoptManual();
    await loc.click();
    this.nextCount++;
    await this.page
      .waitForFunction(
        ({ selector, to }) => {
          const el = document.querySelector(selector);
          return (
            (el?.getAttribute("data-step") || el?.textContent?.trim()) === to
          );
        },
        {
          selector: this.site?.form?.stepSelector ?? "[data-step]",
          to: action.to,
        },
        { timeout: 3000 },
      )
      .catch(() => {});
    const after = await this.observation();
    const count = (this.states.get(after.signature) ?? 0) + 1;
    this.states.set(after.signature, count);
    if (count > 2) throw new Error("重复页面状态，停止自动导航");
    if (after.step !== action.to)
      throw new Error("下一步未到达预期步骤，检查页面校验提示");
    return after;
  }
  async receipt(jobCode: string) {
    const r = this.site?.form?.receipt;
    if (!r || !jobCode || !allowedPage(this.page, this.origins)) return false;
    const receipt = this.page.locator(r.selector),
      code = this.page.locator(r.jobCodeSelector);
    return (
      (await receipt.count()) === 1 &&
      (await receipt.isVisible()) &&
      (await receipt.innerText()).trim() === r.text &&
      (await code.count()) === 1 &&
      (await code.innerText()).trim() === jobCode
    );
  }
}
