import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
export async function ask(message: string, secret = false): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("此步骤需要交互终端中的本人确认");
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try {
    const answer = rl.question(message + " ");
    muted = secret;
    const value = await answer;
    if (secret) process.stdout.write("\n");
    return value.trim();
  } finally {
    rl.close();
  }
}
export async function yes(message: string) {
  return (await ask(message + " [输入 yes 继续]")).toLowerCase() === "yes";
}
export async function pasted() {
  console.log("粘贴内容，单独输入 .end 结束：");
  const lines: string[] = [];
  for (;;) {
    const s = await ask("");
    if (s === ".end") return lines.join("\n");
    lines.push(s);
  }
}
