import {
  profileSelection,
  switchProfile,
  renameProfile,
} from "../src/profile-library.js";
import { randomUUID } from "node:crypto";
import {
  DiscoveryService,
  type DiscoveryDependencies,
} from "../src/discovery/service.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, extname } from "node:path";
import { Store, attention, now } from "../src/db.js";
import {
  dataDir,
  readConfig,
  loadSites,
  findSite,
  mappings,
  saveConfig,
  writePrivate,
  safeUrl,
  profileDir,
} from "../src/config.js";
import { KeychainVault, type Vault } from "../src/vault.js";
import { loadProfile, saveProfile, confirmFact } from "../src/profile.js";
import { SiteSchema, isRecordKind } from "../src/types.js";
import {
  Runtime,
  liveStates,
  cleanText,
  type RunRecord,
} from "../src/application/runtime.js";
import { RunStopped } from "../src/interaction.js";
import {
  doctor,
  importJobsFile,
  importProfileFile,
  checkModel,
  executable,
  resolveFeishuCLI,
  checkFeishuAuth,
  type FeishuCLICheck,
  type FeishuAuthCheck,
} from "../src/application/services.js";
import { probeCLI } from "../src/feishu/discovery.js";
import { configureTemplateViews } from "../src/feishu/template.js";
import { mainColumns, templateViews } from "../src/feishu/schema.js";
import { applyJob } from "../src/apply.js";
import { track } from "../src/track.js";
import { sync, retrySync } from "../src/feishu/sync.js";
import { acquireLock, unlock } from "../src/lock.js";
import {
  scheduleStatus,
  schedulePlan,
  installSchedule,
  uninstallSchedule,
  localDate,
} from "../src/schedule.js";
import {
  openChrome,
  navigate,
  verifyAtApplications,
} from "../src/browser/session.js";
import { FeishuCLI } from "../src/feishu/cli.js";
import { runFile } from "../src/process.js";
import {
  CommandSchema,
  type Command,
  type FileKind,
  type Snapshot,
  type ProfileView,
} from "./contract.js";
export class DesktopService {
  readonly dir: string;
  readonly store: Store;
  readonly vault: Vault;
  readonly discovery: DiscoveryService;
  runtime?: Runtime;
  private done?: Promise<void>;
  private auth?: { deviceCode: string; url: string; expiresAt: number };
  private writing = false;
  private cliDiscovery?: Promise<FeishuCLICheck>;
  private checkedCLI?: string;
  private authCheck?: Promise<FeishuAuthCheck>;
  private checkedAuthCLI?: string;
  constructor(
    private notify: () => void,
    home?: string,
    vault?: Vault,
    private nodePath = process.execPath,
    discoveryDependencies: DiscoveryDependencies = {},
  ) {
    this.dir = dataDir(home);
    readConfig(this.dir);
    this.store = new Store(this.dir);
    this.vault = vault ?? new KeychainVault(this.dir);
    this.discovery = new DiscoveryService(
      this.store,
      this.vault,
      this.dir,
      discoveryDependencies,
    );
    if (!this.store.getMeta("createdDate"))
      this.store.setMeta("createdDate", localDate());
    const old = this.store.task<RunRecord>("desktop:run");
    if (old && liveStates.includes(old.state)) {
      let release: (() => void) | undefined;
      try {
        // A live CLI or launchd lock must never be stolen. Only clear proven dead owners.
        if (existsSync(join(this.dir, "runner.lock"))) unlock(this.dir);
        release = acquireLock(this.dir);
        old.state = "INTERRUPTED";
        delete old.request;
        old.error = "上次进程已退出；先核查官网结果，再恢复";
        old.at = now();
        this.store.task("desktop:run", old);
        if (old.jobId && old.operation === "apply") {
          const a = this.store
            .applications()
            .find((a) => a.jobId === old.jobId);
          if (a && ["FILLING", "REVIEW"].includes(a.state)) {
            a.state = "UNKNOWN_RESULT";
            a.nextAction = old.error;
            this.store.save(a, "DESKTOP_INTERRUPTED");
          }
        }
      } catch {
        // The previous desktop run is no longer attached to this process. A CLI lock
        // can defer application recovery, but must not make the UI claim it is running.
        old.state = "INTERRUPTED";
        delete old.request;
        old.error =
          "上次客户端会话已中断；外部任务占锁，等待它结束后先核查官网";
        this.store.task("desktop:run", old);
      } finally {
        release?.();
      }
    }
  }
  snapshot(): Snapshot {
    const config = readConfig(this.dir),
      sites = loadSites(config, this.dir),
      applications = this.store.applications();
    const locked = existsSync(join(this.dir, "runner.lock"));
    const rows = this.store.jobs().map((job) => {
      const a = applications.find((a) => a.jobId === job.id);
      const site = job.url ? findSite(sites, job.url) : undefined;
      return {
        job,
        application: a,
        attention: a ? attention(a) : ("NORMAL" as const),
        permissions: {
          apply:
            !locked &&
            !!job.url &&
            (!site || site.capabilities.fill) &&
            !["SUBMITTED", "UNKNOWN_RESULT"].includes(a?.state ?? ""),
          track:
            !locked &&
            !!a &&
            !a.paused &&
            ["SUBMITTED", "UNKNOWN_RESULT"].includes(a.state),
          login: !locked && !!site?.login,
          open: !locked && !!job.url,
        },
      };
    });
    const run =
      this.runtime?.record ?? this.store.task<RunRecord>("desktop:run");
    const events = this.store.db
      .prepare(
        "SELECT id,at,kind,data FROM events WHERE app_id IS NULL ORDER BY id DESC LIMIT 150",
      )
      .all()
      .flatMap((r) => {
        const d = JSON.parse(String(r.data));
        return d.runId
          ? [
              {
                id: Number(r.id),
                at: String(r.at),
                kind: String(r.kind),
                runId: d.runId as string,
                step: cleanText(String(d.step || "")),
              },
            ]
          : [];
      })
      .reverse();
    return {
      rows,
      run,
      busy: !!this.runtime || this.writing,
      lock: locked,
      events,
      dataDir: this.dir,
    };
  }
  private async write<T>(fn: () => Promise<T>) {
    if (this.runtime || this.writing)
      throw new Error("任务运行中，请先完成或停止当前任务");
    this.writing = true;
    let release: (() => void) | undefined;
    try {
      release = acquireLock(this.dir);
      return await fn();
    } finally {
      release?.();
      this.writing = false;
      this.notify();
    }
  }
  async profile(profileId?: string): Promise<ProfileView> {
    const selection = await profileSelection(this.vault, this.store, profileId);
    const profile = selection.profile,
      rules = mappings(readConfig(this.dir), this.dir);
    const fields = rules
      .filter((r) => r.path !== "resume")
      .flatMap((r) => {
        if (!r.path.includes("$"))
          return [{ path: r.path, label: r.aliases[0]!, section: r.section }];
        const kind = r.path.split(".")[0];
        if (!isRecordKind(kind)) return [];
        return profile.records[kind].map((id, index) => ({
          path: r.path.replace("$", id),
          label: r.aliases[0]!,
          section: `${r.section} ${index + 1} · ${profile.facts[`${kind}.${id}.${kind === "education" ? "school" : kind === "project" ? "name" : "company"}`]?.value || "待补充名称"}`,
        }));
      });
    for (const path of Object.keys(profile.facts))
      if (!fields.some((f) => f.path === path))
        fields.push({
          path,
          label: path,
          section: path.startsWith("project.")
            ? "项目"
            : path.startsWith("preference.")
              ? "求职偏好"
              : "其他资料",
        });
    return {
      ...selection,
      fields,
      version: selection.selected.file ? selection.selected : undefined,
    };
  }
  private discoverFeishuCLI(refresh = false): Promise<FeishuCLICheck> {
    // Multiple windows/refreshes share one bounded worker operation and one lock.
    if (this.cliDiscovery) return this.cliDiscovery;
    const config = readConfig(this.dir);
    const previous = this.store.getMeta<FeishuCLICheck>("feishuExecutable");
    if (
      !refresh &&
      this.checkedCLI === config.feishu.cli &&
      previous?.configuredPath === config.feishu.cli
    )
      return Promise.resolve(previous);
    this.cliDiscovery = this.write(async () => {
      const result = await resolveFeishuCLI(
        this.store,
        config,
        this.dir,
        refresh,
      );
      this.checkedCLI = result.configuredPath;
      return result;
    }).finally(() => {
      this.cliDiscovery = undefined;
    });
    return this.cliDiscovery;
  }
  private checkSavedFeishuAuth(refresh = false): Promise<FeishuAuthCheck> {
    if (this.authCheck) return this.authCheck;
    const config = readConfig(this.dir);
    const previous = this.store.getMeta<FeishuAuthCheck>("feishuAuth");
    if (
      !refresh &&
      this.checkedAuthCLI === config.feishu.cli &&
      previous?.configuredPath === config.feishu.cli
    )
      return Promise.resolve(previous);
    this.authCheck = this.write(async () => {
      const result = await checkFeishuAuth(this.store, config);
      this.checkedAuthCLI = config.feishu.cli;
      return result;
    }).finally(() => {
      this.authCheck = undefined;
    });
    return this.authCheck;
  }
  async handle(raw: unknown): Promise<unknown> {
    const c = CommandSchema.parse(raw);
    if (c.method === "snapshot") return this.snapshot();
    if (c.method === "profile") return this.profile(c.profileId);
    if (c.method === "profileVersions") {
      const { selected, versions, activeId } = await profileSelection(
        this.vault,
        this.store,
      );
      return { selected, versions, activeId };
    }
    if (c.method === "history") {
      const a = this.store.applications().find((a) => a.jobId === c.jobId);
      return a
        ? this.store.db
            .prepare(
              "SELECT id,at,kind FROM events WHERE app_id=? ORDER BY id DESC LIMIT 100",
            )
            .all(a.id)
        : [];
    }
    if (c.method === "discoverFeishuCLI")
      return this.discoverFeishuCLI(c.refresh);
    if (c.method === "checkFeishuAuth")
      return this.checkSavedFeishuAuth(c.refresh);
    if (c.method === "settings") {
      const config = readConfig(this.dir);
      const localCLI = this.store.getMeta<FeishuCLICheck>("feishuExecutable");
      const auth = this.store.getMeta<FeishuAuthCheck>("feishuAuth");
      const views = this.store.getMeta<{ destination: string; at: string }>(
        "feishuTemplateViews",
      );
      return {
        home: this.dir,
        chromeProfile: profileDir(this.dir),
        sites: loadSites(readConfig(this.dir), this.dir).map((s) => ({
          id: s.id,
          name: s.name,
          fill: s.capabilities.fill,
          login: !!s.login,
          track: s.capabilities.track,
        })),
        modelConnection: this.store.getMeta("modelCheck") ?? {
          status: "NOT_TESTED",
        },
        config,
        feishuExecutable:
          localCLI?.configuredPath === config.feishu.cli ? localCLI : undefined,
        feishuAuth:
          auth?.configuredPath === config.feishu.cli ? auth : undefined,
        doctor: this.store.getMeta("doctor"),
        schedule: await scheduleStatus(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        daily: this.store.task("daily"),
        authPending: !!this.auth && this.auth.expiresAt > Date.now(),
        feishuTemplate: {
          columns: mainColumns,
          views: templateViews.map((v) => v.name),
          verifiedAt:
            views?.destination ===
            `${config.feishu.baseToken}:${config.feishu.tableId}`
              ? views.at
              : undefined,
        },
      };
    }
    if (c.method === "discoveryView") return this.discovery.view();
    if (c.method === "discoveryOpen")
      return this.discovery.sourceUrl(c.batchId, c.id);
    if (c.method === "start") return this.start(c);
    if (c.method === "answer") {
      if (!this.runtime) throw new Error("任务已结束，回答已过期");
      this.runtime.answer(c.runId, c.requestId, c.answer);
      return true;
    }
    if (c.method === "control") {
      if (!this.runtime || this.runtime.record.runId !== c.runId)
        throw new Error("任务已结束或不匹配");
      if (c.action === "focus") await this.runtime.focus();
      else this.runtime.control(c.action);
      return true;
    }
    if (c.method === "unlock") {
      if (this.runtime) throw new Error("当前任务仍在运行");
      unlock(this.dir);
      this.notify();
      return true;
    }
    return this.write(async () => {
      const config = readConfig(this.dir);
      if (c.method === "discoveryPreview")
        return this.discovery.preview(c.profileId, c.preferences);
      if (c.method === "discoveryDecision")
        return this.discovery.decide(c.batchId, c.id, c.decision);
      if (c.method === "channel") {
        const job = this.store.job(c.jobId),
          url = safeUrl(c.url);
        if (this.store.applications().some((a) => a.jobId === job.id))
          throw new Error("已有关联申请，不能直接更改投递入口");
        const site = findSite(loadSites(config, this.dir), c.url);
        this.store.updateJob({
          ...job,
          url: c.url,
          channel: "READY",
          tenant: site?.tenant ?? url.origin,
          account: site?.account ?? job.account,
        });
        return true;
      }
      if (c.method === "switchProfile") {
        await switchProfile(this.vault, this.store, c.profileId);
        return this.profile();
      }
      if (c.method === "renameProfile") {
        await renameProfile(this.vault, this.store, c.profileId, c.name);
        return this.profile(c.profileId);
      }
      if (c.method === "saveFact") {
        const p = await loadProfile(this.vault, c.profileId);
        confirmFact(p, c.path, c.value);
        await saveProfile(this.vault, this.store, p, c.profileId);
        const checked = await loadProfile(this.vault, c.profileId);
        if (
          JSON.stringify(checked.facts[c.path]) !==
          JSON.stringify(p.facts[c.path])
        )
          throw new Error("保存后回读不一致");
        return this.profile(c.profileId);
      }
      if (c.method === "record") {
        const p = await loadProfile(this.vault, c.profileId);
        if (!p.records[c.kind].includes(c.id)) p.records[c.kind].push(c.id);
        await saveProfile(this.vault, this.store, p, c.profileId);
        return this.profile(c.profileId);
      }
      if (c.method === "application") {
        const a = this.store.app(c.jobId);
        if (c.action === "pauseTracking") a.paused = true;
        else if (c.action === "resumeTracking") a.paused = false;
        else {
          if (!c.confirmed) throw new Error("请先在官网核对并确认结果");
          a.state = c.action === "submitted" ? "SUBMITTED" : "DRAFT";
          a.evidence = "manual-confirmation";
          a.nextAction =
            c.action === "submitted"
              ? "本人已核对提交，尚非官网回执验证"
              : "本人核对未提交，可重新观察填写";
        }
        this.store.save(a, "MANUAL_APPLICATION_UPDATE");
        return true;
      }
      if (c.method === "saveSettings") {
        if (c.feishu.cli !== config.feishu.cli)
          throw new Error("可执行文件请通过选择按钮设置");
        if (
          c.model.enabled &&
          (new URL(c.model.endpoint).protocol !== "https:" ||
            !c.model.consent ||
            !c.model.name)
        )
          throw new Error("模型启用需要 HTTPS、模型名称与披露授权");
        if (c.key) await this.vault.set("model-key", c.key);
        saveConfig(this.dir, {
          ...config,
          feishu: c.feishu,
          model: c.model,
          schedule: c.schedule,
        });
        this.store.setMeta("doctor", null);
        this.store.setMeta("modelCheck", { status: "NOT_TESTED" });
        return true;
      }
      if (c.method === "schedule") {
        const node = await runFile(this.nodePath, ["--version"]);
        if (node.code !== 0 || !/^v(2[4-9]|[3-9]\d)\./.test(node.stdout.trim()))
          throw new Error("调度需要独立 Node 24+ 可执行文件");
        if (c.action === "plan")
          return {
            plist: schedulePlan(this.dir, config, this.nodePath),
            message: `本机时区 ${Intl.DateTimeFormat().resolvedOptions().timeZone} 每日 ${config.schedule.hour}:${String(config.schedule.minute).padStart(2, "0")} 查询和同步；登录及每15分钟检查漏跑，可能打开专用 Chrome。不会投递。关闭客户端后仍有效。应用移动后需卸载并重新安装调度。已有调度不会自动覆盖。`,
          };
        if (!c.confirmed) throw new Error("请先预览调度影响并确认");
        if (c.action === "install")
          await installSchedule(this.dir, config, this.nodePath);
        else await uninstallSchedule();
        return scheduleStatus();
      }
      throw new Error("不支持此操作");
    });
  }
  async importFile(kind: FileKind, file: string) {
    return this.write(async () => {
      const config = readConfig(this.dir);
      if (kind === "jobs")
        return importJobsFile(this.store, config, this.dir, file);
      if (kind === "profile") {
        // JSON imports may not cause hidden reads of referenced arbitrary paths.
        if (
          extname(file).toLowerCase() === ".json" &&
          JSON.parse(readFileSync(file, "utf8")).resume
        )
          throw new Error(
            "JSON 中的附件引用不支持直接导入，请单独选择 PDF 简历",
          );
        await importProfileFile(this.store, this.vault, this.dir, file);
        return this.profile();
      }
      if (kind === "site") {
        if (statSync(file).size > 1024 * 1024) throw new Error("站点配置过大");
        const site = SiteSchema.parse(JSON.parse(readFileSync(file, "utf8")));
        const dest = join(this.dir, "site-" + randomUUID() + ".json");
        writePrivate(dest, JSON.stringify(site, null, 2));
        const existing = loadSites(config, this.dir);
        if (existing.some((s) => s.id === site.id))
          throw new Error("站点 ID 已存在；请在配置文件中修改原规则");
        config.siteFiles.push(dest);
        saveConfig(this.dir, config);
        return {
          name: site.name,
          fill: site.capabilities.fill,
          track: site.capabilities.track,
        };
      }
      let path = file;
      if (kind === "chrome" && file.endsWith(".app"))
        path = join(file, "Contents/MacOS/Google Chrome");
      if (!executable(path)) throw new Error("所选文件不是可执行程序");
      if (kind === "feishuCLI") {
        const result = await probeCLI(path);
        if (result.status !== "AVAILABLE") throw new Error(result.message);
        config.feishu.cli = path;
        this.store.setMeta("feishuExecutable", {
          ...result,
          configuredPath: path,
        });
        this.checkedCLI = path;
        this.checkedAuthCLI = undefined;
        this.store.setMeta("feishuAuth", null);
        this.auth = undefined;
      } else config.browser.executablePath = path;
      saveConfig(this.dir, config);
      this.store.setMeta("doctor", null);
      return true;
    });
  }
  private start(c: Extract<Command, { method: "start" }>) {
    if (this.runtime || this.writing)
      throw new Error("同一时间只能执行一个任务");
    if (c.operation === "discover" && (!c.previewId || c.jobId || c.profileId))
      throw new Error("请先预览岗位筛选条件和资料披露范围");
    if (
      c.operation !== "discover" &&
      (c.previewId !== undefined || c.cloudConsent !== undefined)
    )
      throw new Error("当前操作不接受岗位发现的启动确认");
    const row = c.jobId
      ? this.snapshot().rows.find((r) => r.job.id === c.jobId)
      : undefined;
    if (
      ["apply", "open", "login", "retrySync", "retryTrack"].includes(
        c.operation,
      ) &&
      !row
    )
      throw new Error("请先选择岗位");
    if (c.profileId && c.operation !== "apply")
      throw new Error("仅辅助填写可指定简历版本");
    if (c.operation === "apply" && !row?.permissions.apply)
      throw new Error("当前状态禁止重复填写；请先核查官网结果");
    if (c.operation === "track" && row && !row.permissions.track)
      throw new Error("仅查询已提交或结果未知的未暂停申请");
    const release = acquireLock(this.dir);
    const runtime = new Runtime(this.store, c.operation, c.jobId, () =>
      this.notify(),
    );
    this.runtime = runtime;
    this.done = this.execute(c, runtime)
      .then(async () => {
        await runtime.checkpoint();
        runtime.finish();
      })
      .catch((e) => runtime.finish(e))
      .finally(() => {
        release();
        this.runtime = undefined;
        this.notify();
      });
    return runtime.record;
  }
  private async execute(c: Extract<Command, { method: "start" }>, r: Runtime) {
    const config = readConfig(this.dir),
      sites = loadSites(config, this.dir),
      checkpoint = () => r.checkpoint();
    if (c.operation === "discover") {
      await this.discovery.run(c.previewId!, c.cloudConsent === true, r);
      return;
    }
    if (c.operation === "apply") {
      await applyJob(
        c.jobId!,
        this.store,
        config,
        this.dir,
        this.vault,
        r,
        c.profileId,
      );
      return;
    }
    if (["open", "login"].includes(c.operation)) {
      const job = this.store.job(c.jobId!),
        site = findSite(sites, job.url);
      if (c.operation === "login" && !site?.login)
        throw new Error("待配置：此站点没有登录验证规则");
      const context = await openChrome(this.dir);
      try {
        const page = await context.newPage();
        r.browser(page);
        await navigate(
          page,
          c.operation === "login" ? site!.login!.url : job.url,
        );
        if (c.operation === "login") {
          const a = this.store.ensureApplication(job.id);
          for (;;) {
            a.authStatus = await verifyAtApplications(page, site!);
            a.nextAction =
              a.authStatus === "VALID"
                ? "已验证官网登录，可查询或辅助填写"
                : "完成官网登录后重新检查";
            this.store.save(a, "LOGIN_CHECK");
            if (a.authStatus === "VALID") break;
            await r.request({
              kind: "login",
              site: site!.login!.url,
              message:
                "请在专用 Chrome 完成该网站登录，再重新检查。飞书授权不在这里处理。",
            });
            await checkpoint();
          }
        } else
          await r.request({
            kind: "confirm",
            site: job.url,
            message:
              "已打开专用 Chrome，确认结束查看后关闭本次浏览器会话。此操作不会填写或提交。",
          });
      } finally {
        r.browser(undefined);
        await context.close();
      }
      return;
    }
    if (c.operation === "doctor") {
      r.step("检查 Chrome、Keychain、飞书授权和 launchd");
      await doctor(this.store, config, this.dir, this.vault);
      return;
    }
    if (c.operation === "modelCheck") {
      r.step("向配置模型发送不含个人资料的连通性测试（可能计费）");
      const v = await checkModel(this.store, config, this.vault);
      if (v.status !== "VALID") throw new Error("模型未验证");
      return;
    }
    if (c.operation === "feishuViews") {
      if (!config.feishu.baseToken || !config.feishu.tableId)
        throw new Error("请先保存实际目标 Base token 和 Table ID");
      await r.request({
        kind: "confirm",
        message: `将配置已保存目标表 ${config.feishu.baseToken} / ${config.feishu.tableId} 的 Grid、投递状态看板、投递清单。新增缺少的视图；重设同名视图的可见列、看板分组和清单排序。记录和字段保持原样；旧版字段需先按文档手动调整或新建模板表。请确认目标及影响后继续。`,
      });
      const localCLI = await resolveFeishuCLI(this.store, config, this.dir);
      if (localCLI.status !== "AVAILABLE") throw new Error(localCLI.message);
      await configureTemplateViews(
        this.store,
        new FeishuCLI(config.feishu),
        checkpoint,
        (message) => r.step(message),
      );
      r.step(
        "三个模板视图已配置，并已从飞书回读验证。整行条件填色仍需在飞书中设置。 ",
      );
      return;
    }
    if (c.operation === "feishuAuth" || c.operation === "feishuComplete") {
      const localCLI = await resolveFeishuCLI(this.store, config, this.dir);
      if (localCLI.status !== "AVAILABLE") throw new Error(localCLI.message);
      const cli = new FeishuCLI(config.feishu);
      if (c.operation === "feishuAuth") {
        r.step("通过飞书官方 CLI 请求授权链接");
        const out = await cli.raw([
          "auth",
          "login",
          "--domain",
          "base",
          "--no-wait",
          "--json",
        ]);
        if (out.code !== 0)
          throw new Error("飞书 CLI 授权初始化失败，检查官方 CLI 配置");
        const p = JSON.parse(out.stdout),
          d = p.data ?? p;
        const url =
          d.verification_uri_complete ??
          d.verification_url ??
          d.verification_uri;
        const u = safeUrl(url);
        if (
          u.protocol !== "https:" ||
          !/(^|\.)(feishu\.cn|larksuite\.com)$/.test(u.hostname) ||
          typeof d.device_code !== "string"
        )
          throw new Error("CLI 授权响应不受支持，请查阅官方授权流程");
        this.auth = {
          deviceCode: d.device_code,
          url,
          expiresAt:
            Date.now() + Math.min(Number(d.expires_in) || 600, 1800) * 1000,
        };
        r.step("授权链接已准备；请打开飞书授权页，再点击完成授权");
      } else {
        if (this.auth && this.auth.expiresAt > Date.now()) {
          r.step("等待飞书官方 CLI 确认授权（最多30秒，可稍后重试）");
          const result = await cli.raw([
            "auth",
            "login",
            "--device-code",
            this.auth.deviceCode,
            "--json",
          ]);
          if (result.code !== 0)
            throw new Error("授权尚未完成，请在浏览器完成后再次检查");
        }
        r.step("正在验证飞书 CLI 已保存的登录");
        const verified = await checkFeishuAuth(this.store, config);
        this.checkedAuthCLI = config.feishu.cli;
        if (verified.status !== "VALID") throw new Error(verified.message);
        this.auth = undefined;
        r.step("飞书已授权，验证通过；退出客户端后可继续使用已有登录");
      }
      return;
    }
    if (c.operation === "retrySync")
      retrySync(this.store, this.store.app(c.jobId!).id);
    if (c.operation === "retryTrack") {
      const a = this.store.app(c.jobId!),
        job = this.store.job(a.jobId),
        site = findSite(sites, job.url);
      if (!site) throw new Error("NEEDS_ADAPTER");
      this.store.task(`track:${site.id}:${site.tenant}:${job.account}`, {
        status: "PENDING",
        failures: 0,
        nextAt: 0,
      });
      a.queryStatus = "NEVER";
      a.queryRetries = 0;
      this.store.save(a, "MANUAL_TRACK_RETRY");
    }
    if (["track", "retryTrack"].includes(c.operation)) {
      r.step("只读查询官网申请进度");
      await track(
        this.store,
        config,
        sites,
        this.dir,
        undefined,
        checkpoint,
        c.jobId ? [c.jobId] : undefined,
      );
      const attempted = this.store
        .applications()
        .filter(
          (a) =>
            (!c.jobId || a.jobId === c.jobId) &&
            !a.paused &&
            ["SUBMITTED", "UNKNOWN_RESULT"].includes(a.state),
        );
      if (attempted.some((a) => a.queryStatus !== "OK"))
        throw new Error(
          "查询未全部完成，请查看各申请的登录状态、查询错误和重试次数",
        );
    } else {
      r.step("对账并同步飞书；远端未确认前保留本地故障");
      await sync(
        this.store,
        config,
        this.dir,
        undefined,
        undefined,
        checkpoint,
      );
      const failed = this.store
        .applications()
        .filter((a) => a.syncStatus !== "OK");
      r.emit("SYNC_RESULT");
      if (failed.length) {
        r.step("飞书同步未全部成功，查看各申请的同步状态；远端可能尚未更新");
        throw new Error("SYNC_INCOMPLETE");
      }
    }
  }
  authUrl() {
    if (!this.auth || this.auth.expiresAt < Date.now())
      throw new Error("没有有效的授权请求");
    return this.auth.url;
  }
  diagnostics() {
    return {
      at: now(),
      version: "0.2.0",
      counts: {
        jobs: this.store.jobs().length,
        applications: this.store.applications().length,
      },
      statuses: this.store.applications().map((a) => ({
        state: a.state,
        auth: a.authStatus,
        query: a.queryStatus,
        sync: a.syncStatus,
        attention: attention(a),
        queryRetries: a.queryRetries,
        syncRetries: a.syncRetries,
      })),
      run: this.runtime
        ? {
            operation: this.runtime.record.operation,
            state: this.runtime.record.state,
          }
        : null,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    };
  }
  async stop() {
    this.runtime?.control("cancel");
    await this.done;
    while (this.writing)
      await new Promise((resolve) => setTimeout(resolve, 50));
  }
  close() {
    this.store.close();
  }
}
