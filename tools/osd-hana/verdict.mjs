// The verdict: what the sidecar's `probe` answered, said so a person who has
// never seen a HANA can act on it (task B.2). One place, so the plain text and
// the --json document cannot disagree.
//
// The probe's shape is the sidecar README's: db (tenant|system),
// login_class (schema_owner|admin|other), non_select_on_schema
// (bool or {yes, kinds}), abap_attached (yes|no|unknown), tls
// (verified|unverified|off when the sidecar has the capability), and one
// entry per ABAP schema with basis_release, clients, reposrc_rows, tadir_rows,
// owned_by_login. Every field read here tolerates its absence -- the sidecar
// is a moving binary, and the doctor degrades to "unknown", never to a crash.
//
// Every name the PLAIN verdict prints goes through show() (critic round-2
// SHOULD-2, the S-B class one door over): the schema names come from the
// database being examined, on a connection --encrypt does not protect (the
// probe rides the sidecar's own session), so a name carrying ESC/CR must not
// reach the terminal raw. --json is safe on its own (JSON.stringify escapes).

import {show} from "./reader.mjs";

// True when the login can do more than read on the ABAP schema.
export function canWrite(probe = {}) {
  const nsos = probe.non_select_on_schema;
  if (nsos === true) return true;
  if (typeof nsos === "object" && nsos !== null) {
    if (nsos.yes === true) return true;
    if (Array.isArray(nsos.kinds) && nsos.kinds.length > 0) return true;
  }
  if (probe.login_class === "admin") return true;
  return false;
}

export function loginClassText(probe = {}) {
  switch (probe.login_class) {
    case "schema_owner": return "the ABAP schema's owner";
    case "admin": return "an administrator";
    case "other": return "another kind of login (not the schema owner, not an administrator)";
    default: return "of an unknown class";
  }
}

/** Which role the present login holds in the guided two-login create flow
 *  (task item 1), worked out from the probe: "admin" (USER ADMIN, not the
 *  owner), "owner", "both" (one login that can do both -- it exists on some
 *  systems), or "neither" (the doctor explains and sends nothing). The
 *  administrator role is the probe's "admin" login_class; the owner role is
 *  the "schema_owner" class or a schema the probe reports as owned by this
 *  login. */
export function readerRoleFromProbe(probe = {}) {
  const schemas = Array.isArray(probe.schemas) ? probe.schemas : [];
  const isAdmin = probe.login_class === "admin";
  const ownsSchema = probe.login_class === "schema_owner" || schemas.some((s) => s.owned_by_login === true);
  if (isAdmin && ownsSchema) return "both";
  if (isAdmin) return "admin";
  if (ownsSchema) return "owner";
  return "neither";
}

export function dbText(probe = {}) {
  if (probe.db === "tenant") return "a tenant database";
  if (probe.db === "system") return "the system database (SYSTEMDB)";
  return "of an unknown kind";
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
  switch (probe.tls) {
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
  const schemas = Array.isArray(probe.schemas) ? probe.schemas : [];
  if (schemas.length === 0) return ["ABAP schema: none found."];
  return schemas.map((s) => {
    const release = s.basis_release !== undefined ? `, release ${s.basis_release}` : "";
    const clients = Array.isArray(s.clients) && s.clients.length > 0 ? `, clients ${s.clients.join(", ")}` : "";
    const size = [];
    if (s.reposrc_rows !== undefined) size.push(`${s.reposrc_rows} source rows (REPOSRC)`);
    if (s.tadir_rows !== undefined) size.push(`${s.tadir_rows} repository objects (TADIR)`);
    const sizeText = size.length > 0 ? `, repository: ${size.join(", ")}` : "";
    const owned = s.owned_by_login === true ? " (owned by this login)" : "";
    return `ABAP schema ${s.name === undefined ? "?" : show(String(s.name))}${owned}: found${release}${clients}${sizeText}.`;
  });
}

/** The plain verdict, one line per finding, ready to print. `sidecar.pinned`
 *  decides which safety sentence the moment earns (see safetyNote). */
export function plainVerdict(probe = {}, {connection, sidecar} = {}) {
  const lines = [];
  lines.push("Verdict for the ABAP rescue:");
  lines.push(`  Reachable: yes -- logged on as ${connection?.user === undefined ? "?" : show(String(connection.user))} to ${connection?.host ?? "?"}, ${dbText(probe)}.`);
  lines.push(...schemaLines(probe).map((l) => `  ${l}`));
  const attached = probe.abap_attached;
  if (attached === "yes") {
    lines.push("  ABAP server still attached: yes (informational -- you do not need it; the database alone is enough).");
  } else if (attached === "no") {
    lines.push("  ABAP server still attached: no (informational).");
  } else {
    lines.push("  ABAP server still attached: unknown (informational -- this login may not see the sessions).");
  }
  lines.push(`  This login is ${loginClassText(probe)}${canWrite(probe) ? " and can do more than read on the schema" : " and can only read"}.`);
  const tls = tlsLine(probe);
  if (tls !== undefined) lines.push(`  ${tls}`);
  if (canWrite(probe)) lines.push(`  ${safetyNote(sidecar)}`);
  const schemas = Array.isArray(probe.schemas) ? probe.schemas : [];
  if (schemas.length > 0) {
    lines.push("  Ready to extract: yes -- the next step is `osd hana extract`.");
  } else {
    lines.push("  Ready to extract: no -- there is no ABAP schema here to rescue code from.");
  }
  return lines;
}

/** The --json document: the same findings as data. No password field, ever. */
export function jsonVerdict(probe, {connection, sidecar, warnings = []}) {
  const schemas = Array.isArray(probe.schemas) ? probe.schemas : [];
  return {
    command: "osd hana doctor",
    sidecar,
    connection: {
      host: connection?.host, port: connection?.port, database: connection?.database,
      user: connection?.user, schema: connection?.schema,
    },
    probe,
    verdict: {
      reachable: true,
      db: probe.db ?? "unknown",
      abapSchemas: schemas.map((s) => s.name ?? "?"),
      loginClass: probe.login_class ?? "unknown",
      canWrite: canWrite(probe),
      abapAttached: probe.abap_attached ?? "unknown",
      readyToExtract: schemas.length > 0,
      safetyNote: canWrite(probe) ? safetyNote(sidecar) : undefined,
    },
    warnings,
  };
}
