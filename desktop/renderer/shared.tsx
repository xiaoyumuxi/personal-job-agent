import type { Command } from "../contract.js";
export const api = window.jobagent;
const words: Record<string, string> = {
  SCREENING: "简历筛选",
  INTERVIEW: "面试",
  CLOSED: "已结束",
  OFFER: "已发 Offer",
  PENDING: "进行中",
  REJECTED: "未通过",
  NEVER: "未执行",
  OK: "成功",
  VALID: "验证通过",
  AUTH_REQUIRED: "需要登录 / 授权",
  UNKNOWN: "未验证",
  NEEDS_ADAPTER: "待配置站点规则",
  PARTIAL: "仅部分结果",
  NOT_FOUND: "未找到",
  RETRY_EXHAUSTED: "重试耗尽",
  STOPPED: "已停止",
  RETRY_PENDING: "等待重试",
  NOT_CONFIGURED: "待配置",
  NOT_TESTED: "未检测",
  DRAFT: "待填写",
  FILLING: "辅助填写中",
  REVIEW: "等待本人审核",
  SUBMITTED: "已提交",
  UNKNOWN_RESULT: "提交结果未知",
  RUNNING: "正在执行",
  WAIT_LOGIN: "等待官网登录",
  WAIT_INPUT: "等待补充资料",
  WAIT_REVIEW: "等待本人确认",
  PAUSING: "正在暂停",
  PAUSED: "已暂停",
  CANCELLING: "正在停止",
  CANCELLED: "已停止",
  COMPLETED: "任务结束",
  FAILED: "执行失败",
  INTERRUPTED: "上次运行已中断",
  confirmed: "已确认",
  pending: "待确认",
  missing: "缺失",
  conflict: "有冲突",
  apply: "辅助填写",
  open: "查看官网",
  login: "官网登录",
  track: "查询进度",
  sync: "同步飞书",
  doctor: "检测连接",
  modelCheck: "模型连通性检测",
  retrySync: "重试同步",
  retryTrack: "重试查询",
  feishuAuth: "飞书授权",
  feishuComplete: "验证飞书授权",
};
export const label = (v?: string) => (v ? words[v] || v : "—");
export const date = (v?: string | null) =>
  v ? new Date(v).toLocaleString("zh-CN", { hour12: false }) : "尚无记录";
export function Badge({ value, text }: { value?: string; text?: string }) {
  return (
    <span className={`badge status-${value || "UNKNOWN"}`}>
      {text || label(value)}
    </span>
  );
}

export type Start = (
  operation: Extract<Command, { method: "start" }>["operation"],
  jobId?: string,
) => Promise<unknown>;
export type Perform = <T>(
  fn: () => Promise<T>,
  success?: string,
) => Promise<T | undefined>;
export type Send = (command: Command, success?: string) => Promise<unknown>;
