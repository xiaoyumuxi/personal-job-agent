import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db.js";
import { ConfigSchema, initialize } from "../src/config.js";
import { ProfileSchema, SiteSchema } from "../src/types.js";
export const origin = "http://127.0.0.1:43117";
export const site = SiteSchema.parse(
  JSON.parse(
    readFileSync(new URL("../sites/fixture.json", import.meta.url), "utf8"),
  ),
);
export function testState() {
  const dir = mkdtempSync(join(tmpdir(), "jobagent-test-"));
  initialize(dir);
  const store = new Store(dir);
  const config = ConfigSchema.parse({
    notifications: false,
    feishu: {
      enabled: true,
      baseToken: "test-only-base",
      tableId: "test-only-table",
    },
  });
  return {
    dir,
    store,
    config,
    dispose() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
export function selected(store: Store, jobCode = "J001") {
  const job = store.addJob({
    company: "Fixture only",
    title: "Test job",
    batch: "fixture-2026",
    jobCode,
    url: origin + "/apply?ref=KEEP",
    tenant: "fixture",
    account: "default",
    referral: "test",
    source: "unit:2",
    channel: "READY",
  });
  const a = store.ensureApplication(job.id);
  a.state = "SUBMITTED";
  store.save(a, "TEST_ONLY_SUBMITTED");
  return a;
}
export function sampleProfile() {
  const facts: Record<string, unknown> = {};
  for (const [key, value] of Object.entries({
    "basic.name": "测试本人",
    "basic.email": "test@example.invalid",
    "basic.phone": "13800000000",
    "basic.hasInternship": "yes",
    "basic.lastInternCompany": "虚构测试公司",
    "basic.locations": ["上海", "深圳"],
    "basic.workMode": "远程",
    "basic.workDays": ["周一", "周五"],
    "emergency.name": "测试联系人",
    "education.master.school": "测试硕士学校",
    "education.master.startDate": "2024-09-01",
    "education.bachelor.school": "测试本科学校",
    "education.bachelor.startDate": "2020-09-01",
    "experience.intern.company": "测试实习公司",
    "experience.intern.startDate": "2025-01-01",
    "experience.intern.description": "仅用于自动化测试的文字",
  }))
    facts[key] = { value, state: "confirmed", discloseTo: [origin] };
  return ProfileSchema.parse({
    facts,
    records: { education: ["bachelor", "master"], experience: ["intern"] },
  });
}
