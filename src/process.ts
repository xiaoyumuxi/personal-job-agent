import { spawn } from "node:child_process";
export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
export function runFile(
  file: string,
  args: string[],
  options: {
    input?: string;
    timeout?: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    maxBytes?: number;
  } = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: options.cwd,
      env: options.env ?? process.env,
    });
    let stdout = "",
      stderr = "",
      timedOut = false,
      overflow = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeout ?? 30_000);
    const capture = (chunk: Buffer, which: "stdout" | "stderr") => {
      if (
        stdout.length + stderr.length + chunk.length >
        (options.maxBytes ?? 4_000_000)
      ) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      if (which === "stdout") stdout += chunk.toString();
      else stderr += chunk.toString();
    };
    child.stdout.on("data", (c) => capture(c, "stdout"));
    child.stderr.on("data", (c) => capture(c, "stderr"));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: overflow ? 90 : (code ?? 1), stdout, stderr, timedOut });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
  });
}
