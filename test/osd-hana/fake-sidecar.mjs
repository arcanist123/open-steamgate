#!/usr/bin/env node
// The FAKE sidecar the osd-hana tests point OSD_HANA_DUMP at (a shebang
// script, spawned directly, exactly like the real Go binary). It plays
// `--version --json`, `probe` for several logins, `list` and `dump` from
// synthetic fixture directories, and every exit code of the contract -- no
// network, no database.
//
// Behaviour comes from the environment the TEST sets (never from argv):
//   FAKE_SIDECAR_HANDSHAKE  JSON patch over the --version --json document
//                           ({"read_only": false}, {"schema": 2}, drop a
//                           capability, wrong version ...)
//   FAKE_SIDECAR_LIST       fixture dir served for `list --out DIR`
//   FAKE_SIDECAR_DUMP       fixture dir served for `dump --out DIR`
//   FAKE_SIDECAR_DUMP_APPEND  rows appended to the dump's objects.jsonl AFTER
//                           the request filter (a sidecar that over-delivers)
//   FAKE_SIDECAR_REPOSRC_APPEND  reposrc rows appended AFTER the filter (a
//                           source fetched the request cannot justify)
//   FAKE_SIDECAR_EXIT       exit code override for list/dump (default 0)
//   FAKE_SIDECAR_PROBE      scenario name:
//     owner-tenant    schema_owner, tenant, one ABAP schema, cannot write
//     admin-system    admin, system database, can write, attached unknown
//     other           login of class "other", one ABAP schema
//     writer          cannot-write probe except non_select_on_schema: true
//     no-schema       exit 0, probe.schemas empty
//     connect-error   exit 2, {"ok":false,"exit":2,"error":...}
//     unsupported     exit 5, no ABAP schema
//     usage-error     exit 1
//     echo-stderr     like owner-tenant, but repeats the run's host, user,
//                     schema and password on stderr first (redactor fodder)
//     hang            never answers: sleeps 5 s, for the timeout test
//     non-json-leak   exit 0, one non-JSON line with the password at offset 195
//   FAKE_SIDECAR_RECORD     a file the fake appends its argv and which
//                           credentials arrived through the environment to
//                           (the password value itself is NEVER written --
//                           only the fact it was there)
import {appendFileSync, readFileSync, writeSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

const [, , ...args] = process.argv;
const scenario = process.env.FAKE_SIDECAR_PROBE ?? "owner-tenant";
const DUMP_SCENARIOS = process.env.FAKE_SIDECAR_DUMP_SCENARIOS === "1";

function record(entry) {
  const path = process.env.FAKE_SIDECAR_RECORD;
  if (path === undefined || path === "") return;
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

// The credentials arrived through the environment only; the record proves the
// fact, never the value. For list/dump the request echo goes into the record
// too (no credentials in a request -- the tests assert what was fetched).
{
  let recordedRequest;
  const ri = args.indexOf("--request");
  const rp = ri === -1 ? undefined : args[ri + 1];
  if (rp !== undefined && rp !== "-") {
    try { recordedRequest = JSON.parse(readFileSync(rp, "utf8")); } catch { /* unreadable */ }
  }
  if (!DUMP_SCENARIOS) record({
    argv: args,
    request: recordedRequest,
    env: {
      hadUser: typeof process.env.OSD_HANA_USER === "string" && process.env.OSD_HANA_USER !== "",
      hadPassword: typeof process.env.OSD_HANA_PASSWORD === "string" && process.env.OSD_HANA_PASSWORD !== "",
    },
  });
}

// ---- the probe documents: RECORDED contracts, values varied, no field invented ----
// test/osd-hana/contract/ holds what the real binary printed (README there).
// Every document this fake serves is one of those recordings with VALUES
// changed, plus keys contract/fields.json lists; test/osd-hana-contract.mjs
// fails when a scenario carries a key that file does not know.
// The harness copies this script into a temp directory (it must be spawnable
// like the real binary), so the contract directory is baked in at copy time;
// run in place, it is the folder beside this file.
const BAKED_CONTRACT_DIR = "__CONTRACT_DIR__";
const contractDir = BAKED_CONTRACT_DIR.startsWith("__")
  ? fileURLToPath(new URL("./contract/", import.meta.url))
  : BAKED_CONTRACT_DIR;
const recorded = (name) => JSON.parse(readFileSync(join(contractDir, `${name}.json`), "utf8"));

if (args[0] === "--version") {
  // the recorded --version --json document, with test values
  const base = {
    ...recorded("version").document,
    version: "v9.9.9-test",
    commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    go: "test",
    os_arch: "test/test",
    schema: 1,
    read_only: true,
    capabilities: ["probe", "list", "dump", "names", "packages", "local", "closure", "inactive", "catalog", "ddic", "skip_test_includes", "object_report"],
  };
  if (args.includes("--json")) {
    let patch = {};
    try {
      patch = JSON.parse(process.env.FAKE_SIDECAR_HANDSHAKE ?? "{}");
    } catch { /* no patch */ }
    process.stdout.write(`${JSON.stringify({...base, ...patch})}\n`);
  } else {
    process.stdout.write("osd-hana-dump v9.9.9-test aaaaaaaaaa go-test test/test (read-only)\n");
  }
  process.exit(0);
}

// ---- list / dump (W3): a fixture directory is copied into --out, the
// manifest gets the request echo of THIS run, and the contract's one summary
// line goes to stdout. No network, no database.
//   FAKE_SIDECAR_LIST   fixture dir for `list` (objects.jsonl, ...)
//   FAKE_SIDECAR_DUMP   fixture dir for `dump` (objects.jsonl, reposrc.jsonl,
//                       tables/, src/, counts.json, summary.json)
//   FAKE_SIDECAR_EXIT   override the exit code (0 default)
if (args[0] === "list" || args[0] === "dump") {
  const {cpSync: copySync, writeFileSync, readFileSync, appendFileSync, existsSync} = await import("node:fs");
  const {join} = await import("node:path");
  const flag = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  const outDir = flag("--out");
  const requestPath = flag("--request");
  let request = null;
  if (requestPath && requestPath !== "-" && existsSync(requestPath)) request = JSON.parse(readFileSync(requestPath, "utf8"));
  const fixtureDir = process.env[args[0] === "list" ? "FAKE_SIDECAR_LIST" : "FAKE_SIDECAR_DUMP"];
  if (fixtureDir !== undefined && outDir !== undefined) {
    copySync(fixtureDir, outDir, {recursive: true});
    // a dump honours its request the way the real sidecar (v2.62.1) does:
    // `requested: {TYPE: [names]}` is an exact (type, name) selection. The
    // sidecar expands the sources of the requested CLAS / INTF / BDEF (the
    // 30-character '='-padded name plus a suffix), FUGR (its main program
    // SAPL<grp> and the includes L<grp> + exactly three characters, the
    // namespaced shape /NS/SAPLGRP, /NS/LGRP___) and PROG (the exact name);
    // rows the request does not select are not dumped, except the names its
    // dictionary closure reached (manifest `closure.resolved`; a fixture
    // sets it through FAKE_SIDECAR_CLOSURE or its own manifest.json).
    // FAKE_SIDECAR_DUMP_APPEND adds rows AFTER the filter (a sidecar that
    // over-delivers -- the M-2 audit).
    const closureEnv = process.env.FAKE_SIDECAR_CLOSURE;
    if (args[0] === "dump" && closureEnv !== undefined) {
      const mp = join(outDir, "manifest.json");
      const m = existsSync(mp) ? JSON.parse(readFileSync(mp, "utf8")) : {};
      m.closure = JSON.parse(closureEnv);
      writeFileSync(mp, `${JSON.stringify(m, null, 1)}\n`);
    }
    if (args[0] === "dump" && request?.requested && typeof request.requested === "object") {
      const selected = new Set();
      const owners = []; // program -> owned?
      for (const [type, names] of Object.entries(request.requested)) {
        for (const name of names) {
          selected.add(`${type}:${name}`);
          if (type === "CLAS" || type === "INTF" || type === "BDEF") {
            const prefix = name.padEnd(30, "=");
            owners.push((p) => p.length > prefix.length && p.startsWith(prefix));
          } else if (type === "FUGR") {
            const m = /^(\/[^/]+\/)?(.+)$/.exec(name);
            const ns = m?.[1] ?? "";
            const grp = m?.[2] ?? name;
            const main = `${ns}SAPL${grp}`;
            const inc = `${ns}L${grp}`;
            owners.push((p) => p === main || (p.length === inc.length + 3 && p.startsWith(inc)));
          } else if (type === "PROG") {
            owners.push((p) => p === name);
          }
        }
      }
      const mp = join(outDir, "manifest.json");
      const fixtureManifest = existsSync(mp) ? JSON.parse(readFileSync(mp, "utf8")) : {};
      for (const [kind, names] of Object.entries(fixtureManifest.closure?.resolved ?? {})) {
        for (const n of names) selected.add(`${kind}:${n}`);
      }
      const reposrcPath = join(outDir, "reposrc.jsonl");
      if (existsSync(reposrcPath)) {
        const srcRows = readFileSync(reposrcPath, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
        writeFileSync(reposrcPath, srcRows.filter((r) => owners.some((o) => o(String(r.program ?? "")))).map((r) => JSON.stringify(r)).join("\n") + (srcRows.length ? "\n" : ""));
      }
      const objectsPath = join(outDir, "objects.jsonl");
      const rows = readFileSync(objectsPath, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
      // the real sidecar keeps excluded/closure rows in objects.jsonl as
      // skipped entries; rows the request does not select drop out
      writeFileSync(objectsPath, rows.filter((r) => selected.has(`${r.type}:${r.name}`) || r.status === "S" || r.status === "skipped").map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
      const appendPath = process.env.FAKE_SIDECAR_DUMP_APPEND;
      if (appendPath !== undefined && existsSync(appendPath)) {
        appendFileSync(objectsPath, readFileSync(appendPath, "utf8"));
      }
      // FAKE_SIDECAR_REPOSRC_APPEND adds reposrc rows AFTER the filter (a
      // sidecar that fetched a source the request cannot justify -- the
      // round-5 source audit)
      const srcAppendPath = process.env.FAKE_SIDECAR_REPOSRC_APPEND;
      if (srcAppendPath !== undefined && existsSync(srcAppendPath)) {
        appendFileSync(reposrcPath, readFileSync(srcAppendPath, "utf8"));
      }
    }
    // the manifest's sidecar block echoes the request of this run -- a dump
    // is only reusable when it matches (extract.mjs reusableDump)
    const manifestPath = join(outDir, "manifest.json");
    let manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
    const counts = existsSync(join(outDir, "counts.json")) ? JSON.parse(readFileSync(join(outDir, "counts.json"), "utf8")) : {written: 0, skipped: 0, skipped_excluded: 0, skipped_unsupported: 0};
    const errorPatch = process.env.FAKE_SIDECAR_ERRORS;
    const errors = errorPatch !== undefined ? JSON.parse(errorPatch) : [];
    manifest.sidecar = {
      name: "osd-hana-dump", version: "v9.9.9-test", commit: "a".repeat(40),
      request, counts, objects_report: "objects.jsonl", errors,
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 1)}\n`);
  }
  const exit = Number(process.env.FAKE_SIDECAR_EXIT ?? "0");
  const summaryPath = fixtureDir !== undefined ? join(fixtureDir, "summary.json") : undefined;
  const summary = summaryPath !== undefined && existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, "utf8")) : {ok: exit === 0, exit};
  process.stdout.write(`${JSON.stringify({...summary, exit})}\n`);
  process.exit(exit);
}

if (args[0] !== "probe" && !DUMP_SCENARIOS) {
  process.stdout.write(`${JSON.stringify({ok: false, exit: 1, error: `fake sidecar: unknown verb ${args[0]}`})}\n`);
  process.exit(1);
}

// ---- the probe documents (the loader is at the top of the file) ----
const OK = recorded("probe-ok"); // {exit: 0, document: {ok, db, abap_schemas: [{...}], login_class}}
const AUTH_FAILED = recorded("probe-auth-failed"); // {exit: 2, document: {error, exit, ok}}

/** A successful probe: the recording with top-level values and the one
 *  schema's values replaced. `extra` may add only keys fields.json lists. */
function okDoc(top = {}, schema = {}) {
  const document = structuredClone(OK.document);
  Object.assign(document.abap_schemas[0], schema);
  Object.assign(document, top);
  return {exit: 0, document};
}
/** A failed run: the recorded error document with its values replaced. */
function errorDoc(exit, error) {
  return {exit, document: {...structuredClone(AUTH_FAILED.document), exit, error}};
}
/** A document derived from source: a recording with values changed and the
 *  sidecar's own notes added (contract/README.md, "Derived from source"). */
function derived(name) {
  const {exit, document} = recorded(name);
  return {exit, document};
}
const SMALL = {clients: ["100"], reposrc_rows: 5, tadir_rows: 6};
const OWNED = {owned_by_login: true, non_select_on_schema: true, non_select_kinds: ["OWNER"], abap_attached: "no", reposrc_rows: 1234, tadir_rows: 2345};

const PROBES = {
  // the recording itself: a login that may only read, tenant, one ABAP schema
  reader: okDoc(),
  // the schema's owner: the real binary reports it as able to write (kind OWNER)
  "owner-tenant": okDoc({login_class: "schema_owner"}, OWNED),
  // an administrator on the system database (the sidecar adds its SYSTEMDB note)
  "admin-system": okDoc(
    {db: "system", login_class: "admin", admin_privileges: ["DATABASE ADMIN", "USER ADMIN"],
      notes: ["connected to SYSTEMDB: connect to the tenant (its own port, or --database)"]},
    {clients: ["000"], reposrc_rows: 99, tadir_rows: 111, abap_attached: "no"}),
  other: okDoc({}, {...SMALL, abap_attached: "unknown"}),
  // one login that is BOTH administrator and schema owner (exists on some
  // systems): the real binary then says login_class schema_owner AND lists
  // the administrator privileges -- the guided flow does the create in one step
  both: okDoc({login_class: "schema_owner", admin_privileges: ["DATABASE ADMIN"]}, {...OWNED, clients: ["100"]}),
  writer: okDoc({}, {...SMALL, non_select_on_schema: true, non_select_kinds: ["INSERT", "UPDATE"], abap_attached: "unknown"}),
  // two ABAP schemas in one database: the doctor lists both
  "two-schemas": (() => {
    const d = okDoc({}, SMALL);
    d.document.abap_schemas.push({...structuredClone(d.document.abap_schemas[0]), schema: "TESTSCHEMA2", clients: ["300"]});
    return d;
  })(),
  // no ABAP schema readable by this login: the real binary prints its
  // document with ok false and abap_schemas null (a Go nil slice), no error
  // field, and exits 5 (read off probe.go at the pinned tag, not recorded)
  "no-schema": {exit: 5, document: {...structuredClone(OK.document), ok: false, abap_schemas: null}},
  // the same on the system database, with the sidecar's own note
  "no-schema-system": {exit: 5, document: {...structuredClone(OK.document), ok: false, db: "system", abap_schemas: null,
    notes: ["connected to SYSTEMDB: connect to the tenant (its own port, or --database)"]}},
  // a contract break: exit 0 and no abap_schemas key at all (an older or a
  // foreign binary) -- the doctor must say the field is missing, not "none"
  "missing-schemas-key": (() => {
    const d = okDoc();
    delete d.document.abap_schemas;
    return d;
  })(),
  // a schema entry that lacks what the verdict needs
  "missing-schema-fields": (() => {
    const d = okDoc();
    const s = d.document.abap_schemas[0];
    delete s.non_select_on_schema;
    delete s.abap_attached;
    delete d.document.login_class;
    return d;
  })(),
  // SHOULD-2: a schema name from the database carrying control characters --
  // the plain verdict must escape it (show()), never print the raw bytes
  "hostile-schema": okDoc({}, {...SMALL, schema: `X\u001b[2K\rHARMLESS`, abap_attached: "no"}),
  "connect-error": errorDoc(2, "logon failed: the fake never lets anyone in"),
  // TLS (recorded from v2.62.1): the probe reports tls verified | unverified | off
  "tls-verified": okDoc({login_class: "schema_owner", tls: "verified"}, OWNED),
  "tls-unverified": okDoc({login_class: "schema_owner", tls: "unverified"}, OWNED),
  "tls-off": okDoc({login_class: "schema_owner", tls: "off"}, OWNED),
  // an older binary (before v2.62.1) whose probe has no tls key at all
  "no-tls-field": (() => {
    const d = okDoc({login_class: "schema_owner"}, OWNED);
    delete d.document.tls;
    return d;
  })(),
  // the measured trial-image failure: verified TLS to an IP address refused
  "ip-sans": errorDoc(2, "connection failed: TLS handshake: certificate doesn't contain any IP SANs"),
  // Redactor fodder on STDOUT (critic S-1): a buggy or hostile binary repeats
  // a credential inside its one-line JSON answer; the doctor must still
  // print nothing.
  "stdout-leak": errorDoc(2, `logon failed for password ${process.env.OSD_HANA_PASSWORD ?? "?"}`),
  "stdout-leak-doc": okDoc({}, {...SMALL, schema: `SCHEMA_${process.env.OSD_HANA_PASSWORD ?? "?"}`, abap_attached: "no"}),
  // Parse before redact: counts whose digits contain a short numeric
  // password ("123"), so a redactor run over the raw JSON text would turn
  // 1234 into ***4 and break the document; the counts must arrive as numbers.
  "numeric-counts": okDoc({login_class: "schema_owner"}, {...OWNED, reposrc_rows: 1234, tadir_rows: 1123}),
  // exit 5 WITHOUT the probe document: the sidecar could not examine the
  // database at all (its error line) -- not a positive "no ABAP schema"
  unsupported: errorDoc(5, "looking for ABAP schemas: insufficient privilege"),
  "usage-error": errorDoc(1, "usage: the fake refuses this request"),
  partial: errorDoc(3, "partial: a probe cannot be partial, but the fake can"),
  refused: errorDoc(4, "refused: a probe cannot refuse, but the fake can"),
  "weird-exit": errorDoc(9, "the contract defines no exit 9"),
  // DERIVED FROM SOURCE (contract/README.md): what probe.go writes when a
  // value is not readable -- the zero value plus a note naming it
  "counts-unreadable": derived("derived-probe-counts-unreadable"),
  "privileges-unreadable": derived("derived-probe-privileges-unreadable"),
  "system-privileges-unreadable": derived("derived-probe-system-privileges-unreadable"),
  "owner-system-privileges-unreadable": derived("derived-probe-owner-system-privileges-unreadable"),
  // a note this module does not recognise: printed verbatim, nothing marked
  "unrecognised-note": okDoc({notes: ["TESTSCHEMA: something a newer sidecar says"]}),
};

// The contract test asks for every document this fake can serve.
if (DUMP_SCENARIOS) {
  process.stdout.write(`${JSON.stringify({version: recorded("version").document, probes: PROBES})}\n`);
  process.exit(0);
}

const emit = (answer) => {
  process.stdout.write(`${JSON.stringify(answer.document)}\n`);
  process.exit(answer.exit);
};

if (scenario === "echo-stderr") {
  // Redactor fodder: repeat every value of this run on stderr, password
  // included. The doctor's output must still be clean.
  process.stderr.write(`connecting to host=${args[1] === "--host" ? args[2] : "?"} user=${process.env.OSD_HANA_USER ?? "?"}\n`);
  process.stderr.write(`schema=${process.env.FAKE_SIDECAR_ECHO_SCHEMA ?? "?"}\n`);
  process.stderr.write(`${process.env.OSD_HANA_PASSWORD ?? ""}\n`);
  process.stderr.write(`ok: logon ${process.env.OSD_HANA_USER} on ${args[1] === "--host" ? args[2] : "?"} accepted\n`);
}

if (scenario === "roles") {
  // the guided two-login flow: the sidecar answers by WHO it is run as --
  // the reader's own probe (OSD_HANA_USER is the OSD_ reader) sees the
  // database like the measured reader (the recording: login_class "other",
  // no write, not the owner); the main login can do both roles.
  const isReader = (process.env.OSD_HANA_USER ?? "").startsWith("OSD_");
  emit(isReader ? PROBES.other : PROBES.both);
}

if (scenario === "hang") {
  setTimeout(() => process.exit(0), 5000);
} else if (scenario === "two-lines") {
  // one JSON line or an error, not a guess: two lines must be refused
  process.stdout.write(`${JSON.stringify(PROBES["owner-tenant"].document)}\n${JSON.stringify({ok: true})}\n`);
  process.exit(0);
} else if (scenario === "non-json-leak") {
  // not JSON at all, with the password straddling character 200 of the
  // line: the error quotes the line truncated -- it must redact FIRST, or
  // the cut leaves a prefix of the secret the redactor no longer matches
  process.stdout.write(`${"x".repeat(195)}${process.env.OSD_HANA_PASSWORD ?? ""} and more after it\n`);
  process.exit(0);
} else if (scenario === "chatty") {
  // more output than the doctor will accumulate: the cap, not the timeout,
  // must stop this child. Written synchronously -- a buffered write followed
  // by process.exit would be truncated by the exit and never reach the cap.
  const chunk = "x".repeat(1024 * 1024);
  for (let i = 0; i < 10; i++) writeSync(1, chunk);
  process.exit(0);
} else {
  emit(PROBES[scenario] ?? PROBES["owner-tenant"]);
}
