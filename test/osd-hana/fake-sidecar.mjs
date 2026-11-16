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
//   FAKE_SIDECAR_RECORD     a file the fake appends its argv and which
//                           credentials arrived through the environment to
//                           (the password value itself is NEVER written --
//                           only the fact it was there)
import {appendFileSync, readFileSync, writeSync} from "node:fs";

const [, , ...args] = process.argv;
const scenario = process.env.FAKE_SIDECAR_PROBE ?? "owner-tenant";

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
  record({
    argv: args,
    request: recordedRequest,
    env: {
      hadUser: typeof process.env.OSD_HANA_USER === "string" && process.env.OSD_HANA_USER !== "",
      hadPassword: typeof process.env.OSD_HANA_PASSWORD === "string" && process.env.OSD_HANA_PASSWORD !== "",
    },
  });
}

if (args[0] === "--version") {
  const base = {
    name: "osd-hana-dump",
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
    // a dump honours its request the way the real sidecar does: `names` are
    // LIKE patterns with `\` as the escape character, so extract's
    // exact-name patterns ("ZOSD\_X3") match exactly that name and a
    // trailing % is a prefix; rows the request does not name are not dumped.
    // FAKE_SIDECAR_DUMP_APPEND adds rows AFTER the filter (a sidecar that
    // over-delivers -- the M-2 audit).
    if (args[0] === "dump" && Array.isArray(request?.names)) {
      const unescaped = request.names.map((n) => n.replace(/\\(.)/g, "$1"));
      const wanted = new Set(unescaped.filter((n) => !n.endsWith("%")));
      const prefixes = unescaped.filter((n) => n.endsWith("%")).map((n) => n.slice(0, -1));
      const matches = (name) => wanted.has(name) || prefixes.some((p) => name.startsWith(p));
      const objectsPath = join(outDir, "objects.jsonl");
      const rows = readFileSync(objectsPath, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
      // the real sidecar keeps excluded/closure rows in objects.jsonl as
      // skipped entries; only SOURCE rows the request does not name drop out
      writeFileSync(objectsPath, rows.filter((r) => matches(r.name) || r.status === "S" || r.status === "skipped").map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
      const appendPath = process.env.FAKE_SIDECAR_DUMP_APPEND;
      if (appendPath !== undefined && existsSync(appendPath)) {
        appendFileSync(objectsPath, readFileSync(appendPath, "utf8"));
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

if (args[0] !== "probe") {
  process.stdout.write(`${JSON.stringify({ok: false, exit: 1, error: `fake sidecar: unknown verb ${args[0]}`})}\n`);
  process.exit(1);
}

const PROBES = {
  "owner-tenant": {
    ok: true, exit: 0,
    probe: {
      db: "tenant", login_class: "schema_owner", non_select_on_schema: false,
      abap_attached: "no",
      schemas: [{name: "TESTSCHEMA", basis_release: "7.57", clients: ["100", "200"], reposrc_rows: 1234, tadir_rows: 2345, owned_by_login: true}],
    },
  },
  "admin-system": {
    ok: true, exit: 0,
    probe: {
      db: "system", login_class: "admin",
      non_select_on_schema: {yes: true, kinds: ["DATABASE ADMIN", "USER ADMIN"]},
      abap_attached: "unknown",
      schemas: [{name: "TESTSCHEMA", basis_release: "7.57", clients: ["000"], reposrc_rows: 99, tadir_rows: 111, owned_by_login: false}],
    },
  },
  other: {
    ok: true, exit: 0,
    probe: {
      db: "tenant", login_class: "other", non_select_on_schema: false,
      abap_attached: "no",
      schemas: [{name: "TESTSCHEMA", basis_release: "7.57", clients: ["100"], reposrc_rows: 5, tadir_rows: 6, owned_by_login: false}],
    },
  },
  // one login that is BOTH administrator and schema owner (exists on some
  // systems): the guided flow does the whole create in one step
  both: {
    ok: true, exit: 0,
    probe: {
      db: "tenant", login_class: "admin", non_select_on_schema: {yes: true, kinds: ["DATABASE ADMIN"]},
      abap_attached: "no",
      schemas: [{name: "TESTSCHEMA", basis_release: "7.57", clients: ["100"], reposrc_rows: 1234, tadir_rows: 2345, owned_by_login: true}],
    },
  },
  writer: {
    ok: true, exit: 0,
    probe: {
      db: "tenant", login_class: "other", non_select_on_schema: true,
      abap_attached: "no",
      schemas: [{name: "TESTSCHEMA", basis_release: "7.57", clients: ["100"], reposrc_rows: 5, tadir_rows: 6, owned_by_login: false}],
    },
  },
  "no-schema": {ok: true, exit: 0, probe: {db: "tenant", login_class: "other", non_select_on_schema: false, abap_attached: "no", schemas: []}},
  // SHOULD-2: a schema name from the database carrying control characters --
  // the plain verdict must escape it (show()), never print the raw bytes
  "hostile-schema": {
    ok: true, exit: 0,
    probe: {
      db: "tenant", login_class: "other", non_select_on_schema: false, abap_attached: "no",
      schemas: [{name: `X\u001b[2K\rHARMLESS`, basis_release: "7.57", clients: ["100"], reposrc_rows: 5, tadir_rows: 6, owned_by_login: false}],
    },
  },
  "connect-error": {ok: false, exit: 2, error: "logon failed: the fake never lets anyone in"},
  // TLS (W0 "Additions"): the probe reports tls verified | unverified | off
  "tls-verified": {
    ok: true, exit: 0,
    probe: {db: "tenant", login_class: "schema_owner", non_select_on_schema: false, abap_attached: "no", tls: "verified",
      schemas: [{name: "TESTSCHEMA", basis_release: "7.57", clients: ["100"], reposrc_rows: 1234, tadir_rows: 2345, owned_by_login: true}]},
  },
  "tls-unverified": {
    ok: true, exit: 0,
    probe: {db: "tenant", login_class: "schema_owner", non_select_on_schema: false, abap_attached: "no", tls: "unverified",
      schemas: [{name: "TESTSCHEMA", basis_release: "7.57", clients: ["100"], reposrc_rows: 1234, tadir_rows: 2345, owned_by_login: true}]},
  },
  "tls-off": {
    ok: true, exit: 0,
    probe: {db: "tenant", login_class: "schema_owner", non_select_on_schema: false, abap_attached: "no", tls: "off",
      schemas: [{name: "TESTSCHEMA", basis_release: "7.57", clients: ["100"], reposrc_rows: 1234, tadir_rows: 2345, owned_by_login: true}]},
  },
  // the measured trial-image failure: verified TLS to an IP address refused
  "ip-sans": {ok: false, exit: 2, error: "connection failed: TLS handshake: certificate doesn't contain any IP SANs"},
  // Redactor fodder on STDOUT (critic S-1): a buggy or hostile binary repeats
  // a credential inside its one-line JSON answer; the doctor must still
  // print nothing.
  "stdout-leak": {ok: false, exit: 2, error: `logon failed for password ${process.env.OSD_HANA_PASSWORD ?? "?"}`},
  "stdout-leak-doc": {
    ok: true, exit: 0,
    probe: {
      db: "tenant", login_class: "other", non_select_on_schema: false, abap_attached: "no",
      schemas: [{name: `SCHEMA_${process.env.OSD_HANA_PASSWORD ?? "?"}`, basis_release: "7.57", clients: ["100"], reposrc_rows: 5, tadir_rows: 6, owned_by_login: false}],
    },
  },
  unsupported: {ok: false, exit: 5, error: "no ABAP schema: this database holds no REPOSRC"},
  "usage-error": {ok: false, exit: 1, error: "usage: the fake refuses this request"},
  partial: {ok: false, exit: 3, error: "partial: a probe cannot be partial, but the fake can"},
  refused: {ok: false, exit: 4, error: "refused: a probe cannot refuse, but the fake can"},
  "weird-exit": {ok: false, exit: 9, error: "the contract defines no exit 9"},
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
  // database like the measured reader: login_class "other", no write, not
  // the owner; the main login sees the administrator probe.
  const isReader = (process.env.OSD_HANA_USER ?? "").startsWith("OSD_");
  const answer = isReader
    ? {ok: true, exit: 0, probe: {
      db: "tenant", login_class: "other", non_select_on_schema: false, abap_attached: "no",
      schemas: [{name: "TESTSCHEMA", basis_release: "7.57", clients: ["100"], reposrc_rows: 5, tadir_rows: 6, owned_by_login: false}],
    }}
    : PROBES["both"]; // the main login can do both roles: the flow is one step
  process.stdout.write(`${JSON.stringify(answer)}\n`);
  process.exit(answer.exit);
}

if (scenario === "hang") {
  setTimeout(() => process.exit(0), 5000);
} else if (scenario === "two-lines") {
  // one JSON line or an error, not a guess: two lines must be refused
  process.stdout.write(`${JSON.stringify(PROBES["owner-tenant"])}\n${JSON.stringify({ok: true, exit: 0})}\n`);
  process.exit(0);
} else if (scenario === "chatty") {
  // more output than the doctor will accumulate: the cap, not the timeout,
  // must stop this child. Written synchronously -- a buffered write followed
  // by process.exit would be truncated by the exit and never reach the cap.
  const chunk = "x".repeat(1024 * 1024);
  for (let i = 0; i < 10; i++) writeSync(1, chunk);
  process.exit(0);
} else {
  const answer = PROBES[scenario] ?? PROBES["owner-tenant"];
  process.stdout.write(`${JSON.stringify(answer)}\n`);
  process.exit(answer.exit);
}
