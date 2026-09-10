import { z } from "zod";
import type { ProfileVersion } from "../profile-library.js";

export const sources = {
  tencent: {
    name: "腾讯社会招聘",
    company: "腾讯",
    origin: "https://careers.tencent.com",
  },
  bytedance: {
    name: "字节校园招聘 / 实习",
    company: "字节跳动",
    origin: "https://jobs.bytedance.com",
  },
} as const;
export const PreferencesSchema = z
  .object({
    sources: z
      .array(z.enum(["tencent", "bytedance"]))
      .min(1)
      .max(2)
      .refine((v) => new Set(v).size === v.length),
    keyword: z.string().trim().min(1).max(60),
    cities: z.array(z.string().trim().min(1).max(30)).max(10),
    kind: z.enum(["any", "campus", "intern", "experienced"]),
    graduationYear: z.number().int().min(2000).max(2100).optional(),
    experienceYears: z.number().min(0).max(60).optional(),
    maxJobs: z.number().int().min(1).max(10),
    mode: z.enum(["local", "ai"]),
  })
  .strict();
export type Preferences = z.infer<typeof PreferencesSchema>;
export type SourceId = keyof typeof sources;
export interface CandidateFact {
  id: string;
  label: string;
  value: string;
}
export interface PublicJob {
  source: SourceId;
  externalId: string;
  url: string;
  title: string;
  location: string;
  metadata: string;
  kind: "campus" | "intern" | "experienced";
  description: string;
  requirements: string;
  bonus: string;
  fetchedAt: string;
}
export interface Rule {
  name: string;
  status: "pass" | "fail" | "unknown";
  reason: string;
  quote: string;
}
export const AssessmentSchema = z
  .object({
    grade: z.enum(["recommended", "consider", "insufficient", "unsuitable"]),
    summary: z.string().min(1).max(600),
    evidence: z
      .array(
        z
          .object({
            kind: z.enum(["match", "gap", "question"]),
            reason: z.string().min(1).max(400),
            jdQuote: z.string().min(2).max(500),
            factId: z.string().nullable(),
            factQuote: z.string().max(500).nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict();
export type Assessment = z.infer<typeof AssessmentSchema>;
export interface DiscoveryPreview {
  id: string;
  expiresAt: number;
  profile: ProfileVersion;
  preferences: Preferences;
  facts: CandidateFact[];
  omitted: number;
  model?: { endpoint: string; name: string };
}
export interface Recommendation {
  id: string;
  job: PublicJob;
  rules: Rule[];
  assessment?: Assessment;
  grade: Assessment["grade"];
  analysis: "local" | "ai" | "failed";
  issue?: string;
  decision?: "keep" | "skip";
  jobId?: string;
}
export interface DiscoveryBatch {
  id: string;
  at: string;
  profile: ProfileVersion;
  preferences: Preferences;
  model?: DiscoveryPreview["model"];
  facts: CandidateFact[];
  status:
    | "running"
    | "completed"
    | "partial"
    | "cancelled"
    | "failed"
    | "interrupted";
  issues: string[];
  results: Recommendation[];
  stale: boolean;
}
export const gradeLabels: Record<Assessment["grade"], string> = {
  recommended: "优先查看",
  consider: "可以考虑",
  insufficient: "信息待补充",
  unsuitable: "暂不匹配",
};
