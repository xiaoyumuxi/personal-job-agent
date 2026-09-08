import type { Application, Job } from "../types.js";
import { attention } from "../db.js";
export type TemplateVersion = 1 | 2;
export interface FieldDefinition {
  name: string;
  type: string;
  multiple?: boolean;
  options?: { name: string; hue: string; lightness: string }[];
  style?: { type?: string; format?: string };
}
const autoText = [
  "本地申请 ID",
  "公司",
  "岗位",
  "招聘批次",
  "官网链接",
  "投递时间",
  "官网原始状态",
  "标准化阶段",
  "招聘结果",
  "授权状态",
  "查询状态",
  "同步状态",
  "最近查询尝试时间",
  "最近成功查询时间",
  "下一项待办",
  "错误摘要",
];
export const legacyManualFields = [
  "截止时间",
  "优先级",
  "暂停跟踪",
  "人工备注",
] as const;
export const legacyTableFields: FieldDefinition[] = [
  ...autoText.map((name) => ({ name, type: "text" })),
  {
    name: "attention_status",
    type: "select",
    multiple: false,
    options: [
      { name: "NORMAL", hue: "Gray", lightness: "Lighter" },
      { name: "AUTH_REQUIRED", hue: "Yellow", lightness: "Lighter" },
      { name: "RETRY_EXHAUSTED", hue: "Red", lightness: "Lighter" },
    ],
  },
  { name: "重试次数", type: "number" },
  { name: "截止时间", type: "text" },
  { name: "优先级", type: "text" },
  { name: "暂停跟踪", type: "checkbox" },
  { name: "人工备注", type: "text" },
];
const choices = (items: [string, string][]) =>
  items.map(([name, hue]) => ({ name, hue, lightness: "Lighter" }));
export const applicationStatuses = choices([
  ["待投递", "Gray"],
  ["填写中", "Blue"],
  ["待官网审核", "Orange"],
  ["提交待核实", "Yellow"],
  ["已投递（人工确认）", "Purple"],
  ["官网已投递", "Purple"],
  ["简历筛选", "Blue"],
  ["待测评", "Orange"],
  ["测评中", "Wathet"],
  ["测评完成", "Green"],
  ["笔试中", "Wathet"],
  ["笔试完成", "Green"],
  ["面试中", "Blue"],
  ["面试完成", "Green"],
  ["已发 Offer", "Green"],
  ["已录用", "Green"],
  ["未通过", "Red"],
  ["已撤回", "Gray"],
  ["已结束", "Gray"],
  ["待核对阶段", "Gray"],
]);
export const applicationChannels = choices([
  ["官方网站", "Blue"],
  ["内推", "Purple"],
  ["招聘平台", "Wathet"],
  ["邮件", "Orange"],
  ["微信公众号", "Green"],
  ["校园宣讲会", "Turquoise"],
  ["其他", "Gray"],
]);
export const mainColumns = [
  "公司",
  "投递岗位",
  "投递渠道",
  "投递日期",
  "投递状态",
  "岗位链接",
  "备注",
];
export const manualFields = [
  "截止时间",
  "优先级",
  "暂停跟踪",
  "备注",
  "投递渠道",
] as const;
export function manualFieldNames(version: TemplateVersion) {
  return version === 1 ? legacyManualFields : manualFields;
}
export const tableFields: FieldDefinition[] = [
  { name: "公司", type: "text" },
  { name: "投递岗位", type: "text" },
  {
    name: "投递渠道",
    type: "select",
    multiple: false,
    options: applicationChannels,
  },
  { name: "投递日期", type: "datetime", style: { format: "yyyy-MM-dd" } },
  {
    name: "投递状态",
    type: "select",
    multiple: false,
    options: applicationStatuses,
  },
  { name: "岗位链接", type: "text", style: { type: "url" } },
  { name: "备注", type: "text" },
  ...legacyTableFields.filter(
    (f) => !["公司", "岗位", "官网链接", "人工备注"].includes(f.name),
  ),
  { name: "执行状态", type: "text" },
  { name: "提交证据", type: "text" },
];
export const templateViews = [
  {
    name: "Grid",
    type: "grid",
    visible_fields: tableFields.map((f) => f.name),
  },
  {
    name: "投递状态看板",
    type: "kanban",
    visible_fields: [...mainColumns, "下一项待办"],
    group_config: [{ field: "投递状态", desc: false }],
  },
  {
    name: "投递清单",
    type: "grid",
    visible_fields: [
      ...mainColumns,
      "下一项待办",
      "最近成功查询时间",
      "授权状态",
      "查询状态",
      "同步状态",
      "attention_status",
    ],
    sort_config: [{ field: "投递日期", desc: true }],
  },
];

const stages: Record<string, string> = {
  SCREENING: "简历筛选",
  ASSESSMENT_PENDING: "待测评",
  ASSESSMENT: "测评中",
  ASSESSMENT_COMPLETED: "测评完成",
  TEST: "笔试中",
  WRITTEN_TEST: "笔试中",
  TEST_COMPLETED: "笔试完成",
  WRITTEN_TEST_COMPLETED: "笔试完成",
  INTERVIEW: "面试中",
  INTERVIEW_COMPLETED: "面试完成",
  OFFER: "已发 Offer",
  HIRED: "已录用",
  CLOSED: "已结束",
};
const rawStages: Record<string, string> = {
  简历筛选: "简历筛选",
  简历筛选中: "简历筛选",
  待测评: "待测评",
  测评中: "测评中",
  测评完成: "测评完成",
  测评已完成: "测评完成",
  笔试中: "笔试中",
  笔试完成: "笔试完成",
  面试中: "面试中",
  面试完成: "面试完成",
};
export function applicationStatus(a: Application) {
  if (a.state === "UNKNOWN_RESULT") return "提交待核实";
  const outcomes: Record<string, string> = {
    REJECTED: "未通过",
    WITHDRAWN: "已撤回",
    HIRED: "已录用",
    ACCEPTED: "已录用",
    OFFER: "已发 Offer",
  };
  if (outcomes[a.outcome]) return outcomes[a.outcome]!;
  if (rawStages[a.rawStatus.trim()]) return rawStages[a.rawStatus.trim()]!;
  if (stages[a.stage]) return stages[a.stage]!;
  if (a.state === "DRAFT") return "待投递";
  if (a.state === "FILLING") return "填写中";
  if (a.state === "REVIEW") return "待官网审核";
  if (a.rawStatus && a.stage === "UNKNOWN") return "待核对阶段";
  if (a.evidence === "manual-confirmation") return "已投递（人工确认）";
  return a.evidence?.includes(":receipt:") ? "官网已投递" : "提交待核实";
}
export function submissionDate(
  at: string | null,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
) {
  if (
    !at ||
    !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(at) ||
    Number.isNaN(Date.parse(at))
  )
    return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(at));
  const value = (part: string) => parts.find((p) => p.type === part)!.value;
  return `${value("year")}-${value("month")}-${value("day")} 00:00:00`;
}
export function autoFields(
  a: Application,
  j: Job,
  version: TemplateVersion = 2,
): Record<string, unknown> {
  const fields = legacyAutoFields(a, j);
  if (version === 1) return fields;
  delete fields.岗位;
  delete fields.官网链接;
  return {
    ...fields,
    投递岗位: j.title,
    岗位链接: j.url || null,
    投递日期: submissionDate(a.submittedAt),
    投递状态: applicationStatus(a),
    执行状态: a.state,
    提交证据: a.evidence ?? "",
  };
}
// Seed human-owned values only when creating a record. Never overwrite remote edits.
export function initialManualFields(
  a: Application,
  j: Job,
  version: TemplateVersion = 2,
): Record<string, unknown> {
  const note = a.note;
  if (version === 1) return note ? { 人工备注: note } : {};
  const channel = a.applicationChannel ?? j.applicationChannel;
  return {
    ...(note ? { 备注: note } : {}),
    ...(channel ? { 投递渠道: channel } : {}),
  };
}
function legacyAutoFields(a: Application, j: Job): Record<string, unknown> {
  return {
    "本地申请 ID": a.id,
    公司: j.company,
    岗位: j.title,
    招聘批次: j.batch,
    官网链接: j.url,
    投递时间: a.submittedAt ?? "",
    官网原始状态: a.rawStatus,
    标准化阶段: a.stage,
    招聘结果: a.outcome,
    授权状态: a.authStatus,
    查询状态: a.queryStatus,
    同步状态: "OK",
    attention_status: attention({ ...a, syncStatus: "OK" }),
    最近查询尝试时间: a.lastAttempt ?? "",
    最近成功查询时间: a.lastSuccess ?? "",
    下一项待办: a.nextAction,
    重试次数: Math.max(a.queryRetries, 0),
    错误摘要: a.queryError,
  };
}
export function readControls(a: Application, fields: Record<string, unknown>) {
  if (typeof fields["暂停跟踪"] === "boolean") a.paused = fields["暂停跟踪"];
  if (typeof fields["优先级"] === "string")
    a.priority = fields["优先级"].slice(0, 100);
  if (typeof fields["截止时间"] === "string")
    a.deadline = fields["截止时间"].slice(0, 100);
  if (typeof fields["人工备注"] === "string")
    a.note = fields["人工备注"].slice(0, 2000);
  if (typeof fields["备注"] === "string" || fields["备注"] === null)
    a.note = String(fields["备注"] ?? "").slice(0, 2000);
  if (typeof fields["投递渠道"] === "string" || fields["投递渠道"] === null)
    a.applicationChannel = String(fields["投递渠道"] ?? "").slice(0, 100);
}
