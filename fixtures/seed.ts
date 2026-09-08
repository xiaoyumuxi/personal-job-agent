import { resolve, join } from "node:path";
import { dataDir, readConfig, saveConfig, ROOT } from "../src/config.js";
import { Store } from "../src/db.js";
import { readJobs, jobsFromGrid } from "../src/jobs.js";
import { SiteSchema } from "../src/types.js";
import { readFileSync, writeFileSync } from "node:fs";
const dir = dataDir(resolve(".jobagent-fixture"));
const config = readConfig(dir);
config.siteFiles = [join(ROOT, "sites/fixture.json")];
config.notifications = false;
saveConfig(dir, config);
const store = new Store(dir);
try {
  const site = SiteSchema.parse(
    JSON.parse(readFileSync(config.siteFiles[0]!, "utf8")),
  );
  const grids = await readJobs(join(ROOT, "examples/jobs.csv"));
  for (const g of grids)
    for (const job of jobsFromGrid(g, [site])) {
      const r = store.addJob(job);
      if (job.url)
        console.log(
          `测试岗位 ID：${r.id}\n填写命令：npm run dev -- --home .jobagent-fixture --session apply ${r.id} --profile examples/fixture-profile.json`,
        );
    }
} finally {
  store.close();
}
