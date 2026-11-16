// The verdict: what the sidecar's `probe` answered, said so a person who has
// never seen a HANA can act on it (task B.2). One place, so the plain text and
// the --json document cannot disagree.
//
// The probe's shape is the REAL binary's, read in one place: probe-doc.mjs
// (recorded contracts in test/osd-hana/contract/). Every function here takes
// the raw one-line document or the already-read model. A field the verdict
// needs and the sidecar did not report is SAID ("the sidecar did not report
// X") -- never rendered as "none", "no" or "no ABAP schema".
//
// Every name the PLAIN verdict prints goes through show() (critic round-2
// SHOULD-2, the S-B class one door over): the schema names come from the
// database being examined, on a connection --encrypt does not protect (the
// probe rides the sidecar's own session), so a name carrying ESC/CR must not
// reach the terminal raw. --json is safe on its own (JSON.stringify escapes).

import {show} from "./reader.mjs";
import {administratorKnown, isAdministrator, ownsAbapSchema, readProbe} from "./probe-doc.mjs";

// True when the login can do more than read on an ABAP schema the probe
// reports: it owns one, holds a privilege other than SELECT on one (the real
// document says so PER SCHEMA: non_select_on_schema + non_select_kinds), or
// is an administrator.
export function canWrite(probe = {}) {
  const p = readProbe(probe);
  if (isAdministrator(p)) return true;
  return p.schemas.some((s) => s.ownedByLogin === true || s.nonSelect === true || s.nonSelectKinds.length > 0);
}

/** False when the document does not let us say whether the login can write:
 *  no positive finding, and a schema whose non_select_on_schema (or the
 *  login class itself) was not reported. */
export function writeAbilityKnown(probe = {}) {
  const p = readProbe(probe);
  if (canWrite(p)) return true;
  if (p.loginClass === undefined) return false;
  // "system privileges not readable": an administrator would write
  if (!administratorKnown(p)) return false;
  return p.schemas.every((s) => s.nonSelect !== undefined && s.ownedByLogin !== undefined);
}

/** True when write ability is open because the SIDECAR said it could not
 *  read a privilege (its notes), as opposed to a field it did not report. */
function privilegesUnreadable(p) {
  return !administratorKnown(p) || p.schemas.some((s) => s.unknown.includes("non_select_on_schema"));
}

export function loginClassText(probe = {}) {
  const p = readProbe(probe);
  // login_class "other" only says no administrator privilege was SEEN; with
  // the system privileges unreadable, nothing was looked at
  if (p.loginClass === "other" && !administratorKnown(p)) {
    return "a login that is not the ABAP schema's owner (whether it is an administrator could not be read with this login)";
  }
  switch (p.loginClass) {
    case "schema_owner": return "the ABAP schema's owner";
    case "admin": return "an administrator";
    case "other": return "another kind of login (not the schema owner, not an administrator)";
    default: return "of a class the sidecar did not report";
  }
}

/** Which role the present login holds in the guided two-login create flow
 *  (task item 1), worked out from the probe: "admin" (an administrator, not
 *  the owner), "owner", "both" (one login that can do both -- it exists on
 *  some systems), or "neither" (the doctor explains and sends nothing). The
 *  real binary reports a login that owns the schema as login_class
 *  "schema_owner" even when it is an administrator too, and lists the
 *  administrator privileges beside it -- so "both" is read off
 *  admin_privileges + ownership, not off the class alone. "unknown": the
 *  sidecar could not read the system privileges, so whether the login is an
 *  administrator is open -- the doctor asks (ownsAbapSchema() still says
 *  which half is known), it never assumes "owner" or "neither". */
export function readerRoleFromProbe(probe = {}) {
  const p = readProbe(probe);
  const isAdmin = isAdministrator(p);
  if (!isAdmin && !administratorKnown(p)) return "unknown";
  const ownsSchema = ownsAbapSchema(p);
  if (isAdmin && ownsSchema) return "both";
  if (isAdmin) return "admin";
  if (ownsSchema) return "owner";
  return "neither";
}

export function dbText(probe = {}) {
  const db = readProbe(probe).db;
  if (db === "tenant") return "a tenant database";
  if (db === "system") return "the system database (SYSTEMDB)";
  return "a database whose kind the sidecar did not report";
}

// The safety sentence, kept in one place so it is said exactly once (task
// B.3): the doctor never refuses a powerful login, because the sidecar's
// sessions are read-only at the database level.
export const SAFETY_NOTE = "Extraction is safe with this login even though it can write: every session the sidecar opens is read-only at the database level -- the database itself refuses any write, whoever logs on.";

// The same moment, but the binary reporting read_only was never
// checksum-verified (--allow-unpinned-sidecar): its read-only claim is
// self-reported, so the guarantee cannot be stated as fact -- it is quoted
// as the unverified binary's own claim, exactly as the doctor can vouch for
// it (critic S-4).
export const UNPINNED_SAFETY_NOTE = "Extraction with this login even though it can write: this binary's read-only claim is its own; it was not checksum-verified (--allow-unpinned-sidecar), so whether the database refuses any write rests entirely on the unverified binary's say-so.";

/** Which sentence the moment earns: pinned (or unknown) states the guarantee,
 *  an explicitly unpinned binary gets the qualified one. */
export function safetyNote({pinned} = {}) {
  return pinned === false ? UNPINNED_SAFETY_NOTE : SAFETY_NOTE;
}

// The TLS finding (W0-contract "Additions"): the sidecar's probe reports
// `tls` as verified | unverified | off when the binary has the capability.
// One plain sentence each; absent when the binary is older (no capability,
// no field -- the doctor degrades to silence, never to a crash).
export function tlsLine(probe = {}) {
  switch (readProbe(probe).tls) {
    case "verified": return "TLS: on -- the server's certificate was verified (encrypted, and the server authenticated).";
    case "unverified": return "TLS: on -- but the server's certificate was NOT verified (--trust-server-certificate?): encrypted, but the server is not authenticated.";
    case "off": return "TLS: off -- the connection is NOT encrypted.";
    default: return undefined;
  }
}

// The measured failure of a verified TLS connection to an IP address on a
// trial image ("certificate doesn't contain any IP SANs"): a self-signed
// certificate rarely carries an IP address. Said with the three ways on,
// when the probe (or the reader path) fails with exactly that.
export function ipSansExplanation() {
  return [
    `  What happened: the server's certificate does not cover the ADDRESS you connected to -- it carries`,
    `  no IP entry ("certificate doesn't contain any IP SANs"). Trial images use a self-signed certificate,`,
    `  and such a certificate is issued for a host NAME, not for an IP address. Three ways on:`,
    `  1. connect by the host NAME the certificate was issued for (--host <name>; a hosts-file or DNS entry`,
    `     pointing at the same address is enough),`,
    `  2. pass --ca-file with the server's PEM certificate, or`,
    `  3. on a network you trust, --trust-server-certificate (encrypted, but the server is not authenticated).`,
  ].join("\n");
}

export function schemaLines(probe = {}) {
  const p = readProbe(probe);
  if (!p.schemasReported) return ["ABAP schema: the sidecar did not report any list of ABAP schemas (abap_schemas) -- this is NOT a finding that there is none."];
  if (p.schemas.length === 0) return ["ABAP schema: none readable by this login."];
  return p.schemas.map((s) => {
    const release = s.basisRelease !== undefined ? `, release ${show(s.basisRelease)}` : "";
    const clients = s.clients !== undefined && s.clients.length > 0 ? `, clients ${s.clients.map((c) => show(c)).join(", ")}` : "";
    const size = [];
    if (s.reposrcRows !== undefined) size.push(`${s.reposrcRows} source rows (REPOSRC)`);
    else if (s.unknown.includes("reposrc_rows")) size.push("source rows (REPOSRC): not readable with this login");
    if (s.tadirRows !== undefined) size.push(`${s.tadirRows} repository objects (TADIR)`);
    else if (s.unknown.includes("tadir_rows")) size.push("repository objects (TADIR): not readable with this login");
    const sizeText = size.length > 0 ? `, repository: ${size.join(", ")}` : "";
    const owned = s.ownedByLogin === true ? " (owned by this login)" : "";
    return `ABAP schema ${s.name === undefined ? "?" : show(String(s.name))}${owned}: found${release}${clients}${sizeText}.`;
  });
}

function attachedLines(p) {
  const one = (attached, of) => {
    if (attached === "yes") return `ABAP server still attached${of}: yes (informational -- you do not need it; the database alone is enough).`;
    if (attached === "no") return `ABAP server still attached${of}: no (informational).`;
    if (attached === "unknown") return `ABAP server still attached${of}: unknown (informational -- this login may not see the sessions).`;
    return `ABAP server still attached${of}: the sidecar did not report it (informational).`;
  };
  if (p.schemas.length <= 1) return [one(p.schemas[0]?.abapAttached, "")];
  return p.schemas.map((s) => one(s.abapAttached, ` to ${s.name === undefined ? "?" : show(String(s.name))}`));
}

/** The plain verdict, one line per finding, ready to print. `sidecar.pinned`
 *  decides which safety sentence the moment earns (see safetyNote). */
export function plainVerdict(probe = {}, {connection, sidecar} = {}) {
  const p = readProbe(probe);
  const lines = [];
  lines.push("Verdict for the ABAP rescue:");
  lines.push(`  Reachable: yes -- logged on as ${connection?.user === undefined ? "?" : show(String(connection.user))} to ${connection?.host ?? "?"}, ${dbText(p)}.`);
  lines.push(...schemaLines(p).map((l) => `  ${l}`));
  if (p.schemas.length > 0) lines.push(...attachedLines(p).map((l) => `  ${l}`));
  const ability = canWrite(p)
    ? " and can do more than read on the schema"
    : writeAbilityKnown(p) ? " and can only read"
      : privilegesUnreadable(p) ? "; the sidecar could not read its privileges, so osd hana could not determine whether this login can write"
        : "; whether it can do more than read, the sidecar did not report";
  lines.push(`  This login is ${loginClassText(p)}${ability}.`);
  const tls = tlsLine(p);
  if (tls !== undefined) lines.push(`  ${tls}`);
  if (canWrite(p)) lines.push(`  ${safetyNote(sidecar)}`);
  // the notes probe-doc.mjs recognised are said above (as "not readable");
  // any other note is the sidecar's own words, printed verbatim
  for (const note of p.unrecognisedNotes) lines.push(`  Note from the sidecar: ${show(note)}`);
  if (p.missing.length > 0) {
    lines.push(`  NOT REPORTED by the sidecar: ${p.missing.map((m) => show(m)).join(", ")} -- the verdict above is incomplete where it depends on these; nothing is assumed for them.`);
  }
  if (p.schemas.length > 0) {
    lines.push("  Ready to extract: yes -- the next step is `osd hana extract`.");
  } else if (p.schemasReported) {
    lines.push("  Ready to extract: no -- there is no ABAP schema here this login can read.");
  } else {
    lines.push("  Ready to extract: unknown -- the sidecar's answer names no ABAP schema list.");
  }
  return lines;
}

/** The --json document: the same findings as data. No password field, ever.
 *  `probe` is the sidecar's document as it came; `verdict` is what the doctor
 *  read from it; `verdict.missing` names what the sidecar did not report. */
export function jsonVerdict(probe, {connection, sidecar, warnings = []}) {
  const p = readProbe(probe);
  return {
    command: "osd hana doctor",
    sidecar,
    connection: {
      host: connection?.host, port: connection?.port, database: connection?.database,
      user: connection?.user, schema: connection?.schema,
    },
    probe: p.raw,
    verdict: {
      reachable: true,
      db: p.db ?? "unknown",
      abapSchemas: p.schemas.map((s) => s.name ?? "?"),
      loginClass: p.loginClass === "other" && !administratorKnown(p) ? "unknown" : (p.loginClass ?? "unknown"),
      canWrite: canWrite(p) ? true : (writeAbilityKnown(p) ? false : "unknown"),
      abapAttached: p.schemas.length === 1 ? (p.schemas[0].abapAttached ?? "unknown") : p.schemas.map((s) => s.abapAttached ?? "unknown"),
      tls: p.tls,
      readyToExtract: p.schemas.length > 0,
      safetyNote: canWrite(p) ? safetyNote(sidecar) : undefined,
      notes: p.notes,
      unrecognisedNotes: p.unrecognisedNotes,
      missing: p.missing,
      unknown: p.unknown,
    },
    warnings,
  };
}
