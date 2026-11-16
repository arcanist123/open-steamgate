// The verdict: what the sidecar's `probe` answered, said so a person who has
// never seen a HANA can act on it (task B.2). One place, so the plain text and
// the --json document cannot disagree.
//
// The probe's shape is the sidecar README's: db (tenant|system),
// login_class (schema_owner|admin|other), non_select_on_schema
// (bool or {yes, kinds}), abap_attached (yes|no|unknown), and one entry per
// ABAP schema with basis_release, clients, reposrc_rows, tadir_rows,
// owned_by_login. Every field read here tolerates its absence -- the sidecar
// is a moving binary, and the doctor degrades to "unknown", never to a crash.

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

export function dbText(probe = {}) {
  if (probe.db === "tenant") return "a tenant database";
  if (probe.db === "system") return "the system database (SYSTEMDB)";
  return "of an unknown kind";
}

// The safety sentence, kept in one place so it is said exactly once (task
// B.3): the doctor never refuses a powerful login, because the sidecar's
// sessions are read-only at the database level.
export const SAFETY_NOTE = "Extraction is safe with this login even though it can write: every session the sidecar opens is read-only at the database level -- the database itself refuses any write, whoever logs on.";

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
    return `ABAP schema ${s.name ?? "?"}${owned}: found${release}${clients}${sizeText}.`;
  });
}

/** The plain verdict, one line per finding, ready to print. */
export function plainVerdict(probe = {}, {connection} = {}) {
  const lines = [];
  lines.push("Verdict for the ABAP rescue:");
  lines.push(`  Reachable: yes -- logged on as ${connection?.user ?? "?"} to ${connection?.host ?? "?"}, ${dbText(probe)}.`);
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
  if (canWrite(probe)) lines.push(`  ${SAFETY_NOTE}`);
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
      safetyNote: canWrite(probe) ? SAFETY_NOTE : undefined,
    },
    warnings,
  };
}
