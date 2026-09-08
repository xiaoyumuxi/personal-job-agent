import { build } from "esbuild";
import { mkdir, copyFile, chmod, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
await mkdir("desktop-build", { recursive: true });
await mkdir(".desktop-runtime", { recursive: true });
await copyFile(process.execPath, ".desktop-runtime/node");
await chmod(".desktop-runtime/node", 0o755);
execFileSync("/usr/bin/swiftc", [
  "-module-cache-path",
  "/private/tmp/jobagent-desktop-swift-cache",
  "src/keychain.swift",
  "-o",
  ".desktop-runtime/keychain-helper",
]);
execFileSync("/usr/bin/swiftc", [
  "-module-cache-path",
  "/private/tmp/jobagent-desktop-swift-cache",
  "src/pdf-ocr.swift",
  "-o",
  ".desktop-runtime/pdf-ocr-helper",
]);
await build({
  entryPoints: ["desktop/preload.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
  outfile: "desktop-build/preload.cjs",
});
await build({
  entryPoints: ["desktop/renderer/main.tsx"],
  bundle: true,
  platform: "browser",
  format: "iife",
  outfile: "desktop-build/renderer.js",
  define: { "process.env.NODE_ENV": '"production"' },
  minify: true,
});
await copyFile("desktop/renderer/style.css", "desktop-build/style.css");
await writeFile(
  "desktop-build/index.html",
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\'; img-src \'self\' data:; font-src \'self\'; connect-src \'none\'; base-uri \'none\'; form-action \'none\'"><title>个人网申助手</title><link rel="stylesheet" href="./style.css"></head><body><div id="root"></div><script src="./renderer.js"></script></body></html>',
);
