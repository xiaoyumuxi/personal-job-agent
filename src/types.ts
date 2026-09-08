import { z } from "zod";
export const ValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
]);
export type Value = z.infer<typeof ValueSchema>;
export const FactSchema = z.object({
  state: z
    .enum(["confirmed", "missing", "conflict", "pending"])
    .default("pending"),
  value: ValueSchema.optional(),
  candidates: z.array(ValueSchema).optional(),
  discloseTo: z.array(z.string()).default([]),
  source: z.object({ text: z.string().max(2000) }).optional(),
});
export type Fact = z.infer<typeof FactSchema>;
export const RecordKindSchema = z.enum(["education", "experience", "project"]);
export type RecordKind = z.infer<typeof RecordKindSchema>;
export const recordKinds = RecordKindSchema.options;
export function isRecordKind(value: unknown): value is RecordKind {
  return RecordKindSchema.safeParse(value).success;
}
export const ProfileSchema = z.object({
  version: z.literal(1).default(1),
  facts: z.record(z.string(), FactSchema).default({}),
  records: z
    .object({
      education: z.array(z.string()).default([]),
      experience: z.array(z.string()).default([]),
      project: z.array(z.string()).default([]),
    })
    .default(() => ({ education: [], experience: [], project: [] })),
  resume: z.string().optional(),
});
export type Profile = z.infer<typeof ProfileSchema>;
export interface Job {
  id: string;
  company: string;
  title: string;
  batch: string;
  jobCode: string;
  url: string;
  tenant: string;
  account: string;
  referral: string;
  source: string;
  applicationChannel?: string;
  note?: string;
  channel: "READY" | "NEEDS_CHANNEL";
  dedupWarning?: string;
}
export type RunStatus =
  | "NEVER"
  | "OK"
  | "AUTH_REQUIRED"
  | "UNKNOWN"
  | "NEEDS_ADAPTER"
  | "PARTIAL"
  | "NOT_FOUND"
  | "RETRY_EXHAUSTED"
  | "STOPPED"
  | "RETRY_PENDING"
  | "NOT_CONFIGURED";
export interface Application {
  profileId?: string;
  profileRevision?: number;
  profileName?: string;
  id: string;
  jobId: string;
  state: "DRAFT" | "FILLING" | "REVIEW" | "SUBMITTED" | "UNKNOWN_RESULT";
  rawStatus: string;
  stage: string;
  outcome: string;
  authStatus: "VALID" | "AUTH_REQUIRED" | "UNKNOWN";
  queryStatus: RunStatus;
  syncStatus: RunStatus;
  lastAttempt: string | null;
  lastSuccess: string | null;
  submittedAt: string | null;
  evidence: string | null;
  nextAction: string;
  queryError: string;
  syncError: string;
  queryRetries: number;
  syncRetries: number;
  priority: string;
  paused: boolean;
  note: string;
  applicationChannel?: string;
  deadline: string;
  revision: number;
}
export interface Outbox {
  appId: string;
  revision: number;
  status: string;
  failures: number;
  uncertain: boolean;
  nextAt: number;
  error: string;
}
export const MappingSchema = z.object({
  section: z.string(),
  sectionAliases: z.array(z.string()).optional(),
  aliases: z.array(z.string()),
  path: z.string(),
});
export type MappingRule = z.infer<typeof MappingSchema>;
const ActionSchema = z.object({
  selector: z.string(),
  from: z.string(),
  to: z.string(),
  safe: z.literal(true),
});
export const SiteSchema = z.object({
  id: z.string(),
  name: z.string(),
  origins: z.array(z.string().url()).min(1),
  pathPrefix: z.string().default("/"),
  tenant: z.string(),
  account: z.string().default("default"),
  capabilities: z.object({ fill: z.boolean(), track: z.boolean() }),
  login: z
    .object({
      url: z.string().url(),
      authenticated: z.string(),
      unauthenticated: z.string().optional(),
      accountSelector: z.string().optional(),
      accountText: z.string().optional(),
    })
    .optional(),
  form: z
    .object({
      stepSelector: z.string().default("[data-step]"),
      fields: z
        .array(
          z.object({
            selector: z.string(),
            path: z.string(),
            section: z.string().optional(),
            required: z.boolean().optional(),
          }),
        )
        .default([]),
      sections: z
        .array(z.object({ selector: z.string(), name: z.string() }))
        .default([]),
      repeats: z
        .array(
          z.object({
            section: z.string(),
            container: z.string(),
            records: z.string(),
            kind: RecordKindSchema,
            add: z.string().optional(),
          }),
        )
        .default([]),
      next: z.array(ActionSchema).default([]),
      receipt: z
        .object({
          selector: z.string(),
          text: z.string(),
          jobCodeSelector: z.string(),
        })
        .optional(),
    })
    .optional(),
  tracking: z
    .object({
      url: z.string().url(),
      ready: z.string(),
      rows: z.string(),
      jobCode: z.string(),
      batch: z.string().optional(),
      status: z.string(),
      next: z.string().optional(),
      nextSafe: z.boolean().default(false),
      end: z.string().optional(),
      pageMarker: z.string().optional(),
      maxPages: z.number().int().min(1).max(100).default(20),
      statusMap: z
        .record(
          z.string(),
          z.object({ stage: z.string(), outcome: z.string() }),
        )
        .default({}),
    })
    .optional(),
});
export type Site = z.infer<typeof SiteSchema>;
