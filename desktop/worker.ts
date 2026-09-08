import { watch } from "node:fs";
import { DesktopService } from "./service.js";
process.umask(0o077);
const port = process.parentPort!;
const service = new DesktopService(
  () => port.postMessage({ type: "changed" }),
  process.env.JOBAGENT_HOME,
  undefined,
  process.env.JOBAGENT_NODE,
);
let timer: NodeJS.Timeout | undefined;
const watcher = watch(service.dir, (_event, file) => {
  if (file && /state\.sqlite|config\.json|runner\.lock/.test(file)) {
    clearTimeout(timer);
    timer = setTimeout(() => port.postMessage({ type: "changed" }), 120);
  }
});
port.on("message", async ({ data }) => {
  const { id, method, value } = data;
  try {
    let result: unknown;
    if (method === "command") result = await service.handle(value);
    else if (method === "import")
      result = await service.importFile(value.kind, value.file);
    else if (method === "diagnostics") result = service.diagnostics();
    else if (method === "authUrl") result = service.authUrl();
    else if (method === "shutdown") {
      await service.stop();
      watcher.close();
      clearTimeout(timer);
      service.close();
    } else throw new Error("未知请求");
    port.postMessage({ id, ok: true, result });
  } catch (e) {
    const error = e as { name?: string; message?: string };
    port.postMessage({
      id,
      ok: false,
      error:
        error.name === "ZodError"
          ? "参数格式不正确，请检查输入"
          : (error.message || "操作失败").slice(0, 500),
    });
  }
});
port.postMessage({ type: "ready" });
