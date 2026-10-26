import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

/**
 * OrcaRouter evidence run.
 *
 * Same product build as the normal suite, but pinned to the system Chromium so the
 * evidence check does not depend on a Playwright browser download. The screenshots it
 * produces land in `orca-evidence/`; verification regenerates them from scratch.
 */
const PORT = Number(process.env.PW_PORT ?? 4371);
const ROOT = path.resolve(import.meta.dirname, "..");
const CHROMIUM = process.env.PW_CHROMIUM ?? "/usr/bin/chromium";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /orcarouter-evidence\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    headless: true,
    viewport: { width: 1920, height: 1080 },
    launchOptions: { executablePath: CHROMIUM, args: ["--no-sandbox", "--disable-dev-shm-usage"] },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1920, height: 1080 } } }],
  webServer: {
    command: `PORT=${PORT} bash scripts/e2e-server.sh`,
    url: `http://localhost:${PORT}/healthz`,
    cwd: ROOT,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
