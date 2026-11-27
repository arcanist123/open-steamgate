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
import {mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {readProbe, saysNoAbapSchema, isAdministrator} from "../tools/osd-hana/probe-doc.mjs";
import {canWrite, jsonVerdict, plainVerdict, readerRoleFromProbe, SAFETY_NOTE} from "../tools/osd-hana/verdict.mjs";
import {CONTRACT_DIR, FAKE_SIDECAR, SCHEMA, makeHarness} from "./osd-hana/harness.mjs";
import {SUCCESS_RULES, fakeClientFactory} from "./osd-hana/fake-client.mjs";
import {buildExtractFixtures} from "./osd-hana/extract-fixtures.mjs";

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

  describe("a dump part the fake writes is the recorded part's shape", function () {
    /** Every key path of a JSON value (arrays: their elements' paths under []). */
    const paths = (v, at = "") => {
      if (Array.isArray(v)) return v.flatMap((x) => paths(x, `${at}[]`));
      if (v !== null && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => [`${at}.${k}`, ...paths(x, `${at}.${k}`)]);
      return [];
    };
    it("a W3MI-only dump request: the part's files, manifest keys and object rows are a subset of the recording dump-part-w3mi-only (mutation: the fake gains a manifest field or a tables/ folder -> red)", function () {
      const recorded = load("dump-part-w3mi-only");
      const work = mkdtempSync(join(tmpdir(), "osd-hana-part-"));
      try {
        const fx = buildExtractFixtures(join(work, "fx"));
        const out = join(work, "part");
        const request = join(work, "request.json");
        writeFileSync(request, JSON.stringify({schema: 1, requested: {W3MI: ["ZOSD_MIME_01.BIN"]}, catalog: true, ddic: true, provenance: "contract test"}));
        writeFileSync(join(fx.dump, "objects.jsonl"), JSON.stringify(recorded.objects_row) + "\n");
        try {
          execFileSync(process.execPath, [FAKE_SIDECAR, "dump", "--request", request, "--out", out], {env: {...process.env, FAKE_SIDECAR_DUMP: fx.dump}, encoding: "utf8"});
        } catch (error) {
          if (error.status !== 0) throw error;
        }
        const files = readdirSync(out).sort().filter((f) => !["counts.json", "summary.json"].includes(f));
        expect(files, "the part's files").to.deep.equal(recorded.files);
        expect(readFileSync(join(out, "reposrc.jsonl"), "utf8").length).to.equal(recorded.reposrc_bytes);
        const known = new Set(paths(recorded.manifest));
        const invented = [...new Set(paths(JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"))))].filter((p) => !known.has(p)
          // the request echo holds what THIS request asked; its keys are the request's, checked by the request tests
          && !p.startsWith(".sidecar.request."));
        expect(invented, "manifest keys no recording carries").to.deep.equal([]);
        const rowKeys = new Set(Object.keys(recorded.objects_row));
        for (const line of readFileSync(join(out, "objects.jsonl"), "utf8").split("\n").filter(Boolean)) {
          expect(Object.keys(JSON.parse(line)).filter((k) => !rowKeys.has(k)), "object-row keys").to.deep.equal([]);
        }
        expect(recorded.manifest.counts.rows_TADIR, "the recording says zero TADIR rows").to.equal(0);
      } finally {
        rmSync(work, {recursive: true, force: true});
      }
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

  describe("a value the sidecar could not read is UNKNOWN, not zero (derived from source: probe.go writes 0/false plus a note)", function () {
    const derivedFiles = () => readdirSync(CONTRACT_DIR).sort().filter((f) => f.startsWith("derived-probe-") && f.endsWith(".json"));
    // the note texts, exactly as cmd/osd-hana-dump/probe.go at the pinned tag writes them
    const PROBE_GO_NOTES = [/^system privileges not readable$/, /^.+: privileges not readable$/, /^.+: REPOSRC not readable$/, /^.+: TADIR not readable$/];

    it("the derived fixtures are a recording with values changed: only listed keys, notes only in probe.go's own words, each named in the README", function () {
      const files = derivedFiles();
      expect(files.length).to.equal(4);
      const readme = readFileSync(join(CONTRACT_DIR, "README.md"), "utf8");
      expect(readme).to.include("derived from source");
      for (const file of files) {
        const fixture = load(file.slice(0, -5));
        expect(readme, file).to.include(`\`${file}\``);
        expect(fixture.derived_from, file).to.equal("probe-ok");
        expect(unknownKeys(fixture.document), file).to.deep.equal([]);
        expect(fixture.document.notes, file).to.be.an("array").that.is.not.empty;
        for (const note of fixture.document.notes) expect(PROBE_GO_NOTES.some((re) => re.test(note)), `${file}: ${note}`).to.equal(true);
      }
    });

    it("REPOSRC / TADIR not readable: the counts are 'not readable with this login', never '0 source rows' (mutation: the notes ignored -> red)", async function () {
      const code = await h.runDoctor([], {scenario: "counts-unreadable"});
      expect(code).to.equal(0);
      const text = h.allText();
      expect(text).to.include("source rows (REPOSRC): not readable with this login");
      expect(text).to.include("repository objects (TADIR): not readable with this login");
      expect(text).to.not.include("0 source rows");
      expect(text).to.not.include("0 repository objects");
      // recognised notes are said through the verdict, not repeated raw
      expect(text).to.not.include("Note from the sidecar");
      const p = readProbe(load("derived-probe-counts-unreadable").document);
      expect(p.schemas[0].reposrcRows).to.equal(undefined);
      expect(p.schemas[0].tadirRows).to.equal(undefined);
      expect(p.unknown).to.deep.equal(["abap_schemas[0].reposrc_rows", "abap_schemas[0].tadir_rows"]);
      expect(p.missing).to.deep.equal([]);
    });

    it("schema privileges not readable: never 'can only read' -- 'could not determine whether this login can write' (mutation: non_select_on_schema false taken at face value -> red)", async function () {
      const code = await h.runDoctor([], {scenario: "privileges-unreadable"});
      expect(code).to.equal(0);
      const text = h.allText();
      expect(text).to.include("could not determine whether this login can write");
      expect(text).to.not.include("can only read");
      expect(text).to.not.include("Note from the sidecar");
      const code2 = await h.runDoctor(["--json"], {scenario: "privileges-unreadable"});
      expect(code2).to.equal(0);
      const document = JSON.parse(h.out.join("\n"));
      expect(document.verdict.canWrite).to.equal("unknown");
      expect(document.verdict.unknown).to.deep.equal(["abap_schemas[0].non_select_on_schema"]);
    });

    it("system privileges not readable: the login is not called 'not an administrator', and whether it can write is undetermined (mutation: login_class 'other' taken at face value -> red)", async function () {
      const code = await h.runDoctor([], {scenario: "system-privileges-unreadable"});
      expect(code).to.equal(0);
      const text = h.allText();
      expect(text).to.not.include("not an administrator)");
      expect(text).to.include("whether it is an administrator could not be read with this login");
      expect(text).to.include("could not determine whether this login can write");
      expect(text).to.not.include("can only read");
      const d = load("derived-probe-system-privileges-unreadable").document;
      expect(readProbe(d).adminKnown).to.equal(false);
      expect(readerRoleFromProbe(d)).to.equal("unknown");
      expect(jsonVerdict(d, {connection: {}, sidecar: {}}).verdict.canWrite).to.equal("unknown");
      // the owner is still the owner; only whether it is ALSO an administrator is open
      const owner = load("derived-probe-owner-system-privileges-unreadable").document;
      expect(readerRoleFromProbe(owner)).to.equal("unknown");
      expect(canWrite(owner)).to.equal(true);
    });

    it("a note the parser does not recognise is printed verbatim and marks nothing (mutation: unknown notes dropped -> red)", async function () {
      const code = await h.runDoctor([], {scenario: "unrecognised-note"});
      expect(code).to.equal(0);
      const text = h.allText();
      expect(text).to.include(`Note from the sidecar: ${SCHEMA}: something a newer sidecar says`);
      expect(text).to.include("can only read");
      const p = readProbe({...load("probe-ok").document, notes: ["OTHERSCHEMA: REPOSRC not readable"]});
      // a schema note for a schema the document does not list is not applied to another one
      expect(p.unknown).to.deep.equal([]);
      expect(p.unrecognisedNotes).to.deep.equal(["OTHERSCHEMA: REPOSRC not readable"]);
    });

    describe("the reader flow asks instead of assuming when system privileges were not readable", function () {
      it("not the owner, admin unknown, no terminal: refuses and says why -- never 'neither an administrator', nothing sent (mutation: unknown treated as neither -> red)", async function () {
        const {log, factory} = fakeClientFactory(SUCCESS_RULES);
        const code = await h.runDoctor(["--create-reader", "--yes"], {
          scenario: "system-privileges-unreadable",
          deps: {clientFactory: factory, store: h.store()},
        });
        expect(code).to.equal(1);
        const text = h.allText();
        expect(text).to.include("could not read this login's system privileges");
        expect(text).to.not.include("neither an administrator");
        expect(text).to.include("Nothing was sent");
        expect(log.connections).to.have.length(0);
      });

      it("owner, admin unknown, on a terminal: the doctor asks; 'yes' makes it one login for both roles, nothing assumed before the answer (mutation: unknown treated as owner without asking -> red)", async function () {
        const {log, factory} = fakeClientFactory(SUCCESS_RULES);
        const asked = [];
        const code = await h.runDoctor(["--create-reader", "--yes"], {
          scenario: "owner-system-privileges-unreadable",
          isTTY: true,
          deps: {clientFactory: factory, store: h.store(), stderr: {isTTY: true},
            prompt: async (question) => { asked.push(question); return "y"; }},
        });
        expect(code, h.allText()).to.equal(0);
        expect(asked.some((q) => q.includes("administrator") && q.includes("[y/n]"))).to.equal(true);
        expect(asked.some((q) => q.includes("login:"))).to.equal(false);
        // one login ran everything: no second login was opened
        expect(new Set(log.connections.map((c) => c.user)).has("OWNERLOGIN")).to.equal(false);
        expect(log.statements.some((s) => s.sql.startsWith("CREATE USER"))).to.equal(true);
      });

      it("owner, admin unknown, on a terminal, answered 'no': the doctor then asks for the administrator login", async function () {
        const {factory} = fakeClientFactory(SUCCESS_RULES);
        const asked = [];
        await h.runDoctor(["--create-reader", "--yes"], {
          scenario: "owner-system-privileges-unreadable",
          isTTY: true,
          deps: {clientFactory: factory, store: h.store(), stderr: {isTTY: true},
            prompt: async (question) => { asked.push(question); return question.includes("[y/n]") ? "n" : ""; }},
        });
        expect(asked.some((q) => q.includes("[y/n]"))).to.equal(true);
        expect(asked.some((q) => q.includes("administrator login"))).to.equal(true);
      });
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
