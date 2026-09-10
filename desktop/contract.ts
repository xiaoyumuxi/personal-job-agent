import {
  ProfileIdSchema,
  type ProfileVersion,
} from "../src/profile-library.js";
import { z } from "zod";
import { PreferencesSchema } from "../src/discovery/types.js";
import { AnswerSchema } from "../src/interaction.js";
import { ValueSchema } from "../src/types.js";
import { ConfigSchema } from "../src/config.js";
import {
  RecordKindSchema,
  type Job,
  type Application,
  type Profile,
} from "../src/types.js";
import type { RunRecord, TaskEvent } from "../src/application/runtime.js";
import type {
  doctor,
  FeishuCLICheck,
  FeishuAuthCheck,
} from "../src/application/services.js";
import type { ProfileImportInfo } from "../src/profile.js";
export const CommandSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("discoveryView") }).strict(),
  z
    .object({
      method: z.literal("discoveryOpen"),
      batchId: z.string().uuid(),
      id: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      method: z.literal("discoveryPreview"),
      profileId: ProfileIdSchema,
      preferences: PreferencesSchema,
    })
    .strict(),
  z
    .object({
      method: z.literal("discoveryDecision"),
      batchId: z.string().uuid(),
      id: z.string().uuid(),
      decision: z.enum(["keep", "skip"]),
    })
    .strict(),
  z
    .object({
      method: z.literal("channel"),
      jobId: z.string().uuid(),
      url: z.string().url().max(10000),
    })
    .strict(),
  z.object({ method: z.literal("snapshot") }).strict(),
  z
    .object({
      method: z.literal("profile"),
      profileId: ProfileIdSchema.optional(),
    })
    .strict(),
  z.object({ method: z.literal("profileVersions") }).strict(),
  z
    .object({ method: z.literal("switchProfile"), profileId: ProfileIdSchema })
    .strict(),
  z
    .object({
      method: z.literal("renameProfile"),
      profileId: ProfileIdSchema,
      name: z.string().trim().min(1).max(120),
    })
    .strict(),
  z.object({ method: z.literal("settings") }).strict(),
  z
    .object({
      method: z.literal("checkFeishuAuth"),
      refresh: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("discoverFeishuCLI"),
      refresh: z.boolean().optional(),
    })
    .strict(),
  z.object({ method: z.literal("history"), jobId: z.string().uuid() }).strict(),
  z
    .object({
      method: z.literal("start"),
      operation: z.enum([
        "discover",
        "apply",
        "login",
        "open",
        "track",
        "sync",
        "doctor",
        "modelCheck",
        "feishuAuth",
        "feishuComplete",
        "feishuViews",
        "retrySync",
        "retryTrack",
      ]),
      jobId: z.string().uuid().optional(),
      profileId: ProfileIdSchema.optional(),
      previewId: z.string().uuid().optional(),
      cloudConsent: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("answer"),
      runId: z.string().uuid(),
      requestId: z.string().uuid(),
      answer: AnswerSchema,
    })
    .strict(),
  z
    .object({
      method: z.literal("control"),
      runId: z.string().uuid(),
      action: z.enum(["pause", "resume", "cancel", "focus"]),
    })
    .strict(),
  z
    .object({
      method: z.literal("application"),
      jobId: z.string().uuid(),
      action: z.enum([
        "pauseTracking",
        "resumeTracking",
        "submitted",
        "notSubmitted",
      ]),
      confirmed: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("saveFact"),
      profileId: ProfileIdSchema.optional(),
      path: z.string().regex(/^[a-zA-Z][\w.-]{0,120}$/),
      value: ValueSchema,
    })
    .strict(),
  z
    .object({
      method: z.literal("record"),
      profileId: ProfileIdSchema.optional(),
      kind: RecordKindSchema,
      id: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),
    })
    .strict(),
  z
    .object({
      method: z.literal("saveSettings"),
      feishu: ConfigSchema.shape.feishu,
      model: ConfigSchema.shape.model,
      schedule: ConfigSchema.shape.schedule,
      key: z.string().max(4096).optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("schedule"),
      action: z.enum(["plan", "install", "uninstall"]),
      confirmed: z.boolean().optional(),
    })
    .strict(),
  z.object({ method: z.literal("unlock") }).strict(),
]);
export type Command = z.infer<typeof CommandSchema>;
export const FileKindSchema = z.enum([
  "jobs",
  "profile",
  "site",
  "feishuCLI",
  "chrome",
]);
export type FileKind = z.infer<typeof FileKindSchema>;
export interface Row {
  job: Job;
  application?: Application;
  attention: "NORMAL" | "AUTH_REQUIRED" | "RETRY_EXHAUSTED";
  permissions: {
    apply: boolean;
    track: boolean;
    login: boolean;
    open: boolean;
  };
}
export interface Snapshot {
  rows: Row[];
  run?: RunRecord;
  busy: boolean;
  lock: boolean;
  events: TaskEvent[];
  dataDir: string;
}
export interface ProfileView {
  selected: ProfileVersion;
  versions: ProfileVersion[];
  activeId: string;
  profile: Profile;
  fields: { path: string; label: string; section: string }[];
  version?: {
    at: string;
    revision: number;
    file: string;
    extraction?: ProfileImportInfo;
  };
}
export interface SettingsView {
  home: string;
  chromeProfile: string;
  sites: {
    id: string;
    name: string;
    fill: boolean;
    login: boolean;
    track: boolean;
  }[];
  modelConnection: { status: string; at?: string };
  config: z.infer<typeof ConfigSchema>;
  doctor?: Awaited<ReturnType<typeof doctor>>;
  feishuExecutable?: FeishuCLICheck;
  feishuAuth?: FeishuAuthCheck;
  schedule: { installed: boolean; plistExists: boolean; path: string };
  timezone: string;
  daily: unknown;
  authPending: boolean;
  feishuTemplate: { columns: string[]; views: string[]; verifiedAt?: string };
}
export interface DesktopAPI {
  invoke(command: Command): Promise<unknown>;
  chooseFile(kind: FileKind): Promise<unknown>;
  exportDiagnostics(): Promise<string | null>;
  chooseDataDirectory(): Promise<boolean>;
  openFeishuAuth(): Promise<void>;
  subscribe(listener: () => void): () => void;
}
declare global {
  interface Window {
    jobagent: DesktopAPI;
  }
}
