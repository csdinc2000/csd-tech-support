import { defineConfig } from "@playwright/test";

const previewBaseURL = process.env.PLAYWRIGHT_BASE_URL;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  use: {
    baseURL: previewBaseURL || "http://127.0.0.1:4174",
    headless: true,
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? "/repl/tools/bin/chromium",
    },
  },
  webServer: previewBaseURL ? undefined : {
    command: "BASE_PATH=/ PORT=4174 pnpm run dev",
    url: "http://127.0.0.1:4174/tests/staff-access.fixture.html",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});