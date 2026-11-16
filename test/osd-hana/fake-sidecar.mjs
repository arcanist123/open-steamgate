#!/usr/bin/env node
// The FAKE sidecar the osd-hana tests point OSD_HANA_DUMP at (a shebang
// script, spawned directly, exactly like the real Go binary). It plays
// `--version --json`, `probe` for several logins and every exit code of the
// contract -- no network, no database.
//
// Behaviour comes from the environment the TEST sets (never from argv):
//   FAKE_SIDECAR_HANDSHAKE  JSON patch over the --version --json document
//                           ({"read_only": false}, {"schema": 2}, drop a
//                           capability, wrong version ...)
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
import {appendFileSync} from "node:fs";

const [, , ...args] = process.argv;
const scenario = process.env.FAKE_SIDECAR_PROBE ?? "owner-tenant";

function record(entry) {
  const path = process.env.FAKE_SIDECAR_RECORD;
  if (path === undefined || path === "") return;
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

// The credentials arrived through the environment only; the record proves the
// fact, never the value.
record({
  argv: args,
  env: {
    hadUser: typeof process.env.OSD_HANA_USER === "string" && process.env.OSD_HANA_USER !== "",
    hadPassword: typeof process.env.OSD_HANA_PASSWORD === "string" && process.env.OSD_HANA_PASSWORD !== "",
  },
});

if (args[0] === "--version") {
  const base = {
    name: "osd-hana-dump",
    version: "v9.9.9-test",
    commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    go: "test",
    os_arch: "test/test",
    schema: 1,
    read_only: true,
    capabilities: ["probe", "list", "dump"],
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
  writer: {
    ok: true, exit: 0,
    probe: {
      db: "tenant", login_class: "other", non_select_on_schema: true,
      abap_attached: "no",
      schemas: [{name: "TESTSCHEMA", basis_release: "7.57", clients: ["100"], reposrc_rows: 5, tadir_rows: 6, owned_by_login: false}],
    },
  },
  "no-schema": {ok: true, exit: 0, probe: {db: "tenant", login_class: "other", non_select_on_schema: false, abap_attached: "no", schemas: []}},
  "connect-error": {ok: false, exit: 2, error: "logon failed: the fake never lets anyone in"},
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

if (scenario === "hang") {
  setTimeout(() => process.exit(0), 5000);
} else {
  const answer = PROBES[scenario] ?? PROBES["owner-tenant"];
  process.stdout.write(`${JSON.stringify(answer)}\n`);
  process.exit(answer.exit);
}
