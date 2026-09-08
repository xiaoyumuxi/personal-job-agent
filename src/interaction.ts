import type { Page } from "playwright";
import { z } from "zod";
import { ValueSchema, type RecordKind } from "./types.js";
import { ask, yes } from "./prompt.js";
export const AnswerSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("confirm"), accepted: z.boolean() }).strict(),
  z.object({ action: z.literal("check") }).strict(),
  z
    .object({
      action: z.enum(["resume", "next", "submitted", "quit", "model"]),
    })
    .strict(),
  z
    .object({
      action: z.literal("answer"),
      issue: z.number().int().min(0),
      path: z.string().regex(/^[a-zA-Z][\w.-]{0,120}$/),
      value: ValueSchema,
      scope: z.enum(["general", "application"]),
    })
    .strict(),
  z
    .object({
      action: z.literal("bind"),
      issue: z.number().int().min(0),
      record: z.string().max(120),
    })
    .strict(),
  z
    .object({
      action: z.literal("map"),
      issue: z.number().int().min(0),
      path: z.string().max(120),
    })
    .strict(),
  z.object({ action: z.literal("add"), section: z.string().max(120) }).strict(),
]);
export type Answer = z.infer<typeof AnswerSchema>;
export interface Question {
  kind: "confirm" | "login" | "review";
  message: string;
  site?: string;
  step?: string;
  issues?: {
    label: string;
    section: string;
    type: string;
    required: boolean | "unknown";
    options: { value: string; label: string }[];
    path?: string;
    reason: string;
    canAnswer: boolean;
    records?: string[];
    recordKind?: RecordKind;
  }[];
  paths?: string[];
  additions?: string[];
  canNext?: boolean;
  canModel?: boolean;
}
export interface Interaction {
  request(q: Question): Promise<Answer>;
  step(name: string): void;
  checkpoint(): Promise<boolean>;
  browser(page?: Page): void;
}
export class RunStopped extends Error {
  constructor() {
    super("任务已在安全边界停止；已发出的页面操作无法撤回");
  }
}
export const terminalInteraction: Interaction = {
  step: (s) => console.log(s),
  checkpoint: async () => false,
  browser: () => {},
  async request(q) {
    console.log(q.message);
    if (q.kind === "confirm")
      return { action: "confirm", accepted: await yes("确认继续？") };
    if (q.kind === "login") {
      if ((await ask("完成登录后回车重新检查（q 停止）")) === "q")
        throw new RunStopped();
      return { action: "check" };
    }
    q.issues?.forEach((i, n) =>
      console.log(`${n + 1}. ${i.section}/${i.label}: ${i.reason}`),
    );
    const [verb, ...args] = (
      await ask(
        "answer 编号 / bind 编号 / map 编号 / add 区块 / model / next / resume / submitted / quit",
      )
    ).split(" ");
    const issue = Number(args[0]) - 1;
    if (verb === "answer") {
      const path = q.issues?.[issue]?.path || (await ask("资料路径："));
      const raw = await ask("本人确认的答案（支持 JSON 数组/布尔值）：", true);
      let value: unknown = raw;
      try {
        value = JSON.parse(raw);
      } catch {}
      return AnswerSchema.parse({
        action: verb,
        issue,
        path,
        value,
        scope:
          (await ask("general 通用 / application 此申请")) === "general"
            ? "general"
            : "application",
      });
    }
    if (verb === "bind")
      return {
        action: verb,
        issue,
        record: await ask("记录 ID：" + q.issues?.[issue]?.records?.join(", ")),
      };
    if (verb === "map")
      return {
        action: verb,
        issue,
        path: await ask("资料路径（将保存映射）："),
      };
    if (verb === "add") return { action: verb, section: args.join(" ") };
    return AnswerSchema.parse({ action: verb });
  },
};
