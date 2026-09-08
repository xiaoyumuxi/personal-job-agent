import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import { Store, now } from "../db.js";
import {
  AnswerSchema,
  RunStopped,
  type Answer,
  type Question,
  type Interaction,
} from "../interaction.js";
export type RunState =
  | "RUNNING"
  | "WAIT_LOGIN"
  | "WAIT_INPUT"
  | "WAIT_REVIEW"
  | "PAUSING"
  | "PAUSED"
  | "CANCELLING"
  | "CANCELLED"
  | "COMPLETED"
  | "FAILED"
  | "INTERRUPTED";
export interface RunRecord {
  profile?: { id: string; name: string; revision: number };
  runId: string;
  jobId?: string;
  operation: string;
  state: RunState;
  step: string;
  at: string;
  request?: Question & { requestId: string };
  error?: string;
}
export interface TaskEvent {
  id: number;
  runId: string;
  at: string;
  kind: string;
  step: string;
}
export const liveStates: RunState[] = [
  "RUNNING",
  "WAIT_LOGIN",
  "WAIT_INPUT",
  "WAIT_REVIEW",
  "PAUSING",
  "PAUSED",
  "CANCELLING",
];
export function cleanText(s: string) {
  return s
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[邮箱]")
    .replace(/\b1[3-9]\d{9}\b/g, "[电话]")
    .replace(/https?:\/\/[^\s]+/g, "[网站]")
    .slice(0, 300);
}
export class Runtime implements Interaction {
  record: RunRecord;
  private pending?: {
    resolve: (a: Answer) => void;
    reject: (e: Error) => void;
  };
  private paused?: () => void;
  private pauseWanted = false;
  private cancelled = false;
  private page?: Page;
  constructor(
    private store: Store,
    operation: string,
    jobId: string | undefined,
    private publish: (e: TaskEvent) => void,
  ) {
    this.record = {
      runId: randomUUID(),
      operation,
      jobId,
      state: "RUNNING",
      step: "准备任务",
      at: now(),
    };
    this.emit("TASK_STARTED");
  }
  emit(kind: string) {
    this.record.at = now();
    this.store.task("desktop:run", this.record);
    this.store.event(null, kind, {
      runId: this.record.runId,
      step: cleanText(this.record.step),
    });
    const id = Number(
      this.store.db.prepare("SELECT last_insert_rowid() AS id").get()!.id,
    );
    this.publish({
      id,
      runId: this.record.runId,
      at: this.record.at,
      kind,
      step: cleanText(this.record.step),
    });
  }
  profile(value: { id: string; name: string; revision: number }) {
    this.record.profile = {
      id: value.id,
      name: value.name,
      revision: value.revision,
    };
    this.emit("PROFILE_SELECTED");
  }
  step(name: string) {
    this.record.step = cleanText(name);
    this.emit("STEP_CHANGED");
  }
  browser(page?: Page) {
    this.page = page;
  }
  async focus() {
    if (!this.page || this.page.isClosed())
      throw new Error("受控浏览器尚未打开或已关闭");
    await this.page.bringToFront();
  }
  async checkpoint() {
    if (this.cancelled) throw new RunStopped();
    if (!this.pauseWanted) return false;
    this.record.state = "PAUSED";
    this.emit("PAUSED");
    await new Promise<void>((resolve) => {
      this.paused = resolve;
    });
    this.paused = undefined;
    if (this.cancelled) throw new RunStopped();
    this.record.state = "RUNNING";
    this.emit("RESUMED");
    return true;
  }
  async request(q: Question): Promise<Answer> {
    await this.checkpoint();
    this.record.request = { ...q, requestId: randomUUID() };
    this.record.state =
      q.kind === "login"
        ? "WAIT_LOGIN"
        : q.kind === "review" && q.issues?.some((i) => i.canAnswer)
          ? "WAIT_INPUT"
          : "WAIT_REVIEW";
    this.emit(
      q.kind === "login"
        ? "WAITING_LOGIN"
        : this.record.state === "WAIT_INPUT"
          ? "WAITING_INPUT"
          : "WAITING_REVIEW",
    );
    try {
      return await new Promise<Answer>((resolve, reject) => {
        this.pending = { resolve, reject };
      });
    } finally {
      this.pending = undefined;
      delete this.record.request;
      if (!this.cancelled) this.record.state = "RUNNING";
      this.emit("REQUEST_CLOSED");
    }
  }
  answer(runId: string, requestId: string, raw: unknown) {
    if (
      runId !== this.record.runId ||
      requestId !== this.record.request?.requestId ||
      !this.pending ||
      !["WAIT_LOGIN", "WAIT_INPUT", "WAIT_REVIEW"].includes(this.record.state)
    )
      throw new Error("问题已过期、已回答或不属于当前任务，请刷新状态");
    const a = AnswerSchema.parse(raw),
      q = this.record.request;
    if (
      (q.kind === "confirm" && a.action !== "confirm") ||
      (q.kind === "login" && a.action !== "check") ||
      (q.kind === "review" && ["confirm", "check"].includes(a.action))
    )
      throw new Error("当前步骤不允许此操作");
    if ("issue" in a && !q.issues?.[a.issue]) throw new Error("问题不存在");
    if (a.action === "answer" && !q.issues?.[a.issue]?.canAnswer)
      throw new Error("此字段必须在官网人工处理");
    if (a.action === "answer") {
      const f = q.issues![a.issue]!;
      if (JSON.stringify(a.value).length > 20000)
        throw new Error("答案过长，请精简");
      if (
        f.required === true &&
        (a.value === "" || (Array.isArray(a.value) && !a.value.length))
      )
        throw new Error("此字段为必填");
      if (
        f.type === "number" &&
        (typeof a.value !== "number" || !Number.isFinite(a.value))
      )
        throw new Error("此字段需要数字");
      if (
        f.type === "checkbox" &&
        typeof a.value !== "boolean" &&
        !Array.isArray(a.value)
      )
        throw new Error("此字段需要布尔值或选项数组");
      if (f.type === "select-multiple" && !Array.isArray(a.value))
        throw new Error("此字段需要多选数组");
      if (f.options.length && f.type !== "checkbox") {
        const values = Array.isArray(a.value) ? a.value : [String(a.value)];
        if (
          values.some(
            (v) => !f.options.some((o) => o.value === v || o.label === v),
          )
        )
          throw new Error("答案不在当前候选项中");
      }
      if (a.path.includes("__proto__") || a.path.includes("constructor"))
        throw new Error("资料字段路径不合法");
    }
    if (a.action === "next" && !q.canNext) throw new Error("未配置安全下一步");
    if (a.action === "model" && !q.canModel) throw new Error("模型待配置");
    const pending = this.pending;
    this.pending = undefined;
    delete this.record.request;
    this.record.state = "RUNNING";
    this.emit("INPUT_ACCEPTED");
    pending.resolve(a);
  }
  control(action: "pause" | "resume" | "cancel") {
    if (action === "pause") {
      if (this.pauseWanted || this.cancelled) throw new Error("当前不能暂停");
      this.pauseWanted = true;
      this.record.state = this.pending ? "PAUSED" : "PAUSING";
      this.emit(this.pending ? "PAUSED" : "PAUSE_REQUESTED");
    } else if (action === "resume") {
      if (this.record.state !== "PAUSED") throw new Error("后端尚未确认暂停");
      this.pauseWanted = false;
      if (this.pending && this.record.request) {
        this.record.request.requestId = randomUUID();
        const q = this.record.request;
        this.record.state =
          q.kind === "login"
            ? "WAIT_LOGIN"
            : q.kind === "review" && q.issues?.some((i) => i.canAnswer)
              ? "WAIT_INPUT"
              : "WAIT_REVIEW";
        this.emit("RESUMED");
      } else this.paused?.();
    } else {
      if (this.cancelled) return;
      this.cancelled = true;
      this.record.state = "CANCELLING";
      this.emit("CANCEL_REQUESTED");
      this.pending?.reject(new RunStopped());
      this.paused?.();
    }
  }
  finish(error?: unknown) {
    delete this.record.request;
    this.record.state =
      error instanceof RunStopped || this.cancelled
        ? "CANCELLED"
        : error
          ? "FAILED"
          : "COMPLETED";
    if (error) {
      const message = error instanceof Error ? error.message : "";
      this.record.error =
        error instanceof RunStopped
          ? error.message
          : /[\u4e00-\u9fff]/.test(message) && !message.includes("Call log:")
            ? cleanText(message)
            : (
                {
                  KEYCHAIN_UNAVAILABLE:
                    "Keychain 不可访问，请检查本机钥匙串权限",
                  KEYCHAIN_HELPER_BUILD_FAILED: "Keychain 辅助程序不可用",
                  NEEDS_ADAPTER: "该站点的查询规则待配置",
                  SYNC_INCOMPLETE:
                    "飞书未全部同步成功，请查看本地同步错误；远端可能尚未更新",
                } as Record<string, string>
              )[message] ||
              "执行未完成，请检查 Chrome、文件权限或站点规则；详情以申请中的查询和同步错误为准";
    }
    this.emit(error ? "TASK_FAILED" : "TASK_ENDED");
  }
}
