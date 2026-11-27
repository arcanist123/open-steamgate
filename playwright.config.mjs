import {defineConfig} from "@playwright/test";
import {delimiter} from "node:path";
// the port of the gateway under test: STG_PORT, as test/start.mjs reads it, so sessions do not collide on 3030
const PORT = process.env.STG_PORT ?? 3030;

export default defineConfig({
  testDir: "test/e2e",
  // the preview build has its own config (playwright.preview.config.mjs)
  testIgnore: [/preview\.spec\.mjs/, /\/deactivated\//],
  // one worker: every spec talks to the same gateway and the same in-memory
  // database, so specs that create or delete rows collide when they run in
  // parallel (a Travel another spec expects disappears, and the run has been
  // seen losing the server). 13 specs, 41 seconds.
  workers: 1,
  timeout: 90_000,
  expect: {timeout: 30_000},
  retries: 0,
  use: {
    baseURL: `http://localhost:${PORT}`,
    headless: true,
    screenshot: "only-on-failure",
  },
  // OSD_E2E_BASE_URL: a spec run by hand against a host somewhere else
  // (test/e2e/h5x-app.spec.mjs on a bed, docs/hana-milestone-3.md) needs no
  // gateway of its own
  webServer: process.env.OSD_E2E_BASE_URL ? undefined : {
    command: "node test/run.mjs",
    // CRUD suites must not reuse the developer's persistent default DB.
    // Explicit adapter selection is retained for targeted backend checks.
    // The cockpit browser fixture opts in here; ordinary ABAP Unit has no fleet rows.
    // The pack is a generation input: a tree built without it is transpiled
    // again at the server's start, inside the timeout below. CI builds it
    // first (tests.yml, e2e job); `npm run e2e` pays it at the first start.
    env: {OSD_PACKS: [process.env.OSD_PACKS, "demo/cockpit-fleet"].filter(Boolean).join(delimiter), STG_DB: process.env.STG_DB ?? "sqlite",
      STG_DB_PATH: process.env.STG_DB ? process.env.STG_DB_PATH ?? "" : ""},
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
