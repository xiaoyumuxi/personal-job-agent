import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import { privateDir } from "./config.js";
import type { Application, Job, Outbox } from "./types.js";
function jobDedup(input: Omit<Job, "id">) {
  return input.tenant && input.company && input.batch && input.jobCode
    ? createHash("sha256")
        .update(
          JSON.stringify([
            input.tenant,
            input.account,
            input.company,
            input.batch,
            input.jobCode,
          ]),
        )
        .digest("hex")
    : null;
}
export const now = () => new Date().toISOString();
export class Store {
  db: DatabaseSync;
  constructor(dir: string) {
    privateDir(dir);
    const file = join(dir, "state.sqlite");
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,dedup TEXT UNIQUE,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS applications(id TEXT PRIMARY KEY,job_id TEXT UNIQUE REFERENCES jobs(id),data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,app_id TEXT,at TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS observations(id INTEGER PRIMARY KEY,app_id TEXT NOT NULL,at TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS outbox(app_id TEXT PRIMARY KEY REFERENCES applications(id),revision INTEGER NOT NULL,status TEXT NOT NULL,failures INTEGER NOT NULL DEFAULT 0,uncertain INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS sync_map(app_id TEXT PRIMARY KEY REFERENCES applications(id),destination TEXT NOT NULL,record_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mapping_cache(key TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks(key TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS alerts(key TEXT PRIMARY KEY,code TEXT NOT NULL,at TEXT NOT NULL,active INTEGER NOT NULL);
  `);
  }
  close() {
    this.db.close();
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const x = fn();
      this.db.exec("COMMIT");
      return x;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  getMeta<T>(key: string): T | undefined {
    const r = this.db.prepare("SELECT value FROM meta WHERE key=?").get(key);
    return r ? (JSON.parse(String(r.value)) as T) : undefined;
  }
  setMeta(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  event(appId: string | null, kind: string, data: unknown = {}) {
    this.db
      .prepare("INSERT INTO events(app_id,at,kind,data) VALUES(?,?,?,?)")
      .run(appId, now(), kind, JSON.stringify(data));
  }
  jobs(): Job[] {
    return this.db
      .prepare("SELECT data FROM jobs")
      .all()
      .map((r) => JSON.parse(String(r.data)) as Job);
  }
  job(id: string): Job {
    const r = this.db.prepare("SELECT data FROM jobs WHERE id=?").get(id);
    if (!r) throw new Error("岗位 ID 不存在");
    return JSON.parse(String(r.data));
  }
  addJob(input: Omit<Job, "id">) {
    const dedup = jobDedup(input);
    const strong = dedup !== null;
    if (dedup) {
      const r = this.db.prepare("SELECT id FROM jobs WHERE dedup=?").get(dedup);
      if (r) return { id: String(r.id), duplicate: true };
    }
    const job: Job = {
      ...input,
      id: randomUUID(),
      ...(!strong
        ? { dedupWarning: "标识不充分，未自动合并；投递前核查重复申请" }
        : {}),
    };
    this.db
      .prepare("INSERT INTO jobs VALUES(?,?,?)")
      .run(job.id, dedup, JSON.stringify(job));
    return { id: job.id, duplicate: false };
  }
  updateJob(job: Job) {
    this.db
      .prepare("UPDATE jobs SET data=?,dedup=? WHERE id=?")
      .run(JSON.stringify(job), jobDedup(job), job.id);
  }
  applications(): Application[] {
    return this.db
      .prepare("SELECT data FROM applications")
      .all()
      .map((r) => JSON.parse(String(r.data)) as Application);
  }
  app(id: string): Application {
    const r = this.db
      .prepare("SELECT data FROM applications WHERE id=? OR job_id=?")
      .get(id, id);
    if (!r) throw new Error("申请不存在");
    return JSON.parse(String(r.data));
  }
  ensureApplication(jobId: string): Application {
    const r = this.db
      .prepare("SELECT id FROM applications WHERE job_id=?")
      .get(jobId);
    if (r) return this.app(String(r.id));
    const job = this.job(jobId);
    const a: Application = {
      id: randomUUID(),
      jobId,
      state: "DRAFT",
      rawStatus: "",
      stage: "UNKNOWN",
      outcome: "UNKNOWN",
      authStatus: "UNKNOWN",
      queryStatus: "NEVER",
      syncStatus: "NEVER",
      lastAttempt: null,
      lastSuccess: null,
      submittedAt: null,
      evidence: null,
      nextAction: "人工确认目标和披露范围",
      queryError: "",
      syncError: "",
      queryRetries: 0,
      syncRetries: 0,
      priority: "",
      paused: false,
      note: job.note ?? "",
      applicationChannel: job.applicationChannel,
      deadline: "",
      revision: 1,
    };
    this.transaction(() => {
      this.db
        .prepare("INSERT INTO applications VALUES(?,?,?)")
        .run(a.id, jobId, JSON.stringify(a));
      this.queue(a);
      this.event(a.id, "APPLICATION_SELECTED");
    });
    return a;
  }
  save(a: Application, kind: string, detail: unknown = {}, queue = true) {
    this.transaction(() => {
      a.revision++;
      this.db
        .prepare("UPDATE applications SET data=? WHERE id=?")
        .run(JSON.stringify(a), a.id);
      if (queue) this.queue(a);
      this.event(a.id, kind, detail);
    });
  }
  queue(a: Application) {
    this.db
      .prepare(
        `INSERT INTO outbox(app_id,revision,status) VALUES(?,?,'PENDING') ON CONFLICT(app_id) DO UPDATE SET revision=excluded.revision,status=CASE WHEN outbox.status IN ('RETRY_EXHAUSTED','STOPPED') THEN outbox.status ELSE 'PENDING' END`,
      )
      .run(a.id, a.revision);
  }
  pending(): Outbox[] {
    return this.db
      .prepare("SELECT * FROM outbox WHERE status!='DONE'")
      .all()
      .map((r) => ({
        appId: String(r.app_id),
        revision: Number(r.revision),
        status: String(r.status),
        failures: Number(r.failures),
        uncertain: !!r.uncertain,
        nextAt: Number(r.next_at),
        error: String(r.error),
      }));
  }
  setOutbox(o: Outbox) {
    this.db
      .prepare(
        "UPDATE outbox SET revision=?,status=?,failures=?,uncertain=?,next_at=?,error=? WHERE app_id=?",
      )
      .run(
        o.revision,
        o.status,
        o.failures,
        Number(o.uncertain),
        o.nextAt,
        o.error,
        o.appId,
      );
  }
  mapping(appId: string, destination: string) {
    const r = this.db
      .prepare(
        "SELECT record_id FROM sync_map WHERE app_id=? AND destination=?",
      )
      .get(appId, destination);
    return r ? String(r.record_id) : undefined;
  }
  map(appId: string, destination: string, recordId: string) {
    this.db
      .prepare(
        "INSERT INTO sync_map VALUES(?,?,?) ON CONFLICT(app_id) DO UPDATE SET destination=excluded.destination,record_id=excluded.record_id",
      )
      .run(appId, destination, recordId);
  }
  observe(a: Application, data: unknown) {
    this.db
      .prepare("INSERT INTO observations(app_id,at,data) VALUES(?,?,?)")
      .run(a.id, now(), JSON.stringify(data));
  }
  cache(key: string, value?: unknown): unknown {
    if (value !== undefined) {
      this.db
        .prepare(
          "INSERT INTO mapping_cache VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
        )
        .run(key, JSON.stringify(value));
      return value;
    }
    const r = this.db
      .prepare("SELECT data FROM mapping_cache WHERE key=?")
      .get(key);
    return r ? JSON.parse(String(r.data)) : undefined;
  }
  task<T>(key: string, value?: T): T | undefined {
    if (value !== undefined) {
      this.db
        .prepare(
          "INSERT INTO tasks VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
        )
        .run(key, JSON.stringify(value));
      return value;
    }
    const r = this.db.prepare("SELECT data FROM tasks WHERE key=?").get(key);
    return r ? (JSON.parse(String(r.data)) as T) : undefined;
  }
}
export function attention(
  a: Application,
): "RETRY_EXHAUSTED" | "AUTH_REQUIRED" | "NORMAL" {
  if ([a.queryStatus, a.syncStatus].includes("RETRY_EXHAUSTED"))
    return "RETRY_EXHAUSTED";
  if (
    a.authStatus === "AUTH_REQUIRED" ||
    a.queryStatus === "AUTH_REQUIRED" ||
    a.syncStatus === "AUTH_REQUIRED"
  )
    return "AUTH_REQUIRED";
  return "NORMAL";
}
