// Photographs the preview build (build/preview/) into build/preview/screenshots/, so a
// deployment carries pictures of itself: the Fiori list report, the service
// document and $metadata as the browser renders them.
import {chromium} from "@playwright/test";
import {mkdir, mkdtemp, rm} from "node:fs/promises";
import {spawn} from "node:child_process";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {restampTreeArtefact, verifyTreeArtefact} from "../tools/osd-public-tree.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const preview = resolve(root, "build/preview");
const provenance = verifyTreeArtefact(preview, root);
const out = resolve(root, "build/preview/screenshots");
await mkdir(out, {recursive: true});

const port = 3032;
const server = spawn("node", [resolve(root, "scripts/serve-build.mjs")], {env: {...process.env, STG_PREVIEW_PORT: String(port)}, stdio: "ignore"});
await new Promise((r) => setTimeout(r, 1500));
const profile = await mkdtemp(join(tmpdir(), "stg-shots-"));
const context = await chromium.launchPersistentContext(profile, {headless: true, serviceWorkers: "allow", viewport: {width: 1280, height: 800}});
try {
  const page = await context.newPage();
  await page.goto(`http://localhost:${port}/app/index.html`);
  await page.locator("table tbody tr.sapMListTblRow").first().waitFor({timeout: 90_000});
  await page.waitForTimeout(1000);
  await page.screenshot({path: join(out, "list-report.png"), fullPage: true});
  await page.goto(`http://localhost:${port}/sap/opu/odata/sap/ZSTG_DEMO_SRV/$metadata`);
  await page.screenshot({path: join(out, "metadata.png"), fullPage: true});
  await page.goto(`http://localhost:${port}/sap/opu/odata/sap/ZSTG_SADL_SRV/Zc_Stg_TravelcubeSet?$select=STATUS,SEATS&$orderby=STATUS&$format=json`);
  await page.screenshot({path: join(out, "sadl-aggregate.png"), fullPage: true});
  // the screenshots changed the preview: stamp it again, only if the tree is
  // still the generation it was verified as
  restampTreeArtefact(preview, root, provenance);
  console.log(`Screenshots in ${out}`);
} finally {
  await context.close();
  await rm(profile, {recursive: true, force: true});
  server.kill();
}
