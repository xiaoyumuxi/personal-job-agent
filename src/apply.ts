import { ProfileSchema, type Profile, type Fact } from "./types.js";
import { type Config, loadSites, findSite, mappings } from "./config.js";
import { Store, now } from "./db.js";
import { loadProfile, saveProfile, confirmFact } from "./profile.js";
import type { Vault } from "./vault.js";
import { ask, yes } from "./prompt.js";
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
  if (
    existing &&
    ["FILLING", "REVIEW"].includes(existing.state) &&
    !(await yes(
      "上次会话未结束；已在官网核对该岗位尚未最终提交，允许重新观察辅助填写？",
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
  console.log(
    `目标：${job.company} / ${job.title}\n网站：${job.url}\n候选资料字段：${available.join(", ") || "尚无已确认资料"}\n附件：${profile.resume ? "已导入简历，将可能上传至上述网站" : "无"}\n填写/上传本身可能发送数据。声明和最终提交由本人完成。`,
  );
  if (job.dedupWarning) console.log(job.dedupWarning);
  if (
    !(await yes("确认选择此岗位，并允许向此网站填写上述已确认资料及上传附件？"))
  )
    return;
  const a = store.ensureApplication(job.id);
  a.state = "FILLING";
  store.save(a, "DISCLOSURE_APPROVED", {
    origin: new URL(job.url).origin,
    fields: available,
    attachment: !!profile.resume,
  });
  const context = await openChrome(dir);
  const page = await context.newPage();
  try {
    if (site?.login) {
      a.authStatus = await verifyAtApplications(page, site);
      if (a.authStatus !== "VALID") {
        console.log(`登录检测：${a.authStatus}。请在专用 Chrome 正常登录。`);
        await ask("完成后按回车重新检测（q 退出）").then((s) => {
          if (s === "q") throw new Error("用户暂停登录");
        });
        a.authStatus = await verifyAtApplications(page, site);
        if (a.authStatus !== "VALID") {
          a.nextAction = "登录状态尚未验证，请核对登录及站点配置";
          store.save(a, "LOGIN_NOT_VERIFIED");
          return;
        }
      }
    } else {
      a.authStatus = "UNKNOWN";
      await navigate(page, job.url);
      console.log(
        "没有该网站的登录验证规则，状态保留 UNKNOWN。请本人在浏览器检查登录和表单。",
      );
      if (
        !(await yes("确认当前是本人可访问的申请表单，并仅在本次会话辅助填写？"))
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
    );
    let manualRounds = 0;
    for (;;) {
      if (++manualRounds > config.maxActions) {
        console.log("达到本次交互上限，保存后退出");
        break;
      }
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
      console.log(
        `步骤 ${result.ob.step || "未识别"}；本轮填写 ${result.filled} 项；覆盖 ${result.ob.coverage}`,
      );
      for (const warning of result.ob.warnings)
        console.log("覆盖提示：" + warning);
      for (const [n, issue] of result.issues.entries())
        console.log(
          `${n + 1}. ${issue.field?.section ?? ""} / ${issue.field?.label ?? ""}：${issue.reason}${issue.path ? " (" + issue.path + ")" : ""}`,
        );
      a.state = "REVIEW";
      a.nextAction = "浏览器人工审核；最终提交必须本人点击";
      store.save(a, "FORM_PAUSED", {
        step: result.ob.step,
        coverage: result.ob.coverage,
        issueCount: result.issues.length,
      });
      const action = await ask(
        "命令：answer 编号 / bind 编号 / map 编号 / model / add 区块 / next / resume / submitted / quit（明确尚未提交）",
      );
      const [verb, ...parts] = action.split(" ");
      const index = Number(parts[0]) - 1;
      const issue = result.issues[index];
      if (verb === "quit" || verb === "q") break;
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
      if (verb === "answer" && issue?.field) {
        const path =
          issue.path ||
          (await ask("输入资料路径，例如 basic.name 或 custom.availability："));
        const raw = await ask(
          "本人确认的答案（支持 JSON 数组 / true / false；不会推断未知值）：",
          true,
        );
        let value: Fact["value"] = raw;
        try {
          value = JSON.parse(raw);
        } catch {}
        const validated = ProfileSchema.parse({
          facts: {
            [path]: { state: "confirmed", value, discloseTo: [origin] },
          },
        }).facts[path]!;
        if (
          (await ask("保存范围：general 通用 / application 仅此申请")) ===
          "general"
        ) {
          confirmFact(profile, path, validated.value!);
          profile.facts[path]!.discloseTo = [origin];
          await saveProfile(vault, store, profile);
        } else {
          overrides[path] = validated;
          await vault.set(
            "application:" + a.id,
            JSON.stringify({ version: 1, facts: overrides }),
          );
        }
        engine.approveMapping(issue.field, path);
      } else if (verb === "bind" && issue?.field?.record) {
        const kind = issue.field.repeatKind;
        if (kind !== "education" && kind !== "experience") {
          console.log("未知重复区块，请人工填写或补充站点 repeats 配置");
          continue;
        }
        console.log("可绑定资料记录：" + profile.records[kind].join(", "));
        const record = await ask(
          "输入具体记录 ID（在浏览器核对该区块内容，不按显示顺序自动绑定）：",
        );
        if (!profile.records[kind].includes(record))
          throw new Error("资料记录 ID 不存在");
        engine.bind(issue.field.record, record);
      } else if (verb === "map" && issue?.field) {
        const path = await ask("明确指定资料路径：");
        if (!profile.facts[path] && !overrides[path]) {
          console.log("资料路径不存在，请先 answer");
          continue;
        }
        engine.approveMapping(issue.field, path);
        if (await yes("已核对区块和字段含义，保存此站点结构下的语义映射？"))
          store.cache(cacheKey(site, page.url(), result.ob, issue.field), path);
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
          console.log(
            "模型未启用、未授权、无 Key 或没有可验证建议；请使用 map / answer",
          );
        for (const suggestion of suggestions) {
          const f = unknown.find((f) => f.uid === suggestion.id)!;
          if (
            await yes(
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
          console.log((e as Error).message);
        }
      } else if (verb === "add") {
        try {
          await engine.addRecord(parts.join(" "));
        } catch (e) {
          console.log((e as Error).message);
        }
      } else if (verb === "resume") {
        if (site?.login) {
          const auth = await verifySession(page, site);
          a.authStatus = auth;
          if (auth !== "VALID") {
            console.log("登录状态未验证，停止自动填写");
            break;
          }
        }
        await engine.adoptManual();
      } else console.log("未识别命令；没有执行页面动作");
    }
  } catch {
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
  } finally {
    await context.close();
  }
}
