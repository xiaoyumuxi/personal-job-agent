import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopService } from "../desktop/service.js";
import { CommandSchema } from "../desktop/contract.js";
import { MemoryVault } from "../src/vault.js";
import { readConfig, saveConfig } from "../src/config.js";
import { ProfileSchema } from "../src/types.js";
import {
  candidateFacts,
  hardRules,
  validateAssessment,
  assess,
} from "../src/discovery/match.js";
import { officialJobUrl } from "../src/discovery/sources.js";
import type { DiscoveryDependencies } from "../src/discovery/service.js";
import {
  PreferencesSchema,
  type DiscoveryPreview,
  type DiscoveryBatch,
  type PublicJob,
  type Assessment,
} from "../src/discovery/types.js";

const preferences = PreferencesSchema.parse({
  sources: ["bytedance"],
  keyword: "后端",
  cities: ["深圳"],
  kind: "campus",
  maxJobs: 3,
  mode: "ai",
});
const job: PublicJob = {
  source: "bytedance",
  externalId: "7682636037198694709",
  url: "https://jobs.bytedance.com/campus/position/7682636037198694709/detail",
  title: "后端工程师",
  location: "深圳、上海",
  metadata: "正式 2027届校园招聘",
  kind: "campus",
  description: "开发 Python 后端服务",
  requirements: "2027届本科及以上学历；熟悉 Python",
  bonus: "有 Go 项目经验优先",
  fetchedAt: "2026-09-10T00:00:00.000Z",
};
const assessment: Assessment = {
  grade: "recommended",
  summary: "Python 项目经验相关，仍需核对教育要求",
  evidence: [
    {
      kind: "match",
      reason: "项目使用 Python",
      jdQuote: "熟悉 Python",
      factId: "F1",
      factQuote: "Python",
    },
  ],
};
const profile = ProfileSchema.parse({
  facts: {
    "skills.description": { state: "confirmed", value: "Python 项目经验" },
    "basic.name": { state: "confirmed", value: "私人姓名" },
    "basic.email": { state: "confirmed", value: "private@example.invalid" },
    "basic.phone": { state: "confirmed", value: "13800000000" },
    "skills.unconfirmed": { state: "pending", value: "不应发送" },
  },
});
async function harness(deps: DiscoveryDependencies = {}) {
  const dir = mkdtempSync(join(tmpdir(), "discovery-test-"));
  const vault = new MemoryVault();
  await vault.set("profile", JSON.stringify(profile));
  await vault.set("model-key", "test-key");
  const service = new DesktopService(() => {}, dir, vault, process.execPath, {
    crawl: async (o) => {
      await o.onJob(job);
    },
    assess: async () => assessment,
    ...deps,
  });
  const config = readConfig(dir);
  config.model.name = "test-model";
  saveConfig(dir, config);
  return {
    service,
    vault,
    dir,
    async close() {
      await service.stop();
      service.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
async function preview(s: DesktopService, p = preferences) {
  return (await s.handle({
    method: "discoveryPreview",
    profileId: "legacy",
    preferences: p,
  })) as DiscoveryPreview;
}
async function wait(s: DesktopService) {
  await vi.waitFor(() => expect(s.runtime).toBeUndefined());
}
async function start(
  s: DesktopService,
  p: DiscoveryPreview,
  cloudConsent = true,
) {
  await s.handle({
    method: "start",
    operation: "discover",
    previewId: p.id,
    cloudConsent,
  });
  await wait(s);
  return (await s.handle({ method: "discoveryView" })) as DiscoveryBatch | null;
}
afterEach(() => vi.unstubAllGlobals());
describe("official job discovery contracts and evidence", () => {
  it("restricts sources, budgets, URLs and unsupported commands", () => {
    expect(
      CommandSchema.safeParse({
        method: "discoveryPreview",
        profileId: "legacy",
        preferences: {
          ...preferences,
          sources: ["custom"],
          url: "http://localhost",
        },
      }).success,
    ).toBe(false);
    expect(
      PreferencesSchema.safeParse({ ...preferences, maxJobs: 200 }).success,
    ).toBe(false);
    expect(() =>
      officialJobUrl(
        "bytedance",
        "https://evil.invalid/campus/position/7682636037198694709/detail",
      ),
    ).toThrow();
    expect(() =>
      officialJobUrl("tencent", "https://careers.tencent.com/login"),
    ).toThrow();
    expect(
      officialJobUrl(
        "tencent",
        "https://careers.tencent.com/jobdesc.html?postId=2078028283043299328&ref=x",
      ).url,
    ).not.toContain("ref=");
  });
  it("only discloses confirmed allowed facts, with bounds and contact redaction", () => {
    const p = structuredClone(profile);
    p.facts["portfolio.description"] = {
      state: "confirmed",
      value:
        "contact private@example.invalid 13800000000 https://secret.invalid",
      discloseTo: [],
    };
    p.facts["project.deleted.description"] = {
      state: "confirmed",
      value: "orphan record",
      discloseTo: [],
    };
    const card = candidateFacts(p);
    const serialized = JSON.stringify(card);
    for (const secret of [
      "私人姓名",
      "private@example.invalid",
      "13800000000",
      "secret.invalid",
      "orphan record",
      "不应发送",
    ])
      expect(serialized).not.toContain(secret);
    expect(card.facts[0]!.id).toBe("F1");
    expect(serialized).toContain("Python");
  });
  it("retains unknown conditions and never turns preferred experience into a hard rejection", () => {
    const rules = hardRules(
      { ...job, requirements: "3年以上相关工作经验优先" },
      { ...preferences, experienceYears: 0, graduationYear: 2026 },
    );
    expect(rules.find((r) => r.name === "相关经验")?.status).toBe("unknown");
    expect(rules.find((r) => r.name === "毕业届别")?.status).toBe("fail");
    expect(
      hardRules(
        { ...job, requirements: "3 年以上测试开发经验" },
        { ...preferences, experienceYears: 0 },
      ).find((r) => r.name === "相关经验")?.status,
    ).toBe("fail");
    expect(hardRules({ ...job, location: "" }, preferences)[0]!.status).toBe(
      "unknown",
    );
    expect(
      hardRules(
        { ...job, requirements: "2026届或2027届毕业生" },
        { ...preferences, graduationYear: 2025 },
      ).find((r) => r.name === "毕业届别")?.status,
    ).toBe("unknown");
  });
  it("rejects invented JD and profile citations and unsupported recommendation claims", () => {
    const facts = candidateFacts(profile).facts;
    expect(validateAssessment(assessment, job, facts).grade).toBe(
      "recommended",
    );
    expect(
      validateAssessment(
        {
          ...assessment,
          grade: "unsuitable",
          evidence: [
            {
              kind: "question",
              reason: "学历待补充",
              jdQuote: "本科及以上学历",
              factId: null,
              factQuote: null,
            },
          ],
        },
        job,
        facts,
      ).grade,
    ).toBe("insufficient");
    for (const patch of [
      { jdQuote: "岗位没有说过的话" },
      { factId: "F99" },
      { factQuote: "Java" },
      { factId: null, factQuote: null },
    ])
      expect(() =>
        validateAssessment(
          {
            ...assessment,
            evidence: [{ ...assessment.evidence[0], ...patch }],
          },
          job,
          facts,
        ),
      ).toThrow();
  });
  it("sends only the previewed matching payload, without attachments or identity fields", async () => {
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(assessment) } }],
          }),
        ),
    );
    vi.stubGlobal("fetch", request);
    await assess(
      job,
      candidateFacts(profile).facts,
      preferences,
      { endpoint: "https://model.example.invalid/chat", name: "fixture" },
      "test-key",
      new AbortController().signal,
    );
    const opts = (request.mock.calls as unknown as [URL, RequestInit][])[0]![1];
    expect(opts.redirect).toBe("error");
    expect(opts.body).toContain("Python");
    for (const secret of [
      "私人姓名",
      "private@example.invalid",
      "13800000000",
      "test-key",
    ])
      expect(opts.body).not.toContain(secret);
  });
});
describe("desktop discovery wiring", () => {
  it("requires independent cloud consent and rejects stale/replayed previews before crawling", async () => {
    const crawler = vi.fn(async () => {});
    const h = await harness({ crawl: crawler });
    try {
      const p = await preview(h.service);
      await start(h.service, p, false);
      expect(crawler).not.toHaveBeenCalled();
      expect(h.service.snapshot().run?.error).toContain("披露");
      await start(h.service, p);
      expect(crawler).not.toHaveBeenCalled();
      const fresh = await preview(h.service);
      await h.vault.set(
        "profile",
        JSON.stringify({
          ...profile,
          facts: {
            ...profile.facts,
            "skills.description": { state: "confirmed", value: "changed" },
          },
        }),
      );
      await start(h.service, fresh);
      expect(crawler).not.toHaveBeenCalled();
      expect(h.service.snapshot().run?.error).toContain("已变化");
    } finally {
      await h.close();
    }
  });
  it("persists evidence, imports only explicit selections and never creates applications or sync work", async () => {
    const h = await harness({
      crawl: async (o) => {
        await o.onJob(job);
        await o.onJob(job);
      },
    });
    try {
      const result = (await start(h.service, await preview(h.service)))!;
      expect(result.status).toBe("completed");
      expect(result.results).toHaveLength(1);
      expect(result.results[0]!.grade).toBe("recommended");
      expect(h.service.store.jobs()).toHaveLength(0);
      const request = {
        method: "discoveryDecision",
        batchId: result.id,
        id: result.results[0]!.id,
        decision: "keep",
      };
      await h.service.handle(request);
      await h.service.handle(request);
      expect(h.service.store.jobs()).toHaveLength(1);
      expect(h.service.store.applications()).toHaveLength(0);
      expect(
        h.service.store.db.prepare("SELECT * FROM outbox").all(),
      ).toHaveLength(0);
      const disk =
        JSON.stringify(h.service.store.db.prepare("SELECT * FROM meta").all()) +
        JSON.stringify(
          h.service.store.db.prepare("SELECT * FROM events").all(),
        );
      expect(disk).not.toContain("Python");
      expect(disk).not.toContain("私人姓名");
      const restored = await h.service.discovery.view();
      expect(restored?.results[0]?.jobId).toBe(h.service.store.jobs()[0]?.id);
      await h.vault.set("profile", JSON.stringify({ ...profile, facts: {} }));
      expect((await h.service.discovery.view())?.stale).toBe(true);
    } finally {
      await h.close();
    }
  });
  it("keeps hard failures outside AI and preserves partial failures without false confidence", async () => {
    const model = vi.fn(async () => assessment);
    const h = await harness({
      assess: model,
      crawl: async (o) => {
        await o.onJob({ ...job, location: "北京" });
        o.onIssue("另一站点读取失败");
      },
    });
    try {
      const result = (await start(h.service, await preview(h.service)))!;
      expect(model).not.toHaveBeenCalled();
      expect(result.results[0]?.grade).toBe("unsuitable");
      expect(result.status).toBe("partial");
    } finally {
      await h.close();
    }
    const bad = await harness({
      assess: async () => ({
        ...assessment,
        evidence: [{ ...assessment.evidence[0]!, jdQuote: "虚构要求" }],
      }),
    });
    try {
      const result = (await start(bad.service, await preview(bad.service)))!;
      expect(result.results[0]?.analysis).toBe("failed");
      expect(result.results[0]?.grade).toBe("insufficient");
      expect(result.status).toBe("partial");
    } finally {
      await bad.close();
    }
  });
  it("does not call a model in local mode and preserves completed jobs on cancel", async () => {
    const model = vi.fn(async () => assessment);
    let entered!: () => void;
    const gate = new Promise<void>((r) => (entered = r));
    const h = await harness({
      assess: model,
      crawl: async (o) => {
        await o.onJob(job);
        entered();
        await new Promise<void>((_, reject) =>
          o.signal.addEventListener("abort", () => reject(new Error("abort")), {
            once: true,
          }),
        );
      },
    });
    try {
      const p = await preview(h.service, { ...preferences, mode: "local" });
      await h.service.handle({
        method: "start",
        operation: "discover",
        previewId: p.id,
      });
      await gate;
      await h.service.handle({
        method: "control",
        runId: h.service.runtime!.record.runId,
        action: "cancel",
      });
      await wait(h.service);
      const result = await h.service.discovery.view();
      expect(result?.status).toBe("cancelled");
      expect(result?.results).toHaveLength(1);
      expect(model).not.toHaveBeenCalled();
      expect(h.service.snapshot().run?.state).toBe("CANCELLED");
    } finally {
      await h.close();
    }
  });
});
