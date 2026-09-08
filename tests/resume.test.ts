import { describe, it, expect } from "vitest";
import { draftFromText, confirmFact, loadProfile } from "../src/profile.js";
import { orderedPDFText } from "../src/pdf-text.js";
import { MemoryVault } from "../src/vault.js";
import { saveProfile } from "../src/profile.js";
import { importProfileFile } from "../src/application/services.js";
import { testState } from "./helpers.js";
import { mappings } from "../src/config.js";
import { matchField } from "../src/browser/fill.js";
import type { Field } from "../src/browser/observe.js";
import { ProfileSchema } from "../src/types.js";
import { structuredResume } from "./resume-fixture.js";

describe("resume structure and evidence", () => {
  it("reorders PDF drawing commands into spatial lines, including a detached date column", () => {
    const item = (str: string, x: number, y: number, width = 80) => ({
      str,
      width,
      height: 12,
      transform: [12, 0, 0, 12, x, y],
    });
    const text = orderedPDFText([
      item("个人项目", 30, 400),
      item("专业技能", 30, 200),
      item("熟悉数据库", 30, 180),
      item("测试框架", 30, 375),
      item("2025.07–2025.11", 350, 376),
      item("项目内容", 30, 350),
    ]);
    expect(text).toBe(
      "个人项目\n测试框架  2025.07–2025.11\n项目内容\n专业技能\n熟悉数据库",
    );
  });
  it("splits one education, two internships and a project with month precision and original descriptions", () => {
    const p = draftFromText(structuredResume);
    expect(p.records.education).toHaveLength(1);
    expect(p.records.experience).toHaveLength(2);
    expect(p.records.project).toHaveLength(1);
    const [edu] = p.records.education,
      [first, second] = p.records.experience,
      [project] = p.records.project;
    expect(p.facts[`education.${edu}.school`]?.value).toBe("南湖测试大学");
    expect(p.facts[`education.${edu}.major`]?.value).toBe("软件工程");
    expect(p.facts[`education.${edu}.qualification`]?.value).toBe("本科");
    expect(p.facts[`education.${edu}.degree`]).toBeUndefined();
    expect(p.facts[`experience.${first}.endDate`]?.value).toBe("至今");
    expect(p.facts[`experience.${second}.startDate`]?.value).toBe("2025-12");
    expect(p.facts[`project.${project}.endDate`]?.value).toBe("2025-11");
    expect(p.facts[`project.${project}.description`]?.value).toContain(
      "多协议请求处理",
    );
    expect(p.facts[`project.${project}.description`]?.value).not.toContain(
      "熟悉并发",
    );
    expect(p.facts[`project.${project}.responsibilities`]?.value).toBe(
      "负责服务发现与故障重试模块。",
    );
    expect(p.facts[`project.${project}.role`]).toBeUndefined();
    expect(p.facts[`education.${edu}.school`]?.source?.text).toContain(
      "南湖测试大学",
    );
    expect(
      Object.values(p.facts).every(
        (f) => f.state !== "confirmed" && !f.discloseTo.length,
      ),
    ).toBe(true);
    expect(p.facts["basic.name"]?.value).toBe("测试同学");
  });
  it("handles separated date lines, alternate headings, multiple academic entries and year-only dates", () => {
    const p = draftFromText(
      `教育背景\n2020–2024\n青川大学 | 计算机科学 本科\n青川大学 | 软件工程 硕士 2024.09–2027.06\n工作经历\n公司名称：测试软件有限公司\n职位：开发工程师\n入职时间：2025.10\n离职时间：2026.02\n工作内容：开发测试服务。\n个 ⼈ 项 ⽬\n项目名称：测试项目\n项目角色：开发成员\n项目描述：完成接口开发。`,
    );
    expect(p.records.education).toHaveLength(2);
    expect(
      p.facts[`education.${p.records.education[0]}.startDate`]?.value,
    ).toBe("2020");
    expect(
      p.facts[`experience.${p.records.experience[0]}.startDate`]?.value,
    ).toBe("2025-10");
    expect(p.facts[`experience.${p.records.experience[0]}.title`]?.value).toBe(
      "开发工程师",
    );
    expect(p.facts[`project.${p.records.project[0]}.role`]?.value).toBe(
      "开发成员",
    );
    expect(p.facts[`project.${p.records.project[0]}.startDate`]?.state).toBe(
      "missing",
    );
    expect(draftFromText("没有信息").facts["basic.name"]?.state).toBe(
      "missing",
    );
  });
  it("reimport is idempotent, preserves confirmed fields and flags changed descriptions", async () => {
    const s = testState(),
      vault = new MemoryVault();
    try {
      const first = await importProfileFile(
        s.store,
        vault,
        s.dir,
        undefined,
        structuredResume,
      );
      const path = `experience.${first.records.experience[0]}.description`;
      confirmFact(first, path, first.facts[path]!.value!);
      await saveProfile(vault, s.store, first);
      const again = await importProfileFile(
        s.store,
        vault,
        s.dir,
        undefined,
        structuredResume,
      );
      expect(again.records).toEqual(first.records);
      expect(again.facts[path]?.state).toBe("confirmed");
      const changed = await importProfileFile(
        s.store,
        vault,
        s.dir,
        undefined,
        structuredResume.replace("去重校验", "请求去重"),
        "update",
      );
      expect(changed.records).toEqual(first.records);
      expect(changed.facts[path]?.state).toBe("conflict");
      expect(changed.facts[path]?.candidates).toHaveLength(2);
      expect(JSON.stringify(s.store.getMeta("profileVersion"))).not.toContain(
        "测试大学",
      );
      expect(await loadProfile(vault)).toEqual(changed);
    } finally {
      s.dispose();
    }
  });
  it("keeps old version-1 profiles readable and adds an empty project collection", () => {
    expect(
      ProfileSchema.parse({
        version: 1,
        records: { education: ["old"], experience: [] },
      }).records,
    ).toEqual({ education: ["old"], experience: [], project: [] });
    const first = ProfileSchema.parse({}),
      second = ProfileSchema.parse({});
    first.records.project.push("isolated");
    expect(second.records.project).toEqual([]);
  });
  it("maps public form aliases only within their section and preserves ambiguity", () => {
    const s = testState();
    try {
      const rules = mappings(s.config, s.dir);
      const field = (section: string, label: string) =>
        ({ section, label }) as Field;
      expect(matchField(field("教育背景", "学校名称"), rules)).toBe(
        "education.$.school",
      );
      expect(matchField(field("工作经历", "职务"), rules)).toBe(
        "experience.$.title",
      );
      expect(matchField(field("项目经验", "职务"), rules)).toBe(
        "project.$.role",
      );
      expect(matchField(field("项目经验", "项目中职责"), rules)).toBe(
        "project.$.responsibilities",
      );
      expect(matchField(field("紧急联系人", "职务"), rules)).toBeUndefined();
      expect(matchField(field("教育背景", "学历"), rules)).toBe(
        "education.$.qualification",
      );
      expect(matchField(field("教育背景", "学位"), rules)).toBe(
        "education.$.degree",
      );
      expect(
        matchField(field("项目经验", "职务"), [
          ...rules,
          { section: "项目经验", aliases: ["职务"], path: "unexpected.field" },
        ]),
      ).toBeUndefined();
    } finally {
      s.dispose();
    }
  });
});
