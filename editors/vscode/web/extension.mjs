import * as vscode from "vscode";
import {
  Osd, dataPreviewObjectOf, tablHasMandt,
  dataPreviewQuery, dataPreviewCountQuery, dataPreviewStatusText,
  dataPreviewAvailability, dataPreviewError,
  freestyleOutputItems, freestyleTableHtml, htmlEscape, notebookAbapSource, notebookFromJson, notebookToJson,
  sqlNotebookStarter,
} from "../lib.js";
import {openDataPreview} from "../data-preview-view.js";
import {newSqlNotebook, sqlNotebookController, sqlNotebookSerializer} from "../sql-notebook.js";

const SERVICE = "/sap/opu/odata/sap/ZSTG_DEMO_SRV";
const METADATA = `${SERVICE}/$metadata`;
const DB_NAME = "open-steamgate-vscode-web";
const LAST_TRAVEL = "last-travel";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let backendPromise;
let requestQueue = Promise.resolve();
let activationToMetadataMs;
const STATUS = "/sap/opu/odata/sap/ZOSD_STATUS_SRV";
const SERVICE_KINDS = [["ODATA", "OData"], ["APP", "Apps"], ["ICF", "ICF"], ["APC", "APC"]];
const webLib = {
  dataPreviewQuery, dataPreviewCountQuery, dataPreviewStatusText,
  dataPreviewAvailability, dataPreviewError,
  freestyleOutputItems, freestyleTableHtml, htmlEscape, notebookAbapSource, notebookFromJson, notebookToJson,
  sqlNotebookStarter,
};

function transaction(mode, work) {
  return new Promise((resolve, reject) => {
    const opened = indexedDB.open(DB_NAME, 1);
    opened.onupgradeneeded = () => opened.result.createObjectStore("values");
    opened.onerror = () => reject(opened.error);
    opened.onsuccess = () => {
      const db = opened.result;
      let result;
      const tx = db.transaction("values", mode);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
      tx.oncomplete = () => {
        db.close();
        resolve(result);
      };
      const request = work(tx.objectStore("values"));
      request.onsuccess = () => { result = request.result; };
    };
  });
}

const readValue = (key) => transaction("readonly", (store) => store.get(key));
const writeValue = (key, value) => transaction("readwrite", (store) => store.put(value, key));

function backendOf() {
  backendPromise ??= (async () => {
    // preview-backend imports this before the transpiled runtime. Do not pin
    // Date in a worker shared with the VS Code extension host.
    globalThis.__stgPreviewFreezeTime = false;
    const backend = await import("../../../web/preview-backend.mjs");
    if (backend.database !== "sql.js") throw new Error("The web extension requires the sql.js preview build");
    const stored = await readValue(backend.buildId);
    await backend.startBackend(stored && new Uint8Array(stored), {mount: "/", stamp: backend.buildId});
    if (!stored) await writeValue(backend.buildId, await backend.exportDatabase());
    return backend;
  })().catch((error) => {
    backendPromise = undefined;
    throw error;
  });
  return backendPromise;
}

// Keep the request and its snapshot in one queue. The preview backend already
// serializes ABAP requests; this extra queue also orders IndexedDB exports.
function gateway(request) {
  const result = requestQueue.then(async () => {
    const backend = await backendOf();
    const answer = await backend.handleRequest(request);
    if (!["GET", "HEAD"].includes(request.method) && !request.path.startsWith("/sap/bc/adt/datapreview/") && request.path !== "/osd/sql") {
      await writeValue(backend.buildId, await backend.exportDatabase());
    }
    return answer;
  });
  requestQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function send(method, path, {headers = {}, body, search = ""} = {}) {
  const answer = await gateway({
    method, path, search, headers: {
      host: "osd.invalid", "x-forwarded-proto": "https", ...headers,
    }, body: body === undefined ? undefined : encoder.encode(JSON.stringify(body)),
  });
  return {status: answer.status, headers: answer.headers, text: decoder.decode(answer.body)};
}

async function gatewayFetch(input, init = {}) {
  const request = input instanceof Request ? input : new Request(new URL(String(input), "https://osd.invalid"), init);
  const body = ["GET", "HEAD"].includes(request.method) ? undefined : new Uint8Array(await request.arrayBuffer());
  const answer = await gateway({
    method: request.method,
    path: new URL(request.url).pathname,
    search: new URL(request.url).search,
    headers: Object.fromEntries(request.headers.entries()),
    body,
  });
  return new Response([204, 205, 304].includes(answer.status) ? null : answer.body, {
    status: answer.status,
    statusText: {200: "OK", 201: "Created", 202: "Accepted", 204: "No Content", 400: "Bad Request",
      401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed",
      409: "Conflict", 500: "Internal Server Error"}[answer.status] ?? "",
    headers: answer.headers,
  });
}

// The wire format uses base64 because VS Code's webview message transport is
// JSON based. Never decode a multipart body as text on its way to the gateway.
function bytesFromBase64(value) {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Invalid base64 body");
  }
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function base64FromBytes(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value ?? 0);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

function bridgeError(status, detail) {
  const body = encoder.encode(String(detail));
  return {status, statusText: status === 403 ? "Forbidden" : status === 400 ? "Bad Request" : "Bad Gateway",
    headers: [["content-type", "text/plain; charset=utf-8"]], body: base64FromBytes(body)};
}

async function bridgeRequest(message) {
  try {
    if (typeof message.method !== "string" || !/^[A-Z]+$/.test(message.method) ||
        typeof message.path !== "string" || !message.path.startsWith("/") ||
        typeof message.query !== "string" || (message.query && !message.query.startsWith("?")) ||
        !Array.isArray(message.headers)) return bridgeError(400, "Invalid bridge request");
    // Decode each segment once before checking it. URL parsers may already
    // canonicalize literal dot segments; an encoded dot inside a name is fine.
    let segments;
    try { segments = message.path.split("/").map((segment) => decodeURIComponent(segment)); }
    catch { return bridgeError(400, "Malformed percent-encoding in path"); }
    if (!/^\/sap\/(?:opu\/odata\/|bc\/)/i.test(segments.join("/")) ||
        segments.some((segment) => segment === "." || segment === ".." ||
          segment.includes("/") || segment.includes("\\"))) {
      return bridgeError(403, "Path outside the virtual gateway");
    }
    const headers = new Headers(message.headers);
    headers.set("host", "osd.invalid");
    headers.set("x-forwarded-proto", "https");
    const body = bytesFromBase64(message.body ?? "");
    const answer = await gateway({method: message.method, path: message.path, search: message.query,
      headers: Object.fromEntries(headers), body});
    const responseHeaders = new Headers(answer.headers);
    const statusText = {200: "OK", 201: "Created", 202: "Accepted", 204: "No Content",
      400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
      405: "Method Not Allowed", 409: "Conflict", 500: "Internal Server Error"};
    return {status: answer.status, statusText: statusText[answer.status] ?? "",
      headers: Array.from(responseHeaders.entries()), body: base64FromBytes(answer.body)};
  } catch (error) {
    return bridgeError(502, String(error?.message ?? error));
  }
}

async function readProbe() {
  const post = (path, body, search = "") => gateway({method: "POST", path, search,
    headers: {"content-type": path === "/osd/sql" ? "application/json" : "text/plain"},
    body: encoder.encode(path === "/osd/sql" ? JSON.stringify(body) : body)});
  const sql = await post("/osd/sql", {sql: "SELECT * FROM zstg_demo UP TO 5 ROWS", max: 100});
  if (sql.status !== 200) throw new Error(`SQL read: ${sql.status} ${decoder.decode(sql.body)}`);
  const result = JSON.parse(decoder.decode(sql.body));
  if (result.rows.length !== 5 || !result.columns.includes("seats") ||
      typeof result.rows[0].seats !== "number" || result.rows[0].travel_id !== "T0001") {
    throw new Error("SQL read did not return five typed rows");
  }
  const ddic = await post("/sap/bc/adt/datapreview/ddic", "SELECT * FROM zstg_demo", "?ddicEntityName=ZSTG_DEMO&rowNumber=3");
  const xml = decoder.decode(ddic.body);
  if (ddic.status !== 200 || !xml.includes("<dataPreview:columns>") || !xml.includes("<dataPreview:data>")) throw new Error(`DDIC read: ${ddic.status} ${xml.slice(0, 300)}`);
  const capped = await post("/osd/sql", {sql: "SELECT * FROM zstg_demo", max: 2});
  if (capped.status !== 200 || JSON.parse(decoder.decode(capped.body)).rows.length !== 2) throw new Error("SQL row cap failed");
  const invalid = await post("/osd/sql", {sql: "DELETE FROM zstg_demo"});
  const refusal = JSON.parse(decoder.decode(invalid.body));
  if (invalid.status !== 400 || refusal.error?.code !== "NOT_ALLOWED") throw new Error("Invalid SQL was not refused");
  return {sql: sql.status, rows: result.rows.length, ddic: ddic.status, cap: 2, invalid: invalid.status};
}

function required(answer, status, step) {
  if (answer.status !== status) {
    throw new Error(`${step}: expected ${status}, got ${answer.status}: ${answer.text.slice(0, 500)}`);
  }
}

async function statusRows(set) {
  const answer = await send("GET", `${STATUS}/${set}`, {search: "?$format=json", headers: {accept: "application/json"}});
  required(answer, 200, set);
  return JSON.parse(answer.text)?.d?.results ?? [];
}

function serviceName(row) {
  if (row.Kind === "APP" && row.HandlerName) return row.HandlerName;
  const parts = String(row.Path ?? "").split("/").filter(Boolean);
  return parts.at(-1) ?? row.Path ?? "(unnamed)";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[char]);
}

function showServiceDetails(row) {
  const name = serviceName(row);
  const panel = vscode.window.createWebviewPanel("osdWebService", `OSD: ${name}`, vscode.ViewColumn.One);
  panel.webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>body{font:14px system-ui;padding:1rem;color:var(--vscode-foreground)}dt{font-weight:bold;margin-top:1rem}dd{margin:.25rem 0}</style></head>
<body><h1>${escapeHtml(name)}</h1><dl><dt>Kind</dt><dd>${escapeHtml(row.Kind)}</dd><dt>URL</dt><dd>${escapeHtml(row.Path)}</dd></dl></body></html>`;
}

class WebTreeProvider {
  constructor() {
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.system = undefined;
    this.services = [];
    this.error = undefined;
  }

  dispose() { this.emitter.dispose(); }

  async refresh() {
    try {
      const [systems, services] = await Promise.all([statusRows("SystemSet"), statusRows("ServiceSet")]);
      this.system = systems[0];
      this.services = services;
      this.error = undefined;
    } catch (error) {
      this.error = String(error);
    }
    this.emitter.fire();
  }

  getTreeItem(item) { return item; }

  getChildren(item) {
    if (!item) {
      const system = new vscode.TreeItem("System", vscode.TreeItemCollapsibleState.Expanded);
      system.contextValue = "osd-web-system";
      system.iconPath = new vscode.ThemeIcon("server-environment");
      const services = new vscode.TreeItem("Services", vscode.TreeItemCollapsibleState.Expanded);
      services.contextValue = "osd-web-services";
      services.iconPath = new vscode.ThemeIcon("plug");
      return [system, services];
    }
    if (item.contextValue === "osd-web-system") {
      if (this.error) return [new vscode.TreeItem(`Status unavailable: ${this.error}`)];
      if (!this.system) return [new vscode.TreeItem("Loading…")];
      const generation = this.system.GenServing ?? this.system.GenLive ?? this.system.Generation;
      return [
        new vscode.TreeItem("In-browser gateway"),
        new vscode.TreeItem(`Generation: ${generation ?? "unknown"}`),
        new vscode.TreeItem("Database: sql.js + IndexedDB"),
      ];
    }
    if (item.contextValue === "osd-web-services") {
      if (this.error) return [new vscode.TreeItem(`Services unavailable: ${this.error}`)];
      if (!this.system) return [new vscode.TreeItem("Loading…")];
      const kinds = [...SERVICE_KINDS];
      for (const row of this.services) {
        if (!kinds.some(([kind]) => kind === row.Kind)) kinds.push([row.Kind, row.Kind || "Other"]);
      }
      return kinds.map(([kind, label]) => {
        const rows = this.services.filter((row) => row.Kind === kind);
        const group = new vscode.TreeItem(`${label} (${rows.length})`, vscode.TreeItemCollapsibleState.Collapsed);
        group.contextValue = "osd-web-service-group";
        group.kind = kind;
        group.iconPath = new vscode.ThemeIcon("folder");
        return group;
      });
    }
    if (item.contextValue === "osd-web-service-group") {
      return this.services.filter((row) => row.Kind === item.kind).sort((a, b) => a.Path.localeCompare(b.Path)).map((row) => {
        const leaf = new vscode.TreeItem(serviceName(row), vscode.TreeItemCollapsibleState.None);
        leaf.description = row.Path;
        leaf.tooltip = row.Text || row.Path;
        leaf.contextValue = "osd-web-service";
        leaf.iconPath = new vscode.ThemeIcon(row.Kind === "ODATA" ? "database" : row.Kind === "APP" ? "browser" : row.Kind === "APC" ? "broadcast" : "plug");
        leaf.command = row.Kind === "APP" && /^\/app\//.test(row.Path ?? "")
          ? {command: "osd.webOpenApp", title: "Open app", arguments: [row]}
          : {command: "osd.webServiceDetails", title: "Details", arguments: [row]};
        return leaf;
      });
    }
    return [];
  }
}

function travelId() {
  const bytes = crypto.getRandomValues(new Uint8Array(7));
  return "W" + Array.from(bytes, (byte) => (byte % 36).toString(36).toUpperCase()).join("");
}

async function probe(commandStarted) {
  const metadata = await send("GET", METADATA);
  required(metadata, 200, "$metadata");
  const commandToMetadataMs = Math.round(performance.now() - commandStarted);
  const photo = await gateway({method: "GET", path: `${SERVICE}/PhotoSet('T0001')/$value`,
    headers: {host: "osd.invalid", "x-forwarded-proto": "https"}});
  if (photo.status !== 200) throw new Error(`PhotoSet direct GET: ${photo.status}`);
  const photoBytes = photo.body instanceof Uint8Array ? photo.body : new Uint8Array(photo.body);
  const photoDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", photoBytes));
  const photoHash = Array.from(photoDigest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const tokenAnswer = await send("GET", `${SERVICE}/`, {headers: {"x-csrf-token": "fetch"}});
  required(tokenAnswer, 200, "CSRF fetch");
  const token = tokenAnswer.headers.get("x-csrf-token");
  if (!token) throw new Error("CSRF fetch returned no token");
  const id = travelId();
  const description = `Web probe ${id}`;
  const created = await send("POST", `${SERVICE}/TravelSet`, {
    headers: {"content-type": "application/json", "x-csrf-token": token},
    body: {TravelId: id, Description: description},
  });
  required(created, 201, "TravelSet POST");
  const fetched = await send("GET", `${SERVICE}/TravelSet('${id}')`, {headers: {accept: "application/json"}});
  required(fetched, 200, "TravelSet GET");
  const row = JSON.parse(fetched.text).d;
  if (row.TravelId !== id || row.Description !== description) throw new Error("TravelSet GET returned the wrong row");
  await writeValue(LAST_TRAVEL, {id, description});
  return {metadata: metadata.status, post: created.status, get: fetched.status, id, description,
    photo: {status: photo.status, hash: photoHash, bytes: photoBytes.length,
      contentType: photo.headers.get("content-type"), contentLength: photo.headers.get("content-length")},
    activationToMetadataMs, commandToMetadataMs};
}

async function verifyLastTravel() {
  const last = await readValue(LAST_TRAVEL);
  if (!last) throw new Error("No web probe TravelSet row has been recorded");
  const fetched = await send("GET", `${SERVICE}/TravelSet('${last.id}')`, {headers: {accept: "application/json"}});
  required(fetched, 200, "persistent TravelSet GET");
  const row = JSON.parse(fetched.text).d;
  if (row.TravelId !== last.id || row.Description !== last.description) {
    throw new Error("The TravelSet row did not survive the page reload");
  }
  return {get: fetched.status, id: last.id, description: last.description};
}

// Runs in the isolated webview. Keep it self-contained so the exact same
// function is embedded in the generated page and exercises real postMessage.
function webviewRuntime(service) {
  const vscode = acquireVsCodeApi();
  const origin = "https://osd.invalid";
  const encode = new TextEncoder();
  const bridgeFetch = webviewBridge(vscode, service);
  // A later UI5 XHR adapter can install a constructor backed by this fetch.
  window.osdBridge = {fetch: bridgeFetch, installXHR: (factory) => { window.XMLHttpRequest = factory(bridgeFetch); }};
  const result = document.getElementById("result");
  const show = (name, value) => { result.textContent = `${name} ${JSON.stringify(value)}`; };
  const requireStatus = (answer, status, step) => {
    if (answer.status !== status) throw new Error(`${step}: ${answer.status} ${answer.statusText}`);
  };
  const freshId = () => "W" + Array.from(crypto.getRandomValues(new Uint8Array(7)),
    (byte) => (byte % 36).toString(36).toUpperCase()).join("");
  let saved;
  window.addEventListener("message", (event) => {
    if (event.data?.type === "probe-saved") saved?.();
  });
  async function runProbe() {
    try {
      const metadata = await bridgeFetch("$metadata");
      requireStatus(metadata, 200, "metadata");
      const metadataText = await metadata.text();
      if (!metadata.headers.get("content-type")?.includes("xml") || !metadataText.includes("Edmx")) throw new Error("metadata body or content-type missing");
      const tokenResponse = await bridgeFetch("./?probe=csrf", {headers: {"x-csrf-token": "fetch"}});
      requireStatus(tokenResponse, 200, "token");
      const token = tokenResponse.headers.get("x-csrf-token");
      if (!token || !(await tokenResponse.text())) throw new Error("CSRF response missing token or body");
      const id = freshId();
      const description = `Webview probe ${id}`;
      const created = await bridgeFetch("TravelSet", {method: "POST",
        headers: {"content-type": "application/json", "x-csrf-token": token},
        body: JSON.stringify({TravelId: id, Description: description})});
      requireStatus(created, 201, "POST");
      const location = created.headers.get("location");
      if (!location?.includes(`TravelSet('${id}')`) || !created.headers.get("content-type")?.includes("json") ||
          !(await created.text()).includes(id)) throw new Error("POST response headers or body missing");
      const fetched = await bridgeFetch(`TravelSet('${id}')?$format=json`, {headers: {accept: "application/json"}});
      requireStatus(fetched, 200, "GET");
      const row = (await fetched.json()).d;
      if (row.TravelId !== id || row.Description !== description || !fetched.headers.get("content-type")?.includes("json")) throw new Error("GET response mismatch");
      const filtered = await bridgeFetch(`TravelSet?$filter=${encodeURIComponent(`TravelId eq '${id}'`)}&$format=json`);
      requireStatus(filtered, 200, "filtered GET");
      const filteredRows = (await filtered.json()).d.results;
      if (filteredRows.length !== 1 || filteredRows[0].TravelId !== id) throw new Error("query was not forwarded");
      const refused = await bridgeFetch(`${origin}/outside`);
      requireStatus(refused, 403, "path guard");
      const batchId = freshId();
      const boundary = `batch_${batchId}`;
      const change = `change_${batchId}`;
      const batchBody = [
        `--${boundary}`, "Content-Type: application/http", "Content-Transfer-Encoding: binary", "",
        "GET TravelSet?$top=1&$format=json HTTP/1.1", "Accept: application/json", "", "",
        `--${boundary}`, `Content-Type: multipart/mixed; boundary=${change}`, "",
        `--${change}`, "Content-Type: application/http", "Content-Transfer-Encoding: binary", "",
        "POST TravelSet HTTP/1.1", "Content-Type: application/json", "",
        JSON.stringify({TravelId: batchId, Description: `Batch café ${batchId}`}),
        `--${change}--`, "", `--${boundary}--`, "",
      ].join("\r\n");
      const bodyBytes = encode.encode(batchBody);
      const batch = await bridgeFetch("$batch", {method: "POST",
        headers: {"content-type": `multipart/mixed; boundary=${boundary}`, "x-csrf-token": token}, body: bodyBytes});
      if (batch.status !== 202) throw new Error(`batch: ${batch.status} ${await batch.text()}`);
      const batchText = await batch.text();
      if (!batch.headers.get("content-type")?.includes("multipart/mixed") ||
          !batchText.includes("HTTP/1.1 200 OK") || !batchText.includes("HTTP/1.1 201 Created") ||
          !batchText.includes(batchId)) throw new Error("batch response mismatch");
      const batchRow = await bridgeFetch(`TravelSet('${batchId}')?$format=json`);
      requireStatus(batchRow, 200, "batch row");
      if ((await batchRow.json()).d.Description !== `Batch café ${batchId}`) throw new Error("batch bytes changed");
      const stored = new Promise((resolve) => { saved = resolve; });
      vscode.postMessage({type: "probe-complete", id, description});
      await stored;
      show("OSD_WEBVIEW_PROBE", {metadata: metadata.status, csrf: tokenResponse.status, post: created.status,
        get: fetched.status, filtered: filtered.status, forbidden: refused.status,
        batch: batch.status, batchGet: batchRow.status, id, description,
        contentType: fetched.headers.get("content-type"), token, location});
    } catch (error) { show("OSD_WEBVIEW_ERROR", {error: String(error?.stack ?? error)}); }
  }
  window.addEventListener("message", async (event) => {
    if (event.data?.type !== "last-travel") return;
    try {
      const last = event.data.value;
      if (!last) return;
      const answer = await bridgeFetch(`TravelSet('${last.id}')?$format=json`);
      requireStatus(answer, 200, "reload GET");
      const row = (await answer.json()).d;
      if (row.TravelId !== last.id || row.Description !== last.description ||
          !answer.headers.get("content-type")?.includes("json")) throw new Error("reload row mismatch");
      show("OSD_WEBVIEW_VERIFY", {get: answer.status, id: last.id, description: row.Description});
    } catch (error) { show("OSD_WEBVIEW_ERROR", {error: String(error?.stack ?? error)}); }
  });
  document.getElementById("run").onclick = runProbe;
  document.getElementById("verify").onclick = () => vscode.postMessage({type: "get-last-travel"});
  vscode.postMessage({type: "ready"});
}

// The postMessage transport of a webview page, shared by the probe view and
// the Fiori view. Self-contained: it is embedded in the page as source text.
function webviewBridge(vscode, service) {
  const origin = "https://osd.invalid";
  const pending = new Map();
  let nextId = 1;
  const encode = new TextEncoder();
  const toBase64 = (bytes) => {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(binary);
  };
  const fromBase64 = (value) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message?.type === "fetch-result" && pending.has(message.id)) {
      pending.get(message.id)(message.response);
      pending.delete(message.id);
    }
  });
  return async function bridgeFetch(input, init = {}) {
    const source = input instanceof Request ? input : null;
    const url = new URL(source?.url ?? input, `${origin}${service}/`);
    if (url.origin !== origin) throw new TypeError("URL outside the virtual gateway");
    const method = String(init.method ?? source?.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers ?? source?.headers ?? {});
    let body = init.body;
    if (body === undefined && source && method !== "GET" && method !== "HEAD") body = await source.arrayBuffer();
    if (body instanceof URLSearchParams) {
      if (!headers.has("content-type")) headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
      body = body.toString();
    } else if (typeof body === "string" && !headers.has("content-type")) {
      headers.set("content-type", "text/plain;charset=UTF-8");
    } else if (body instanceof Blob) {
      if (body.type && !headers.has("content-type")) headers.set("content-type", body.type);
    }
    if (body instanceof Blob) body = await body.arrayBuffer();
    const bytes = body === undefined || body === null ? new Uint8Array(0)
      : typeof body === "string" ? encode.encode(body)
      : body instanceof ArrayBuffer ? new Uint8Array(body)
      : ArrayBuffer.isView(body) ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
      : (() => { throw new TypeError("Unsupported request body"); })();
    const id = nextId++;
    const answer = new Promise((resolve) => pending.set(id, resolve));
    vscode.postMessage({type: "fetch", id, method, path: url.pathname, query: url.search,
      headers: Array.from(headers.entries()), body: toBase64(bytes)});
    const response = await answer;
    return new Response([204, 205, 304].includes(response.status) ? null : fromBase64(response.body), {status: response.status,
      statusText: response.statusText, headers: response.headers});
  };
}

function webviewHtml(nonce) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<style>body{font:14px system-ui;padding:1rem}pre{white-space:pre-wrap}</style></head>
<body><h1>OSD web gateway</h1><button id="run">Run write and batch probe</button>
<button id="verify">Verify saved row</button><pre id="result">Waiting</pre>
<script nonce="${nonce}">${webviewBridge.toString()}
(${webviewRuntime.toString()})(${JSON.stringify(SERVICE)});</script></body></html>`;
}

// Runs first in a Fiori page inside a webview, before the UI5 bootstrap. UI5,
// datajs and launchpad.js reach the gateway through XMLHttpRequest and fetch
// at app-relative URLs ("../sap/opu/odata/..." from the app folder, or
// "/sap/bc/..."); those resolve inside the webview's resource origin, which
// serves files only. Such URLs go to the extension's in-worker gateway over
// the postMessage bridge; everything else (the UI5 CDN, the app's own files)
// stays on the browser's own XMLHttpRequest and fetch.
function fioriRuntime(config) {
  const vscode = acquireVsCodeApi();
  const bridgeFetch = webviewBridge(vscode, "/sap/opu/odata/sap");
  const mount = new URL(config.mount);
  const stats = {bridged: 0, bridgedSync: [], localSync: [], nativeSync: [], errors: []};
  // vscode.dev is cross-origin isolated and so is every webview frame in it
  // (COEP require-corp). The UI5 CDN answers CORS (access-control-allow-origin
  // *) but sends no Cross-Origin-Resource-Policy, so a plain <script>, <link>
  // or <img> from it is blocked there, and only a CORS-mode load passes. UI5
  // creates those elements itself (ui5loader, theming), so every one aimed at
  // the CDN is switched to crossorigin="anonymous" before its URL is set.
  // Harmless where the page is not isolated (desktop, @vscode/test-web).
  const cdn = (value) => {
    try { return new URL(String(value), document.baseURI).origin === "https://ui5.sap.com"; } catch { return false; }
  };
  for (const [type, attribute] of [[HTMLScriptElement, "src"], [HTMLLinkElement, "href"], [HTMLImageElement, "src"]]) {
    const descriptor = Object.getOwnPropertyDescriptor(type.prototype, attribute);
    Object.defineProperty(type.prototype, attribute, {...descriptor, set(value) {
      if (cdn(value) && this.crossOrigin === null) this.crossOrigin = "anonymous";
      descriptor.set.call(this, value);
    }});
  }
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if ((name === "src" || name === "href") && cdn(value) && "crossOrigin" in this && this.crossOrigin === null) {
      this.crossOrigin = "anonymous";
    }
    return setAttribute.call(this, name, value);
  };
  // A virtual path of the gateway, or undefined for a URL the browser loads.
  const virtualOf = (input) => {
    let url;
    try { url = new URL(String(input), document.baseURI); } catch { return undefined; }
    if (url.origin !== mount.origin) return undefined;
    const path = url.pathname.startsWith(mount.pathname) ? "/" + url.pathname.slice(mount.pathname.length) : url.pathname;
    return /^\/sap\/(?:opu\/odata|bc)\//i.test(path) || path === config.sandboxConfigPath ? path + url.search : undefined;
  };
  // The launchpad sandbox asks for an optional config at an absolute path
  // with a synchronous request. The answer is a constant (an empty merge, as
  // tools/osd-sandbox-config.mjs serves it), so it is answered in the page.
  const localAnswer = (path) => path.split("?")[0] === config.sandboxConfigPath
    ? {status: 200, statusText: "OK", headers: new Headers({"content-type": "application/json"}), bytes: new TextEncoder().encode(config.sandboxConfigBody)}
    : undefined;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const path = virtualOf(input instanceof Request ? input.url : input);
    if (path === undefined) return nativeFetch(input, init);
    stats.bridged++;
    return bridgeFetch(`https://osd.invalid${path}`, input instanceof Request && init === undefined ? input : init ?? {});
  };
  const Native = window.XMLHttpRequest;
  const decoder = new TextDecoder();
  class OsdXMLHttpRequest extends Native {
    open(method, url, async = true, user, password) {
      const path = virtualOf(url);
      this.osd = undefined;
      if (path === undefined) {
        if (async === false) stats.nativeSync.push(String(url));
        return arguments.length > 2 ? super.open(method, url, async, user, password) : super.open(method, url);
      }
      this.osd = {method: String(method).toUpperCase(), path, async: async !== false, headers: new Headers(),
        readyState: 1, status: 0, statusText: "", responseHeaders: new Headers(), bytes: new Uint8Array(0),
        url: new URL(String(url), document.baseURI).href, aborted: false, sent: false};
      this.osdFire("readystatechange");
    }
    osdFire(type, progress) {
      this.dispatchEvent(progress ? new ProgressEvent(type, progress) : new Event(type));
    }
    setRequestHeader(name, value) {
      if (!this.osd) return super.setRequestHeader(name, value);
      if (this.osd.readyState !== 1 || this.osd.sent) throw new DOMException("The object's state must be OPENED.", "InvalidStateError");
      this.osd.headers.append(name, value);
    }
    send(body) {
      const state = this.osd;
      if (!state) return super.send(body);
      if (state.readyState !== 1 || state.sent) throw new DOMException("The object's state must be OPENED.", "InvalidStateError");
      state.sent = true;
      const finish = (answer) => {
        state.status = answer.status;
        state.statusText = answer.statusText;
        state.responseHeaders = answer.headers;
        state.bytes = answer.bytes;
        for (const ready of [2, 3, 4]) {
          state.readyState = ready;
          this.osdFire("readystatechange");
        }
        const progress = {lengthComputable: true, loaded: answer.bytes.length, total: answer.bytes.length};
        this.osdFire("load", progress);
        this.osdFire("loadend", progress);
      };
      const fail = (error) => {
        stats.errors.push(`${state.method} ${state.path}: ${error?.message ?? error}`);
        state.readyState = 4;
        state.status = 0;
        this.osdFire("readystatechange");
        this.osdFire("error", {lengthComputable: false, loaded: 0, total: 0});
        this.osdFire("loadend", {lengthComputable: false, loaded: 0, total: 0});
      };
      if (!state.async) {
        // A webview's message channel is asynchronous, so a synchronous
        // gateway request cannot be answered. Record it and fail it the way a
        // synchronous network error fails, unless the answer is a constant.
        const local = localAnswer(state.path);
        if (local) {
          stats.localSync.push(state.path);
          finish(local);
          return;
        }
        stats.bridgedSync.push(`${state.method} ${state.path}`);
        state.readyState = 4;
        throw new DOMException(`Synchronous request to the in-worker gateway is not supported: ${state.method} ${state.path}`, "NetworkError");
      }
      this.osdFire("loadstart", {lengthComputable: false, loaded: 0, total: 0});
      const local = localAnswer(state.path);
      if (local) {
        queueMicrotask(() => { if (!state.aborted) finish(local); });
        return;
      }
      stats.bridged++;
      const payload = body === undefined || body === null || ["GET", "HEAD"].includes(state.method) ? undefined
        : body instanceof Document ? new XMLSerializer().serializeToString(body) : body;
      bridgeFetch(`https://osd.invalid${state.path}`, {method: state.method, headers: state.headers, body: payload})
        .then(async (response) => {
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (!state.aborted) finish({status: response.status, statusText: response.statusText, headers: response.headers, bytes});
        }, (error) => { if (!state.aborted) fail(error); });
    }
    abort() {
      const state = this.osd;
      if (!state) return super.abort();
      if (state.aborted || state.readyState === 4 && !state.sent) return;
      state.aborted = true;
      const active = state.sent && state.readyState !== 4;
      state.readyState = 4;
      state.status = 0;
      if (active) {
        this.osdFire("readystatechange");
        this.osdFire("abort", {lengthComputable: false, loaded: 0, total: 0});
        this.osdFire("loadend", {lengthComputable: false, loaded: 0, total: 0});
      }
      state.readyState = 0;
    }
    getResponseHeader(name) {
      if (!this.osd) return super.getResponseHeader(name);
      return this.osd.readyState >= 2 ? this.osd.responseHeaders.get(name) : null;
    }
    getAllResponseHeaders() {
      if (!this.osd) return super.getAllResponseHeaders();
      if (this.osd.readyState < 2) return "";
      return Array.from(this.osd.responseHeaders.entries(), ([name, value]) => `${name}: ${value}\r\n`).join("");
    }
    overrideMimeType(mime) {
      if (!this.osd) return super.overrideMimeType(mime);
      this.osd.mime = mime;
    }
    get readyState() { return this.osd ? this.osd.readyState : super.readyState; }
    get status() { return this.osd ? this.osd.status : super.status; }
    get statusText() { return this.osd ? this.osd.statusText : super.statusText; }
    get responseURL() { return this.osd ? (this.osd.readyState === 4 && this.osd.status ? this.osd.url : "") : super.responseURL; }
    get responseText() {
      if (!this.osd) return super.responseText;
      if (this.responseType !== "" && this.responseType !== "text") throw new DOMException("responseText needs responseType text", "InvalidStateError");
      return this.osd.readyState >= 3 ? decoder.decode(this.osd.bytes) : "";
    }
    get responseXML() {
      if (!this.osd) return super.responseXML;
      if (this.osd.readyState !== 4 || !this.osd.status) return null;
      const type = this.osd.mime ?? this.osd.responseHeaders.get("content-type") ?? "";
      if (this.responseType === "document" || /[/+]xml\b/i.test(type)) {
        const document = new DOMParser().parseFromString(decoder.decode(this.osd.bytes), "application/xml");
        return document.querySelector("parsererror") ? null : document;
      }
      return null;
    }
    get response() {
      if (!this.osd) return super.response;
      const type = this.responseType;
      if (type === "" || type === "text") return this.responseText;
      if (this.osd.readyState !== 4) return null;
      const bytes = this.osd.bytes;
      if (type === "arraybuffer") return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      if (type === "blob") return new Blob([bytes], {type: this.osd.responseHeaders.get("content-type") ?? ""});
      if (type === "document") return this.responseXML;
      if (type === "json") {
        try { return JSON.parse(decoder.decode(bytes)); } catch { return null; }
      }
      return null;
    }
  }
  window.XMLHttpRequest = OsdXMLHttpRequest;
  window.osdBridge = {fetch: bridgeFetch, stats, virtualOf};
  // CSP refusals are kept so a test (and a developer) can see what the
  // policy blocked instead of guessing from a blank page.
  document.addEventListener("securitypolicyviolation", (event) => {
    stats.errors.push(`CSP ${event.violatedDirective} ${event.blockedURI}`);
  });
  // The component URLs of the launchpad's applications point at the BSP path
  // the gateway serves on a system (../sap/bc/ui5_ui5/<ns>/<app>/). Script
  // tags cannot travel over the message bridge, so a UI5 application this
  // extension ships is loaded from its copy under dist/web/app instead.
  window.osdRebaseApplications = () => {
    const applications = window["sap-ushell-config"]?.applications ?? {};
    for (const intent of Object.keys(applications)) {
      const app = applications[intent];
      const component = /^SAPUI5\.Component=(.+)$/.exec(app.additionalInformation ?? "")?.[1];
      if (component && config.components[component] !== undefined && /\/sap\/bc\/ui5_ui5\//.test(app.url ?? "")) {
        app.url = config.appBase + config.components[component];
      }
    }
  };
  if (config.hash && window.location.hash !== config.hash) window.location.hash = config.hash;
}

function fioriPage(source, {nonce, cspSource, appBase, pageBase, mount, hash, apps}) {
  // Why each source is allowed:
  // - 'nonce-…': the page's own inline scripts and this bridge, nothing else inline;
  // - https://ui5.sap.com: SAPUI5 core, libraries, themes and fonts from SAP's CDN, as the app loads them everywhere;
  // - cspSource: the app's own files (Component.js, manifest, i18n, annotations, images) copied into dist/web/app;
  // - style-src 'unsafe-inline': UI5 renderers write style attributes and the pages carry <style> blocks;
  // - img-src data: blob:: UI5 icons and theme images as data URIs.
  // connect-src has no gateway origin: the gateway is reached by postMessage only.
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' https://ui5.sap.com ${cspSource}`,
    `style-src 'unsafe-inline' https://ui5.sap.com ${cspSource}`,
    `font-src https://ui5.sap.com ${cspSource}`,
    `img-src https://ui5.sap.com ${cspSource} data: blob:`,
    `connect-src https://ui5.sap.com ${cspSource}`,
  ].join("; ");
  const config = {mount, appBase, hash, components: apps.components, sandboxConfigPath: apps.sandboxConfigPath,
    sandboxConfigBody: apps.sandboxConfigBody};
  const head = `<meta http-equiv="Content-Security-Policy" content="${csp}">
<base href="${pageBase}">
<script nonce="${nonce}">${webviewBridge.toString()}
${fioriRuntime.toString()}
fioriRuntime(${JSON.stringify(config).replace(/</g, "\\u003c")});</script>`;
  let html = source.replace(/<head>/i, `<head>\n${head}`);
  html = html.replace(/<script\b(?![^>]*\bnonce=)/gi, `<script nonce="${nonce}"`);
  // The launchpad's own config script ends before the sandbox bootstrap tag.
  html = html.replace(/<script nonce="[^"]*" src="[^"]*\/sap\/ushell\/bootstrap\/sandbox\.js"/,
    (tag) => `<script nonce="${nonce}">window.osdRebaseApplications();</script>\n  ${tag}`);
  // The page's own CDN tags load in CORS mode too (see fioriRuntime: COEP).
  // After the rebase insertion above, whose pattern expects <script nonce=... src=...>.
  html = html.replace(/<(script|link)\b(?![^>]*\bcrossorigin)([^>]*\b(?:src|href)="https:\/\/ui5\.sap\.com\/)/gi,
    (_, tag, rest) => `<${tag} crossorigin="anonymous"${rest}`);
  return html;
}

const fioriPanels = new Map();

async function openFioriPage(context, path) {
  const match = /^\/app\/((?:[\w-]+\/)*[\w-]+\.html)(#[^\s]*)?$/.exec(path ?? "");
  if (!match) throw new Error(`Not a page of the bundled apps: ${path}`);
  const [, page, hash = ""] = match;
  const appRoot = vscode.Uri.joinPath(context.extensionUri, "dist", "web", "app");
  const source = decoder.decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(appRoot, ...page.split("/"))));
  const apps = JSON.parse(decoder.decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(appRoot, "osd-web-apps.json"))));
  const title = page === "flp.html" ? "Fiori Launchpad" : `Fiori: ${page.replace(/\/?index\.html$/, "") || "Travels"}`;
  let panel = fioriPanels.get(page);
  if (panel) {
    panel.reveal();
  } else {
    panel = vscode.window.createWebviewPanel("osdWebFiori", title, vscode.ViewColumn.One,
      {enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [appRoot]});
    fioriPanels.set(page, panel);
    panel.onDidDispose(() => fioriPanels.delete(page));
    panel.webview.onDidReceiveMessage(async (message) => {
      if (message?.type === "fetch" && Number.isSafeInteger(message.id)) {
        const response = await bridgeRequest(message);
        await panel.webview.postMessage({type: "fetch-result", id: message.id, response});
      }
    });
  }
  const webviewRoot = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "dist", "web")).toString().replace(/\/?$/, "/");
  const appBase = `${webviewRoot}app/`;
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  panel.webview.html = fioriPage(source, {nonce, cspSource: panel.webview.cspSource, appBase,
    pageBase: appBase + page.slice(0, page.lastIndexOf("/") + 1), mount: webviewRoot,
    hash: hash || (page === "flp.html" ? "#Shell-home" : ""), apps});
  return panel;
}

export async function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand("osd.prepareAbapgitZip", () =>
    vscode.window.showErrorMessage("osd: Preparing an abapGit zip needs a desktop open-steamgate checkout with deploy/manifest.json, source files and Node tools. The web build has no file system or process runner.")));
  const started = performance.now();
  await vscode.commands.executeCommand("setContext", "osd.web", true);
  const output = vscode.window.createOutputChannel("OSD Web Probe");
  context.subscriptions.push(output);
  const webClient = () => new Osd("https://osd.invalid", gatewayFetch);
  const openWebDataPreview = async () => {
    const editor = vscode.window.activeTextEditor;
    const preview = editor === undefined ? undefined : dataPreviewObjectOf(editor.document.fileName);
    if (preview === undefined) {
      vscode.window.showErrorMessage("osd: Open a TABL or DDLS source before running Data Preview.");
      return;
    }
    await openDataPreview(preview.type, preview.name, preview.type === "TABL" && tablHasMandt(editor.document.getText()), {
      vscode, output, client: webClient, managedUrl: "https://osd.invalid", openNotebook: (statement) => newSqlNotebook(vscode, "osd-sql-notebook", statement),
      lib: webLib,
    });
  };
  const loggedWebDataPreview = async () => {
    try {
      await openWebDataPreview();
    } catch (error) {
      console.error(error);
      output.appendLine(`OSD_WEB_DATA_PREVIEW_ERROR ${String(error?.stack ?? error)}`);
      throw error;
    }
  };
  const run = (label, work) => async () => {
    const commandStarted = performance.now();
    output.show(true);
    try {
      const result = await work(commandStarted);
      output.appendLine(`${label} ${JSON.stringify(result)}`);
      return result;
    } catch (error) {
      output.appendLine(`${label}_ERROR ${String(error?.stack ?? error)}`);
      throw error;
    }
  };
  context.subscriptions.push(vscode.commands.registerCommand("osd.webProbe", run("OSD_WEB_PROBE", probe)));
  context.subscriptions.push(vscode.commands.registerCommand("osd.webReadProbe", run("OSD_WEB_READ", readProbe)));
  context.subscriptions.push(vscode.commands.registerCommand("osd.webVerifyLastTravel", run("OSD_WEB_VERIFY", verifyLastTravel)));
  context.subscriptions.push(vscode.commands.registerCommand("osd.webProbeView", () => {
    const panel = vscode.window.createWebviewPanel("osdWebProbe", "OSD web gateway", vscode.ViewColumn.One, {enableScripts: true});
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    panel.webview.onDidReceiveMessage(async (message) => {
      if (message?.type === "fetch" && Number.isSafeInteger(message.id)) {
        const response = await bridgeRequest(message);
        await panel.webview.postMessage({type: "fetch-result", id: message.id, response});
      } else if (message?.type === "probe-complete" && /^W[A-Z0-9]{7}$/.test(message.id) &&
                 typeof message.description === "string") {
        await writeValue(LAST_TRAVEL, {id: message.id, description: message.description});
        await panel.webview.postMessage({type: "probe-saved"});
      } else if (message?.type === "get-last-travel") {
        await panel.webview.postMessage({type: "last-travel", value: await readValue(LAST_TRAVEL)});
      }
    });
    panel.webview.html = webviewHtml(nonce);
  }));
  const tree = new WebTreeProvider();
  context.subscriptions.push(tree, vscode.window.registerTreeDataProvider("osdTree", tree));
  context.subscriptions.push(vscode.commands.registerCommand("osd.refreshTree", () => tree.refresh()));
  context.subscriptions.push(vscode.commands.registerCommand("osd.webServiceDetails", showServiceDetails));
  context.subscriptions.push(vscode.commands.registerCommand("osd.webOpenLaunchpad", () => openFioriPage(context, "/app/flp.html#Shell-home")));
  context.subscriptions.push(vscode.commands.registerCommand("osd.webOpenApp", (row) => openFioriPage(context, row?.Path)));
  context.subscriptions.push(vscode.commands.registerCommand("osd.webDataPreview", loggedWebDataPreview));
  context.subscriptions.push(vscode.commands.registerCommand("osd.newSqlNotebook", (statement) => newSqlNotebook(vscode, "osd-sql-notebook", statement, webLib)));
  context.subscriptions.push(vscode.workspace.registerNotebookSerializer("osd-sql-notebook", sqlNotebookSerializer(vscode, (text) => new TextEncoder().encode(text), webLib)));
  context.subscriptions.push(sqlNotebookController(vscode, {
    output,
    client: webClient,
    lib: webLib,
    // The bundled worker exposes the ADT freestyle door, not the AMDP or
    // notebook classrun doors used by the desktop kernel.
    isCellAvailable: async (language) => language === "sql",
  }));
  try {
    const metadata = await send("GET", METADATA);
    required(metadata, 200, "activation $metadata");
    activationToMetadataMs = Math.round(performance.now() - started);
    output.appendLine(`OSD_WEB_READY ${JSON.stringify({activationToMetadataMs})}`);
    await tree.refresh();
  } catch (error) {
    output.appendLine(`OSD_WEB_BOOT_ERROR ${String(error?.stack ?? error)}`);
    throw error;
  }
}

export function deactivate() {}
