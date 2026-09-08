#!/usr/bin/env node
import { Command } from "commander";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import {
  ConfigSchema,
  dataDir,
  readConfig,
  saveConfig,
  loadSites,
  findSite,
  safeUrl,
  type Config,
} from "./config.js";
import { Store } from "./db.js";
import {
  loadProfile,
  importProfile,
  saveProfile,
  confirmFact,
  blankProfile,
} from "./profile.js";
import { KeychainVault, MemoryVault, type Vault } from "./vault.js";
import { readJobs, jobsFromGrid } from "./jobs.js";
import { acquireLock, unlock } from "./lock.js";
import { ask, yes, pasted } from "./prompt.js";
import { openChrome, verifyAtApplications } from "./browser/session.js";
import { applyJob } from "./apply.js";
import { track } from "./track.js";
import { sync, pullControls, retrySync } from "./feishu/sync.js";
import { FeishuCLI } from "./feishu/cli.js";
import { tableFields } from "./feishu/schema.js";
import { alert, writeReport } from "./notify.js";
import {
  installSchedule,
  uninstallSchedule,
  schedulePlan,
  scheduleStatus,
  dailyRun,
  localDate,
} from "./schedule.js";
import { runFile } from "./process.js";
import type { Profile, Value } from "./types.js";
import {
  doctor,
  importJobsFile,
  importProfileFile,
} from "./application/services.js";
process.umask(0o077);
const program = new Command()
  .name("jobagent")
  .description(
    "个人网申助手：本地资料、可见 Chrome、飞书官方 CLI、人工最终提交",
  )
  .version("0.2.0")
  .option("--home <directory>", "本地资料目录")
  .option("--session", "资料仅保存在本次进程内存（不降级为明文）", false);
interface State {
  store: Store;
  config: Config;
  dir: string;
  vault: Vault;
}
async function state(
  fn: (s: State) => Promise<unknown> | unknown,
  locking = true,
) {
  const dir = dataDir(program.opts().home),
    config = readConfig(dir);
  let release: (() => void) | undefined;
  let store: Store | undefined;
  try {
    if (locking) release = acquireLock(dir);
    store = new Store(dir);
    if (!store.getMeta("createdDate"))
      store.setMeta("createdDate", localDate());
    if (program.opts().session)
      console.log(
        "会话模式：资料值仅在当前命令进程内有效；跨命令不保留。辅助填写请使用 apply --profile。",
      );
    await fn({
      store,
      config,
      dir,
      vault: program.opts().session
        ? new MemoryVault()
        : new KeychainVault(dir),
    });
  } finally {
    store?.close();
    release?.();
  }
}
function output(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}
program
  .command("init")
  .description("初始化本地目录、SQLite 和安全默认配置")
  .action(() =>
    state(({ store, dir }) => {
      output({
        home: dir,
        config: join(dir, "config.json"),
        initialized: true,
        schedule: "使用 schedule status 查看真实安装状态",
      });
      writeReport(store, dir);
    }),
  );
program
  .command("doctor")
  .description("检查环境、Keychain 可用性、官方 CLI 和授权；不登录、不写飞书")
  .action(() =>
    state(async ({ store, config, dir, vault }) => {
      output(await doctor(store, config, dir, vault));
    }),
  );
program
  .command("unlock")
  .description("仅在原进程已退出时清理遗留锁")
  .action(() => {
    unlock(dataDir(program.opts().home));
    console.log("已清理失效任务锁");
  });
const profile = program
  .command("profile")
  .description("资料导入、确认、补充；值保存在 Keychain");
profile
  .command("import [file]")
  .option("--paste", "交互粘贴文本")
  .description("导入文本 PDF、TXT 或 JSON，生成待确认资料")
  .action((file, opts) =>
    state(async ({ store, vault, dir }) => {
      const merged = await importProfileFile(
        store,
        vault,
        dir,
        file,
        opts.paste ? await pasted() : undefined,
      );
      output({
        fields: Object.entries(merged.facts).map(([path, f]) => ({
          path,
          state: f.state,
        })),
        next: "profile confirm 或 profile set",
      });
    }),
  );
profile
  .command("show")
  .option("--values", "在本人终端明确显示资料值")
  .action((opts) =>
    state(async ({ vault }) => {
      const p = await loadProfile(vault);
      output(
        opts.values
          ? p
          : {
              fields: Object.entries(p.facts).map(([path, f]) => ({
                path,
                state: f.state,
              })),
              records: p.records,
              resume: !!p.resume,
            },
      );
    }, false),
  );
profile
  .command("confirm")
  .description("逐项审阅并确认待确认或冲突资料")
  .action(() =>
    state(async ({ vault, store }) => {
      const p = await loadProfile(vault);
      for (const [k, f] of Object.entries(p.facts)) {
        if (f.state === "confirmed") continue;
        console.log(
          `${k} [${f.state}] 候选：${JSON.stringify(f.candidates ?? f.value ?? "缺失")}`,
        );
        if (
          f.value !== undefined &&
          f.state === "pending" &&
          (await yes("确认此资料？"))
        )
          confirmFact(p, k, f.value);
        else {
          const raw = await ask("补充本人确认的值；留空保持当前状态：", true);
          if (raw) {
            let value: Value = raw;
            try {
              value = JSON.parse(raw);
            } catch {}
            confirmFact(p, k, value);
          }
        }
      }
      await saveProfile(vault, store, p);
      console.log(
        vault.kind === "session"
          ? "确认结果仅在当前进程有效，退出后丢弃"
          : "确认结果已保存到 Keychain",
      );
    }),
  );
profile
  .command("set <path>")
  .description("交互输入已确认答案，不把敏感值放在 Shell 参数里")
  .action((path) =>
    state(async ({ vault, store }) => {
      const p = await loadProfile(vault);
      let value: Value = await ask(
        "本人确认的值（可输入 JSON 数组/布尔值）：",
        true,
      );
      try {
        value = JSON.parse(String(value));
      } catch {}
      confirmFact(p, path, value);
      await saveProfile(vault, store, p);
      console.log("已保存");
    }),
  );
profile
  .command("record <kind> <id>")
  .description("添加稳定的 education / experience 资料记录 ID")
  .action((kind, id) =>
    state(async ({ vault, store }) => {
      if (
        !["education", "experience"].includes(kind) ||
        !/^[a-zA-Z0-9_-]+$/.test(id)
      )
        throw new Error(
          "kind 应为 education 或 experience；id 使用字母数字下划线",
        );
      const p = await loadProfile(vault);
      const k = kind as "education" | "experience";
      if (!p.records[k].includes(id)) p.records[k].push(id);
      await saveProfile(vault, store, p);
      console.log(
        `记录已添加，用 profile set ${kind}.${id}.school 等路径补充资料`,
      );
    }),
  );
const jobs = program.command("jobs").description("导入岗位并保留原始投递链接");
jobs
  .command("import [file]")
  .option("--paste", "粘贴 CSV / TSV")
  .option("--columns <json>", "自定义表头映射 JSON")
  .action((file, opts) =>
    state(async ({ store, config, dir }) => {
      output(
        await importJobsFile(
          store,
          config,
          dir,
          file,
          opts.paste ? await pasted() : undefined,
          opts.columns ? JSON.parse(opts.columns) : {},
        ),
      );
      console.log("导入不代表投递授权；jobs list 后自行选择 apply <id>");
    }),
  );
jobs
  .command("list")
  .action(() => state(({ store }) => output(store.jobs()), false));
jobs
  .command("channel <id> <url>")
  .description("为岗位补充/更正入口，保留全部 URL 参数")
  .action((id, url) =>
    state(({ store, config, dir }) => {
      const u = safeUrl(url),
        j = store.job(id);
      if (store.applications().some((a) => a.jobId === id))
        throw new Error("已有关联申请，不能直接改变目标入口");
      const site = findSite(loadSites(config, dir), url);
      store.updateJob({
        ...j,
        url,
        tenant: site?.tenant ?? u.origin,
        account: site?.account ?? j.account,
        channel: "READY",
      });
      console.log("入口已保存");
    }),
  );
program
  .command("login <siteId>")
  .description("打开本人申请页，在专用 Chrome 中正常登录并重新检测")
  .action((siteId) =>
    state(async ({ config, store, dir }) => {
      const site = loadSites(config, dir).find((s) => s.id === siteId);
      if (!site?.login) throw new Error("站点缺少 login 配置");
      const context = await openChrome(dir);
      try {
        const page = await context.newPage();
        let auth = await verifyAtApplications(page, site);
        if (auth !== "VALID") {
          console.log(`登录检测：${auth}。请在浏览器中完成人工登录。`);
          await ask("完成后按回车，程序将重新访问申请页验证：");
          auth = await verifyAtApplications(page, site);
        }
        output({ site: siteId, auth });
        store.event(null, "LOGIN_CHECK", { site: siteId, auth });
      } finally {
        await context.close();
      }
    }),
  );
program
  .command("apply <id>")
  .description("本人选择并授权披露后辅助填写，最终提交须手动完成")
  .option("--profile <file>", "会话模式下临时导入已确认的结构化 JSON")
  .action((id, opts) =>
    state(async (s) => {
      if (opts.profile) {
        const p = await importProfile(opts.profile, undefined, s.dir);
        console.log("会话资料：" + JSON.stringify(p));
        if (!(await yes("本人核对以上资料，全部现有值真实准确？"))) return;
        for (const f of Object.values(p.facts))
          if (f.value !== undefined) f.state = "confirmed";
        await s.vault.set("profile", JSON.stringify(p));
      }
      await applyJob(id, s.store, s.config, s.dir, s.vault);
    }),
  );
program
  .command("track")
  .description("只读查询已提交/结果未知申请；不自动投递")
  .action(() =>
    state(async ({ store, config, dir }) => {
      try {
        await pullControls(store, config);
      } catch {
        await alert(
          store,
          dir,
          "feishu",
          "FEISHU_CONTROL_READ_FAILED",
          config.notifications,
        );
      }
      await track(store, config, loadSites(config, dir), dir);
      await sync(store, config, dir);
      output(writeReport(store, dir));
    }),
  );
program
  .command("sync")
  .description("对账后同步待处理事件；仅写自动字段")
  .action(() =>
    state(async ({ store, config, dir }) => {
      await sync(store, config, dir);
      output(writeReport(store, dir));
    }),
  );
program
  .command("status")
  .option("--history <id>", "申请事件历史")
  .action((opts) =>
    state(({ store, dir }) => {
      if (opts.history) {
        const a = store.app(opts.history);
        output(
          store.db
            .prepare(
              "SELECT at,kind,data FROM events WHERE app_id=? ORDER BY id",
            )
            .all(a.id),
        );
      } else output(writeReport(store, dir));
    }, false),
  );
program
  .command("retry <id>")
  .option("--operation <name>", "sync 或 track", "sync")
  .option("--allow-create", "已在官网飞书核对不存在该行，解除未知创建保护")
  .action((id, opts) =>
    state(async ({ store, config, dir }) => {
      const a = store.app(id);
      if (opts.operation === "sync") {
        if (
          opts.allowCreate &&
          !(await yes(
            "确认已在飞书核查本地申请 ID 没有对应记录？解除保护可能造成重复新增。",
          ))
        )
          return;
        retrySync(store, a.id, opts.allowCreate);
        await sync(store, config, dir);
      } else if (opts.operation === "track") {
        const job = store.job(a.jobId),
          site = findSite(loadSites(config, dir), job.url);
        if (!site) throw new Error("NEEDS_ADAPTER");
        store.task(`track:${site.id}:${site.tenant}:${job.account}`, {
          status: "PENDING",
          failures: 0,
          nextAt: 0,
        });
        a.queryStatus = "NEVER";
        a.queryRetries = 0;
        store.save(a, "MANUAL_TRACK_RETRY");
        await track(store, config, loadSites(config, dir), dir);
      } else throw new Error("operation 仅支持 sync 或 track");
    }),
  );
program
  .command("application <id>")
  .description("本人维护跟踪状态/人工核对未知提交结果")
  .option("--pause", "暂停跟踪")
  .option("--resume", "恢复跟踪")
  .option("--resolve <state>", "人工核对后：submitted 或 not-submitted")
  .action((id, opts) =>
    state(async ({ store }) => {
      const a = store.app(id);
      if (opts.pause) a.paused = true;
      if (opts.resume) a.paused = false;
      if (opts.resolve) {
        if (!["submitted", "not-submitted"].includes(opts.resolve))
          throw new Error("resolve 值不合法");
        if (
          !(await yes(
            "已在官网核对该岗位的真实投递结果？该操作只记录本人确认，不代表系统验证回执。",
          ))
        )
          return;
        a.state = opts.resolve === "submitted" ? "SUBMITTED" : "DRAFT";
        a.evidence = "manual-confirmation";
        a.nextAction =
          opts.resolve === "submitted" ? "查询官网后续进度" : "可重新辅助填写";
      }
      store.save(a, "MANUAL_APPLICATION_UPDATE");
    }),
  );
const feishu = program
  .command("feishu")
  .description("通过已检查的飞书官方 CLI 接入");
feishu.command("schema").action(() => output(tableFields));
feishu
  .command("connect <baseToken> <tableId>")
  .description("验证真实目标表结构后保存同步配置")
  .action((baseToken, tableId) =>
    state(async ({ config, dir }) => {
      const next = { ...config.feishu, enabled: true, baseToken, tableId };
      const cli = new FeishuCLI(next);
      await cli.check();
      console.log(
        `目标多维表格：${baseToken} / ${tableId}；后续 sync 将披露岗位和进度字段。`,
      );
      if (!(await yes("确认使用此表？"))) return;
      config.feishu = next;
      saveConfig(dir, config);
    }),
  );
feishu
  .command("create")
  .description("使用官方 CLI 新建一张主表，先预览字段并确认")
  .action(() =>
    state(async ({ store, config, dir }) => {
      if (store.getMeta("feishuCreateIntent"))
        throw new Error(
          "已有建表意图/结果；请核对飞书后用 feishu connect，禁止重复建表",
        );
      output(tableFields);
      if (!(await yes("确认使用飞书用户身份新建“个人网申助手 / 投递主表”？")))
        return;
      const cli = new FeishuCLI(config.feishu);
      await cli.auth();
      store.setMeta("feishuCreateIntent", {
        at: new Date().toISOString(),
        state: "REQUESTED",
      });
      const result = await cli.createBase();
      store.setMeta("feishuCreateResult", result);
      output(result);
      console.log(
        "使用返回的真实 base token、table id 执行 feishu connect；填色须按 docs/feishu.md 配置，当前未验证。",
      );
    }),
  );
const model = program
  .command("model")
  .description("可选语义映射，只发送标签和字段路径，不发送资料值");
model.command("configure").action(() =>
  state(async ({ vault, config, dir }) => {
    const endpoint = await ask("OpenAI 兼容 chat/completions HTTPS 完整地址：");
    if (new URL(endpoint).protocol !== "https:")
      throw new Error("必须使用 HTTPS");
    const name = await ask("模型名称：");
    console.log(
      "开启后，执行 apply 中的 model 命令会把页面字段标签、区块名、资料字段路径发送至 " +
        new URL(endpoint).origin +
        "。不发送简历内容或资料值。",
    );
    if (!(await yes("授权该云端处理？"))) return;
    await vault.set(
      "model-key",
      await ask("API Key（隐藏输入；保存到 Keychain）：", true),
    );
    config.model = { enabled: true, consent: true, endpoint, name };
    saveConfig(dir, config);
  }),
);
model.command("disable").action(() =>
  state(({ config, dir }) => {
    config.model.enabled = false;
    config.model.consent = false;
    saveConfig(dir, config);
  }),
);
const schedule = program
  .command("schedule")
  .description("每日只读查询与同步；安装前展示执行时间和影响");
schedule
  .command("install")
  .option("--hour <hour>", "小时")
  .option("--minute <minute>", "分钟")
  .option("--dry-run", "只输出 plist，不安装")
  .action((opts) =>
    state(async ({ config, dir }) => {
      if (opts.hour !== undefined) config.schedule.hour = Number(opts.hour);
      if (opts.minute !== undefined)
        config.schedule.minute = Number(opts.minute);
      ConfigSchema.parse(config);
      const plan = schedulePlan(dir, config);
      console.log(
        `本机时区每日 ${config.schedule.hour}:${String(config.schedule.minute).padStart(2, "0")} 查询与同步；登录桌面时有效。每 15 分钟及登录时检查漏跑/占用，仅有到期任务才读取官网。会打开专用 Chrome。Mac 关机时不承诺准点。`,
      );
      if (opts.dryRun) {
        console.log(plan);
        return;
      }
      if (!(await yes("确认安装 launchd 用户任务？"))) return;
      const path = await installSchedule(dir, config);
      saveConfig(dir, config);
      output({ installed: true, path });
    }),
  );
schedule.command("status").action(async () => output(await scheduleStatus()));
schedule.command("uninstall").action(async () => {
  await uninstallSchedule();
  output({ installed: false });
});
program
  .command("daily")
  .description("launchd 入口：串行、漏跑补查、日期去重")
  .action(() =>
    state(async ({ store, config, dir }) => {
      const result = await dailyRun(store, config, async () => {
        try {
          await pullControls(store, config);
        } catch {
          await alert(
            store,
            dir,
            "feishu",
            "FEISHU_CONTROL_READ_FAILED",
            config.notifications,
          );
        }
        await track(store, config, loadSites(config, dir), dir);
        await sync(store, config, dir);
        writeReport(store, dir);
      });
      output(result);
    }),
  );
await program.parseAsync().catch((error) => {
  console.error(error instanceof Error ? error.message : "执行失败");
  process.exitCode = 1;
});
