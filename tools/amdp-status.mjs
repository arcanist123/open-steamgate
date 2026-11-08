// Where each AMDP method's body runs, right now, as facts the status
// service can classify (docs/amdp-engine-status.md).
//
// An AMDP method (`BY DATABASE PROCEDURE/FUNCTION FOR HDB`) is rewritten by
// tools/amdp-gen.mjs into `CALL FUNCTION ... DESTINATION 'AMDP'`, and the
// destination (tools/amdp-destination.mjs) decides at call time where the
// body runs: on the system's own DuckDB connection through the compiled
// portable IR (pAMDP), or natively on HANA over the destination's own
// session (eAMDP). Nothing in configuration says which; the status page used
// to read the system connection and said "HDB" while the eAMDP session was
// dead (docs/backlog/data-analytics.md, "the eAMDP session that goes stale").
//
// So this reads the destination itself and hands the ABAP side raw facts;
// ZCL_OSD_STATUS=>ENGINE turns them into the label a person sees. The JSON is
// part of the snapshot contract ZCL_OSD_STATUS=>REFRESH parses:
//
//   "amdp": {"db": "duckdb", "driver": true, "configured": false,
//            "session": "none",   (+ "unknown": true when nothing was observed)
//            "methods": [{"clsname": "ZCL_OSD_AMDP_DEMO", "mtdname": "SQUARES",
//                         "kind": "procedure", "portable": true, "refusal": ""}]}
//
// Bounded vocabulary only, as tools/osd-status.mjs keeps it: an engine name
// from a fixed list, booleans, a session word from a fixed list, ABAP names
// and the compiler's refusal text cut to a column. No host, port, user,
// schema or path ever enters this object.
import {databaseDescriptor} from "./osd-database-identity.mjs";

export const ENGINES = ["sqlite", "duckdb", "HDB", "postgres", "unknown"];
export const SESSIONS = ["none", "connected", "closed"];
const NAME = /^[A-Z0-9_/]{1,30}$/;

const noFacts = (db = "unknown") => ({db, driver: false, configured: false, session: "none", methods: []});

/** what a host says when the process that holds the destination did not
 *  answer (a pool child busy at boot, or mid hot swap): "not known", with
 *  `unknown` set so ZCL_OSD_STATUS=>REFRESH keeps the last rows it had
 *  instead of replacing them with none */
export const unknownAmdpFacts = () => ({...noFacts(), unknown: true});

/** the methods the destination knows, one row each, sorted by class and method */
export function methodRows(procedures) {
  const rows = [];
  for (const p of procedures?.values?.() ?? []) {
    if (p === undefined || p === null) continue;
    rows.push({
      clsname: String(p.class ?? "").toUpperCase().slice(0, 30),
      mtdname: String(p.method ?? "").toUpperCase().slice(0, 30),
      kind: p.kind === "function" ? "function" : "procedure",
      portable: p.portable !== undefined,
      // the compiler's refusal, or for a compiled body the refusal DuckDB's
      // lowering raises when it is called (tools/amdp-gen.mjs, dialectCheck);
      // ZCL_OSD_STATUS=>ENGINE says portable-refused for the second
      refusal: String(p.portableRefusal?.message ?? p.portableDuckdbRefusal?.message ?? "")
        .replace(/\s+/g, " ").trim().slice(0, 240),
    });
  }
  return rows.sort((a, b) => a.clsname.localeCompare(b.clsname) || a.mtdname.localeCompare(b.mtdname));
}

/** the facts of this process: its destination and its database connection */
export async function amdpFacts({
  destination = globalThis.abap?.context?.RFCDestinations?.AMDP,
  client = globalThis.abap?.context?.databaseConnections?.DEFAULT,
} = {}) {
  const db = databaseDescriptor(client).engine;
  if (destination === undefined || destination === null) return noFacts(db);
  let state;
  try {
    state = typeof destination.sessionState === "function" ? await destination.sessionState() : undefined;
  } catch {
    state = undefined;
  }
  return {
    db,
    driver: state?.driver === true,
    configured: state?.configured === true,
    session: SESSIONS.includes(state?.session) ? state.session : "none",
    methods: methodRows(destination.procedures),
  };
}

/** a child's answer, accepted only when every value is in the vocabulary;
 *  undefined otherwise, so a garbled answer is an observation and never a row */
export function acceptAmdpFacts(body) {
  if (body === undefined || body === null || typeof body !== "object") return undefined;
  if (!ENGINES.includes(body.db) || !SESSIONS.includes(body.session)) return undefined;
  if (typeof body.driver !== "boolean" || typeof body.configured !== "boolean") return undefined;
  if (!Array.isArray(body.methods)) return undefined;
  const methods = [];
  for (const m of body.methods) {
    if (m === undefined || m === null || typeof m !== "object") return undefined;
    if (!NAME.test(String(m.clsname)) || !NAME.test(String(m.mtdname))) return undefined;
    if (!["procedure", "function"].includes(m.kind) || typeof m.portable !== "boolean") return undefined;
    methods.push({clsname: m.clsname, mtdname: m.mtdname, kind: m.kind, portable: m.portable,
      refusal: String(m.refusal ?? "").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 240)});
  }
  return {db: body.db, driver: body.driver, configured: body.configured, session: body.session, methods};
}

/** the same facts as two rows of the Environment facet, beside Engine and Storage */
export function amdpFactRows(facts) {
  if (facts.unknown === true) {
    const note = "the work process holding the AMDP destination did not answer; nothing is guessed";
    return [
      {section: "AMDP", name: "pAMDP portable engine", value: "not known", note},
      {section: "AMDP", name: "eAMDP HANA destination", value: "not known", note},
    ];
  }
  const portable = facts.db === "duckdb";
  const destination = !facts.driver ? "no HANA driver in this build"
    : !facts.configured ? "not configured"
      : facts.session === "connected" ? "session connected"
        : facts.session === "closed" ? "session closed (stale)" : "configured, no session yet";
  return [
    {section: "AMDP", name: "pAMDP portable engine", value: portable ? "duckdb" : "off",
      note: portable ? "SQLScript bodies in the portable subset run on the system DuckDB connection"
        : "the portable IR runs only when the system database is DuckDB (STG_DB=duckdb)"},
    {section: "AMDP", name: "eAMDP HANA destination", value: destination,
      note: `${facts.methods.length} AMDP method(s) in the tree; see the AMDP facet for each`},
  ];
}
