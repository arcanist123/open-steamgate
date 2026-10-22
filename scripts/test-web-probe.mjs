// End-to-end VS Code web extension check. @vscode/test-web serves VS Code;
// Playwright drives one persistent Chromium profile through a page reload.
import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {copyFile, mkdir, mkdtemp, readFile, rm, stat} from "node:fs/promises";
import {createServer} from "node:net";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {runInNewContext} from "node:vm";
import {chromium} from "@playwright/test";

const root = resolve(import.meta.dirname, "..");
const shots = process.env.OUT_DIR || "/tmp/osd-shots";
const extension = join(root, "editors/vscode");
const source = await readFile(join(extension, "web/extension.mjs"), "utf8");

// Test-only harness: execute the shipped functions with a fake message channel
// and gateway. No test dispatch or synthetic response is bundled in the extension.
async function testTransportSeam() {
  const calls = [];
  const bridgeSource = source.slice(source.indexOf("function bytesFromBase64"), source.indexOf("function required("));
  const bridge = runInNewContext(`${bridgeSource}\nbridgeRequest`, {
    Uint8Array, TextEncoder, Headers, atob, btoa,
    encoder: new TextEncoder(),
    gateway: async (request) => {
      calls.push(request);
      return {status: 200, headers: new Headers({"content-type": "application/octet-stream", "content-length": "4"}),
        body: Uint8Array.from([0, 255, 13, 10])};
    },
  });
  const body = Uint8Array.from([255, 254, 13, 0]);
  const request = (path) => ({method: "POST", path, query: "?source=test", headers: [["content-type", "application/octet-stream"]],
    body: Buffer.from(body).toString("base64")});
  const allowed = "/sap/bc/assets/photo%2epng";
  const answer = await bridge(request(allowed));
  if (answer.status !== 200 || calls.length !== 1 || calls[0].path !== allowed ||
      createHash("sha256").update(calls[0].body).digest("hex") !== createHash("sha256").update(body).digest("hex") ||
      calls[0].search !== "?source=test" || calls[0].headers["content-type"] !== "application/octet-stream" ||
      Buffer.from(answer.body, "base64").compare(Buffer.from([0, 255, 13, 10])) !== 0) {
    throw new Error("Bridge byte forwarding, encoded-dot filename, or binary response changed");
  }
  for (const path of ["/sap/bc/../secret", "/sap/bc/%2e%2e/secret", "/sap/bc/%2e/secret",
    "/sap/bc/dir%2fsecret", "/sap/bc/dir%5csecret", "/sap/bc/dir\\secret"]) {
    const denied = await bridge(request(path));
    if (denied.status !== 403 || calls.length !== 1) throw new Error(`Traversal reached gateway: ${path}`);
  }
  const malformed = await bridge(request("/sap/bc/photo%ZZ"));
  if (malformed.status !== 400 || calls.length !== 1) throw new Error("Malformed path encoding must be 400 and never reach the gateway");
  const listeners = [];
  const sent = [];
  const viewSource = source.slice(source.indexOf("function webviewRuntime("), source.indexOf("function webviewHtml("));
  const viewWindow = {addEventListener: (_type, listener) => listeners.push(listener)};
  const runtime = runInNewContext(`${viewSource}\nwebviewRuntime`, {
    window: viewWindow, document: {getElementById: () => ({textContent: "", onclick: null})},
    acquireVsCodeApi: () => ({postMessage: (message) => {
      sent.push(message);
      if (message.type === "fetch") queueMicrotask(() => listeners.forEach((listener) => listener({data: {type: "fetch-result",
        id: message.id, response: {status: 204, statusText: "No Content", headers: [], body: ""}}})));
    }}),
    URL, URLSearchParams, Request, Response, Headers, Blob, TextEncoder, TextDecoder, Uint8Array,
    ArrayBuffer, crypto, atob, btoa,
  });
  runtime("/sap/opu/odata/sap/ZSTG_DEMO_SRV");
  const cases = [
    {body: new URLSearchParams({word: "café"}), expected: "application/x-www-form-urlencoded;charset=UTF-8"},
    {body: "café", expected: "text/plain;charset=UTF-8"},
    {body: new Blob(["café"], {type: "application/example"}), expected: "application/example"},
    {body: new Blob(["café"]), expected: ""},
  ];
  for (const entry of cases) for (const explicit of [false, true]) {
    const expected = explicit ? "application/explicit" : entry.expected;
    await viewWindow.osdBridge.fetch("$metadata", {method: "POST",
      headers: explicit ? {"content-type": expected} : {}, body: entry.body});
    const actual = new Headers(sent.at(-1).headers).get("content-type") ?? "";
    if (actual !== expected) throw new Error(`Content-Type ${actual} != ${expected}`);
  }
  console.log("Test-only transport seam: bytes, path segments, content types passed");
}

await testTransportSeam();
// Always rebuild before launching VS Code so this check exercises current sources.
if (process.env.OSD_WEB_TEST_SKIP_BUILD !== "1") {
  const build = spawn("npm", ["run", "web:vscode"], {cwd: root, stdio: "inherit"});
  const buildExit = await new Promise((resolveExit, reject) => {
    build.on("error", reject);
    build.on("close", resolveExit);
  });
  if (buildExit !== 0) throw new Error(`npm run web:vscode failed (exit ${buildExit})`);
}
await stat(join(extension, "dist/web/extension.js")).catch(() => {
  throw new Error("Web extension bundle is missing after npm run web:vscode");
});
const {buildId} = await import("../web/generated/seed.mjs");

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = server.address().port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

const temp = await mkdtemp(join(tmpdir(), "osd-vscode-web-"));
const workspace = join(temp, "workspace");
const port = await freePort();
const origin = `http://localhost:${port}`;
let server;
let context;
let page;
let serverOutput = "";
const browserLog = [];

async function waitForServer() {
  const until = Date.now() + 15 * 60 * 1000; // first run downloads VS Code
  while (Date.now() < until) {
    if (server.exitCode !== null) throw new Error(`@vscode/test-web exited early:\n${serverOutput.slice(-4000)}`);
    try {
      const answer = await fetch(origin);
      if (answer.ok) return;
    } catch { /* download or server start in progress */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  throw new Error(`@vscode/test-web did not start:\n${serverOutput.slice(-4000)}`);
}

async function command(page, title, marker) {
  await page.keyboard.press("Control+Shift+P");
  const input = page.locator(".quick-input-widget input").first();
  await input.waitFor({timeout: 30000});
  await input.fill(`>${title}`);
  const choice = page.locator(".quick-input-list .monaco-list-row").filter({hasText: title}).first();
  await choice.waitFor({timeout: 30000});
  await choice.click();
  await page.waitForFunction((name) => {
    const text = (document.querySelector(".output-view .view-lines")?.textContent ?? "").replaceAll("\u00a0", " ");
    return text.includes(`${name} {`) || text.includes(`${name}_ERROR`);
  }, marker, {timeout: 180000});
  const text = (await page.locator(".output-view .view-lines").textContent()).replaceAll("\u00a0", " ");
  const error = text.match(new RegExp(`${marker}_ERROR ([\\s\\S]*)`));
  if (error) throw new Error(error[1].slice(0, 2000));
  const start = text.indexOf(`${marker} {`);
  if (start < 0) throw new Error(`${marker} result missing from Output: ${text.slice(-2000)}`);
  const jsonStart = start + marker.length + 1;
  for (let end = jsonStart + 1; end <= text.length; end++) {
    if (text[end - 1] !== "}") continue;
    try { return JSON.parse(text.slice(jsonStart, end)); } catch { /* nested object continues */ }
  }
  throw new Error(`${marker} result has incomplete JSON: ${text.slice(start, start + 2000)}`);
}

async function openProbeView(page) {
  await page.keyboard.press("Control+Shift+P");
  const input = page.locator(".quick-input-widget input").first();
  await input.fill(">osd: Web probe view");
  await page.locator(".quick-input-list .monaco-list-row").filter({hasText: "osd: Web probe view"}).first().click();
  for (let attempt = 0; attempt < 120; attempt++) {
    for (const frame of page.frames()) {
      if (frame !== page.mainFrame() && await frame.locator("#run").count().catch(() => 0)) return frame;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error("Probe webview did not open");
}

async function openWorkspaceFile(page, name) {
  const explorer = page.locator(".explorer-folders-view .monaco-list-row").filter({hasText: name}).first();
  await explorer.waitFor({timeout: 30000});
  await explorer.dblclick();
  await page.locator(".editor-instance .monaco-editor").first().waitFor({timeout: 30000});
}

async function runPaletteCommand(page, title) {
  await page.keyboard.press("Control+Shift+P");
  const input = page.locator(".quick-input-widget input").first();
  await input.waitFor({timeout: 30000});
  await input.fill(`>${title}`);
  const choice = page.locator(".quick-input-list .monaco-list-row").filter({hasText: title}).first();
  await choice.waitFor({timeout: 30000});
  await choice.click();
}

async function frameWithText(page, text, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const body = await frame.locator("body").textContent({timeout: 500}).catch(() => "");
      if (body?.includes(text)) return frame;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`No webview frame contained ${JSON.stringify(text)}`);
}

async function acceptNotebookTrust(page) {
  const trust = page.locator(".monaco-text-button").filter({hasText: "Open Notebook"}).first();
  await trust.waitFor({state: "visible", timeout: 5000}).catch(() => undefined);
  if (await trust.isVisible()) {
    const remember = page.locator("text=Don't ask me again").first();
    if (await remember.isVisible()) await remember.click();
    await trust.click();
  }
}

async function webviewResult(frame, marker) {
  await frame.waitForFunction((name) => {
    const text = document.querySelector("#result")?.textContent ?? "";
    return text.startsWith(name + " ") || text.startsWith("OSD_WEBVIEW_ERROR ");
  }, marker, {timeout: 180000});
  const value = await frame.locator("#result").textContent();
  if (value.startsWith("OSD_WEBVIEW_ERROR")) throw new Error(value);
  return JSON.parse(value.slice(marker.length + 1));
}


// The Fiori webview: the frame whose document is the UI5 page (VS Code nests
// it inside its own webview host frames).
async function fioriFrame(page, test, arg, what, timeout = 180000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const ok = await frame.evaluate(test, arg).catch(() => false);
      if (ok) return frame;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  const stats = [];
  for (const frame of page.frames()) {
    const one = await frame.evaluate(() => window.osdBridge?.stats && JSON.stringify(window.osdBridge.stats)).catch(() => undefined);
    if (one) stats.push(one);
  }
  throw new Error(`${what} did not appear in a webview; bridge stats: ${stats.join(" | ").slice(0, 3000)}`);
}

const bridgeStats = (frame) => frame.evaluate(() => JSON.parse(JSON.stringify(window.osdBridge.stats)));

async function fioriChecks(page) {
  await mkdir(shots, {recursive: true});
  await page.keyboard.press("Control+Shift+P");
  const input = page.locator(".quick-input-widget input").first();
  await input.fill(">osd: Open Fiori Launchpad");
  await page.locator(".quick-input-list .monaco-list-row").filter({hasText: "osd: Open Fiori Launchpad"}).first().click();
  const tiles = ["Travels", "Bookings", "Flight analytics", "System status"];
  const launchpad = await fioriFrame(page, (names) => !!window.osdBridge && names.every((name) =>
    [...document.querySelectorAll(".sapUshellTile, .sapMGT")].some((tile) => tile.textContent.includes(name))), tiles, "Launchpad tiles");
  for (const name of tiles) {
    if (!await launchpad.locator(".sapUshellTile, .sapMGT").filter({hasText: name}).first().isVisible()) throw new Error(`Tile ${name} not visible`);
  }
  await page.screenshot({path: join(shots, "fiori-launchpad.png")});
  console.log(`Fiori launchpad in a webview: tiles ${tiles.join(", ")}; ${join(shots, "fiori-launchpad.png")}`);
  await launchpad.locator(".sapUshellTile, .sapMGT").filter({hasText: "Travels"}).first().click();
  const hasRow = (wanted) => [...document.querySelectorAll(".sapMListTblRow, tr")].some((row) => row.textContent.includes(wanted));
  await launchpad.waitForFunction(hasRow, "T0001", {timeout: 180000});
  if (!(await launchpad.evaluate(() => window.location.hash)).startsWith("#Travel-manage")) throw new Error("Tile click did not navigate to #Travel-manage");
  await page.screenshot({path: join(shots, "fiori-travels.png")});
  // A row written through the page's own fetch (the bridge the app's model
  // uses) must show in the list report after Go, and in other features.
  const created = await launchpad.evaluate(async () => {
    const service = "../sap/opu/odata/sap/ZSTG_DEMO_SRV/";
    const token = (await fetch(service, {headers: {"x-csrf-token": "fetch"}})).headers.get("x-csrf-token");
    const id = "A" + Array.from(crypto.getRandomValues(new Uint8Array(7)), (byte) => (byte % 36).toString(36).toUpperCase()).join("");
    const answer = await fetch(`${service}TravelSet`, {method: "POST", headers: {"content-type": "application/json", "x-csrf-token": token},
      body: JSON.stringify({TravelId: id, Description: `Fiori webview ${id}`})});
    return {status: answer.status, id};
  });
  if (created.status !== 201) throw new Error(`Fiori webview POST: ${created.status}`);
  const go = launchpad.locator("button").filter({hasText: /^Go$/}).first();
  await go.click();
  await launchpad.waitForFunction(hasRow, created.id, {timeout: 60000});
  await page.screenshot({path: join(shots, "fiori-travels-created.png")});
  // The app's own Create flow (non-draft object page in create mode): the
  // POST travels in a $batch through the XMLHttpRequest replacement.
  const typed = "A" + Array.from(crypto.getRandomValues(new Uint8Array(7)), (byte) => (byte % 36).toString(36).toUpperCase()).join("");
  await launchpad.getByRole("button", {name: "Create", exact: true}).first().focus();
  await page.keyboard.press("Enter");
  const travelField = launchpad.getByRole("textbox", {name: "Travel", exact: true});
  await travelField.waitFor({timeout: 60000});
  await travelField.fill(typed);
  await launchpad.getByRole("textbox", {name: "Description", exact: true}).fill(`Typed in Fiori ${typed}`);
  await launchpad.getByRole("button", {name: "Create", exact: true}).last().focus();
  await page.keyboard.press("Enter");
  await launchpad.getByRole("heading", {name: `Typed in Fiori ${typed}`}).first().waitFor({timeout: 60000});
  // display mode after the save answered: Edit replaces the footer's Create
  await launchpad.getByRole("button", {name: "Edit", exact: true}).first().waitFor({timeout: 60000});
  await page.screenshot({path: join(shots, "fiori-object-created.png")});
  created.typed = typed;
  const stats = await bridgeStats(launchpad);
  if (stats.bridgedSync.length) throw new Error(`Synchronous gateway requests: ${JSON.stringify(stats.bridgedSync)}`);
  console.log(`Travels list report: T0001 and ${created.id} (page fetch) listed; ${typed} created through the app's Create; bridged ${stats.bridged}, ` +
    `sync answered locally ${JSON.stringify(stats.localSync)}, sync to CDN/files ${stats.nativeSync.length}, errors ${JSON.stringify(stats.errors)}`);
  return created;
}

async function fioriFromTree(page, ids) {
  const tree = page.locator(".pane-body .monaco-list-row");
  await tree.filter({hasText: /^Apps \([1-9]/}).first().click();
  const app = tree.filter({hasText: "stg.travel"}).first();
  await app.waitFor({timeout: 30000});
  await app.click();
  const frame = await fioriFrame(page, (wanted) => !!window.osdBridge && window.location.hash.startsWith("#Travel-manage") &&
    wanted.every((id) => [...document.querySelectorAll(".sapMListTblRow, tr")].some((row) => row.textContent.includes(id))), ids, "Travels app from the tree");
  await page.screenshot({path: join(shots, "fiori-tree-app.png")});
  return frame;
}
await mkdir(workspace, {recursive: true});
await copyFile(join(root, "src/ddic/zstg_demo.tabl.xml"), join(workspace, "zstg_demo.tabl.xml"));
await copyFile(join(extension, "examples/demo.osdnb"), join(workspace, "demo.osdnb"));
await copyFile(join(extension, "examples/abap-amdp.osdnb"), join(workspace, "abap-amdp.osdnb"));

try {
  server = spawn("npx", ["-y", "@vscode/test-web", "--browser", "none",
    "--quality", "stable", "--extensionDevelopmentPath", extension,
    "--testRunnerDataDir", process.env.OSD_WEB_TEST_DATA_DIR ?? join(temp, "vscode"), "--port", String(port),
    workspace], {
    cwd: root,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {...process.env, npm_config_cache: join(temp, "npm-cache")},
  });
  for (const stream of [server.stdout, server.stderr]) {
    stream.on("data", (chunk) => {
      serverOutput = (serverOutput + chunk.toString()).slice(-12000);
      process.stdout.write(chunk);
    });
  }
  await waitForServer();
  context = await chromium.launchPersistentContext(join(temp, "profile"), {
    headless: true, args: ["--no-sandbox"], viewport: {width: 1440, height: 900},
  });
  page = context.pages()[0] ?? await context.newPage();
  page.on("console", (message) => browserLog.push(`${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => browserLog.push(`pageerror: ${error.stack ?? error}`));
  await page.goto(origin, {waitUntil: "domcontentloaded"});
  await page.locator(".monaco-workbench").waitFor({timeout: 120000});

  const probe = await command(page, "osd: Web probe", "OSD_WEB_PROBE");
  if (probe.metadata !== 200 || probe.post !== 201 || probe.get !== 200 || !/^W[A-Z0-9]{7}$/.test(probe.id)) {
    throw new Error(`Invalid probe result: ${JSON.stringify(probe)}`);
  }
  if (!Number.isFinite(probe.activationToMetadataMs) || !Number.isFinite(probe.commandToMetadataMs)) {
    throw new Error(`Missing $metadata timing: ${JSON.stringify(probe)}`);
  }
  if (probe.photo?.status !== 200 || !/^[0-9a-f]{64}$/.test(probe.photo.hash) || probe.photo.contentType !== "image/png") {
    throw new Error(`Invalid direct gateway image: ${JSON.stringify(probe.photo)}`);
  }
  console.log(`Probe: $metadata ${probe.metadata}, POST ${probe.post}, GET ${probe.get}, ${probe.id}`);
  console.log(`Activation to first $metadata: ${probe.activationToMetadataMs} ms`);
  console.log(`Command to $metadata response: ${probe.commandToMetadataMs} ms`);

  const read = await command(page, "osd: Web read probe", "OSD_WEB_READ");
  if (read.sql !== 200 || read.rows !== 5 || read.ddic !== 200 || read.cap !== 2 || read.invalid !== 400) {
    throw new Error(`Web read probe failed: ${JSON.stringify(read)}`);
  }
  console.log(`Worker reads: SELECT ${read.rows} rows, DDIC ${read.ddic}, cap ${read.cap}, invalid ${read.invalid}`);

  // OSD_WEB_TEST_DB=duckdb: from here switch osd.web.database through the UI
  // and check the DuckDB-Wasm gateway (scripts/test-web-duckdb.mjs) instead of
  // the sql.js checks below, which the default run covers and which rely on
  // IndexedDB persistence across reloads.
  const duckdbOnly = process.env.OSD_WEB_TEST_DB === "duckdb";
  if (duckdbOnly) {
    const {duckdbPass} = await import("./test-web-duckdb.mjs");
    const duck = await duckdbPass({page, command, runPaletteCommand, fioriFrame, acceptNotebookTrust,
      shots: process.env.OUT_DIR || "/tmp/osd-shots"});
    console.log(`First $metadata: sql.js ${probe.activationToMetadataMs} ms, duckdb ${duck.activationToMetadataMs} ms`);
  }
  if (!duckdbOnly) {

  await openWorkspaceFile(page, "zstg_demo.tabl.xml");
  await runPaletteCommand(page, "osd: Data Preview (F8)");
  const previewFrame = await frameWithText(page, "Open in SQL notebook");
  const previewText = await previewFrame.locator("body").textContent();
  if (!previewText.includes("TRAVEL_ID") || !previewText.includes("T0001") ||
      !previewText.includes("Open in SQL notebook") || !/-- \d+ rows? --/.test(previewText)) {
    throw new Error(`F8 Data Preview output is incomplete: ${previewText.slice(0, 1000)}`);
  }
  const shots = process.env.OUT_DIR ?? "/tmp/osd-shots";
  await mkdir(shots, {recursive: true});
  await previewFrame.locator("#notebook").waitFor({timeout: 30000});
  await page.screenshot({path: join(shots, "web-data-preview.png"), fullPage: true});
  console.log("F8 Data Preview: webview columns, T0001 row, status, notebook action");

  await openWorkspaceFile(page, "demo.osdnb");
  await acceptNotebookTrust(page);
  await page.getByText("SELECT travel_id, description, status, seats FROM zstg_demo ORDER BY travel_id").first().click();
  await page.keyboard.press("Shift+Enter");
  const notebookFrame = await frameWithText(page, "raw JSON");
  const notebookText = await notebookFrame.locator("body").textContent();
  if (!notebookText.includes("TRAVEL_ID") || !notebookText.includes("DESCRIPTION") ||
      !notebookText.includes("T0001") || !notebookText.includes("raw JSON")) {
    throw new Error(`SQL notebook output is incomplete: ${notebookText.slice(0, 1000)}`);
  }
  await page.screenshot({path: join(shots, "web-sql-notebook.png"), fullPage: true});
  console.log("SQL notebook: HTML table header, T0001 row, raw JSON output");

  await openWorkspaceFile(page, "abap-amdp.osdnb");
  await acceptNotebookTrust(page);
  await page.getByText("DATA lt_demo TYPE").first().click();
  await page.keyboard.press("Shift+Enter");
  await page.getByText("abap notebook cells are not available in the browser").first().waitFor({timeout: 30000});
  const sqlscriptEditor = page.locator(".notebook-editor .monaco-editor").filter({hasText: "SELECT 6*7 AS answer"}).last();
  await sqlscriptEditor.locator(".view-lines").click();
  await page.keyboard.press("Shift+Enter");
  await page.getByText("sqlscript notebook cells are not available in the browser").first().waitFor({timeout: 30000});
  await page.screenshot({path: join(shots, "web-notebook-unavailable.png"), fullPage: true});
  console.log("Browser notebooks: ABAP and SQLScript cells explain that they are unavailable");

  await page.reload({waitUntil: "domcontentloaded"});
  await page.locator(".monaco-workbench").waitFor({timeout: 120000});
  const verified = await command(page, "osd: Web verify last Travel", "OSD_WEB_VERIFY");
  if (verified.get !== 200 || verified.id !== probe.id || verified.description !== probe.description) {
    throw new Error(`IndexedDB reload check failed: ${JSON.stringify(verified)}`);
  }
  console.log(`After reload: GET ${verified.get}, same row ${verified.id}`);

  const frame = await openProbeView(page);
  const photo = await frame.evaluate(async () => {
    const response = await window.osdBridge.fetch("PhotoSet('T0001')/$value");
    const bytes = await response.arrayBuffer();
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return {status: response.status, hash: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
      bytes: bytes.byteLength, contentType: response.headers.get("content-type"),
      contentLength: response.headers.get("content-length")};
  });
  if (JSON.stringify(photo) !== JSON.stringify(probe.photo)) {
    throw new Error(`Binary bridge response differs from direct gateway: ${JSON.stringify({direct: probe.photo, bridged: photo})}`);
  }
  console.log(`Webview image: ${photo.bytes} bytes, ${photo.contentType}, SHA-256 ${photo.hash}`);
  await frame.locator("#run").click();
  const bridged = await webviewResult(frame, "OSD_WEBVIEW_PROBE");
  if (bridged.metadata !== 200 || bridged.csrf !== 200 || bridged.post !== 201 ||
      bridged.get !== 200 || bridged.filtered !== 200 || bridged.forbidden !== 403 ||
      bridged.batch !== 202 || bridged.batchGet !== 200 ||
      !bridged.token || !bridged.location?.includes(bridged.id) || !bridged.contentType?.includes("json")) {
    throw new Error(`Invalid webview result: ${JSON.stringify(bridged)}`);
  }
  console.log(`Webview bridge: metadata ${bridged.metadata}, POST ${bridged.post}, batch ${bridged.batch}`);

  await page.reload({waitUntil: "domcontentloaded"});
  await page.locator(".monaco-workbench").waitFor({timeout: 120000});
  const reloadedFrame = await openProbeView(page);
  await reloadedFrame.locator("#verify").click();
  const persisted = await webviewResult(reloadedFrame, "OSD_WEBVIEW_VERIFY");
  if (persisted.get !== 200 || persisted.id !== bridged.id || persisted.description !== bridged.description) {
    throw new Error(`Webview IndexedDB reload check failed: ${JSON.stringify(persisted)}`);
  }
  console.log(`Webview after reload: GET ${persisted.get}, same row ${persisted.id}`);
  const osdActivity = page.locator(".activitybar .action-label[aria-label*='OSD']").first();
  await osdActivity.waitFor({timeout: 120000});
  await osdActivity.click();
  const tree = page.locator(".pane-body .monaco-list-row");
  await tree.filter({hasText: "System"}).first().waitFor({timeout: 120000});
  await tree.filter({hasText: "In-browser gateway"}).first().waitFor({timeout: 120000});
  await tree.filter({hasText: `Generation: ${buildId}`}).first().waitFor({timeout: 120000});
  await tree.filter({hasText: "Database: sql.js + IndexedDB"}).first().waitFor({timeout: 120000});
  await tree.filter({hasText: "Services"}).first().waitFor({timeout: 120000});
  await tree.filter({hasText: /^OData \([1-9]/}).first().waitFor({timeout: 120000});
  await tree.filter({hasText: /^OData \([1-9]/}).first().click();
  const demo = tree.filter({hasText: "ZSTG_DEMO_SRV"}).first();
  await demo.waitFor({timeout: 30000});
  await tree.filter({hasText: "ZSTG_SADL_SRV"}).first().waitFor({timeout: 30000});
  await demo.click();
  let serviceDetails = false;
  const detailsDeadline = Date.now() + 30000;
  while (Date.now() < detailsDeadline && !serviceDetails) {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const body = await frame.locator("body").textContent({timeout: 1000}).catch(() => "");
      if (body?.includes("ZSTG_DEMO_SRV") && body.includes("ODATA") && body.includes("/sap/opu/odata/sap/")) {
        serviceDetails = true;
        break;
      }
    }
    if (!serviceDetails) await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  if (!serviceDetails) throw new Error("Single click did not open the service details panel");
  const created = await fioriChecks(page);
  // The row the app wrote is the extension's: the probe view, another
  // webview over the same worker gateway, reads it.
  // Focus is inside the Fiori webview now; switch tabs with the mouse.
  await page.locator(".tabs-container .tab").filter({hasText: "OSD web gateway"}).first().click();
  const other = await fioriFrame(page, () => !!document.querySelector("#run") && !!window.osdBridge?.fetch, undefined, "Probe view", 60000);
  for (const id of [created.id, created.typed]) {
    const seen = await other.evaluate(async (wanted) => {
      const response = await window.osdBridge.fetch(`TravelSet('${wanted}')?$format=json`);
      return {status: response.status, id: response.status === 200 ? (await response.json()).d.TravelId : undefined};
    }, id);
    if (seen.status !== 200 || seen.id !== id) throw new Error(`Probe view did not see the Fiori row: ${JSON.stringify(seen)}`);
  }
  console.log(`Probe view reads both Fiori rows: ${created.id}, ${created.typed}`);
  await page.reload({waitUntil: "domcontentloaded"});
  await page.locator(".monaco-workbench").waitFor({timeout: 120000});
  // The reload restores the open OSD view; clicking its activity icon would
  // close it, so focus the view by its command.
  await page.keyboard.press("Control+Shift+P");
  await page.locator(".quick-input-widget input").first().fill(">OSD: Focus on System View");
  await page.locator(".quick-input-list .monaco-list-row").filter({hasText: "OSD: Focus on System View"}).first().click();
  await tree.filter({hasText: "In-browser gateway"}).first().waitFor({timeout: 120000});
  await fioriFromTree(page, [created.id, created.typed]);
  console.log(`After reload, tree App node stg.travel: Travels list shows ${created.id} and ${created.typed}`);
  await page.keyboard.press("Control+Shift+P");
  const palette = page.locator(".quick-input-widget input").first();
  await palette.fill(">osd: Web probe");
  const choices = page.locator(".quick-input-list .monaco-list-row");
  await choices.filter({hasText: "osd: Web probe"}).first().waitFor({timeout: 30000});
  await palette.fill(">osd:");
  const webCommands = ["osd: Web probe", "osd: Web read probe", "osd: Web verify last Travel", "osd: Web probe view",
    "osd: Open Fiori Launchpad", "osd: Data Preview (F8)", "osd: New SQL notebook", "osd: Refresh the view (no rebuild)"];
  for (const title of webCommands) await choices.filter({hasText: title}).first().waitFor({timeout: 30000});
  await page.locator(".quick-input-widget .quick-input-progress.done").waitFor({timeout: 30000});
  const paletteRows = await choices.allTextContents();
  // prepareAbapgitZip is registered by the browser entry too (it builds the zip in memory).
  const allowed = [...webCommands, "OSD: Focus on System View", "osd: Prepare abapGit zip"];
  const unexpected = paletteRows.filter((row) => !allowed.some((title) => row.includes(title)));
  if (unexpected.length || paletteRows.length !== allowed.length) {
    throw new Error(`Desktop-only or missing OSD commands in the web palette: ${JSON.stringify(paletteRows)}`);
  }
  await page.keyboard.press("Escape");
  await page.locator(".quick-input-widget").first().waitFor({state: "hidden", timeout: 30000});
  console.log("OSD tree: generation, grouped demo OData, service details; web commands available");

  await runPaletteCommand(page, "osd: New SQL notebook");
  await acceptNotebookTrust(page);
  await page.locator("text=SELECT * FROM zosd_sys UP TO 10 ROWS").first().waitFor({timeout: 30000});
  await page.screenshot({path: join(shots, "web-new-sql-notebook.png"), fullPage: true});
  console.log("New SQL notebook: untitled notebook opened with runnable starter cell");

  } // !duckdbOnly
} catch (error) {
  console.error(error);
  console.error("Workbench text:", (await page?.locator("body").innerText().catch(() => ""))?.slice(-3000));
  console.error("Output text:", await page?.locator(".output-view").textContent().catch(() => ""));
  console.error("Browser log:", browserLog.slice(-40).join("\n"));
  process.exitCode = 1;
} finally {
  await context?.close();
  if (server?.pid && server.exitCode === null) {
    // Detached process group consists of this script's npx and its children.
    try { process.kill(-server.pid, "SIGTERM"); } catch { /* already exited */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  await rm(temp, {recursive: true, force: true});
}
