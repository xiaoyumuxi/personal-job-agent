import type { Application, Job } from "../types.js";
import { attention } from "../db.js";
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
export const manualFields = [
  "截止时间",
  "优先级",
  "暂停跟踪",
  "人工备注",
] as const;
export const tableFields = [
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
export function autoFields(a: Application, j: Job): Record<string, unknown> {
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
}
