import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.desktop.ts",
  workers: 1,
  fullyParallel: false,
  timeout: 90000,
  reporter: "list",
  use: { screenshot: "off", trace: "off", video: "off" },
});
