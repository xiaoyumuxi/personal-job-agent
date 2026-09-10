import { z } from "zod";
import type { Config } from "../config.js";
import { AgentError } from "../errors.js";
import { runFile, type ProcessResult } from "../process.js";
import {
  tableFields,
  legacyTableFields,
  manualFieldNames,
  type TemplateVersion,
} from "./schema.js";
export type Runner = (file: string, args: string[]) => Promise<ProcessResult>;
export interface RemoteRow {
  id: string;
  fields: Record<string, unknown>;
}
export interface FeishuTransport {
  destination: string;
  templateVersion?: TemplateVersion;
  check(): Promise<void>;
  find(appId: string): Promise<RemoteRow[]>;
  create(fields: Record<string, unknown>): Promise<string>;
  update(recordId: string, fields: Record<string, unknown>): Promise<void>;
}
export const runFeishuCLI = (file: string, args: string[], timeout = 30_000) =>
  runFile(file, args, {
    timeout,
    env: {
      ...process.env,
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
    },
  });
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
export function parseEnvelope(r: ProcessResult): Record<string, unknown> {
  if (r.timedOut) throw new AgentError("TRANSIENT", "FEISHU_TIMEOUT", true);
  let payload: Record<string, unknown> = {};
  for (const source of r.code === 0
    ? [r.stdout, r.stderr]
    : [r.stderr, r.stdout]) {
    try {
      payload = obj(JSON.parse(source));
      if (Object.keys(payload).length) break;
    } catch {}
  }
  if (r.code !== 0 || payload.ok !== true) {
    const e = obj(payload.error);
    const kind = String(e.type ?? "");
    const code = String(e.code ?? "");
    if (
      ["authentication", "authorization", "auth"].includes(kind) ||
      [
        "99991661",
        "99991663",
        "99991668",
        "99991671",
        "99991672",
        "99991679",
      ].includes(code)
    )
      throw new AgentError("AUTH_REQUIRED", "FEISHU_AUTH_REQUIRED");
    if (
      ["network", "timeout", "rate_limit"].includes(kind) ||
      ["429", "500", "502", "503", "504", "1254290", "1254291"].includes(code)
    )
      throw new AgentError("TRANSIENT", "FEISHU_TEMPORARY_ERROR", true);
    if (kind === "confirmation")
      throw new AgentError("PERMANENT", "FEISHU_CONFIRMATION_REQUIRED");
    if (!payload.ok && !payload.error)
      throw new AgentError("UNKNOWN", "FEISHU_INVALID_OUTPUT", true);
    throw new AgentError(
      "PERMANENT",
      code === "91403" ? "FEISHU_RESOURCE_FORBIDDEN" : "FEISHU_BUSINESS_ERROR",
    );
  }
  if (payload.identity && payload.identity !== "user")
    throw new AgentError("PERMANENT", "FEISHU_UNEXPECTED_IDENTITY");
  const data = obj(payload.data);
  if (data.code !== undefined && data.code !== 0)
    throw new AgentError("PERMANENT", "FEISHU_NESTED_BUSINESS_ERROR");
  if (
    (Array.isArray(data.ignored_fields) && data.ignored_fields.length) ||
    (Array.isArray(obj(data.record).ignored_fields) &&
      (obj(data.record).ignored_fields as unknown[]).length)
  )
    throw new AgentError("PERMANENT", "FEISHU_IGNORED_FIELDS");
  return data;
}
export function parseRows(data: Record<string, unknown>): RemoteRow[] {
  // v1 Base shortcuts use column metadata + row matrix. Fail closed on unknown output.
  if (Array.isArray(data.data) && Array.isArray(data.record_id_list)) {
    const columns = data.fields ?? data.field_id_list;
    if (!Array.isArray(columns)) {
      if (data.data.length === 0) return [];
      throw new AgentError("PERMANENT", "FEISHU_COLUMNS_MISSING");
    }
    if (data.data.length !== data.record_id_list.length)
      throw new AgentError("PERMANENT", "FEISHU_ROW_COUNT_MISMATCH");
    const names = columns.map((c) =>
      typeof c === "string"
        ? c
        : String(obj(c).name ?? obj(c).field_name ?? obj(c).id ?? ""),
    );
    return data.data.map((row, i) => {
      if (!Array.isArray(row) || row.length !== names.length)
        throw new AgentError("PERMANENT", "FEISHU_ROW_SHAPE_CHANGED");
      return {
        id: String((data.record_id_list as unknown[])[i]),
        fields: Object.fromEntries(names.map((n, j) => [n, row[j]])),
      };
    });
  }
  if (Array.isArray(data.records) || Array.isArray(data.items))
    return ((data.records ?? data.items) as unknown[]).map((r) => {
      const v = obj(r);
      const id = v.record_id ?? v.id;
      if (typeof id !== "string" || !v.fields)
        throw new AgentError("PERMANENT", "FEISHU_RECORD_SHAPE_CHANGED");
      return { id, fields: obj(v.fields) };
    });
  throw new AgentError("PERMANENT", "FEISHU_RECORD_SHAPE_CHANGED");
}
export class FeishuCLI implements FeishuTransport {
  destination: string;
  templateVersion?: TemplateVersion;
  private fieldNames = new Map<string, string>();
  constructor(
    public config: Config["feishu"],
    private runner: Runner = runFeishuCLI,
  ) {
    this.destination = config.baseToken + ":" + config.tableId;
  }
  async raw(args: string[]) {
    try {
      return await this.runner(this.config.cli, args);
    } catch {
      throw new AgentError("PERMANENT", "FEISHU_CLI_UNAVAILABLE");
    }
  }
  async command(cmd: string, args: string[] = []) {
    return parseEnvelope(
      await this.raw([
        "base",
        cmd,
        ...args,
        "--as",
        "user",
        "--format",
        "json",
      ]),
    );
  }
  target() {
    return [
      "--base-token",
      this.config.baseToken,
      "--table-id",
      this.config.tableId,
    ];
  }
  fieldName(id: string) {
    return this.fieldNames.get(id) ?? id;
  }
  async auth() {
    const r = await this.raw(["auth", "status", "--json", "--verify"]);
    if (r.timedOut)
      throw new AgentError("TRANSIENT", "FEISHU_AUTH_CHECK_TIMEOUT");
    let p: Record<string, unknown>;
    try {
      p = obj(JSON.parse(r.stdout));
    } catch {
      // CLI/network failures do not prove that saved credentials are missing.
      parseEnvelope(r);
      throw new AgentError("UNKNOWN", "FEISHU_AUTH_INVALID_OUTPUT");
    }
    if (p.error || (r.code !== 0 && !p.identities)) parseEnvelope(r);
    const user = obj(obj(p.identities).user);
    if (typeof user.available !== "boolean")
      throw new AgentError("UNKNOWN", "FEISHU_AUTH_CHECK_FAILED");
    if (
      user.available !== true ||
      user.status !== "ready" ||
      p.verified === false ||
      user.verified === false
    )
      throw new AgentError("AUTH_REQUIRED", "FEISHU_AUTH_REQUIRED");
    if (r.code !== 0)
      throw new AgentError("UNKNOWN", "FEISHU_AUTH_CHECK_FAILED");
  }
  async check() {
    this.templateVersion = undefined;
    this.fieldNames.clear();
    const version = await this.raw(["--version"]);
    if (version.code !== 0 || !version.stdout.includes("lark-cli version"))
      throw new AgentError("PERMANENT", "FEISHU_CLI_UNSUPPORTED");
    for (const [cmd, flags] of [
      ["+record-list", ["--filter-json", "--offset", "--field-id"]],
      ["+record-upsert", ["--record-id", "--json"]],
      ["+field-list", ["--offset"]],
    ] as const) {
      const r = await this.raw(["base", cmd, "--help"]);
      if (r.code !== 0 || flags.some((f) => !r.stdout.includes(f)))
        throw new AgentError("PERMANENT", "FEISHU_CLI_CONTRACT_CHANGED");
    }
    await this.auth();
    const data = await this.command("+field-list", [
      ...this.target(),
      "--offset",
      "0",
      "--limit",
      "200",
    ]);
    const items = data.fields;
    if (!Array.isArray(items))
      throw new AgentError("PERMANENT", "FEISHU_FIELD_SHAPE_CHANGED");
    if (
      data.has_more === true ||
      (typeof data.total === "number" && data.total > items.length)
    )
      throw new AgentError("PERMANENT", "FEISHU_FIELD_PAGINATION_PARTIAL");
    const fields = items.map(obj);
    for (const f of fields) {
      if (
        typeof f.name === "string" &&
        typeof (f.id ?? f.field_id) === "string"
      )
        this.fieldNames.set(String(f.id ?? f.field_id), f.name);
    }
    const definitions = [tableFields, legacyTableFields].find((schema) =>
      schema.every((expected) =>
        fields.some(
          (actual) =>
            actual.name === expected.name && actual.type === expected.type,
        ),
      ),
    );
    if (!definitions)
      throw new AgentError("PERMANENT", "FEISHU_SCHEMA_MISMATCH");
    for (const expected of definitions) {
      const actual = fields.find((f) => f.name === expected.name);
      if (!actual || actual.type !== expected.type)
        throw new AgentError("PERMANENT", "FEISHU_SCHEMA_MISMATCH");
      if (expected.type === "select") {
        if (actual.multiple === true)
          throw new AgentError("PERMANENT", "FEISHU_SCHEMA_MISMATCH");
        const options = Array.isArray(actual.options)
          ? actual.options.map((o) => obj(o).name)
          : [];
        if (expected.options?.some((o) => !options.includes(o.name)))
          throw new AgentError(
            "PERMANENT",
            expected.name === "attention_status"
              ? "FEISHU_ATTENTION_OPTIONS_MISSING"
              : "FEISHU_TEMPLATE_OPTIONS_MISSING",
          );
      }
    }
    this.templateVersion = definitions === tableFields ? 2 : 1;
  }
  async find(appId: string) {
    const rows: RemoteRow[] = [];
    const seen = new Set<string>();
    for (let offset = 0; offset < 10_000; offset += 200) {
      const d = await this.command("+record-list", [
        ...this.target(),
        "--filter-json",
        JSON.stringify({
          logic: "and",
          conditions: [["本地申请 ID", "==", appId]],
        }),
        "--field-id",
        "本地申请 ID",
        ...manualFieldNames(this.templateVersion ?? 2).flatMap((f) => [
          "--field-id",
          f,
        ]),
        "--offset",
        String(offset),
        "--limit",
        "200",
      ]);
      const batch = parseRows(d).map((r) => ({
        id: r.id,
        fields: Object.fromEntries(
          Object.entries(r.fields).map(([k, v]) => [
            this.fieldNames.get(k) ?? k,
            v,
          ]),
        ),
      }));
      for (const r of batch) {
        if (seen.has(r.id))
          throw new AgentError("PERMANENT", "FEISHU_PAGINATION_REPEATED");
        seen.add(r.id);
        if (r.fields["本地申请 ID"] !== appId)
          throw new AgentError("PERMANENT", "FEISHU_KEY_MISMATCH");
        rows.push(r);
      }
      if (batch.length < 200 && d.has_more !== true) return rows;
    }
    throw new AgentError("PERMANENT", "FEISHU_PAGINATION_PARTIAL");
  }
  async create(fields: Record<string, unknown>) {
    const d = await this.command("+record-upsert", [
      ...this.target(),
      "--json",
      JSON.stringify(fields),
    ]);
    const record = obj(d.record);
    const id = record.id ?? record.record_id;
    if (typeof id !== "string" || !id)
      throw new AgentError("UNKNOWN", "FEISHU_CREATE_RESULT_UNKNOWN", true);
    return id;
  }
  async update(recordId: string, fields: Record<string, unknown>) {
    const d = await this.command("+record-upsert", [
      ...this.target(),
      "--record-id",
      recordId,
      "--json",
      JSON.stringify(fields),
    ]);
    if (d.updated !== true && !d.record)
      throw new AgentError("UNKNOWN", "FEISHU_UPDATE_RESULT_UNKNOWN", true);
  }
  async createBase() {
    const help = await this.raw(["base", "+base-create", "--help"]);
    if (!help.stdout.includes("--fields"))
      throw new AgentError("PERMANENT", "FEISHU_CLI_CONTRACT_CHANGED");
    await this.auth();
    return this.command("+base-create", [
      "--name",
      "个人网申助手",
      "--table-name",
      "投递主表",
      "--fields",
      JSON.stringify(tableFields),
      "--time-zone",
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    ]);
  }
}
