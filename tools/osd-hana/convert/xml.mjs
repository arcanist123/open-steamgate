// The XML layer of the extract converter (tools/osd-hana/convert/): the exact
// shapes abapGit writes, as measured in abapGit's own repository files (the
// oracle) -- a UTF-8 BOM, `<?xml version="1.0" encoding="utf-8"?>`, the
// `<abapGit version=... serializer=...>` tag, the `asx:abap` envelope, ONE
// ELEMENT PER LINE with one space of indentation per depth, text-only leaves
// inline, initial values suppressed (abapGit serializes with
// `initial_components = 'suppress'`, where a NUMC field's initial value is
// zeros, not blanks).
//
// The BOM: abapGit writes XML files through string_to_xstring_utf8_bom -- its
// own tracked files all start with EF BB BF. .abap source files never carry it.

// A source the database holds with CRLF: files carry LF like every other
// source, and always end with one newline.
export const lf = (s) => String(s ?? "").replace(/\r\n/g, "\n").replace(/\n?$/, "\n");

export const xmlEscape = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));

// abapGit names files lower case, and a namespace slash becomes `#` (abapGit's
// filename logic; `/FOO/BAR` -> `#foo#bar` on disk).
export const filename = (s) => String(s).toLowerCase().replaceAll("/", "#");

// trim + upper: the object-name normalisation every comparison here uses.
export const key = (s) => String(s ?? "").trim().toUpperCase();

// ---- element tree --------------------------------------------------------
// A node is `{tag, text}` (a leaf: `<TAG>escaped</TAG>`) or
// `{tag, children}` (a container). Leaves with empty text must not be built:
// abapGit suppresses initial values, so an empty element never appears.

export const leaf = (tag, text) => ({tag, text: String(text)});
export const node = (tag, children) => ({tag, children});

function render(n, depth) {
  const i = " ".repeat(depth);
  if (n.text !== undefined) return `${i}<${n.tag}>${xmlEscape(n.text)}</${n.tag}>\n`;
  return `${i}<${n.tag}>\n${n.children.map((c) => render(c, depth + 1)).join("")}${i}</${n.tag}>\n`;
}

/** An abapGit object XML: BOM, header, `abapGit` tag (with the serializer
 *  attributes only when a serializer is given -- abapGit's per-include
 *  `<abapGit version="v1.0.0">` files carry none), the envelope, the values. */
export function abapgitXmlDoc(serializer, values) {
  const attr = serializer === undefined ? "" : ` serializer="${serializer}" serializer_version="v1.0.0"`;
  return (
    "\uFEFF<?xml version=\"1.0\" encoding=\"utf-8\"?>\n" +
    `<abapGit version="v1.0.0"${attr}>\n` +
    " <asx:abap xmlns:asx=\"http://www.sap.com/abapxml\" version=\"1.0\">\n" +
    "  <asx:values>\n" +
    values.map((v) => render(v, 3)).join("") +
    "  </asx:values>\n" +
    " </asx:abap>\n" +
    "</abapGit>\n"
  );
}

/** The repository's `.abapgit.xml` (abapGit's own tracked form: `asx:abap` at
 *  the top, no `abapGit` wrapper). */
export function repoDotXml({masterLanguage = "E", startingFolder = "/src/", folderLogic}) {
  return (
    "\uFEFF<?xml version=\"1.0\" encoding=\"utf-8\"?>\n" +
    "<asx:abap xmlns:asx=\"http://www.sap.com/abapxml\" version=\"1.0\">\n" +
    " <asx:values>\n" +
    "  <DATA>\n" +
    `   <MASTER_LANGUAGE>${masterLanguage}</MASTER_LANGUAGE>\n` +
    `   <STARTING_FOLDER>${startingFolder}</STARTING_FOLDER>\n` +
    `   <FOLDER_LOGIC>${folderLogic}</FOLDER_LOGIC>\n` +
    "  </DATA>\n" +
    " </asx:values>\n" +
    "</asx:abap>\n"
  );
}

// ---- initial-value rules --------------------------------------------------

// NUMC-style fields: their type-initial value is zeros, so `000000` is as
// initial as a blank and is suppressed, exactly what abapGit's
// `initial_components = 'suppress'` does for them.
const NUMC = new Set(["AUTHCLASS","PROZPUFF","INTLEN","LENG","DECIMALS","DEPTH","OUTPUTSTYLE","DBPOSITION","OUTPUTLEN","HEADLEN","SCRLEN1","SCRLEN2","SCRLEN3","ROUTPUTLEN","VALPOS","KEYFDCOUNT","TYPELEN","SCHFELDANZ","DATMIN","DATMAX","DATAVG","FLPOSITION","SHPOSITION","SHLPSELPOS","SHLPLISPOS","AS4VERS","TABPOS","OBJPOS","POSITION","OFFSET","FLENGTH","EXVFLENGTH","EXVDECIMALS"]);

export function initial(k, v) {
  return (
    v === undefined || v === null || String(v).trim() === "" ||
    (typeof v === "number" && v === 0) ||
    (NUMC.has(k) && /^0+$/.test(String(v).trim()))
  );
}

/** Structure fields in order, initial ones suppressed, as one leaf per field. */
export function elems(order, row, depth = 0) {
  const i = " ".repeat(depth + 4);
  return order
    .filter((k) => !initial(k, row[k]))
    .map((k) => `${i}<${k}>${xmlEscape(String(row[k]).trim())}</${k}>\n`);
}

// ---- text pools -----------------------------------------------------------

// A text pool as REPOTEXT holds it on a Unicode system: one record per entry,
// UTF-16BE -- the entry's length L (two bytes), then ID (1 char), KEY (8) and
// ENTRY (L chars). Anything else (a compressed or foreign row) is null: the
// caller leaves the pool out rather than guess.
export function decodeTextpool(data) {
  if (data === null || data === undefined) return [];
  const hex = String(data).replace(/^0x/i, "");
  if (!hex) return [];
  if (hex.length % 4 || !/^[0-9a-f]*$/i.test(hex)) return null;
  const b = Buffer.from(hex, "hex");
  const out = [];
  const chars = (at, n) => {
    let t = "";
    for (let i = 0; i < n; i++) t += String.fromCharCode(b.readUInt16BE(at + 2 * i));
    return t;
  };
  for (let at = 0; at < b.length;) {
    if (at + 2 > b.length) return null;
    const len = b.readUInt16BE(at);
    const end = at + 2 + 2 * (9 + len);
    if (end > b.length) return null;
    const id = chars(at + 2, 1);
    if (!/^[A-Z]$/.test(id)) return null;
    out.push({ID: id, KEY: chars(at + 4, 8).trimEnd(), ENTRY: chars(at + 20, len).trimEnd(), LENGTH: len});
    at = end;
  }
  return out;
}

// abapGit's <TPOOL> (zcl_abapgit_objects_program add_tpool): a selection text
// (S) is stored as an 8-character control prefix and the text; abapGit moves
// the prefix into SPLIT (c LENGTH 8) and keeps the rest as ENTRY. A blank
// prefix, like a zero LENGTH, is initial and not written.
export function tpoolNode(entries) {
  if (!entries?.length) return undefined;
  const item = (e) => {
    const s = e.ID === "S";
    const children = [];
    const f = (k, v) => {
      if (v === "" || v === undefined || v === 0) return;
      children.push(leaf(k, String(v)));
    };
    f("ID", e.ID);
    f("KEY", e.KEY);
    f("ENTRY", s ? e.ENTRY.slice(8) : e.ENTRY);
    f("LENGTH", e.LENGTH);
    if (s) f("SPLIT", e.ENTRY.slice(0, 8).trimEnd());
    return node("item", children);
  };
  return node("TPOOL", entries.map(item));
}
