// The dumper round of the closure walk (H5c), beside the loop since H5x-1:
// tools/hana-closure.mjs stays the loop -- this file is its own package so
// the size budget stays honest -- and carries the dumper's contract: the
// argv and child environment of the real binary, the connection env file's
// reader, the by-hand command printed when no dumper is configured, and
// the one dumper round itself. The binary is foreign (another project's,
// with credentials of its own), so nothing here knows the walk: the loop
// hands in request path, dump directory and provenance.
import {readFileSync} from "node:fs";
import {spawnSync} from "node:child_process";

/** the dumper's argv and child environment -- the contract the real binary
 *  refuses to run without (cobra MarkFlagRequired: host, user, schema,
 *  provenance, out): the connection flags from the env file's
 *  HANA_HOST/HANA_PORT/HANA_USER/HANA_SCHEMA, the request as a file, the
 *  dump directory inside gitignored .local/ -- inside the working tree,
 *  which the dumper refuses without --allow-in-repo -- the password
 *  ONLY in the child's environment (VSP_HANA_PASSWORD), never on the argv,
 *  and --skip-test-includes: the closure must never carry CCAU test
 *  includes (round 7). Throws when the env file cannot answer a required
 *  flag, before any connection travels. Pure. */
export function dumperCommand({dumper, connection, requestPath, dumpDir, provenance}) {
  for (const [key, flag] of [["HANA_HOST", "--host"], ["HANA_USER", "--user"], ["HANA_SCHEMA", "--schema"]]) {
    if (connection[key] === undefined || connection[key] === "") {
      throw new Error(`hana-closure: the env file carries no ${key}; the dumper refuses to run without ${flag}`);
    }
  }
  if (connection.HANA_PASSWORD === undefined || connection.HANA_PASSWORD === "") {
    throw new Error("hana-closure: the env file carries no HANA_PASSWORD (VSP_HANA_PASSWORD); the dumper refuses to run without a password");
  }
  const argv = [
    dumper, "hana", "dump",
    "--host", connection.HANA_HOST,
    ...(connection.HANA_PORT === undefined || connection.HANA_PORT === "" ? [] : ["--port", connection.HANA_PORT]),
    "--user", connection.HANA_USER,
    "--schema", connection.HANA_SCHEMA,
    "--provenance", provenance,
    "--ddic-closure", requestPath,
    "--out", dumpDir,
    // the closure must never carry CCAU test includes (round 7): the real
    // dumper's flag, off by default there
    "--skip-test-includes",
    "--allow-in-repo",
  ];
  return {argv, env: {VSP_HANA_PASSWORD: connection.HANA_PASSWORD}};
}

/** the dumper's connection: KEY=VALUE lines, `#` comments, `export `
 *  allowed. Values are taken as written -- quoting is the dumper's dialect,
 *  not this file's. Throws on a line it cannot read, so a typo'd env file
 *  is refused before the connection travels anywhere. Pure. */
export function parseEnvFile(text) {
  const vars = {};
  for (const line of String(text ?? "").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const m = /^(?:export )?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (m === null) throw new Error(`hana-closure: the env file carries a line that is not KEY=VALUE: ${JSON.stringify(trimmed)}`);
    vars[m[1]] = m[2];
  }
  return vars;
}

export const dumperConfigured = (env) =>
  env.OSD_HANA_DUMPER !== undefined && env.OSD_HANA_DUMPER !== "" &&
  env.OSD_HANA_DUMP_ENV !== undefined && env.OSD_HANA_DUMP_ENV !== "";

// the connection flags whose VALUES never reach the loop's own log line:
// a loop log is exactly what gets pasted into a report (the bed run's was,
// carrying the bed's host, user and schema), so the line prints the flag
// with <env> and keeps the value for the by-hand command only
const REDACTED = new Set(["--host", "--port", "--user", "--schema"]);
const redactedArgv = (argv) =>
  argv.map((a, i) => (REDACTED.has(argv[i - 1]) === true ? "<env>" : a)).join(" ");

// one dumper round, when the dumper is configured: undefined when it is
// not (the caller prints the command instead), a throw when the round
// fails. The binary is foreign (see the header): spawned by the path the
// environment names, its connection the env file's flags on the argv and
// the password in the child's environment only.
export function dumpRound({root, env, say, requestPath, dumpDir, provenance}) {
  if (dumperConfigured(env) === false) return undefined;
  const connection = parseEnvFile(readFileSync(env.OSD_HANA_DUMP_ENV, "utf8"));
  const {argv, env: childEnv} = dumperCommand({dumper: env.OSD_HANA_DUMPER, connection, requestPath, dumpDir, provenance});
  say(`dump: ${redactedArgv(argv.slice(1))}`);
  const child = spawnSync(argv[0], argv.slice(1), {cwd: root, env: {...env, ...childEnv}, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024});
  if (child.status !== 0) {
    const tail = [child.stdout, child.stderr].filter(Boolean).join("\n").slice(-2000);
    throw new Error(`hana-closure: the dumper exited ${child.status ?? "on a signal"}${tail === "" ? "" : `:\n${tail}`}`);
  }
}

// the command a human runs by hand when no dumper is configured here: the
// real argv, with the env file's values when it is readable and
// placeholders when it is not -- and no password, ever (it is env-only).
// This is the one place the connection values still print: it answers the
// human's own ask, it is not the loop's log line.
export function printedCommand(env, requestPath, dumpDir, provenance) {
  let connection;
  try {
    connection = parseEnvFile(readFileSync(env.OSD_HANA_DUMP_ENV ?? "", "utf8"));
  } catch {
    connection = undefined;
  }
  const shown = dumperConfigured(env) === false && (env.OSD_HANA_DUMPER === undefined || env.OSD_HANA_DUMPER === "")
    ? "$OSD_HANA_DUMPER" : env.OSD_HANA_DUMPER;
  const value = (key, placeholder) =>
    connection?.[key] !== undefined && connection?.[key] !== "" ? connection[key] : placeholder;
  return [
    shown, "hana", "dump",
    `--host ${value("HANA_HOST", "<HANA_HOST>")}`,
    `--port ${value("HANA_PORT", "<HANA_PORT>")}`,
    `--user ${value("HANA_USER", "<HANA_USER>")}`,
    `--schema ${value("HANA_SCHEMA", "<HANA_SCHEMA>")}`,
    `--provenance ${JSON.stringify(provenance)}`,
    `--ddic-closure ${requestPath}`,
    `--out ${dumpDir}`,
    "--skip-test-includes",
    "--allow-in-repo",
  ].join(" ");
}

// the loop's provenance string for iteration n: the same words every round
// records, the dumper side of the contract -- moved here from the loop
// (tools/hana-closure.mjs) since FIX-1 with the rest of the dumper's
// vocabulary
export const provenanceFor = (iteration) =>
  `hana-closure iteration ${iteration}: the closure request's names (tools/hana-closure.mjs)`;
