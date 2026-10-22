// The DuckDB pass of scripts/test-web-probe.mjs (OSD_WEB_TEST_DB=duckdb).
//
// Runs after the sql.js checks, in the same VS Code for the Web session, and
// only through the UI: the setting is changed in the user settings JSON, the
// extension's prompt is answered with "Reload Window", and after the reload the
// gateway runs on DuckDB-Wasm, loaded from dist/web/duckdb-mvp.wasm beside the
// bundle. Then:
// - the probe's $metadata / POST / GET, and the time to first $metadata;
// - the OSD tree says DuckDB-Wasm, in memory;
// - the launchpad's AMDP sandbox tile shows what the GitHub Pages main preview
//   shows (recorded there on 2026-10-22: grey, "needs a database that speaks
//   it" / "no SQLScript engine here", /engine = {"engine":"none",
//   "system_db":"duckdb"}): the sandbox page needs HANA on every host, Portable
//   AMDP is not a sandbox engine;
// - a SQLScript notebook cell runs as Portable AMDP on DuckDB through the
//   worker's /sap/bc/osd/amdp/cell door.
import {mkdir} from "node:fs/promises";
import {join} from "node:path";

const PAGES_AMDP_TILE = ["AMDP sandbox", "needs a database that speaks it", "no SQLScript engine here"];

export async function duckdbPass({page, command, runPaletteCommand, fioriFrame, acceptNotebookTrust, shots}) {
  await mkdir(shots, {recursive: true});
  // 1. the setting, through the UI
  await runPaletteCommand(page, "Preferences: Open User Settings (JSON)");
  // current VS Code opens it in a modal editor rather than a tab; either way
  // the editor that shows the file has the focus
  const editor = page.locator(".monaco-editor").filter({has: page.locator(".view-lines")})
    .filter({hasText: "{"}).last();
  await page.getByText("settings.json", {exact: true}).first().waitFor({timeout: 30000});
  await editor.waitFor({timeout: 30000});
  await editor.locator(".view-lines").click();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText(`{\n  "osd.web.database": "duckdb"\n}\n`);
  await page.keyboard.press("Control+S");
  const prompt = page.locator(".notifications-toasts .notification-list-item")
    .filter({hasText: "takes effect after a window reload"}).first();
  await prompt.waitFor({timeout: 30000});
  const promptText = (await prompt.textContent()).replaceAll("\u00a0", " ");
  if (!promptText.includes("DuckDB-Wasm")) throw new Error(`Engine prompt does not name DuckDB: ${promptText}`);
  await page.screenshot({path: join(shots, "duckdb-setting-prompt.png")});
  console.log(`DuckDB setting: prompt "${promptText.slice(0, 160)}"`);
  const reloaded = page.waitForNavigation({waitUntil: "domcontentloaded", timeout: 120000});
  await prompt.getByRole("button", {name: "Reload Window"}).first().click();
  await reloaded;
  await page.locator(".monaco-workbench").waitFor({timeout: 120000});

  // 2. the gateway, on DuckDB
  const probe = await command(page, "osd: Web probe", "OSD_WEB_PROBE");
  if (probe.metadata !== 200 || probe.post !== 201 || probe.get !== 200) {
    throw new Error(`DuckDB probe: ${JSON.stringify(probe)}`);
  }
  console.log(`DuckDB probe: $metadata ${probe.metadata}, POST ${probe.post}, GET ${probe.get}, ${probe.id}`);
  console.log(`DuckDB activation to first $metadata: ${probe.activationToMetadataMs} ms`);

  // 3. the tree says so
  await runPaletteCommand(page, "OSD: Focus on System View");
  const tree = page.locator(".pane-body .monaco-list-row");
  await tree.filter({hasText: "Database: DuckDB-Wasm (in memory, reseeded on reload)"}).first().waitFor({timeout: 120000});
  await page.screenshot({path: join(shots, "duckdb-tree.png")});
  console.log("DuckDB tree: Database: DuckDB-Wasm (in memory, reseeded on reload)");

  // 4. the launchpad and its AMDP sandbox tile, as on Pages
  await runPaletteCommand(page, "osd: Open Fiori Launchpad");
  const launchpad = await fioriFrame(page, (parts) => !!window.osdBridge && [...document.querySelectorAll(".sapUshellTile, .sapMGT")]
    .some((tile) => parts.every((part) => tile.textContent.includes(part))), PAGES_AMDP_TILE, "AMDP sandbox tile as on Pages");
  const engine = await launchpad.evaluate(async () => {
    const answer = await fetch("../sap/bc/osd/amdp/engine");
    return {status: answer.status, body: await answer.json()};
  });
  if (engine.status !== 200 || engine.body.engine !== "none" || engine.body.system_db !== "duckdb") {
    throw new Error(`AMDP /engine differs from Pages: ${JSON.stringify(engine)}`);
  }
  const tile = launchpad.locator(".sapUshellTile, .sapMGT").filter({hasText: "AMDP sandbox"}).first();
  await tile.click();
  await page.waitForTimeout(2000);
  const hash = await launchpad.evaluate(() => window.location.hash);
  if (hash !== "#Shell-home") throw new Error(`AMDP sandbox tile navigated (${hash}); on Pages it has no target`);
  await page.screenshot({path: join(shots, "duckdb-launchpad-amdp.png")});
  console.log(`DuckDB launchpad: AMDP sandbox tile "${PAGES_AMDP_TILE.slice(1).join(" / ")}", /engine ${JSON.stringify(engine.body)}, click stays on ${hash}`);

  // 5. a SQLScript notebook cell, Portable AMDP on the worker's DuckDB
  await runPaletteCommand(page, "View: Show Explorer");
  // not openWorkspaceFile: the launchpad webview is the editor group's first
  // editor, so wait for the notebook's own cell instead of a text editor
  await page.locator(".explorer-folders-view .monaco-list-row").filter({hasText: "abap-amdp.osdnb"}).first().dblclick();
  await acceptNotebookTrust(page);
  const abapCell = page.locator(".notebook-editor .monaco-editor").filter({hasText: "DATA lt_demo TYPE"}).first();
  await abapCell.waitFor({timeout: 60000});
  // the SQLScript cell is below the fold: focus the ABAP cell, leave its
  // editor and step down to the next code cell, then run that one cell
  await abapCell.locator(".view-lines").click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("ArrowDown");
  const sqlscriptEditor = page.locator(".notebook-editor .monaco-editor").filter({hasText: "SELECT 6*7 AS answer"}).last();
  await sqlscriptEditor.waitFor({timeout: 60000}).catch(async (error) => {
    await page.screenshot({path: join(shots, "duckdb-notebook-missing.png")});
    throw error;
  });
  await sqlscriptEditor.locator(".view-lines").click();
  await page.keyboard.press("Shift+Enter");
  const until = Date.now() + 120000;
  let cell;
  while (Date.now() < until && cell === undefined) {
    for (const frame of page.frames()) {
      const body = await frame.locator("body").textContent({timeout: 500}).catch(() => "");
      if (body?.includes("Portable AMDP (limited) on duckdb")) { cell = body; break; }
    }
    if (cell === undefined) await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  if (cell === undefined) {
    await page.screenshot({path: join(shots, "duckdb-sqlscript-missing.png")});
    const refused = await page.getByText("sqlscript notebook cells are not available in the browser").count();
    throw new Error(`SQLScript cell did not run on DuckDB${refused ? ": refused as unavailable in the browser" : ""}`);
  }
  if (!/ANSWER/i.test(cell) || !cell.includes("42")) {
    throw new Error(`SQLScript cell output is not Portable AMDP's 42: ${String(cell).slice(0, 1000)}`);
  }
  await page.screenshot({path: join(shots, "duckdb-sqlscript-cell.png"), fullPage: true});
  console.log("DuckDB SQLScript cell: Portable AMDP (limited) on duckdb, ANSWER 42");
  return {activationToMetadataMs: probe.activationToMetadataMs};
}
