import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.platform !== "darwin")
  throw new Error("DMG creation requires macOS");

const app = resolve(`release/JobAgent-darwin-${process.arch}/JobAgent.app`);
await access(join(app, "Contents/MacOS/JobAgent"));
const output = resolve("release/artifacts");
await mkdir(output, { recursive: true });
const name = `JobAgent-macOS-${process.arch}.dmg`;
const dmg = join(output, name);
const staging = await mkdtemp(join(tmpdir(), "jobagent-dmg-"));

try {
  // ditto preserves bundle metadata, executable permissions and framework links.
  execFileSync("/usr/bin/ditto", [app, join(staging, "JobAgent.app")], {
    stdio: "inherit",
  });
  await symlink("/Applications", join(staging, "Applications"));
  execFileSync(
    "/usr/bin/hdiutil",
    [
      "create",
      "-volname",
      "JobAgent",
      "-srcfolder",
      staging,
      "-fs",
      "HFS+",
      "-format",
      "UDZO",
      "-ov",
      dmg,
    ],
    { stdio: "inherit" },
  );
  execFileSync("/usr/bin/hdiutil", ["verify", dmg], { stdio: "inherit" });
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(dmg)) hash.update(chunk);
  await writeFile(`${dmg}.sha256`, `${hash.digest("hex")}  ${name}\n`);
  console.log(dmg);
} finally {
  await rm(staging, { recursive: true, force: true });
}
