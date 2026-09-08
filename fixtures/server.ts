import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const file = fileURLToPath(new URL("./form.html", import.meta.url));
const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (req.url === "/frame") {
    res.end(
      '<!doctype html><html><body><section data-section="额外信息"><label>备注<input data-optional="true"></label></section></body></html>',
    );
    return;
  }
  res.end(await readFile(file, "utf8"));
});
server.listen(43117, "127.0.0.1", () =>
  console.log("本地 fixture（非真实招聘网站）：http://127.0.0.1:43117/apply"),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => server.close(() => process.exit()));
