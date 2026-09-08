import {
  ProfileSchema,
  isRecordKind,
  type Profile,
  type Fact,
} from "./types.js";
import { type Config, loadSites, findSite, mappings } from "./config.js";
import { Store, now } from "./db.js";
import { loadProfile, saveProfile, confirmFact } from "./profile.js";
import type { Vault } from "./vault.js";
import {
  terminalInteraction,
  RunStopped,
  type Interaction,
  type Question,
} from "./interaction.js";
import {
  openChrome,
  navigate,
  verifyAtApplications,
  verifySession,
} from "./browser/session.js";
import { FillEngine, cacheKey, matchField } from "./browser/fill.js";
import { suggestMappings } from "./model.js";
import { alert } from "./notify.js";
export async function applyJob(
  id: string,
  store: Store,
  config: Config,
  dir: string,
  vault: Vault,
  io: Interaction = terminalInteraction,
) {
  let job = store.jobs().find((j) => j.id === id);
  if (!job) {
    job = store.job(store.app(id).jobId);
  }
  if (!job.url)
    throw new Error("NEEDS_CHANNEL：先使用 jobs channel 补充投递入口");
  const existing = store.applications().find((a) => a.jobId === job!.id);
  if (existing && ["SUBMITTED", "UNKNOWN_RESULT"].includes(existing.state))
    throw new Error(
      "已投递或结果不确定，禁止重复执行 apply；请先查询官网/人工核对",
    );
  const confirm = async (message: string) => {
    const answer = await io.request({
      kind: "confirm",
      message,
      site: job!.url,
    });
    return answer.action === "confirm" && answer.accepted;
  };
  if (
    existing &&
    ["FILLING", "REVIEW"].includes(existing.state) &&
    !(await confirm(
      "上次会话未结束；请先在官网核对该岗位尚未最终提交，再恢复辅助填写",
    ))
  )
    return;
  const site = findSite(loadSites(config, dir), job.url);
  if (site && !site.capabilities.fill)
    throw new Error("该站点配置没有声明填表能力");
  const profile = await loadProfile(vault);
  const available = Object.keys(profile.facts).filter(
    (k) => profile.facts[k]!.state === "confirmed",
  );
  if (
    !(await confirm(
      `目标：${job.company} / ${job.title}。允许向该网站填写以下已确认资料：${available.join(", ") || "暂无"}；${profile.resume ? "包含简历附件上传" : "没有附件"}。填写和上传可能立即发送数据，最终提交必须本人在官网完成。${job.dedupWarning || ""}`,
    ))
  )
    return;
  const a = store.ensureApplication(job.id);
  a.state = "FILLING";
  store.save(a, "DISCLOSURE_APPROVED", {
    origin: new URL(job.url).origin,
    fields: available,
    attachment: !!profile.resume,
  });
  let context: Awaited<ReturnType<typeof openChrome>> | undefined;
  try {
    await io.checkpoint();
    io.step("打开专用 Chrome");
    context = await openChrome(dir);
    const page = await context.newPage();
    io.browser(page);
    if (site?.login) {
      a.authStatus = await verifyAtApplications(page, site);
      while (a.authStatus !== "VALID") {
        a.nextAction = "请在专用 Chrome 登录，然后重新检查";
        store.save(a, "LOGIN_REQUIRED");
        await io.request({
          kind: "login",
          site: site.login.url,
          message: `官网登录${a.authStatus === "UNKNOWN" ? "尚未验证（检查账户和站点规则）" : "已失效"}。完成后由后端重新访问申请页验证。`,
        });
        await io.checkpoint();
        a.authStatus = await verifyAtApplications(page, site);
      }
      store.save(a, "LOGIN_VERIFIED");
    } else {
      a.authStatus = "UNKNOWN";
      await navigate(page, job.url);
      if (
        !(await confirm(
          "该网站没有登录验证规则，状态保留未验证。请在浏览器核对当前是本人可访问的申请表单，仅本次会话辅助填写。",
        ))
      ) {
        store.save(a, "SESSION_UNKNOWN");
        return;
      }
    }
    await navigate(page, job.url);
    const origin = new URL(job.url).origin;
    for (const f of Object.values(profile.facts))
      if (f.state === "confirmed")
        f.discloseTo = [...new Set([...f.discloseTo, origin])];
    let overrides: Record<string, Fact> = {};
    const saved = await vault.get("application:" + a.id);
    if (saved) overrides = ProfileSchema.parse(JSON.parse(saved)).facts;
    const engine = new FillEngine(
      page,
      profile,
      mappings(config, dir),
      site,
      [origin],
      dir,
      overrides,
      config.maxActions,
      config.maxSteps,
      () => io.checkpoint(),
    );
    let manualRounds = 0;
    for (;;) {
      if (++manualRounds > config.maxActions) {
        io.step("达到本次交互上限，保存后退出");
        break;
      }
      if (await io.checkpoint()) await engine.adoptManual();
      io.step("观察表单并填写已确认资料");
      const initial = await engine.observation();
      for (const f of initial.fields) {
        const cached = !matchField(f, engine.rules)
          ? store.cache(cacheKey(site, page.url(), initial, f))
          : undefined;
        if (
          typeof cached === "string" &&
          (profile.facts[cached] || cached.includes("$"))
        ) {
          engine.approveMapping(f, cached);
          store.event(a.id, "MAPPING_CACHE_HIT", {
            key: cacheKey(site, page.url(), initial, f),
          });
        }
      }
      const result = await engine.pass();
      io.step(
        `步骤 ${result.ob.step || "未识别"}；已填写 ${result.filled} 项；覆盖 ${result.ob.coverage}`,
      );
      a.state = "REVIEW";
      a.nextAction = "浏览器人工审核；最终提交必须本人点击";
      store.save(a, "FORM_PAUSED", {
        step: result.ob.step,
        coverage: result.ob.coverage,
        issueCount: result.issues.length,
      });
      const question: Question = {
        kind: "review",
        message:
          "请核对表单；声明与最终提交由本人在官网完成。" +
          result.ob.warnings.join("；"),
        site: job.url,
        step: result.ob.step,
        paths: [
          ...new Set([
            ...Object.keys(profile.facts),
            ...Object.keys(overrides),
          ]),
        ],
        additions: site?.form?.repeats
          .filter((r) => r.add)
          .map((r) => r.section),
        canNext: !!site?.form?.next.some(
          (n) => n.from === result.ob.step && n.safe,
        ),
        canModel: config.model.enabled && config.model.consent,
        issues: result.issues.map((i) => ({
          label: i.field?.label ?? "页面核查",
          section: i.field?.section ?? "",
          type: i.field?.type ?? "manual",
          required: i.field?.required ?? "unknown",
          options: i.field?.options ?? [],
          path: i.path,
          reason: i.reason,
          canAnswer:
            !!i.field &&
            !i.field.sensitive &&
            (!i.field.record || (!!i.path && !i.path.includes("$"))) &&
            !["file", "manual"].includes(i.field.type),
          records: isRecordKind(i.field?.repeatKind)
            ? profile.records[i.field.repeatKind]
            : undefined,
          recordKind: isRecordKind(i.field?.repeatKind)
            ? i.field.repeatKind
            : undefined,
        })),
      };
      const action = await io.request(question);
      await io.checkpoint();
      const verb = action.action;
      const issue = "issue" in action ? result.issues[action.issue] : undefined;
      if (verb === "quit") break;
      // A human may have changed any field while the request was visible.
      if (verb !== "submitted") await engine.adoptManual();
      if (verb === "submitted") {
        // Intent is persisted before inspecting the receipt, including crashes during readback.
        a.state = "UNKNOWN_RESULT";
        a.nextAction = "核查官网回执；不要重复投递";
        store.save(a, "USER_REPORTED_SUBMIT");
        const confirmed = await engine.receipt(job.jobCode);
        if (confirmed) {
          a.state = "SUBMITTED";
          a.submittedAt = now();
          a.nextAction = "等待官网后续进度";
          a.evidence = site?.id + ":receipt:" + job.jobCode;
        }
        store.save(
          a,
          confirmed ? "SUBMIT_RECEIPT_CONFIRMED" : "SUBMIT_RESULT_UNKNOWN",
        );
        break;
      }
      if (action.action === "answer" && issue?.field) {
        const { path, value } = action;
        const validation = ProfileSchema.parse({
          facts: {
            [path]: { state: "confirmed", value, discloseTo: [origin] },
          },
        });
        // Reuse core path validation even for application-scoped facts.
        confirmFact({ ...profile, facts: {} }, path, value);
        if (action.scope === "general") {
          confirmFact(profile, path, value);
          profile.facts[path]!.discloseTo = [origin];
          await saveProfile(vault, store, profile);
        } else {
          overrides[path] = validation.facts[path]!;
          await vault.set(
            "application:" + a.id,
            JSON.stringify({ version: 1, facts: overrides }),
          );
        }
        engine.approveMapping(issue.field, path);
      } else if (action.action === "bind" && issue?.field?.record) {
        const kind = issue.field.repeatKind;
        if (
          !isRecordKind(kind) ||
          !profile.records[kind].includes(action.record)
        )
          throw new Error("资料记录 ID 不存在");
        engine.bind(issue.field.record, action.record);
      } else if (action.action === "map" && issue?.field) {
        if (!profile.facts[action.path] && !overrides[action.path])
          throw new Error("资料路径不存在");
        engine.approveMapping(issue.field, action.path);
        store.cache(
          cacheKey(site, page.url(), result.ob, issue.field),
          action.path,
        );
      } else if (verb === "model") {
        const unknown = result.issues.flatMap((i) =>
          i.field ? [i.field] : [],
        );
        const suggestions = await suggestMappings(
          unknown,
          Object.keys(profile.facts),
          config,
          store,
          vault,
        );
        if (!suggestions.length)
          io.step("模型未配置或没有可验证建议，请手工指定字段");
        for (const suggestion of suggestions) {
          const f = unknown.find((f) => f.uid === suggestion.id)!;
          if (
            await confirm(
              `${f.section}/${f.label} → ${suggestion.path}，确认此语义？`,
            )
          ) {
            engine.approveMapping(f, suggestion.path!);
            store.cache(
              cacheKey(site, page.url(), result.ob, f),
              suggestion.path,
            );
          }
        }
      } else if (verb === "next") {
        try {
          await engine.next();
        } catch (e) {
          io.step((e as Error).message);
        }
      } else if (verb === "add") {
        try {
          await engine.addRecord(action.action === "add" ? action.section : "");
        } catch (e) {
          io.step((e as Error).message);
        }
      } else if (verb === "resume") {
        if (site?.login) {
          const auth = await verifySession(page, site);
          a.authStatus = auth;
          if (auth !== "VALID") {
            io.step("登录状态未验证，停止自动填写");
            break;
          }
        }
        await engine.adoptManual();
      } else io.step("没有执行页面动作");
    }
  } catch (error) {
    a.state = "UNKNOWN_RESULT";
    a.nextAction =
      "会话意外中断，先核对是否已提交，再用 application --resolve 记录本人核查结果";
    store.save(a, "APPLY_INTERRUPTED");
    await alert(
      store,
      dir,
      "apply:" + a.id,
      "APPLY_PAUSED",
      config.notifications,
    );
    if (io !== terminalInteraction) throw error;
  } finally {
    io.browser(undefined);
    await context?.close();
  }
}
