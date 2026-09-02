import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "android-compact-360x640",
      use: { ...devices["Pixel 5"], viewport: { width: 360, height: 640 } },
    },
    {
      name: "android-tall-412x892",
      use: { ...devices["Pixel 7"], viewport: { width: 412, height: 892 } },
    },
  ],
  webServer: {
    command: "node test/static-server.mjs",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
