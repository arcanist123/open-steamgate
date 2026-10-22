// The JavaScript environment the transpiled ABAP runtime expects, prepared
// before that runtime is imported (preview-backend.mjs imports this first).
//
// The generated CL_SYSTEM_UUID reaches for window.crypto; a service worker has
// the same object on its own global under another name.
globalThis.window ??= globalThis;

// GET TIME STAMP / sy-datum reach the JavaScript Date. Pinning it makes two
// builds of the same code answer with the same bytes, which is what makes
// screenshot diffs between deployments readable.
export const PREVIEW_INSTANT = Date.parse("2026-09-12T10:00:00Z");
const RealDate = Date;
class PreviewDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) {
      super(PREVIEW_INSTANT);
      return;
    }
    super(...args);
  }

  static now() {
    return PREVIEW_INSTANT;
  }
}
// The extension host shares its worker with VS Code. Its clock must stay real;
// the preview service worker keeps the deterministic screenshot clock.
if (globalThis.__stgPreviewFreezeTime !== false) globalThis.Date = PreviewDate;

// The wall clock, for the one thing that must not be pinned.
//
// The status snapshot says when it was taken (web/preview-backend.mjs), and a
// "snapshot taken" frozen at the instant above would be a lie told to keep a
// screenshot diff quiet. Everything the transpiled ABAP asks for stays pinned;
// only this steps outside.
export function realNow() {
  return new RealDate();
}


// Read-only data preview over the connection owned by the browser gateway.
// The JSON door preserves SQLite values; the ADT door renders the XML consumed
// by the existing desktop F8 and notebook parsers.
const DEFAULT_ROWS = 100;
const MAX_ROWS = 1000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const escape = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function limitOf(value) {
  const n = value === undefined ? DEFAULT_ROWS : Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new ReadError("ROW_LIMIT", "rowNumber/max must be a positive integer");
  return Math.min(n, MAX_ROWS);
}

export class ReadError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export async function readQuery(client, statement, requestedMax) {
  const max = limitOf(requestedMax);
  let sql = String(statement ?? "").trim().replace(/;$/, "").trim();
  if (!/^select\b/i.test(sql)) throw new ReadError("NOT_ALLOWED", "only SELECT is allowed here");
  // A semicolon inside the statement would permit a second SQL statement.
  if (sql.includes(";")) throw new ReadError("NOT_ALLOWED", "only one SELECT is allowed here");
  const head = /^(select\s+(?:distinct\s+)?)(.+?)(\s+from\s+)/is.exec(sql);
  if (head && !head[2].includes(",") && /^[A-Za-z_/$][\w/$~]*(?:\s+[A-Za-z_/$][\w/$~]*)+$/.test(head[2].trim())) {
    sql = head[1] + head[2].trim().split(/\s+/).join(", ") + head[3] + sql.slice(head[0].length);
  }
  const upTo = /\s+up\s+to\s+(\d+)\s+rows\b/i.exec(sql);
  if (upTo) sql = sql.replace(upTo[0], "") + ` LIMIT ${upTo[1]}`;
  // The sql.js adapter removes a trailing LIMIT 0 before preparing SQL.
  if (/\s+limit\s+0$/i.test(sql)) {
    return {sql, columns: [], rows: [], count: 0, truncated: false};
  }
  // Bound the query itself, including an explicit LIMIT or UP TO, so the
  // adapter never materialises more rows than the preview can return.
  const bounded = `SELECT * FROM (${sql}) AS osd_preview LIMIT ${max}`;
  const answer = await client.select({select: bounded});
  const rows = (answer.rows ?? []).map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) =>
    [key, typeof value === "string" ? value.trimEnd() : value])));
  return {sql: bounded, columns: rows.length ? Object.keys(rows[0]) : [], rows, count: rows.length, truncated: rows.length === max};
}

function xmlDocument(result, name, kind, fields = []) {
  const {columns, rows} = result;
  const known = new Map(fields.map((field) => [field.name.toUpperCase(), field]));
  const columnXml = columns.map((column) => {
    const field = known.get(column.toUpperCase());
    const value = rows.find((row) => row[column] != null)?.[column];
    const type = typeof value === "number" ? "I" : typeof value === "object" && value !== null ? "X" : "C";
    const metadata = field
      ? `${field.camelCaseName === undefined ? "" : `dataPreview:camelCaseName="${escape(field.camelCaseName)}" `}dataPreview:type="${escape(field.letter)}" dataPreview:description="${escape(field.description || field.name)}" dataPreview:keyAttribute="${field.key === true}" dataPreview:colType="${escape(field.dataType)}" dataPreview:isKeyFigure="false" dataPreview:length="${field.length}" dataPreview:caseSensitive="false"`
      : `dataPreview:type="${type}" dataPreview:description="${escape(column.toUpperCase())}" dataPreview:keyAttribute="false" dataPreview:colType="" dataPreview:isKeyFigure="false"`;
    const cells = rows.map((row) => {
      const cell = row[column];
      return `      <dataPreview:data>${escape(cell == null ? "" : typeof cell === "object" ? Array.from(cell, (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase() : cell)}</dataPreview:data>`;
    }).join("\n");
    return `  <dataPreview:columns>\n    <dataPreview:metadata dataPreview:name="${escape(column.toUpperCase())}" ${metadata}/>\n    <dataPreview:dataSet>\n${cells}\n    </dataPreview:dataSet>\n  </dataPreview:columns>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>\n<dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">\n  <dataPreview:totalRows>${rows.length}</dataPreview:totalRows>${name ? `\n  <dataPreview:name>${escape(name)}</dataPreview:name>` : ""}${kind === "cds" ? `\n  <dataPreview:cdsEntityName>${escape(name)}</dataPreview:cdsEntityName>\n  <dataPreview:cdsCamelCaseName>${escape(name)}</dataPreview:cdsCamelCaseName>` : ""}\n  <dataPreview:isHanaAnalyticalView>false</dataPreview:isHanaAnalyticalView>\n  <dataPreview:executedQueryString>${escape(result.sql)}</dataPreview:executedQueryString>\n  <dataPreview:queryExecutionTime>0</dataPreview:queryExecutionTime>\n${columnXml}\n</dataPreview:tableData>\n`;
}

function response(status, contentType, body) {
  return {status, headers: new Headers({"content-type": contentType}), body: encoder.encode(body)};
}

export async function readRequest(client, {method, path, search = "", body}, previewFields = {}) {
  // The SQLScript notebook door, answered the way the Node host answers it
  // (tools/osd-serve.mjs, mountPortableCells): Portable AMDP over the
  // gateway's own connection. Only on DuckDB here; on sql.js the request
  // falls through to the ABAP sandbox, whose answer is its HANA refusal.
  if (path === "/sap/bc/osd/amdp/cell" && client?.name === "duckdb" && String(method).toUpperCase() === "POST") {
    const {portableCell} = await import("../tools/sqlscript-to-procedure-ir.mjs");
    return response(200, "application/json; charset=utf-8", JSON.stringify(await portableCell(decoder.decode(body ?? new Uint8Array()), client)));
  }
  const json = path === "/osd/sql";
  const match = /^\/sap\/bc\/adt\/datapreview\/(freestyle|ddic|cds)$/.exec(path);
  if (!json && !match) return undefined;
  if (String(method).toUpperCase() !== "POST") return response(405, "application/json", JSON.stringify({error: {code: "METHOD_NOT_ALLOWED", message: "POST required"}}));
  try {
    if (json) {
      const asked = JSON.parse(decoder.decode(body ?? new Uint8Array()));
      const result = await readQuery(client, asked.sql, asked.max);
      return response(200, "application/json", JSON.stringify(result));
    }
    const kind = match[1];
    const query = new URLSearchParams(search.replace(/^\?/, ""));
    const name = kind === "ddic" ? query.get("ddicEntityName") : query.get("ddlSourceName");
    if (kind !== "freestyle") {
      if (!name || !/^[A-Za-z_/$][\w/$]*$/.test(name)) throw new ReadError("INVALID_NAME", "a valid preview object name is required");
      const found = await client.select({select: `SELECT name FROM sqlite_master WHERE lower(name) = lower('${name}') AND type IN ('table', 'view') LIMIT 1`});
      if (!found.rows?.length) throw new ReadError("NOT_FOUND", `${kind === "ddic" ? "TABL" : "DDLS"} ${name.toUpperCase()} does not exist`);
    }
    const statement = decoder.decode(body ?? new Uint8Array()).trim() || `SELECT * FROM ${name}`;
    const result = await readQuery(client, statement, query.get("rowNumber") ?? undefined);
    return response(200, kind === "freestyle" ? "application/xml; charset=utf-8" : "application/vnd.sap.adt.datapreview.table.v1+xml; charset=utf-8", xmlDocument(result, name?.toUpperCase(), kind, previewFields[kind]?.[name?.toUpperCase()]));
  } catch (error) {
    const code = error.code ?? "INVALID_STATEMENT";
    const message = String(error.message || error);
    const status = code === "NOT_FOUND" ? 404 : 400;
    if (json) return response(status, "application/json", JSON.stringify({error: {code, message}}));
    return response(status, "application/xml; charset=utf-8", `<?xml version="1.0" encoding="utf-8"?><exception><message>${escape(message)}</message></exception>`);
  }
}
