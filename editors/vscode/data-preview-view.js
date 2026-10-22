"use strict";

const desktopLib = require("./lib.js");

function xmlEscapeHtml(text) {
  return String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function cellText(value) {
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** `systemState()` is read on every load, not once: the panel's own Start
 *  button creates the launcher after the panel opened, and a reload must see
 *  it (it returns `{launcher, managedUrl}`). */
function openDataPreview(objectType, name, hasMandt, {vscode, output, client, openNotebook, systemState = () => ({}), lib = desktopLib} = {}) {
  const panel = vscode.window.createWebviewPanel("osdDataPreview", `Data Preview ${name}`, vscode.ViewColumn.Beside,
    {enableScripts: true, retainContextWhenHidden: true});
  let allClients = false;
  const load = async () => {
    const rowLimit = vscode.workspace.getConfiguration("osd").get("dataPreview.rowLimit", 100);
    const url = vscode.workspace.getConfiguration("osd").get("url", "http://localhost:3030").replace(/\/+$/, "");
    const {launcher, managedUrl} = systemState();
    const unavailable = lib.dataPreviewAvailability(launcher?.state, managedUrl, url);
    if (unavailable !== undefined) {
      panel.webview.html = dataPreviewHtml(name, {error: unavailable.message, start: unavailable.start});
      return;
    }
    panel.webview.html = dataPreviewHtml(name, {loading: true});
    const statement = lib.dataPreviewQuery(name, {hasMandt, allClients});
    try {
      const result = await client().dataPreview(objectType, name, statement, rowLimit);
      let total;
      if (result.rows.length >= rowLimit) {
        try {
          const count = await client().freestyle(lib.dataPreviewCountQuery(name, {hasMandt, allClients}), 1);
          const first = count.rows[0] ?? {};
          total = Number(first.N ?? first.n ?? Object.values(first)[0]);
        } catch (error) {
          output.appendLine(`osd data preview ${name}: count failed: ${String(error.message ?? error)}`);
        }
      }
      panel.webview.html = dataPreviewHtml(name, {
        objectType, columns: result.columns, rows: result.rows, ms: result.ms, generation: result.generation,
        statement, hasMandt, allClients, status: lib.dataPreviewStatusText(result.rows.length, rowLimit, total),
      });
    } catch (error) {
      const message = lib.dataPreviewError(error, url);
      output.appendLine(`osd data preview ${name}: ${message}`);
      panel.webview.html = dataPreviewHtml(name, {error: message});
    }
  };
  panel.webview.onDidReceiveMessage(async (message) => {
    if (message?.command === "refresh") {
      await load();
    } else if (message?.command === "start") {
      await vscode.commands.executeCommand("osd.start");
      await load();
    } else if (message?.command === "toggleAllClients") {
      allClients = message.value === true;
      await load();
    } else if (message?.command === "openNotebook") {
      await openNotebook(typeof message.statement === "string" ? message.statement : `SELECT * FROM ${name}`);
    }
  });
  return load();
}

function dataPreviewShell(name, body) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: var(--vscode-font-family, sans-serif); font-size: 13px; padding: 8px; color: var(--vscode-foreground); }
  .meta { margin-bottom: 8px; opacity: 0.9; }
  .meta div { margin: 4px 0; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid var(--vscode-panel-border, #555); padding: 4px 8px; text-align: left; white-space: nowrap; }
  th { background: var(--vscode-editor-lineHighlightBackground, #2a2a2a); }
  button { cursor: pointer; }
  label { user-select: none; cursor: pointer; margin-right: 12px; }
  .osd-error { color: var(--vscode-errorForeground, #f66); }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function dataPreviewHtml(name, state = {}, lib = desktopLib) {
  if (state.loading === true) {
    return dataPreviewShell(name, `<p>loading ${xmlEscapeHtml(name)}...</p>`);
  }
  if (state.error !== undefined) {
    return dataPreviewShell(name, `<p class="osd-error">${xmlEscapeHtml(state.error)}</p>
${state.start ? '<button id="start">Start system</button> ' : ""}<button id="refresh">Refresh</button>
<script>
  const vscode = acquireVsCodeApi();
  document.getElementById("refresh").addEventListener("click", () => vscode.postMessage({command: "refresh"}));
  document.getElementById("start")?.addEventListener("click", () => vscode.postMessage({command: "start"}));
</script>`);
  }
  const shown = state.columns.filter((column) => state.allClients || column.name !== "MANDT");
  const thead = shown.map((column) => `<th title="${xmlEscapeHtml(column.name)}">${xmlEscapeHtml(column.label)}</th>`).join("");
  const tbody = state.rows.map((row) => `<tr>${shown.map((column) => `<td>${xmlEscapeHtml(cellText(row[column.name]))}</td>`).join("")}</tr>`).join("");
  const generation = state.generation === undefined ? "" : ` -- ${xmlEscapeHtml(String(state.generation).slice(0, 8))}`;
  const toggle = state.hasMandt
    ? `<label><input type="checkbox" id="all-clients"${state.allClients ? " checked" : ""}> all clients</label>`
    : "";
  const body = `<div class="meta">
  <div>${xmlEscapeHtml(state.objectType)} ${xmlEscapeHtml(name)} -- ${xmlEscapeHtml(state.status)} -- ${state.ms} ms${generation}</div>
  <div>${toggle}<button id="refresh">Refresh</button> <button id="notebook">Open in SQL notebook</button></div>
</div>
<table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>
<script>
  const vscode = acquireVsCodeApi();
  document.getElementById("refresh").addEventListener("click", () => vscode.postMessage({command: "refresh"}));
  document.getElementById("notebook").addEventListener("click", () =>
    vscode.postMessage({command: "openNotebook", statement: ${JSON.stringify(state.statement)}}));
  const allClients = document.getElementById("all-clients");
  if (allClients) allClients.addEventListener("change", () => vscode.postMessage({command: "toggleAllClients", value: allClients.checked}));
</script>`;
  return dataPreviewShell(name, body);
}

module.exports = {dataPreviewHtml, dataPreviewShell, openDataPreview};
