// tools/osd-hana: the sidecar's RECORDED contracts, and the doctor reading
// the real probe document.
//
// The doctor once read field names only the test fake spoke (`schemas[].name`
// under a `probe` wrapper): 118 tests were green and on a real database the
// doctor answered "no ABAP schema" on a healthy system. So:
//  - test/osd-hana/contract/ holds what the real binary printed (identifiers
//    replaced, shapes untouched);
//  - the fake sidecar serves those documents with values varied, and the
//    first block below fails when it carries a key nobody recorded or listed;
//  - a field the verdict needs and the sidecar did not report is SAID, and
//    "no ABAP schema" is claimed only when the document positively says so.
// Fakes only: no network, no database.
import {expect} from "chai";
import {execFileSync} from "node:child_process";
import {readFileSync, readdirSync} from "node:fs";
import {join} from "node:path";

import {readProbe, saysNoAbapSchema, isAdministrator} from "../tools/osd-hana/probe-doc.mjs";
import {canWrite, jsonVerdict, plainVerdict, readerRoleFromProbe, SAFETY_NOTE} from "../tools/osd-hana/verdict.mjs";
import {CONTRACT_DIR, FAKE_SIDECAR, SCHEMA, makeHarness} from "./osd-hana/harness.mjs";

const load = (name) => JSON.parse(readFileSync(join(CONTRACT_DIR, `${name}.json`), "utf8"));
const FIELDS = load("fields");
const fake = () => JSON.parse(execFileSync(process.execPath, [FAKE_SIDECAR], {
  env: {...process.env, FAKE_SIDECAR_DUMP_SCENARIOS: "1", OSD_HANA_PASSWORD: "pw-for-the-dump"}, encoding: "utf8",
}));

/** Every key of a probe document, by level, that fields.json does not list. */
function unknownKeys(document) {
  const unknown = [];
  const isError = Object.hasOwn(document, "error");
  const top = isError ? FIELDS.error : FIELDS.probe;
  for (const key of Object.keys(document)) if (!Object.hasOwn(top, key)) unknown.push(key);
  for (const schema of Array.isArray(document.abap_schemas) ? document.abap_schemas : []) {
    for (const key of Object.keys(schema)) if (!Object.hasOwn(FIELDS["probe.abap_schemas[]"], key)) unknown.push(`abap_schemas[].${key}`);
  }
  return unknown;
}

describe("tools/osd-hana: the recorded sidecar contracts", function () {
  this.timeout(20000);
  const h = makeHarness();
  before(h.before);
  after(h.after);

  describe("the fake may not invent fields", function () {
    it("every probe document the fake can serve carries only keys a recording or the sidecar's own source lists (mutation: a scenario gains an invented key -> red)", function () {
      const {probes} = fake();
      expect(Object.keys(probes).length).to.be.greaterThan(15);
      for (const [name, answer] of Object.entries(probes)) {
        expect(unknownKeys(answer.document), `scenario ${name}`).to.deep.equal([]);
        // the invented shapes of the first version, by name
        expect(answer, `scenario ${name}`).to.not.have.property("probe");
        expect(answer.document, `scenario ${name}`).to.not.have.property("schemas");
        expect(answer.document, `scenario ${name}`).to.not.have.property("probe");
      }
    });

    it("the detector itself works: a document with an invented key is named (the positive control)", function () {
      const invented = structuredClone(load("probe-ok").document);
      invented.schemas = [];
      invented.abap_schemas[0].name = "X";
      expect(unknownKeys(invented)).to.deep.equal(["schemas", "abap_schemas[].name"]);
    });

    it("enumerated values stay inside the sidecar's own value lists", function () {
      const {probes} = fake();
      for (const [name, answer] of Object.entries(probes)) {
        const d = answer.document;
        for (const key of ["db", "login_class", "tls"]) {
          if (d[key] !== undefined) expect(FIELDS.values[key], `${name}.${key}`).to.include(d[key]);
        }
        for (const s of Array.isArray(d.abap_schemas) ? d.abap_schemas : []) {
          if (s.abap_attached !== undefined) expect(FIELDS.values.abap_attached, `${name}.abap_attached`).to.include(s.abap_attached);
        }
      }
    });

    it("the fake's --version --json has exactly the recorded keys", function () {
      const out = JSON.parse(execFileSync(process.execPath, [FAKE_SIDECAR, "--version", "--json"], {encoding: "utf8"}));
      expect(Object.keys(out).sort()).to.deep.equal(Object.keys(load("version").document).sort());
    });
  });

  describe("fields.json is honest about the recordings", function () {
    it("a key marked recorded appears in a recording, and no recording carries an unlisted key", function () {
      const recordings = readdirSync(CONTRACT_DIR).sort().filter((f) => f.startsWith("probe-") && f.endsWith(".json")).map((f) => load(f.slice(0, -5)));
      expect(recordings.length).to.equal(3);
      const seen = {probe: new Set(), "probe.abap_schemas[]": new Set(), error: new Set()};
      for (const {document} of recordings) {
        expect(unknownKeys(document)).to.deep.equal([]);
        const level = Object.hasOwn(document, "error") ? "error" : "probe";
        for (const key of Object.keys(document)) seen[level].add(key);
        for (const s of document.abap_schemas ?? []) for (const key of Object.keys(s)) seen["probe.abap_schemas[]"].add(key);
      }
      for (const level of Object.keys(seen)) {
        const marked = Object.entries(FIELDS[level]).filter(([, how]) => how === "recorded").map(([key]) => key).sort();
        expect([...seen[level]].sort(), level).to.deep.equal(marked);
      }
    });

    it("the recordings carry no live identifier shapes: synthetic names only", function () {
      const text = readdirSync(CONTRACT_DIR).sort().filter((f) => f.endsWith(".json")).map((f) => readFileSync(join(CONTRACT_DIR, f), "utf8")).join("\n");
      expect(text).to.include(SCHEMA);
      // documentation addresses (RFC 5737) and the example host only
      for (const address of text.match(/\b\d{1,3}(\.\d{1,3}){3}\b/g) ?? []) expect(address).to.match(/^192\.0\.2\./);
    });
  });

  describe("the doctor reads the real document", function () {
    it("the recorded probe of a read-only login gives exit 0 and the whole verdict (mutation: read `schemas` instead of `abap_schemas` -> red)", async function () {
      const code = await h.runDoctor([], {scenario: "reader"});
      expect(code).to.equal(0);
      const text = h.allText();
      expect(text).to.include(`ABAP schema ${SCHEMA}: found, release 757/0000000001, clients 100, 200`);
      expect(text).to.include("3000000 source rows (REPOSRC), 1300000 repository objects (TADIR)");
      expect(text).to.include("a tenant database");
      expect(text).to.include("another kind of login (not the schema owner, not an administrator) and can only read");
      expect(text).to.include("ABAP server still attached: unknown");
      expect(text).to.include("Ready to extract: yes");
      expect(text).to.not.include(SAFETY_NOTE);
      expect(text).to.not.include("NOT REPORTED");
    });

    it("--json carries the sidecar's document as it came and what the doctor read from it", async function () {
      const code = await h.runDoctor(["--json"], {scenario: "reader"});
      expect(code).to.equal(0);
      const document = JSON.parse(h.out.join("\n"));
      expect(document.probe).to.deep.equal(load("probe-ok").document);
      expect(document.verdict).to.include({db: "tenant", loginClass: "other", canWrite: false, abapAttached: "unknown", readyToExtract: true});
      expect(document.verdict.abapSchemas).to.deep.equal([SCHEMA]);
      expect(document.verdict.missing).to.deep.equal([]);
    });

    it("the schema's owner is a login that can write: the real binary says kind OWNER, and the safety sentence is said once", async function () {
      const code = await h.runDoctor([], {scenario: "owner-tenant"});
      expect(code).to.equal(0);
      const text = h.allText();
      expect(text).to.include("(owned by this login)");
      expect(text).to.include("the ABAP schema's owner and can do more than read");
      expect(text.split(SAFETY_NOTE).length - 1).to.equal(1);
    });

    it("lists every ABAP schema, each with its own attached line; --create-reader then needs --schema (mutation: take the first schema -> red)", async function () {
      const code = await h.runDoctor([], {scenario: "two-schemas", schemaArg: false});
      expect(code).to.equal(0);
      const text = h.allText();
      expect(text).to.include(`ABAP schema ${SCHEMA}: found`);
      expect(text).to.include("ABAP schema TESTSCHEMA2: found");
      expect(text).to.include(`ABAP server still attached to ${SCHEMA}:`);
      expect(text).to.include("ABAP server still attached to TESTSCHEMA2:");
      const code2 = await h.runDoctor(["--create-reader", "--yes"], {scenario: "two-schemas", schemaArg: false,
        deps: {clientFactory: () => { throw new Error("no connection may be opened without a schema"); }}});
      expect(code2).to.equal(1);
      expect(h.allText()).to.include("pass --schema (the probe found 2 schemas)");
    });

    it("the system database note of the sidecar reaches the user", async function () {
      const code = await h.runDoctor([], {scenario: "admin-system"});
      expect(code).to.equal(0);
      expect(h.allText()).to.include("Note from the sidecar: connected to SYSTEMDB: connect to the tenant");
    });
  });

  describe("missing is said, never rendered as none", function () {
    it("an answer WITHOUT the abap_schemas key is a disagreement about the document, not 'no ABAP schema' (mutation: an absent key counts as an empty list -> red)", async function () {
      const code = await h.runDoctor([], {scenario: "missing-schemas-key"});
      expect(code).to.equal(1);
      const text = h.allText();
      expect(text).to.include(`the field "abap_schemas" is missing`);
      expect(text).to.include("NOT a finding that there is none");
      expect(text).to.not.include("no ABAP code to rescue");
      expect(text).to.not.include("no ABAP schema readable");
    });

    it("the first version's invented shape is exactly that case", function () {
      const invented = {ok: true, exit: 0, probe: {db: "tenant", login_class: "other", schemas: [{name: SCHEMA}]}};
      const p = readProbe(invented);
      expect(p.schemasReported).to.equal(false);
      expect(saysNoAbapSchema(invented)).to.equal(false);
      expect(p.missing).to.include("abap_schemas");
    });

    it("no ABAP schema is claimed when the document positively says so: exit 5 with abap_schemas null (mutation: require an error text -> red)", async function () {
      const code = await h.runDoctor([], {scenario: "no-schema"});
      expect(code).to.equal(5);
      const text = h.allText();
      expect(text).to.include("no ABAP schema readable by this login was found");
      expect(text).to.include("try the schema's owner, or an administrator");
      expect(text).to.include("looked only for the schema named with --schema");
      const code2 = await h.runDoctor([], {scenario: "no-schema-system", schemaArg: false});
      expect(code2).to.equal(5);
      expect(h.allText()).to.include("Note from the sidecar: connected to SYSTEMDB");
      expect(h.allText()).to.not.include("looked only for the schema");
    });

    it("exit 5 with the sidecar's ERROR line is 'could not examine', and says it is not a finding (mutation: every exit 5 says no schema -> red)", async function () {
      const code = await h.runDoctor([], {scenario: "unsupported"});
      expect(code).to.equal(5);
      const text = h.allText();
      expect(text).to.include("could not examine this database (unsupported system): looking for ABAP schemas: insufficient privilege");
      expect(text).to.include("NOT a finding that the database holds no ABAP schema");
      expect(text).to.not.include("no ABAP schema readable by this login was found");
    });

    it("schema fields the verdict needs and the sidecar did not report are named, and nothing is assumed for them (mutation: a missing non_select_on_schema reads as false -> red)", async function () {
      const code = await h.runDoctor([], {scenario: "missing-schema-fields"});
      expect(code).to.equal(0);
      const text = h.allText();
      expect(text).to.include("NOT REPORTED by the sidecar: abap_schemas[0].non_select_on_schema, abap_schemas[0].abap_attached, login_class");
      expect(text).to.include("ABAP server still attached: the sidecar did not report it");
      expect(text).to.include("of a class the sidecar did not report; whether it can do more than read, the sidecar did not report");
      expect(text).to.not.include("can only read");
      const code2 = await h.runDoctor(["--json"], {scenario: "missing-schema-fields"});
      expect(code2).to.equal(0);
      const document = JSON.parse(h.out.join("\n"));
      expect(document.verdict.canWrite).to.equal("unknown");
      expect(document.verdict.loginClass).to.equal("unknown");
      expect(document.verdict.missing).to.have.length(3);
    });

    it("unknown extra fields are ignored", function () {
      const d = structuredClone(load("probe-ok").document);
      d.something_new = {a: 1};
      d.abap_schemas[0].another = true;
      expect(readProbe(d).missing).to.deep.equal([]);
      expect(plainVerdict(d, {connection: {user: "U", host: "h"}}).join("\n")).to.include("Ready to extract: yes");
    });
  });

  describe("the roles of the two-login flow, read off the real document", function () {
    const base = () => structuredClone(load("probe-ok").document);
    it("a login that owns the schema AND is an administrator is reported as schema_owner with admin_privileges: that is 'both' (mutation: role from login_class alone -> red)", function () {
      const d = base();
      d.login_class = "schema_owner";
      d.admin_privileges = ["USER ADMIN"];
      Object.assign(d.abap_schemas[0], {owned_by_login: true, non_select_on_schema: true, non_select_kinds: ["OWNER"]});
      expect(isAdministrator(d)).to.equal(true);
      expect(readerRoleFromProbe(d)).to.equal("both");
      expect(canWrite(d)).to.equal(true);
    });
    it("owner, administrator and a plain reader", function () {
      const owner = base();
      owner.login_class = "schema_owner";
      owner.abap_schemas[0].owned_by_login = true;
      expect(readerRoleFromProbe(owner)).to.equal("owner");
      const admin = base();
      admin.login_class = "admin";
      admin.admin_privileges = ["USER ADMIN"];
      expect(readerRoleFromProbe(admin)).to.equal("admin");
      expect(canWrite(admin)).to.equal(true);
      expect(readerRoleFromProbe(base())).to.equal("neither");
      expect(jsonVerdict(base(), {connection: {}, sidecar: {}}).verdict.canWrite).to.equal(false);
    });
  });
});
