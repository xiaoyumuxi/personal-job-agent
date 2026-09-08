import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.browser.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: {
    channel: "chrome",
    headless: true,
    baseURL: "http://127.0.0.1:43117",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: {
    command: "npm run fixture",
    url: "http://127.0.0.1:43117/apply",
    reuseExistingServer: false,
    timeout: 30000,
  },
  reporter: "list",
});
