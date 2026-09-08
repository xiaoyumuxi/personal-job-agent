import type { Config } from "../config.js";
import type { Application, Outbox } from "../types.js";
import { Store } from "../db.js";
import { AgentError, classify, failureState, delay } from "../errors.js";
import { alert, clearAlert, writeReport } from "../notify.js";
import { autoFields, readControls } from "./schema.js";
import { FeishuCLI, type FeishuTransport } from "./cli.js";
export async function sync(
  store: Store,
  config: Config,
  dir: string,
  remote: FeishuTransport = new FeishuCLI(config.feishu),
  wait = delay,
) {
  const pending = store
    .pending()
    .filter(
      (o) =>
        !["STOPPED", "RETRY_EXHAUSTED"].includes(o.status) &&
        o.nextAt <= Date.now(),
    );
  if (!pending.length) return;
  if (
    !config.feishu.enabled ||
    !config.feishu.baseToken ||
    !config.feishu.tableId
  ) {
    for (const o of pending) {
      const a = store.app(o.appId);
      a.syncStatus = "NOT_CONFIGURED";
      a.syncError = "FEISHU_NOT_CONFIGURED";
      store.save(a, "SYNC_NOT_CONFIGURED", {}, false);
    }
    await alert(
      store,
      dir,
      "feishu",
      "FEISHU_NOT_CONFIGURED",
      config.notifications,
    );
    return;
  }
  let checked = false;
  for (const o of pending) {
    for (;;) {
      const a = store.app(o.appId);
      try {
        if (!checked) {
          await remote.check();
          checked = true;
        }
        const rows = await remote.find(a.id);
        if (rows.length > 1)
          throw new AgentError("PERMANENT", "FEISHU_DUPLICATE_LOCAL_ID");
        const row = rows[0];
        let recordId = row?.id;
        if (row) {
          readControls(a, row.fields);
          store.map(a.id, remote.destination, row.id);
        }
        const mapped = store.mapping(a.id, remote.destination);
        if (!row && mapped)
          throw new AgentError("PERMANENT", "FEISHU_MAPPED_ROW_MISSING");
        if (!row && o.uncertain)
          throw new AgentError(
            "UNKNOWN",
            "FEISHU_CREATE_UNCERTAIN_RECONCILE_REQUIRED",
            true,
          );
        const payload = autoFields(a, store.job(a.jobId));
        if (!recordId) {
          // Persist intent before issuing a create; crash/timeout never causes blind recreation.
          o.uncertain = true;
          store.setOutbox(o);
          recordId = await remote.create(payload);
          store.map(a.id, remote.destination, recordId);
        } else await remote.update(recordId, payload);
        a.syncStatus = "OK";
        a.syncError = "";
        a.syncRetries = 0;
        store.save(a, "SYNC_OK", { recordId }, false);
        Object.assign(o, {
          status: "DONE",
          failures: 0,
          uncertain: false,
          nextAt: 0,
          error: "",
          revision: a.revision,
        });
        store.setOutbox(o);
        clearAlert(store, "sync:" + a.id);
        clearAlert(store, "feishu");
        break;
      } catch (error) {
        const e = classify(error);
        const f = failureState(e, o.failures, config.maxRetries);
        Object.assign(o, {
          status: f.status,
          failures: f.failures,
          error: e.code,
          nextAt:
            f.status === "RETRY_PENDING"
              ? Date.now() + 1000 * 2 ** Math.max(0, f.failures - 1)
              : 0,
        });
        store.setOutbox(o);
        a.syncStatus = f.status as Application["syncStatus"];
        a.syncRetries = f.retries;
        a.syncError = e.code;
        store.save(
          a,
          "SYNC_FAILED",
          { code: e.code, uncertain: o.uncertain },
          false,
        );
        await alert(
          store,
          dir,
          e.kind === "AUTH_REQUIRED" ? "feishu" : "sync:" + a.id,
          f.status,
          config.notifications,
        );
        if (e.kind === "AUTH_REQUIRED") {
          for (const rest of pending.filter((x) => x.appId !== a.id)) {
            const other = store.app(rest.appId);
            other.syncStatus = "AUTH_REQUIRED";
            other.syncError = e.code;
            store.save(other, "SYNC_AUTH_REQUIRED", {}, false);
            rest.status = "AUTH_REQUIRED";
            store.setOutbox(rest);
          }
          writeReport(store, dir);
          return;
        }
        if (f.status !== "RETRY_PENDING") break;
        await wait(Math.max(0, o.nextAt - Date.now()));
      }
    }
  }
  writeReport(store, dir);
}
export async function pullControls(
  store: Store,
  config: Config,
  remote: FeishuTransport = new FeishuCLI(config.feishu),
) {
  if (!config.feishu.enabled) return;
  await remote.check();
  for (const a of store.applications()) {
    const rows = await remote.find(a.id);
    if (rows.length > 1)
      throw new AgentError("PERMANENT", "FEISHU_DUPLICATE_LOCAL_ID");
    if (rows[0]) {
      readControls(a, rows[0].fields);
      store.save(a, "CONTROLS_READ");
    }
  }
}
export function retrySync(store: Store, id: string, allowCreate = false) {
  const a = store.app(id);
  const o = store.pending().find((o) => o.appId === a.id);
  if (!o) return;
  o.status = "PENDING";
  o.failures = 0;
  o.nextAt = 0;
  o.error = "";
  if (allowCreate) o.uncertain = false;
  store.setOutbox(o);
  a.syncStatus = "NEVER";
  a.syncRetries = 0;
  a.syncError = "";
  store.save(a, "MANUAL_RETRY", { allowCreate });
}
