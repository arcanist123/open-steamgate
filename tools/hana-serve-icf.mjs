// hana-serve's two readings of a tenant beyond OData (docs/hana-serve-icf.md):
// the ICF tree, as the routes the host mounts, and SMW0's MIME objects, as
// the bytes WWWDATA_IMPORT hands the ABAP. Both read the tenant's own rows
// through the shadow schema (tools/hana-shadow-schema.mjs: a synonym for a
// client-independent table, made at connect or by the 259 fallback), on the
// ABAP's own connection, and both are reads.
//
// ICF. The tenant's ICFSERVICE carries no URL column and no ICFACTIVE --
// this tree's own table (src/osd/ddic/icfservice.tabl.xml) has both, which
// is why tools/osd-icf-routing.mjs cannot read a tenant's rows. A node's
// path is the walk up its ICFPARGUID chain to the virtual host: one segment
// per node, the external name (ICFALTNME) where the node has one, else
// ICF_NAME, lower case (a system matches a path without regard to case, and
// so does express). The virtual host itself is not a segment; a node whose
// chain does not reach a host -- a parent not among the rows -- is not
// served. Activation is not among these rows: a system keeps it in
// ICFSERVLOC (ICFACTIVE = 'X', measured on the bed 2026-11-18: 327 of 3444
// rows active, the rescued node's among them). A node is served only when it
// and every node above it up to the host have an active row; a node without
// a row is not active. ICFSERVLOC is read schema-qualified on the tenant
// (client-independent, so it reads what a synonym would) to make no shadow
// object for it; when it cannot be read, activation is unknown, every node
// with a handler counts as active, and the startup line says so loudly.
//
// A node is mounted only when its handler class is in the generation: a
// system's tree names hundreds of handlers, and the island holds the few the
// rescued code brings. Only a node with exactly ONE handler row is served:
// a system runs a chain in ICFORDER until one handler answers, which this
// host does not do, so a chain of several is counted and not mounted (13
// nodes on the bed). Only ICFTYP A (an ABAP class) is served, the rule
// tools/osd-icf.mjs follows for the tree's own nodes. Two nodes on one path
// (spelled apart only by case) keep the first, and the count says so.
//
// W3MI. The runtime's WWWDATA_IMPORT (open-abap-core) answers a key from
// abap.W3MI -- an object the build knows -- by asking abap.W3MI_LOADER when a
// host installed one, else the disk. installW3mi registers every MI object
// of the tenant's WWWPARAMS (at boot, one read) and installs a loader that
// reads the object's WWWDATA rows when it is asked for, joins the
// fragments and decodes the cluster (./protocols/sap-cluster.mjs). An object
// the generation brought itself keeps being read from the disk, unless the
// tenant holds the same name: on this host the tenant is the system.
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {isAbsolute, join, relative} from "node:path";
import {joinFragments, mimeBytes, parseCluster} from "./protocols/sap-cluster.mjs";

const up = (v) => String(v ?? "").trim().toUpperCase();
const field = (row, name) => row?.[name.toLowerCase()] ?? row?.[name];

/** a parent GUID that names no node: a virtual host's parent */
const isNoParent = (guid) => /^(?:0+|F+)$/i.test(String(guid ?? "").trim());

/** One route per servable node of the tenant's ICF tree, longest path first:
 *  {path, name, handler, icftyp, type, active, travels, source}. `host` is the
 *  virtual host served (DEFAULT_HOST). `ICFSERVLOC` undefined means activation
 *  is unknown (every node counts as active). `counts` says what was not served. */
export function tenantServices({ICFSERVICE = [], ICFHANDLER = [], ICFSERVLOC} = {}, {host = "DEFAULT_HOST"} = {}) {
  const nodes = new Map();
  for (const row of ICFSERVICE) {
    const guid = up(field(row, "ICFNODGUID"));
    if (guid !== "") nodes.set(guid, row);
  }
  const segment = (row) => (String(field(row, "ICFALTNME") ?? "").trim() || String(field(row, "ICF_NAME") ?? "").trim()).toLowerCase();
  const key = (row) => `${up(field(row, "ICF_NAME"))} ${up(field(row, "ICFPARGUID"))}`;
  const activeRows = ICFSERVLOC === undefined ? undefined
    : new Set(ICFSERVLOC.filter((r) => up(field(r, "ICFACTIVE")) === "X").map(key));
  const pathOf = (row) => {
    const segments = [];
    const seen = new Set();
    const chain = [];
    let at = row;
    for (;;) {
      const parent = up(field(at, "ICFPARGUID"));
      const above = nodes.get(parent);
      if (above === undefined) {
        // `at` is the top of the chain: a virtual host, or an orphan
        if (isNoParent(parent) === false || up(field(at, "ICF_NAME")) !== up(host)) return undefined;
        return segments.length === 0 ? undefined : {path: `/${segments.reverse().join("/")}`, chain};
      }
      if (seen.has(parent)) return undefined; // a cycle is no path
      seen.add(parent);
      segments.push(segment(at));
      chain.push(at);
      at = above;
    }
  };
  const handlers = new Map();
  for (const h of ICFHANDLER) {
    const key = `${up(field(h, "ICF_NAME"))} ${up(field(h, "ICFPARGUID"))}`;
    handlers.set(key, [...(handlers.get(key) ?? []), h]);
  }
  const counts = {nodes: ICFSERVICE.length, orphans: 0, withHandler: 0, inactive: 0, activation: activeRows === undefined ? "unknown" : "ICFSERVLOC",
    multiHandler: [], duplicates: []};
  const out = [];
  const taken = new Set();
  for (const row of ICFSERVICE) {
    const chain = handlers.get(key(row)) ?? [];
    if (chain.length === 0) continue;
    counts.withHandler += 1;
    const found = pathOf(row);
    if (found === undefined) {
      counts.orphans += 1;
      continue;
    }
    if (activeRows !== undefined && found.chain.some((node) => activeRows.has(key(node)) === false)) {
      counts.inactive += 1;
      continue;
    }
    if (chain.length > 1) {
      counts.multiHandler.push(found.path);
      continue;
    }
    if (taken.has(found.path)) {
      counts.duplicates.push(found.path);
      continue;
    }
    taken.add(found.path);
    const icftyp = up(field(chain[0], "ICFTYP"));
    out.push({path: found.path, name: up(field(row, "ICF_NAME")), handler: up(field(chain[0], "ICFHANDLER")), icftyp,
      type: icftyp === "A" ? "ABAP" : icftyp, active: true, travels: true, source: "tenant ICFSERVICE"});
  }
  return {services: out.sort((a, b) => b.path.length - a.path.length), counts};
}

/** the tenant's tree, read on the ABAP's connection. `tenantSchema` names
 *  the schema ICFSERVLOC is read in (qualified: no shadow object is made for
 *  it); without one, or when the read fails, activation is unknown and
 *  `activationError` says why. */
export async function readTenantServices(db, {tenantSchema, ...options} = {}) {
  const rows = async (sql) => (await db.select({select: sql}))?.rows ?? [];
  let ICFSERVLOC;
  let activationError;
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(tenantSchema ?? "")) === false) activationError = "no tenant schema to read ICFSERVLOC in";
  else {
    try {
      ICFSERVLOC = await rows(`SELECT ICF_NAME, ICFPARGUID, ICFACTIVE FROM "${String(tenantSchema).toUpperCase()}"."ICFSERVLOC"`);
    } catch (e) {
      activationError = `ICFSERVLOC did not read (${String(e?.code ?? e?.message ?? e).slice(0, 120)})`;
    }
  }
  const result = tenantServices({
    ICFSERVICE: await rows("SELECT ICF_NAME, ICFPARGUID, ICFNODGUID, ICFALTNME FROM ICFSERVICE"),
    ICFHANDLER: await rows("SELECT ICF_NAME, ICFPARGUID, ICFORDER, ICFTYP, ICFHANDLER FROM ICFHANDLER"),
    ICFSERVLOC,
  }, options);
  return {...result, activationError};
}

const literal = (v) => `'${String(v).replace(/'/g, "''")}'`;

/** the MI objects of the tenant's WWWPARAMS: Map objid -> {filesize} */
export async function readTenantMime(db) {
  const found = new Map();
  for (const row of (await db.select({select: "SELECT OBJID, NAME, VALUE FROM WWWPARAMS WHERE RELID = 'MI'"}))?.rows ?? []) {
    const objid = String(field(row, "OBJID") ?? "").trimEnd();
    if (objid === "") continue;
    const one = found.get(objid) ?? {};
    if (String(field(row, "NAME") ?? "").trim().toLowerCase() === "filesize") {
      const size = Number(String(field(row, "VALUE") ?? "").trim());
      if (Number.isInteger(size) && size >= 0) one.filesize = size;
    }
    found.set(objid, one);
  }
  return found;
}

/** one MIME object's bytes out of the tenant's WWWDATA */
export async function readTenantMimeBytes(db, objid, filesize) {
  const rows = (await db.select({select: `SELECT SRTF2, CLUSTR, CLUSTD FROM WWWDATA WHERE RELID = 'MI' AND OBJID = ${literal(objid)}`}))?.rows ?? [];
  if (rows.length === 0) throw new Error(`hana-serve: WWWDATA holds no MI row for ${objid}, though WWWPARAMS lists it`);
  const blob = joinFragments(rows.map((r) => ({srtf2: field(r, "SRTF2"), clustr: field(r, "CLUSTR"), clustd: field(r, "CLUSTD")})));
  return mimeBytes(parseCluster(blob), filesize);
}

/** register the tenant's MI objects and install the loader. `output` is
 *  the generation (the disk fallback reads W3MI files relative to it, as
 *  WWWDATA_IMPORT does); `step` runs a read inside a dialog step when the
 *  call does not come from one. Returns {objects, record} -- the record
 *  lists each object served, with its byte count. */
export async function installW3mi(abap, db, {output, log = () => {}} = {}) {
  const tenant = await readTenantMime(db);
  const own = abap.W3MI ?? {};
  const shadowed = Object.keys(own).filter((objid) => tenant.has(objid));
  abap.W3MI = own;
  for (const [objid] of tenant) abap.W3MI[objid] = {objectType: "W3MI", filename: `wwwdata:${objid}`, source: "tenant WWWDATA"};
  const served = [];
  abap.W3MI_LOADER = async (objid, filename) => {
    const key = String(objid).trimEnd();
    if (tenant.has(key)) {
      const {filesize} = tenant.get(key);
      // without a size the object is its lines, padded to 255 at the end
      if (filesize === undefined) log(`hana-serve: W3MI ${key}: WWWPARAMS has no filesize; served as its whole 255-byte lines, padding included`);
      const bytes = await readTenantMimeBytes(db, key, filesize);
      const hex = bytes.toString("hex");
      served.push({objid: key, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex")});
      if (served.length > 16) served.shift();
      return hex.toUpperCase();
    }
    // the generation's own object: the disk, the way WWWDATA_IMPORT reads it
    const path = isAbsolute(String(filename)) ? String(filename) : join(output, String(filename));
    if (relative(output, path).startsWith("..")) throw new Error(`hana-serve: W3MI file ${filename} is outside the generation`);
    return readFileSync(path).toString("hex").toUpperCase();
  };
  if (shadowed.length > 0) log(`hana-serve: W3MI: the tenant's WWWDATA answers for ${shadowed.length} object(s) the generation also brings: ${shadowed.slice(0, 5).join(", ")}`);
  return {objects: tenant.size, served};
}

/** what WWWDATA_IMPORT hands the ABAP for `objid`, through the function
 *  module itself: the check that the ABAP's path reads the tenant */
export async function importThroughAbap(abap, objid) {
  const fm = abap.FunctionModules?.WWWDATA_IMPORT;
  if (typeof fm !== "function") throw new Error("hana-serve: the generation has no WWWDATA_IMPORT");
  const key = new abap.types.Structure({relid: new abap.types.Character(2), objid: new abap.types.Character(40)});
  key.get().relid.set("MI");
  key.get().objid.set(objid);
  const mime = abap.types.TableFactory.construct(new abap.types.Structure({line: new abap.types.Hex({length: 255})}),
    {withHeader: false, keyType: "DEFAULT", primaryKey: {isUnique: false, type: "STANDARD", keyFields: [], name: "primary_key"}, secondary: []});
  await fm({exporting: {key}, tables: {mime}});
  return Buffer.from(mime.array().map((row) => row.get().line.get()).join(""), "hex");
}
