import { randomUUID } from "node:crypto";
import type { Store } from "../db.js";
import type { Vault } from "../vault.js";
import { readConfig } from "../config.js";
import { profileSelection } from "../profile-library.js";
import type { Runtime } from "../application/runtime.js";
import { RunStopped } from "../interaction.js";
import {
  assess,
  candidateFacts,
  fingerprint,
  hardRules,
  validateAssessment,
  type Assess,
} from "./match.js";
import { crawl, officialJobUrl, type Crawl } from "./sources.js";
import {
  sources,
  type DiscoveryBatch,
  type DiscoveryPreview,
  type Preferences,
  type Recommendation,
} from "./types.js";
type Header = Omit<DiscoveryBatch, "results" | "stale"> & {
  ids: string[];
  signature: string;
};
export interface DiscoveryDependencies {
  crawl?: Crawl;
  assess?: Assess;
}
export class DiscoveryService {
  private previewValue?: DiscoveryPreview & { signature: string };
  constructor(
    private store: Store,
    private vault: Vault,
    private dir: string,
    private deps: DiscoveryDependencies = {},
  ) {}
  private async signature(profileId: string, p: Preferences) {
    const selection = await profileSelection(this.vault, this.store, profileId);
    const config = readConfig(this.dir);
    return fingerprint({
      profile: selection.profile,
      selected: selection.selected,
      preferences: p,
      model: p.mode === "ai" ? config.model : null,
      key: p.mode === "ai" ? await this.vault.get("model-key") : null,
      schemaVersion: 1,
    });
  }
  async preview(
    profileId: string,
    preferences: Preferences,
  ): Promise<DiscoveryPreview> {
    const { selected, profile } = await profileSelection(
      this.vault,
      this.store,
      profileId,
    );
    const config = readConfig(this.dir);
    const model =
      preferences.mode === "ai"
        ? { endpoint: config.model.endpoint, name: config.model.name }
        : undefined;
    if (model) {
      const u = new URL(model.endpoint);
      if (!model.name || !(await this.vault.get("model-key")))
        throw new Error("先在设置中保存模型名称与 API Key，或选择本地筛选");
      if (u.protocol !== "https:" || u.username || u.password)
        throw new Error("模型地址必须为无内嵌凭证的 HTTPS 地址");
    }
    const card = candidateFacts(profile);
    if (model && !card.facts.length)
      throw new Error("这个版本还没有可用于匹配的已确认教育、技能或经历资料");
    const result: DiscoveryPreview = {
      id: randomUUID(),
      expiresAt: Date.now() + 10 * 60_000,
      profile: selected,
      preferences,
      ...card,
      model,
    };
    this.previewValue = {
      ...result,
      signature: await this.signature(profileId, preferences),
    };
    return result;
  }
  async view(): Promise<DiscoveryBatch | null> {
    const raw = await this.vault.get("discovery:latest");
    if (!raw) return null;
    const header = JSON.parse(raw) as Header;
    const results: Recommendation[] = [];
    for (const id of header.ids) {
      const item = await this.vault.get(`discovery:result:${id}`);
      if (item) results.push(JSON.parse(item));
    }
    let stale = true;
    try {
      stale =
        header.signature !==
        (await this.signature(header.profile.id, header.preferences));
    } catch {
      /* removed profile */
    }
    const run = this.store.task<{ runId: string; state: string }>(
      "desktop:run",
    );
    const { ids: _ids, signature: _signature, ...visible } = header;
    if (
      visible.status === "running" &&
      (run?.runId !== header.id ||
        ["INTERRUPTED", "FAILED", "CANCELLED"].includes(run.state))
    )
      visible.status = "interrupted";
    return { ...visible, results, stale };
  }
  async run(previewId: string, cloudConsent: boolean, r: Runtime) {
    const p = this.previewValue;
    this.previewValue = undefined;
    if (!p || p.id !== previewId || p.expiresAt < Date.now())
      throw new Error("启动预览已过期，请重新预览");
    if (p.model && !cloudConsent)
      throw new Error("需要明确确认本次资料披露后才能调用模型");
    if (p.signature !== (await this.signature(p.profile.id, p.preferences)))
      throw new Error("资料或模型设置已变化，请重新预览后启动");
    const config = readConfig(this.dir),
      key = p.model ? (await this.vault.get("model-key"))! : "";
    const previous = await this.vault.get("discovery:latest");
    const header: Header = {
      id: r.record.runId,
      at: new Date().toISOString(),
      profile: p.profile,
      preferences: p.preferences,
      facts: p.facts,
      model: p.model,
      status: "running",
      issues: [],
      ids: [],
      signature: p.signature,
    };
    const save = () =>
      this.vault.set("discovery:latest", JSON.stringify(header));
    await save();
    if (previous)
      for (const id of (JSON.parse(previous) as Header).ids)
        await this.vault.delete?.(`discovery:result:${id}`).catch(() => {});
    r.profile(p.profile);
    const signal = AbortSignal.any([
      r.signal,
      AbortSignal.timeout(12 * 60_000),
    ]);
    const seen = new Set<string>();
    try {
      await (this.deps.crawl || crawl)({
        preferences: p.preferences,
        executablePath: config.browser.executablePath,
        signal,
        checkpoint: () => r.checkpoint(),
        step: (s) => r.step(s),
        onIssue: (issue) => {
          if (header.issues.length < 30) header.issues.push(issue);
        },
        onJob: async (job) => {
          await r.checkpoint();
          signal.throwIfAborted();
          officialJobUrl(job.source, job.url);
          const identity = `${job.source}:${job.externalId}`;
          if (seen.has(identity)) return;
          seen.add(identity);
          if (seen.size > p.preferences.maxJobs * p.preferences.sources.length)
            throw new Error("已达到本次岗位上限");
          const rules = hardRules(job, p.preferences);
          const item: Recommendation = {
            id: randomUUID(),
            job,
            rules,
            analysis: "local",
            grade: rules.some((v) => v.status === "fail")
              ? "unsuitable"
              : "insufficient",
          };
          if (p.model && item.grade !== "unsuitable") {
            r.step("对照已确认资料与 JD，生成带原文依据的建议");
            try {
              item.assessment = validateAssessment(
                await (this.deps.assess || assess)(
                  job,
                  p.facts,
                  p.preferences,
                  p.model,
                  key,
                  signal,
                ),
                job,
                p.facts,
              );
              item.grade =
                rules.some((v) => v.status === "unknown") &&
                item.assessment.grade === "recommended"
                  ? "consider"
                  : item.assessment.grade;
              item.analysis = "ai";
            } catch {
              signal.throwIfAborted();
              item.analysis = "failed";
              item.issue =
                "AI 分析未通过：请求失败或引用无法核实。保留 JD，需重试或人工判断。";
              header.issues.push(
                "部分岗位 AI 分析未完成，已保留完整 JD 和本地筛选结果。",
              );
            }
          }
          await r.checkpoint();
          signal.throwIfAborted();
          await this.vault.set(
            `discovery:result:${item.id}`,
            JSON.stringify(item),
          );
          header.ids.push(item.id);
          await save();
          r.step(`已保存 ${header.ids.length} 个岗位及其判断依据`);
        },
      });
      header.status = header.issues.length ? "partial" : "completed";
    } catch (e) {
      header.status = r.signal.aborted ? "cancelled" : "failed";
      if (!r.signal.aborted)
        header.issues.push(
          "采集未完成，请检查 Chrome 或网络后重试；已读取的岗位仍保留。",
        );
      if (r.signal.aborted) throw new RunStopped();
      throw new Error("岗位发现未完成，已保留可用结果；请检查 Chrome 与网络");
    } finally {
      await save();
    }
  }
  async decide(batchId: string, id: string, decision: "keep" | "skip") {
    const raw = await this.vault.get("discovery:latest");
    if (!raw) throw new Error("没有可操作的推荐结果");
    const header = JSON.parse(raw) as Header;
    if (header.id !== batchId || !header.ids.includes(id))
      throw new Error("推荐批次已变化，请刷新");
    const content = await this.vault.get(`discovery:result:${id}`);
    if (!content) throw new Error("该岗位结果不可读取");
    const item = JSON.parse(content) as Recommendation;
    if (item.jobId) return item; // Repeated clicks cannot remove an already imported job.
    if (decision === "keep") {
      const { job } = item;
      const official = officialJobUrl(job.source, job.url);
      const existing = this.store.jobs().find((j) => {
        try {
          return officialJobUrl(job.source, j.url).url === official.url;
        } catch {
          return false;
        }
      });
      item.jobId =
        existing?.id ||
        this.store.addJob({
          company: sources[job.source].company,
          title: job.title,
          jobCode: official.externalId,
          batch: job.source === "tencent" ? "官网社招" : "官网校招与实习",
          url: official.url,
          tenant: sources[job.source].origin,
          account: "default",
          referral: "",
          source: `${sources[job.source].name} · ${job.fetchedAt}`,
          channel: "READY",
        }).id;
      // No ensureApplication, outbox, tracking, filling or submission here.
    }
    item.decision = decision;
    await this.vault.set(`discovery:result:${id}`, JSON.stringify(item));
    return item;
  }
  async sourceUrl(batchId: string, id: string) {
    const raw = await this.vault.get("discovery:latest");
    const header = raw ? (JSON.parse(raw) as Header) : undefined;
    if (header?.id !== batchId || !header.ids.includes(id))
      throw new Error("推荐结果已变化，请刷新");
    const content = await this.vault.get(`discovery:result:${id}`);
    if (!content) throw new Error("该岗位结果不可读取");
    const { job } = JSON.parse(content) as Recommendation;
    return officialJobUrl(job.source, job.url).url;
  }
}
