// Browser tests run against a fresh local chain: a Hardhat node, the local deploy script and the Vite dev server.
// A test wallet forwards calls to the node. MetaMask is checked by hand.
import { defineConfig } from "@playwright/test";

export const E2E_PORT = 5182;

export default defineConfig({
  testDir: "test/e2e",
  testMatch: "*.spec.ts",
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  globalSetup: "./test/e2e/global-setup.ts",
  globalTeardown: "./test/e2e/global-teardown.ts",
  use: {
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    channel: process.env.PW_CHANNEL ?? "chrome",
    headless: true,
    launchOptions: { timeout: 600_000 }, // a loaded machine can take minutes to start Chrome
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
