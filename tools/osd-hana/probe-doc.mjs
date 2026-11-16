// The sidecar's `probe` document, READ ONCE and in one place.
//
// The shape here is the real binary's, recorded in test/osd-hana/contract/
// (see the README there): a flat document
//
//   {ok, db, abap_schemas: [{schema, owned_by_login, non_select_on_schema,
//    non_select_kinds?, basis_release?, clients?, reposrc_rows, tadir_rows,
//    abap_attached}], login_class, admin_privileges?, notes?, tls?}
//
// and NOT a guess. The first version of the doctor read invented names
// (`schemas[].name`, a `probe` wrapper) that only the test fake spoke: every
// test was green and the doctor answered "no ABAP schema" on a healthy
// system. Two rules follow, and this module is where they live:
//
// 1. A field the verdict needs and the document does not carry is MISSING --
//    recorded in `missing` and said to the user ("the sidecar did not report
//    X") -- never rendered as "none", "no" or "no ABAP schema".
// 2. "No ABAP schema" is claimed only when the document positively says so:
//    the `abap_schemas` key is present and holds null or an empty list (the
//    real binary prints null -- a Go nil slice -- with ok false, exit 5).
//
// Unknown extra fields are ignored: the sidecar is a moving binary.

const NORMALIZED = Symbol("osd-hana probe, read");

const isText = (v) => typeof v === "string" && v !== "";

function readSchema(raw, index, missing) {
  const where = `abap_schemas[${index}]`;
  const entry = (raw !== null && typeof raw === "object") ? raw : {};
  const need = (key, ok) => {
    if (!ok(entry[key])) {
      missing.push(`${where}.${key}`);
      return undefined;
    }
    return entry[key];
  };
  return {
    name: need("schema", isText),
    ownedByLogin: need("owned_by_login", (v) => typeof v === "boolean"),
    nonSelect: need("non_select_on_schema", (v) => typeof v === "boolean"),
    // the kinds, the release and the clients are optional in the real
    // document (omitted when empty / unreadable): absent is not "missing"
    nonSelectKinds: Array.isArray(entry.non_select_kinds) ? entry.non_select_kinds.map(String) : [],
    basisRelease: isText(entry.basis_release) ? entry.basis_release : undefined,
    clients: Array.isArray(entry.clients) ? entry.clients.map(String) : undefined,
    reposrcRows: need("reposrc_rows", Number.isFinite),
    tadirRows: need("tadir_rows", Number.isFinite),
    abapAttached: need("abap_attached", (v) => v === "yes" || v === "no" || v === "unknown"),
  };
}

/** Reads the one-line JSON summary of `osd-hana-dump probe` into the model
 *  the doctor works with. Idempotent: an already-read probe passes through.
 *
 *  schemasReported  the document carries the `abap_schemas` key at all
 *  schemas          [] when the key is absent, null or empty
 *  missing          the fields the verdict needs and the document lacks */
export function readProbe(document) {
  if (document !== null && typeof document === "object" && document[NORMALIZED] === true) return document;
  const raw = (document !== null && typeof document === "object") ? document : {};
  const missing = [];
  const schemasReported = Object.hasOwn(raw, "abap_schemas");
  const list = Array.isArray(raw.abap_schemas) ? raw.abap_schemas : [];
  if (schemasReported && raw.abap_schemas !== null && !Array.isArray(raw.abap_schemas)) missing.push("abap_schemas (not a list)");
  if (!schemasReported) missing.push("abap_schemas");
  const schemas = list.map((entry, index) => readSchema(entry, index, missing));
  const db = raw.db === "tenant" || raw.db === "system" ? raw.db : undefined;
  if (db === undefined) missing.push("db");
  const loginClass = ["schema_owner", "admin", "other"].includes(raw.login_class) ? raw.login_class : undefined;
  if (loginClass === undefined) missing.push("login_class");
  const read = {
    ok: raw.ok === true,
    db,
    loginClass,
    adminPrivileges: Array.isArray(raw.admin_privileges) ? raw.admin_privileges.map(String) : [],
    notes: Array.isArray(raw.notes) ? raw.notes.map(String) : [],
    tls: ["verified", "unverified", "off"].includes(raw.tls) ? raw.tls : undefined,
    error: isText(raw.error) ? raw.error : undefined,
    schemasReported,
    schemas,
    missing,
    raw,
  };
  Object.defineProperty(read, NORMALIZED, {value: true, enumerable: false});
  return read;
}

/** True when the document POSITIVELY says there is no ABAP schema this login
 *  can read: the key is there and holds nothing. An absent key says nothing. */
export function saysNoAbapSchema(probe) {
  const p = readProbe(probe);
  return p.schemasReported && p.schemas.length === 0 && !p.missing.includes("abap_schemas (not a list)");
}

/** The login holds an administrator privilege (DATABASE, USER or ROLE
 *  ADMIN). The real binary reports a login that ALSO owns an ABAP schema as
 *  login_class "schema_owner" and still lists `admin_privileges`, so the
 *  class alone does not answer this. */
export function isAdministrator(probe) {
  const p = readProbe(probe);
  return p.loginClass === "admin" || p.adminPrivileges.length > 0;
}

/** The login owns an ABAP schema the probe reports. */
export function ownsAbapSchema(probe) {
  const p = readProbe(probe);
  return p.loginClass === "schema_owner" || p.schemas.some((s) => s.ownedByLogin === true);
}
