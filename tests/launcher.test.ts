import { afterEach, describe, expect, test } from "vitest";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const source = readFileSync(
  new URL("../scripts/start-desktop.sh", import.meta.url),
  "utf8",
);
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

function file(path: string, content: string, executable = false) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (executable) chmodSync(path, 0o755);
}

// Temporary packages and external-command substitutes keep these launcher tests
// away from Launch Services, network installs and the user's actual application.
function fixture(packaged = true) {
  const temp = mkdtempSync(join(tmpdir(), "jobagent-launcher-test-"));
  homes.push(temp);
  const root = join(temp, "项目 with spaces");
  const app = join(
    root,
    `release/JobAgent-darwin-${process.arch}/JobAgent.app`,
  );
  const files = [
    "Contents/MacOS/JobAgent",
    "Contents/Info.plist",
    "Contents/Resources/app/dist/desktop/main.js",
    "Contents/Resources/app/dist/desktop/worker.js",
    "Contents/Resources/app/dist/src/cli.js",
    "Contents/Resources/app/desktop-build/index.html",
    "Contents/Resources/app/desktop-build/preload.cjs",
    "Contents/Resources/app/desktop-build/renderer.js",
    "Contents/Resources/app/desktop-build/style.css",
    "Contents/Resources/.desktop-runtime/node",
    "Contents/Resources/.desktop-runtime/keychain-helper",
  ];
  if (packaged)
    for (const name of files) file(join(app, name), "test only", true);
  // Hide host-wide installations as well as changing HOME; otherwise a real
  // Homebrew npm could run instead of the fixture's isolated nvm installation.
  let script = source
    .replaceAll("/opt/homebrew", "/nonexistent-jobagent-test/homebrew")
    .replaceAll("/usr/local", "/nonexistent-jobagent-test/local");
  for (const command of ["open", "pgrep", "xcode-select"])
    script = script.replaceAll(
      `/usr/bin/${command}`,
      `"$root/test-bin/${command}"`,
    );
  file(join(root, "scripts/start-desktop.sh"), script, true);
  copyFileSync(
    new URL("../启动客户端.command", import.meta.url),
    join(root, "启动客户端.command"),
  );
  file(
    join(root, "test-bin/open"),
    '#!/bin/bash\nprintf "open:%s\\n" "$1" >> "$LAUNCH_TEST_LOG"\nexit "${LAUNCH_TEST_OPEN_EXIT:-0}"\n',
    true,
  );
  file(
    join(root, "test-bin/pgrep"),
    '#!/bin/bash\nexit "${LAUNCH_TEST_RUNNING:-1}"\n',
    true,
  );
  file(join(root, "test-bin/xcode-select"), "#!/bin/bash\nexit 0\n", true);
  // Test Finder's restricted PATH with a real Node binary in an nvm-style path.
  const nodeDir = join(temp, ".nvm/versions/node/v24-test/bin");
  mkdirSync(nodeDir, { recursive: true });
  symlinkSync(process.execPath, join(nodeDir, "node"));
  file(
    join(nodeDir, "npm"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.LAUNCH_TEST_LOG, 'npm:' + args.join(' ') + '\\n');
if (fs.realpathSync(process.cwd()) !== fs.realpathSync(process.env.LAUNCH_TEST_ROOT)) process.exit(9);
if (process.env.LAUNCH_TEST_FAIL_AT === args[0]) process.exit(7);
if (args[0] === 'run') {
  const names = ${JSON.stringify(files)};
  for (const name of names) {
    if (process.env.LAUNCH_TEST_FAIL_AT === 'incomplete' && name.endsWith('renderer.js')) continue;
    const target = path.join(process.env.LAUNCH_TEST_APP, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'test only', { mode: 0o755 });
  }
}
`,
    true,
  );
  const logPath = join(temp, "calls.txt");
  writeFileSync(logPath, "");
  return {
    root,
    app,
    calls: () =>
      readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean),
    run: (
      args: string[] = [],
      env: Record<string, string> = {},
      wrapper = false,
    ) =>
      spawnSync(
        "/bin/bash",
        [
          join(
            root,
            wrapper ? "启动客户端.command" : "scripts/start-desktop.sh",
          ),
          ...args,
        ],
        {
          cwd: "/",
          encoding: "utf8",
          env: {
            HOME: temp,
            PATH: "/usr/bin:/bin",
            TMPDIR: temp,
            LAUNCH_TEST_LOG: logPath,
            LAUNCH_TEST_ROOT: root,
            LAUNCH_TEST_APP: app,
            ...env,
          },
          timeout: 15000,
        },
      ),
  };
}

describe.skipIf(process.platform !== "darwin")("macOS launcher", () => {
  test("opens an existing package once from a path with spaces without npm", () => {
    const f = fixture();
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(f.calls()).toEqual([`open:${f.app}`]);
    expect(result.stdout).toContain("已向 macOS 发出打开请求");
  });

  test("double-click wrapper supports read-only checks from another cwd", () => {
    const f = fixture();
    const result = f.run(["--check"], {}, true);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(f.app);
    expect(f.calls()).toEqual([]);
  });

  test("discovers nvm Node in Finder PATH and prepares a missing package", () => {
    const f = fixture(false);
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    const calls = f.calls();
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatch(/^npm:ci --cache /);
    expect(calls[1]).toBe("npm:run desktop:package");
    expect(calls[2]).toBe(`open:${f.app}`);
  });

  test.each(["ci", "run", "incomplete"])(
    "does not open after %s fails",
    (failure) => {
      const f = fixture(false);
      const result = f.run([], { LAUNCH_TEST_FAIL_AT: failure });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("启动失败");
      expect(f.calls()[0]).toMatch(/^npm:ci --cache /);
      expect(f.calls()).toHaveLength(failure === "ci" ? 1 : 2);
      expect(f.calls().some((call) => call.startsWith("open:"))).toBe(false);
    },
  );

  test("refuses to rebuild a running client", () => {
    const f = fixture();
    const result = f.run(["--rebuild"], { LAUNCH_TEST_RUNNING: "0" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("⌘Q");
    expect(f.calls()).toEqual([]);
  });

  test("rebuilds an idle existing package only when explicitly requested", () => {
    const f = fixture();
    const result = f.run(["--rebuild"]);
    expect(result.status, result.stderr).toBe(0);
    expect(f.calls()[1]).toBe("npm:run desktop:package");
    expect(f.calls()[2]).toBe(`open:${f.app}`);
  });

  test("reports a Launch Services error without reporting success", () => {
    const f = fixture();
    const result = f.run([], { LAUNCH_TEST_OPEN_EXIT: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("macOS 未能打开应用");
    expect(result.stdout).not.toContain("已向 macOS 发出打开请求");
  });

  test("wrapper preserves failure status and rejects unknown arguments", () => {
    const f = fixture();
    const result = f.run(["--unknown"], {}, true);
    expect(result.status).toBe(1);
    expect(f.calls()).toEqual([]);
  });
});
