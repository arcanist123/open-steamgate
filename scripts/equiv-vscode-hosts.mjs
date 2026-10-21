// One scenario, two VS Code hosts: is the web extension the desktop one?
//
//   desktop  openvscode-server (a VS Code server with a Node extension host,
//            its workbench in Chromium): the extension's `main` entry,
//            talking HTTP to `node test/run.mjs` on STG_PORT.
//   web      @vscode/test-web: the extension's `browser` entry, the gateway
//            inside its web worker, no listener.
//
// Both workbenches are driven by the same Playwright steps (keyboard, command
// palette, DOM), on the same workspace folder. Each step returns the text it
// read; the text is normalised (generation ids, ports, timings) and compared,
// and each step leaves a screenshot per host. The verdict and the frames side
// by side go to $OUT_DIR/index.html and $OUT_DIR/result.json.
//
// A step whose command a host does not offer is reported as "desktop-only",
// not as a difference: the browser has no process to start, debug or test.
//
// Prerequisites: `npm run web:vscode` (the web bundle; it also transpiles,
// which the desktop server needs), Playwright Chromium, and an
// openvscode-server unpacked at $OVS_HOME (bin/openvscode-server).
// Run it under tools/osd-heavy.sh so STG_PORT is this session's own.
import {spawn} from "node:child_process";
import {cp, mkdir, mkdtemp, rm, writeFile, symlink, readFile} from "node:fs/promises";
import {createServer} from "node:net";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {chromium} from "@playwright/test";

const root = resolve(import.meta.dirname, "..");
const extension = join(root, "editors/vscode");
const out = resolve(process.env.OUT_DIR ?? join(root, "build/equiv"));
const ovsHome = process.env.OVS_HOME;
if (!ovsHome) throw new Error("OVS_HOME must name an unpacked openvscode-server (bin/openvscode-server)");
const stgPort = Number(process.env.STG_PORT ?? 3030);
const only = (process.env.EQUIV_HOSTS ?? "desktop,web").split(",");
const manifest = JSON.parse(await readFile(join(extension, "package.json"), "utf8"));

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const {port} = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

async function waitFor(url, child, name, minutes = 15) {
  const until = Date.now() + minutes * 60000;
  while (Date.now() < until) {
    if (child && child.exitCode !== null) throw new Error(`${name} exited early (${child.exitCode})`);
    try { if ((await fetch(url)).ok) return; } catch { /* starting */ }
    await new Promise((done) => setTimeout(done, 1000));
  }
  throw new Error(`${name} did not answer ${url}`);
}

const children = [];
function start(name, command, args, options = {}) {
  const child = spawn(command, args, {cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"], ...options});
  let log = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { log = (log + chunk).slice(-20000); });
  child.tail = () => log;
  children.push(child);
  return child;
}
function stopAll() {
  for (const child of children) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ }
  }
}

// The workspace both hosts open: a TABL, a CDS view, the demo notebook.
async function workspace(temp) {
  const dir = join(temp, "ws");
  await mkdir(join(dir, "src"), {recursive: true});
  for (const file of ["src/ddic/zstg_demo.tabl.xml", "src/cds/zc_stg_booking.ddls.asddls"]) {
    await cp(join(root, file), join(dir, "src", file.split("/").pop()));
  }
  await cp(join(extension, "examples/demo.osdnb"), join(dir, "demo.osdnb"));
  return dir;
}

const settings = {
  "workbench.startupEditor": "none",
  "workbench.colorTheme": "Default Light Modern",
  "workbench.tips.enabled": false,
  "security.workspace.trust.enabled": false,
  "chat.disableAIFeatures": true,
  "workbench.secondarySideBar.defaultVisibility": "hidden",
  "osd.url": `http://127.0.0.1:${stgPort}`,
  "osd.openIn": "vscode",
};

async function desktopHost(temp, folder) {
  const server = start("osd", "node", ["test/run.mjs"], {env: {...process.env, STG_PORT: String(stgPort)}});
  await waitFor(`http://127.0.0.1:${stgPort}/sap/opu/odata/sap/ZSTG_DEMO_SRV/$metadata`, server, "osd server", 5);
  const ext = join(temp, "ovs-ext");
  await mkdir(ext, {recursive: true});
  await symlink(extension, join(ext, `${manifest.publisher}.${manifest.name}-${manifest.version}`));
  const data = join(temp, "ovs-data");
  await mkdir(join(data, "data/Machine"), {recursive: true});
  await writeFile(join(data, "data/Machine/settings.json"), JSON.stringify(settings, null, 2));
  const port = await freePort();
  const ovs = start("openvscode-server", join(ovsHome, "bin/openvscode-server"), [
    "--host", "127.0.0.1", "--port", String(port), "--without-connection-token",
    "--extensions-dir", ext, "--server-data-dir", data, "--user-data-dir", join(temp, "ovs-user"),
    "--disable-telemetry"]);
  const origin = `http://127.0.0.1:${port}`;
  await waitFor(origin, ovs, "openvscode-server", 3);
  return {name: "desktop", url: `${origin}/?folder=${encodeURIComponent(folder)}`, logs: () => server.tail() + ovs.tail()};
}

async function webHost(temp, folder) {
  const port = await freePort();
  const web = start("test-web", "npx", ["-y", "@vscode/test-web", "--browser", "none", "--quality", "stable",
    "--extensionDevelopmentPath", extension, "--testRunnerDataDir", join(temp, "vscode-web"),
    "--port", String(port), folder], {env: {...process.env, npm_config_cache: join(temp, "npm-cache")}});
  const origin = `http://localhost:${port}`;
  await waitFor(origin, web, "@vscode/test-web");
  return {name: "web", url: origin, logs: () => web.tail(), userSettings: true};
}

// --- the steps -------------------------------------------------------------

const norm = (text) => String(text ?? "")
  .replaceAll(" ", " ")
  .replace(/\b[0-9a-f]{16}\b/g, "<gen>")
  .replace(/\b\d+(?:\.\d+)? ?ms\b/g, "<ms>")
  .replace(/(?:localhost|127\.0\.0\.1):\d+/g, "<host>")
  .replace(/[ \t]+/g, " ")
  .trim();

async function palette(page, title) {
  await page.keyboard.press("Control+Shift+P");
  const input = page.locator(".quick-input-widget input").first();
  await input.waitFor({timeout: 30000});
  await input.fill(`>${title}`);
  const rows = page.locator(".quick-input-list .monaco-list-row");
  await page.locator(".quick-input-widget .quick-input-progress.done").waitFor({timeout: 30000}).catch(() => {});
  await page.waitForTimeout(400);
  const choice = rows.filter({has: page.locator(".label-name", {hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`)})}).first();
  if (!(await choice.count())) {
    await page.keyboard.press("Escape");
    return false;
  }
  await choice.click();
  return true;
}

// Through the Explorer, not Quick Open: test-web's mounted folder answers no
// file search, and a click is the same gesture on both hosts.
async function openFile(page, name) {
  await page.keyboard.press("Control+Shift+E");
  const explorer = page.locator(".part.sidebar .explorer-folders-view");
  await explorer.waitFor({timeout: 30000});
  const row = (label) => explorer.locator(".monaco-list-row").filter({has: page.locator(`.label-name:text-is("${label}")`)}).first();
  if (name !== "demo.osdnb" && !(await row(name).count())) {
    const src = row("src");
    await src.waitFor({timeout: 30000});
    if ((await src.getAttribute("aria-expanded")) !== "true") await src.click();
  }
  await row(name).waitFor({timeout: 30000});
  await row(name).dblclick();
  await page.locator(`.tab[aria-label*="${name}"]`).first().waitFor({timeout: 30000});
}

// Workspace trust: the desktop asks once per folder; answer it like a person.
async function trust(page) {
  const yes = page.getByRole("button", {name: /Yes, I trust the authors/});
  if (await yes.waitFor({timeout: 15000}).then(() => true, () => false)) await yes.click();
}

// Text of the active webview panel (VS Code nests the page in two iframes).
async function webviewText(page, until, timeout = 60000) {
  const deadline = Date.now() + timeout;
  let last = "";
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (!/webview|vscode-cdn|vscode-resource/.test(frame.url()) || frame === page.mainFrame()) continue;
      const text = await frame.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      if (text && until.test(text)) return text;
      if (text) last = text;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`webview never showed ${until}: ${last.slice(0, 500)}`);
}

const steps = [
  {
    name: "tree",
    title: "OSD view: the services the system serves",
    async run(page) {
      await page.locator('.activitybar [aria-label^="OSD"]').first().click();
      const rows = page.locator(".part.sidebar .monaco-list-row");
      await rows.first().waitFor({timeout: 60000});
      await page.waitForTimeout(3000);
      return (await rows.allInnerTexts()).map(norm).join("\n");
    },
  },
  {
    name: "f8-tabl",
    title: "F8 Data Preview on ZSTG_DEMO (TABL)",
    command: "osd: Run",
    async run(page) {
      await openFile(page, "zstg_demo.tabl.xml");
      if (!(await palette(page, this.command))) return undefined;
      return norm(await webviewText(page, /T0001/));
    },
  },
  {
    name: "notebook",
    title: "SQL notebook: run the first cell of demo.osdnb",
    async run(page) {
      await openFile(page, "demo.osdnb");
      const cell = page.locator(".notebook-editor .cell-list-container .code-cell-row").first();
      await cell.waitFor({timeout: 60000});
      await cell.click();
      await page.keyboard.press("Control+Enter");
      const output = page.locator(".notebook-editor .output").first();
      await output.waitFor({timeout: 120000}).catch(() => {});
      return norm(await webviewText(page, /\S/, 60000).catch(() => output.innerText()));
    },
  },
  {
    name: "launchpad",
    title: "Fiori launchpad opened from VS Code",
    command: "osd: Open Fiori Launchpad",
    async run(page) {
      if (!(await palette(page, this.command))) return undefined;
      return norm(await webviewText(page, /Travel/i, 120000));
    },
  },
];

// --- run -------------------------------------------------------------------

const temp = await mkdtemp(join(tmpdir(), "osd-eq-"));
await rm(out, {recursive: true, force: true});
await mkdir(out, {recursive: true});
const results = {};
let browser;
try {
  const folder = await workspace(temp);
  browser = await chromium.launch({headless: true, args: ["--no-sandbox"]});
  for (const make of [desktopHost, webHost]) {
    const hostName = make === desktopHost ? "desktop" : "web";
    if (!only.includes(hostName)) continue;
    const host = await make(temp, folder);
    const context = await browser.newContext({viewport: {width: 1440, height: 900}});
    const page = await context.newPage();
    await page.goto(host.url, {waitUntil: "domcontentloaded"});
    await page.locator(".monaco-workbench").waitFor({timeout: 180000});
    await trust(page);
    if (host.userSettings) {
      // test-web has no settings file to seed: write the same settings as JSON.
      await palette(page, "Preferences: Open User Settings (JSON)");
      await page.locator(".monaco-editor textarea").first().waitFor({timeout: 30000});
      await page.keyboard.press("Control+A");
      await page.keyboard.insertText(JSON.stringify(settings));
      await page.keyboard.press("Control+S");
      await page.keyboard.press("Control+W");
    }
    await page.waitForTimeout(5000);
    if (await page.locator(".part.auxiliarybar").isVisible().catch(() => false)) {
      await palette(page, "View: Close Secondary Side Bar");
    }
    results[host.name] = {};
    for (const step of steps) {
      const started = Date.now();
      let text;
      let error;
      try { text = await step.run(page); } catch (e) { error = String(e.message ?? e); }
      await page.screenshot({path: join(out, `${step.name}-${host.name}.png`)}).catch(() => {});
      results[host.name][step.name] = {text, error, ms: Date.now() - started};
      await page.keyboard.press("Escape").catch(() => {});
      console.log(`${host.name} ${step.name}: ${error ? `ERROR ${error.slice(0, 200)}` : text === undefined ? "not offered" : `${text.length} chars`}`);
    }
    await context.close();
  }
} finally {
  await browser?.close();
  stopAll();
}

const rows = steps.map((step) => {
  const d = results.desktop?.[step.name];
  const w = results.web?.[step.name];
  let verdict;
  if (!d || !w) verdict = "not run";
  else if (d.error || w.error) verdict = "error";
  else if (w.text === undefined && d.text !== undefined) verdict = "desktop-only";
  else if (d.text === undefined) verdict = "not offered";
  else verdict = d.text === w.text ? "equal" : "different";
  return {step: step.name, title: step.title, verdict, desktop: d, web: w};
});
await writeFile(join(out, "result.json"), JSON.stringify(rows, null, 2));
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;"})[c]);
await writeFile(join(out, "index.html"), `<!doctype html><meta charset="utf-8"><title>VS Code hosts: desktop vs web</title>
<style>body{font:14px system-ui;margin:16px}img{width:100%;border:1px solid #ccc}td{vertical-align:top;width:50%}pre{white-space:pre-wrap;max-height:16em;overflow:auto;background:#f6f6f6}.equal{color:#060}.different,.error{color:#a00}</style>
<h1>desktop (openvscode-server, main) vs web (@vscode/test-web, browser)</h1>
${rows.map((r) => `<h2>${esc(r.title)} - <span class="${r.verdict}">${r.verdict}</span></h2>
<table><tr><th>desktop</th><th>web</th></tr><tr>
<td><img src="${r.step}-desktop.png"><pre>${esc(r.desktop?.error ?? r.desktop?.text)}</pre></td>
<td><img src="${r.step}-web.png"><pre>${esc(r.web?.error ?? r.web?.text)}</pre></td></tr></table>`).join("\n")}`);
for (const r of rows) console.log(`${r.verdict.padEnd(12)} ${r.step}`);
console.log(`report: ${join(out, "index.html")}`);
await rm(temp, {recursive: true, force: true}).catch(() => {});
process.exit(0);
