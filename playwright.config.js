import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:43173", trace: "retain-on-failure" },
  webServer: {
    command: "node tests/fixtures/e2e-server.mjs",
    url: "http://127.0.0.1:43173/api/health",
    reuseExistingServer: false,
  },
});
