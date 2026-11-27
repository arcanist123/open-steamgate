import {expect} from "chai";
import express from "express";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {request} from "node:http";
import {ObjectStore} from "../tools/osd-store.mjs";
import {adtRouter} from "../tools/adt-facade.mjs";
import {Data} from "../tools/osd-data.mjs";
import {dialogStep} from "../tools/osd-dialog-step.mjs";
import {undoOnExit} from "./helpers/undo-on-exit.mjs";
import {adtAbap} from "./helpers/adt-abap.mjs";
import {SESSION_COOKIE} from "../tools/adt-session.mjs";
import {activeFixture} from "./helpers/source-snapshot.mjs";
import {ActivationJournal} from "../tools/osd-activation-journal.mjs";
import {liveHash} from "../tools/osd-build.mjs";
import {snapshotTree, restoreTree} from "./helpers/tree-snapshot.mjs";

// The state-changing half of the façade: lock, write, unlock, activate.
//
// On its own express app rather than the served one, and with the transpile
// after an activation switched off, because a test that rewrites output/
// underneath the rest of the suite is a test that breaks its neighbours. The
// verdict is what these assert; the modules are the store's business and its
// own tests cover them.
const SCRATCH = "ZCL_OSD_SCRATCH";
const SOURCE = `CLASS zcl_osd_scratch DEFINITION PUBLIC CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS greet RETURNING VALUE(rv) TYPE string.
ENDCLASS.

CLASS zcl_osd_scratch IMPLEMENTATION.
  METHOD greet.
    rv = 'hello'.
  ENDMETHOD.
ENDCLASS.
`;

// a second object that calls the first, so an activation has something to
// break: renaming greet leaves ZCL_OSD_SCRATCH self-consistent and leaves
// this one calling a method that is gone
const CALLER = "ZCL_OSD_SCRATCH_USER";
const CALLER_SOURCE = `CLASS zcl_osd_scratch_user DEFINITION PUBLIC CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS shout RETURNING VALUE(rv) TYPE string.
ENDCLASS.

CLASS zcl_osd_scratch_user IMPLEMENTATION.
  METHOD shout.
    rv = zcl_osd_scratch=>greet( ).
  ENDMETHOD.
ENDCLASS.
`;


describe("tools/adt-facade: the development loop", () => {
  let server;
  let port;
  let store;
  let token;
  let context;
  let data;
  let journalRoot;
  // A PUT marks the scratch class inactive, and the store keeps its name in
  // build/inactive/inactive.json and its active copy under
  // build/inactive/active/. Left there, the next host that builds a
  // generation builds over that overlay (test/adt-preview.mjs did), so the
  // folder is put back as this file found it, with the scratch files.
  const INACTIVE = join("build", "inactive");
  let inactiveBefore;

  before(async function () {
    this.timeout(120000);
    inactiveBefore = snapshotTree(INACTIVE);
    // Q3's readers route reads the database through `data` (tools/adt-facade.mjs
    // xref/readers, ~1310), and a façade built with no `data` of its own gets
    // tools/osd-store.mjs ObjectStore#data's default: a bare `new Data({root})`
    // that boots a *raw* runtime on the first query (tools/osd-data.mjs boot())
    // -- output/init.mjs's `initializeABAP()` with no demo data, because the
    // synthetic taxi facts are seeded by test/start.mjs's own extra step
    // (`ensureDemoData`, tools/osd-demo-data.mjs), not by init.mjs itself.
    // The raw boot does not stop at seeding its own, separate database: the
    // default SQLite branch of test/setup.mjs makes a fresh in-memory client
    // every time `setup()` runs and *replaces*
    // `abap.context.databaseConnections.DEFAULT` with it. So a raw boot here,
    // if it happens before anything else in the process has imported
    // test/start.mjs, leaves that name pointing at an empty database; when
    // test/start.mjs is imported afterwards (test/analytics.mjs does),
    // its own `initializeABAP()` call replaces DEFAULT again and runs
    // `ensureDemoData` against *that* connection, which should be fine on
    // its own -- except this suite's own `data` (and the client Data.boot()
    // captured into it) is still the first, now-orphaned connection, one
    // instance of the mismatch; the one that broke test/analytics.mjs
    // (2026-09-25, PR #98) is the reverse case, an analytics run that
    // imports test/start.mjs first: whichever runtime that import produced,
    // Q3's raw boot swaps DEFAULT out from under it and the cube's rows
    // (already written by that earlier `ensureDemoData`) are on a connection
    // nothing still named DEFAULT can find.
    //
    // The fix is to never let this file be the one that boots raw: import
    // the canonical inline boot (test/start.mjs, run at most once per
    // process thanks to ESM's module cache, demo data included) before this
    // façade ever touches `data`, and hand it that boot's own client the way
    // test/zosd-test.mjs already does for the same reason.
    await import("./start.mjs");
    const client = globalThis.abap?.context?.databaseConnections?.DEFAULT;
    if (client === undefined) {
      throw new Error("the inline test system has no connected database");
    }
    const app = express();
    app.disable("x-powered-by");
    app.use(express.raw({type: "*/*", limit: "16mb"}));
    // LOCK and UNLOCK are ABAP's unless OSD_ADT=js (ADR 0007, slice 2)
    data = new Data({client});
    const facade = adtRouter({transpileOnActivate: false, data, abap: await adtAbap()});
    store = facade.store;
    journalRoot = mkdtempSync(join(tmpdir(), "adt-devloop-journal-"));
    store.activationJournal = new ActivationJournal(journalRoot);
    // registered here, not at load, so a run that filters this suite out
    // installs no signal listener on its behalf
    dropUndo = undoOnExit(removeScratch);
    app.use(facade.router);
    await new Promise((resolve) => {
      server = app.listen(0, resolve);
      // The tests here pause for seconds between requests on one kept-alive
      // socket — a transpile, a check — and Node closes an idle keep-alive
      // connection after five. The next request on it then dies with
      // ECONNRESET, which is what "fetch failed" in a test that passed a
      // minute ago meant. The window is widened past any pause a test takes.
      server.keepAliveTimeout = 120000;
      server.headersTimeout = 125000;
    });
    port = server.address().port;

    const res = await fetch(base() + "/core/discovery", {method: "HEAD", headers: {"x-csrf-token": "fetch"}});
    token = res.headers.get("x-csrf-token");
    context = (res.headers.getSetCookie?.() ?? []).join("; ").match(/sap-contextid=([^;]+)/)?.[1];
  });

  // the scratch objects are files like any other, so they are removed like
  // them -- in after(), and on an interrupted run, which never reaches it
  const removeScratch = () => {
    for (const name of [SCRATCH, CALLER, "ZCL_OSD_SCRATCH_TWO"]) {
      const entry = store?.find("CLAS", name);
      if (entry !== undefined && existsSync(entry.file)) {
        rmSync(entry.file);
      }
    }
    if (inactiveBefore !== undefined) restoreTree(INACTIVE, inactiveBefore);
  };
  let dropUndo = () => {};

  after(async () => {
    await server.close();
    removeScratch();
    dropUndo();
    if (journalRoot) rmSync(journalRoot, {recursive: true, force: true});
  });

  const base = () => `http://localhost:${port}/sap/bc/adt`;

  const call = (path, options = {}) => fetch(base() + path, {
    ...options,
    headers: {
      cookie: `sap-contextid=${context}`,
      "x-csrf-token": token,
      "x-sap-adt-sessiontype": "stateful",
      ...(options.headers ?? {}),
    },
  });

  const testLocks = [];
  afterEach(async () => {
    for (const {name, handle} of testLocks.splice(0)) {
      await call(`/oo/classes/${name}?_action=UNLOCK&lockHandle=${handle}`, {method: "POST"});
    }
  });
  const lock = async (name = SCRATCH) => {
    const res = await call(`/oo/classes/${name}?_action=LOCK&accessMode=MODIFY`, {method: "POST"});
    const xml = await res.text();
    const handle = xml.match(/<LOCK_HANDLE>([^<]*)<\/LOCK_HANDLE>/)?.[1];
    if (handle) testLocks.push({name, handle});
    return {status: res.status, xml, handle};
  };

  it("creation preflight validates class and package before mutation", async () => {
    const validate = async (path, values) => {
      const res = await call(path + "?" + new URLSearchParams(values), {method: "POST"});
      expect(res.status).to.equal(200);
      return res.text();
    };
    const classValues = {objtype: "CLAS/OC", objname: "ZCL_NEW_VALID", packagename: "$TMP"};
    expect(await validate("/oo/validation/objectname", classValues)).to.include("<CHECK_RESULT>X</CHECK_RESULT>");
    expect(store.find("CLAS", "ZCL_NEW_VALID")).to.equal(undefined);
    expect(await validate("/oo/validation/objectname", {...classValues, objname: "ZCL_ZOSD_TEST_DEMO"})).to.include("<SEVERITY>ERROR</SEVERITY>");
    expect(await validate("/oo/validation/objectname", {...classValues, objname: "../invalid"})).to.include("<SEVERITY>ERROR</SEVERITY>");
    expect(await validate("/oo/validation/objectname", {...classValues, packagename: "$NO_SUCH_PACKAGE"})).to.include("<SEVERITY>ERROR</SEVERITY>");
    expect(await validate("/packages/validation", {objtype: "DEVC/K", objname: "$NEW_VALID", packagename: "$TMP"})).to.include("<CHECK_RESULT>X</CHECK_RESULT>");
  });

  describe("locking", () => {

    it("a lock gives a handle in the envelope a client expects", async () => {
      // the object has to exist before it can be locked, so it is written
      // through the store first; the façade's own write is the next test
      store.write("CLAS", SCRATCH, SOURCE);
      const {status, xml, handle} = await lock();
      expect(status).to.equal(200);
      expect(xml).to.contain("<asx:abap");
      expect(handle).to.be.a("string").with.length.greaterThan(8);
    });

    it("locking the same object twice in one session refuses the second LOCK", async () => {
      const first = await lock();
      const again = await lock();
      expect(first.status).to.equal(200);
      expect(again.status).to.equal(403);
      expect(again.handle).to.equal(undefined);
      expect(again.xml).to.contain('<type id="ExceptionResourceNoAccess"/>');
    });

    it("a library object locks with no handle, which is how a system says not modifiable", async () => {
      const res = await call("/oo/classes/CL_ABAP_ZIP?_action=LOCK&accessMode=MODIFY", {method: "POST"});
      expect(res.status).to.equal(200);
      const xml = await res.text();
      expect(xml).to.contain("<LOCK_HANDLE></LOCK_HANDLE>");
    });

    it("a writable object of ours still locks, whatever its modification support says", async () => {
      // Result's modification support is empty; the handle permits a write
      const {status, handle} = await lock();
      expect(status).to.equal(200);
      expect(handle).to.have.length.greaterThan(8);
    });

    it("an object that is not there cannot be locked", async () => {
      const res = await call("/oo/classes/ZCL_NOT_A_THING?_action=LOCK&accessMode=MODIFY", {method: "POST"});
      expect(res.status).to.equal(404);
      expect(await res.text()).to.contain("exc:exception");
    });

    it("an unknown action is refused rather than guessed at", async () => {
      const res = await call(`/oo/classes/${SCRATCH}?_action=SOMETHING`, {method: "POST"});
      expect(res.status).to.equal(400);
    });
  });

  describe("writing", () => {
    it("a write needs the handle, and refuses without one", async () => {
      const res = await call(`/oo/classes/${SCRATCH}/source/main`, {method: "PUT", body: SOURCE});
      expect(res.status).to.equal(423);
      expect(await res.text()).to.contain("no lock handle");
    });

    it("a handle from another object does not open this one", async () => {
      const {handle} = await lock();
      store.write("CLAS", "ZCL_OSD_SCRATCH_TWO", SOURCE.replaceAll("zcl_osd_scratch", "zcl_osd_scratch_two"));
      const res = await call(`/oo/classes/ZCL_OSD_SCRATCH_TWO/source/main?lockHandle=${handle}`, {method: "PUT", body: SOURCE});
      expect(res.status).to.equal(423);
      const other = store.find("CLAS", "ZCL_OSD_SCRATCH_TWO");
      if (other !== undefined && existsSync(other.file)) {
        rmSync(other.file);
      }
    });

    it("a write with the handle lands, and reads back", async function () {
      // Variant C primes the whole-tree outline registry on the host save.
      this.timeout(30000);
      const {handle} = await lock();
      const changed = SOURCE.replace("'hello'", "'changed'");
      const res = await call(`/oo/classes/${SCRATCH}/source/main?lockHandle=${handle}`, {method: "PUT", body: changed});
      expect(res.status).to.equal(200);
      const back = await call(`/oo/classes/${SCRATCH}/source/main`);
      expect(await back.text()).to.contain("'changed'");
    });

    it("does not overwrite a source changed after the editor read it", async () => {
      store.write("CLAS", SCRATCH, SOURCE);
      const opened = await call(`/oo/classes/${SCRATCH}/source/main`);
      const staleTag = opened.headers.get("etag");
      const {handle} = await lock();
      const concurrent = SOURCE.replace("'hello'", "'concurrent'");
      store.write("CLAS", SCRATCH, concurrent);
      try {
        const res = await call(`/oo/classes/${SCRATCH}/source/main?lockHandle=${handle}`, {
          method: "PUT", headers: {"if-match": staleTag},
          body: SOURCE.replace("'hello'", "'editor'"),
        });
        expect(res.status).to.equal(412);
        expect(await res.text()).to.contain("ExceptionResourceIsModified");
        expect(store.read("CLAS", SCRATCH).source).to.equal(concurrent);
      } finally {
        store.write("CLAS", SCRATCH, SOURCE);
      }
    });

    it("accepts a write whose If-Match still names the stored source", async function () {
      // Variant C primes the whole-tree outline registry on the host save.
      this.timeout(30000);
      store.write("CLAS", SCRATCH, SOURCE);
      const opened = await call(`/oo/classes/${SCRATCH}/source/main`);
      const tag = opened.headers.get("etag");
      const {handle} = await lock();
      const changed = SOURCE.replace("'hello'", "'matched'");
      const res = await call(`/oo/classes/${SCRATCH}/source/main?lockHandle=${handle}`, {
        method: "PUT", headers: {"if-match": tag}, body: changed,
      });
      expect(res.status).to.equal(200);
      expect(store.read("CLAS", SCRATCH).source).to.equal(changed);
    });

    it("a library object cannot be written", async () => {
      const {handle} = await lock();
      const res = await call(`/oo/classes/CL_ABAP_ZIP/source/main?lockHandle=${handle}`, {method: "PUT", body: "nope"});
      expect(res.status).to.equal(405);
    });

    it("unlocking gives the object back", async () => {
      const {handle} = await lock();
      const unlocked = await call(`/oo/classes/${SCRATCH}?_action=UNLOCK&lockHandle=${handle}`, {method: "POST"});
      expect(unlocked.status).to.equal(200);
      const res = await call(`/oo/classes/${SCRATCH}/source/main?lockHandle=${handle}`, {method: "PUT", body: SOURCE});
      expect(res.status).to.equal(423);
    });
  });

  describe("the syntax check", () => {
    const checkRun = (name, source) => call("/checkruns?reporters=abapCheckRun", {
      method: "POST",
      body: `<?xml version="1.0" encoding="UTF-8"?>
<chkrun:checkObjectList xmlns:chkrun="http://www.sap.com/adt/checkrun" xmlns:adtcore="http://www.sap.com/adt/core">
  <chkrun:checkObject adtcore:uri="/sap/bc/adt/oo/classes/${String(name).toLowerCase()}" chkrun:version="active">
    <chkrun:artifacts>
      <chkrun:artifact chkrun:contentType="text/plain; charset=utf-8" chkrun:uri="/sap/bc/adt/oo/classes/${String(name).toLowerCase()}/source/main">
        <chkrun:content>${source.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</chkrun:content>
      </chkrun:artifact>
    </chkrun:artifacts>
  </chkrun:checkObject>
</chkrun:checkObjectList>`,
    });

    it("source that holds checks clean", async function () {
      this.timeout(60000);
      const res = await checkRun(SCRATCH, SOURCE);
      expect(res.status).to.equal(200);
      const xml = await res.text();
      expect(xml).to.contain("<chkrun:checkReport");
      expect(xml).to.contain('chkrun:status="processed"');
      expect(xml).to.contain("<chkrun:checkMessageList>");
      // Eclipse's EMF handler uses the checkrun model. An attribute from the
      // adtcore namespace on checkReport made deserialization return null;
      // these names match the document emitted by ADT itself.
      expect(xml).to.not.contain("adtcore:uri=");
      // no findings is an empty list, not an absent one: a client tells the
      // two apart and only one of them means "this ran and found nothing"
      expect(xml).to.not.contain("<chkrun:checkMessage ");
    });

    it("source that does not hold comes back with the finding, though nothing was written", async function () {
      this.timeout(60000);
      const before = await (await call(`/oo/classes/${SCRATCH}/source/main`)).text();
      const res = await checkRun(SCRATCH, SOURCE.replace("rv = 'hello'.", "rv = no_such_variable."));
      const xml = await res.text();
      expect(xml).to.contain("<chkrun:checkMessage ");
      expect(xml).to.contain('chkrun:type="E"');
      // A4H puts severity and text in attributes, and the position only in
      // the URI fragment; text in a child element reaches a client as a
      // finding with no words in it.
      expect(xml).to.match(/chkrun:shortText="[^"]+"/);
      expect(xml).to.match(/chkrun:uri="[^"]+#start=\d+,\d+"/);
      expect(xml).to.not.contain("chkrun:line=");
      expect(xml).to.not.contain("chkrun:column=");
      expect(xml).to.not.contain("chkrun:category=");
      expect(xml).to.not.contain("adtcore:uri=");
      expect(xml).to.not.contain("<shortText>");
      // the point of a check run: the file is untouched by it
      const after = await (await call(`/oo/classes/${SCRATCH}/source/main`)).text();
      expect(after).to.equal(before);
    });

    it("a check of an object that does not exist yet answers, because that is what a create looks like", async function () {
      this.timeout(60000);
      const res = await checkRun("ZCL_OSD_NEVER_WRITTEN", SOURCE.replaceAll("zcl_osd_scratch", "zcl_osd_never_written"));
      expect(res.status).to.equal(200);
      expect(await res.text()).to.contain("<chkrun:checkReport");
      expect(store.exists("CLAS", "ZCL_OSD_NEVER_WRITTEN"), "asking created nothing").to.equal(false);
    });

    const includeBody = (objects) => `<?xml version="1.0" encoding="UTF-8"?>
<chkrun:checkObjectList xmlns:chkrun="http://www.sap.com/adt/checkrun" xmlns:adtcore="http://www.sap.com/adt/core">
${objects.map(([uri, source]) => `  <chkrun:checkObject adtcore:uri="${uri}" chkrun:version="active">
    <chkrun:artifacts>
      <chkrun:artifact chkrun:contentType="text/plain; charset=utf-8" chkrun:uri="${uri}">
        <chkrun:content>${Buffer.from(source).toString("base64")}</chkrun:content>
      </chkrun:artifact>
    </chkrun:artifacts>
  </chkrun:checkObject>`).join("\n")}
</chkrun:checkObjectList>`;

    it("checks a program include as its own object and source resource", async function () {
      this.timeout(60000);
      const uri = "/sap/bc/adt/programs/includes/zosd_program_include";
      const res = await call("/checkruns?reporters=abapCheckRun", {
        method: "POST", body: includeBody([[uri, "THIS IS INVALID ABAP"]]),
      });
      const xml = await res.text();
      expect(res.status).to.equal(200);
      expect(xml.match(/<chkrun:checkReport /g)).to.have.lengthOf(1);
      expect(xml).to.include(`chkrun:triggeringUri="${uri}"`);
      expect(xml).to.include(`chkrun:uri="${uri}#start=`);
    });

    it("checks a mixed class and program-include request without dropping the include", async function () {
      this.timeout(60000);
      const classUri = `/sap/bc/adt/oo/classes/${SCRATCH.toLowerCase()}`;
      const includeUri = "/sap/bc/adt/programs/includes/zosd_program_include";
      const res = await call("/checkruns?reporters=abapCheckRun", {
        method: "POST", body: includeBody([[classUri, SOURCE], [includeUri, "THIS IS INVALID ABAP"]]),
      });
      const xml = await res.text();
      expect(res.status).to.equal(200);
      expect(xml.match(/<chkrun:checkReport /g)).to.have.lengthOf(2);
      expect(xml).to.include(`chkrun:triggeringUri="${includeUri}"`);
      expect(xml).to.include(`chkrun:uri="${includeUri}#start=`);
    });

    it("a wildcard content type is a request like any other", async function () {
      // a real system accepts application/* on a check run, so a client sends
      // it; a body parser that cannot resolve that to a media type leaves the
      // body unread, and the façade must not then claim nothing was sent
      this.timeout(60000);
      const res = await call("/checkruns?reporters=abapCheckRun", {
        method: "POST",
        headers: {"content-type": "application/*"},
        body: `<?xml version="1.0" encoding="UTF-8"?>
<chkrun:checkObjectList xmlns:chkrun="http://www.sap.com/adt/checkrun" xmlns:adtcore="http://www.sap.com/adt/core">
  <chkrun:checkObject adtcore:uri="/sap/bc/adt/oo/classes/${SCRATCH.toLowerCase()}" chkrun:version="active">
    <chkrun:artifacts>
      <chkrun:artifact chkrun:contentType="text/plain; charset=utf-8" chkrun:uri="/sap/bc/adt/oo/classes/${SCRATCH.toLowerCase()}/source/main">
        <chkrun:content>${Buffer.from(SOURCE, "utf8").toString("base64")}</chkrun:content>
      </chkrun:artifact>
    </chkrun:artifacts>
  </chkrun:checkObject>
</chkrun:checkObjectList>`,
      });
      expect(res.status).to.equal(200);
      expect(await res.text()).to.contain("<chkrun:checkReport");
    });

    it("base64 content is the path a real client takes", async function () {
      this.timeout(60000);
      const res = await call("/checkruns?reporters=abapCheckRun", {
        method: "POST",
        headers: {"content-type": "application/*"},
        body: `<chkrun:checkObjectList xmlns:chkrun="http://www.sap.com/adt/checkrun" xmlns:adtcore="http://www.sap.com/adt/core">
  <chkrun:checkObject adtcore:uri="/sap/bc/adt/oo/classes/${SCRATCH.toLowerCase()}">
    <chkrun:artifacts><chkrun:artifact chkrun:uri="/sap/bc/adt/oo/classes/${SCRATCH.toLowerCase()}/source/main">
      <chkrun:content>${Buffer.from(SOURCE.replace("rv = 'hello'.", "rv = no_such_variable."), "utf8").toString("base64")}</chkrun:content>
    </chkrun:artifact></chkrun:artifacts>
  </chkrun:checkObject>
</chkrun:checkObjectList>`,
      });
      expect(await res.text()).to.contain("<chkrun:checkMessage ");
    });

    it("a check run that names nothing is refused", async () => {
      const res = await call("/checkruns?reporters=abapCheckRun", {method: "POST", body: "<chkrun:checkObjectList/>"});
      expect(res.status).to.equal(400);
    });

    it("returns the package result Eclipse looks up instead of only child reports", async function () {
      this.timeout(60000);
      const packageName = (store.packages().find((pkg) => pkg.objects === 0) ?? store.packages()[0]).name;
      const uri = `/sap/bc/adt/packages/${encodeURIComponent(packageName.toLowerCase())}`;
      const res = await call("/checkruns", {
        method: "POST",
        body: `<chkrun:checkObjectList xmlns:chkrun="http://www.sap.com/adt/checkrun" xmlns:adtcore="http://www.sap.com/adt/core"><chkrun:checkObject adtcore:uri="${uri}" chkrun:version="active"/></chkrun:checkObjectList>`,
      });
      expect(res.status).to.equal(200);
      const xml = await res.text();
      expect(xml).to.contain(`chkrun:triggeringUri="${uri}"`);
      expect(xml).to.contain('chkrun:status="processed"');
    });

    it("the check is advertised now that it answers", async () => {
      expect(await (await call("/discovery")).text()).to.contain('href="/sap/bc/adt/checkruns"');
    });
  });

  describe("running the tests", () => {
    const testRun = (name) => call("/abapunit/testruns", {
      method: "POST",
      body: `<?xml version="1.0" encoding="UTF-8"?>
<aunit:runConfiguration xmlns:aunit="http://www.sap.com/adt/aunit" xmlns:adtcore="http://www.sap.com/adt/core">
  <external><coverage active="false"/></external>
  <adtcore:objectReferences>
    <adtcore:objectReference adtcore:uri="/sap/bc/adt/oo/classes/${String(name).toLowerCase()}"/>
  </adtcore:objectReferences>
</aunit:runConfiguration>`,
    });

    // The ABAP Unit view has a handler for the result under one name and
    // not the other: "No content-handler found for content-type
    // ...api.junit.run-result.v1+xml" was the whole of Ctrl+Shift+F10. The
    // document is the same either way; the name follows what is asked for.
    // After a run the client asks for its evaluation — the same result for
    // the objects named, with the test class and method as a fragment — to
    // show the report and navigate from a result (a4h-adt.jsonl:497).
    it("evaluates a run for the method a report points at", async function () {
      this.timeout(120000);
      const body = `<?xml version="1.0" encoding="UTF-8"?>
<aunit:runConfiguration xmlns:aunit="http://www.sap.com/adt/aunit">
  <options><uriType value="semantic"/><withNavigationUri enabled="true"/></options>
  <adtcore:objectSets xmlns:adtcore="http://www.sap.com/adt/core"><objectSet kind="inclusive"><adtcore:objectReferences>
    <adtcore:objectReference adtcore:uri="/sap/bc/adt/oo/classes/zcl_stg_segw_export#testclass=LTCL_EXPORT;testmethod=SOMETHING"/>
  </adtcore:objectReferences></objectSet></adtcore:objectSets>
</aunit:runConfiguration>`;
      const res = await call("/abapunit/testruns/evaluation", {method: "POST", body,
        headers: {accept: "application/vnd.sap.adt.abapunit.testruns.evaluation.result.v2+xml;q=0.9"}});
      expect(res.status).to.equal(200);
      expect(res.headers.get("content-type")).to.contain("application/vnd.sap.adt.abapunit.testruns.evaluation.result.v2+xml");
      expect(await res.text()).to.contain("<aunit:runResult");
    });

    it("names the run result the way the ABAP Unit view knows it, and the junit way on request", async function () {
      this.timeout(120000);
      const body = `<?xml version="1.0" encoding="UTF-8"?>
<aunit:runConfiguration xmlns:aunit="http://www.sap.com/adt/aunit" xmlns:adtcore="http://www.sap.com/adt/core">
  <external><coverage active="false"/></external>
  <adtcore:objectReferences>
    <adtcore:objectReference adtcore:uri="/sap/bc/adt/oo/classes/zcl_stg_segw_export"/>
  </adtcore:objectReferences>
</aunit:runConfiguration>`;
      // Accept: application/xml is what the view sent before this façade
      // advertised the run configurations it takes; its handler for the
      // result is registered for v2, so that is the answer to an unversioned ask
      const eclipse = await call("/abapunit/testruns", {method: "POST", body, headers: {accept: "application/xml"}});
      expect(eclipse.status).to.equal(200);
      expect(eclipse.headers.get("content-type")).to.contain("application/vnd.sap.adt.abapunit.testruns.result.v2+xml");
      const v1 = await call("/abapunit/testruns", {method: "POST", body, headers: {accept: "application/vnd.sap.adt.abapunit.testruns.result.v1+xml"}});
      expect(v1.headers.get("content-type"), "a version asked for is the version answered").to.contain("testruns.result.v1+xml");
      const v2 = await call("/abapunit/testruns", {method: "POST", body, headers: {accept: "application/vnd.sap.adt.abapunit.testruns.result.v2+xml"}});
      expect(v2.headers.get("content-type"), "the version the client asks by").to.contain("testruns.result.v2+xml");
      const vsp = await call("/abapunit/testruns", {method: "POST", body, headers: {accept: "application/vnd.sap.adt.api.junit.run-result.v1+xml"}});
      expect(vsp.headers.get("content-type")).to.contain("application/vnd.sap.adt.api.junit.run-result.v1+xml");
      expect(await vsp.text(), "the same document under either name").to.contain("<aunit:runResult");
    });

    it("a class with tests comes back as a tree of classes and methods", async function () {
      this.timeout(180000);
      const res = await testRun("ZCL_STG_SEGW_TEST");
      expect(res.status).to.equal(200);
      const xml = await res.text();
      expect(xml).to.contain("<aunit:runResult");
      expect(xml).to.contain('adtcore:name="ZCL_STG_SEGW_TEST"');
      expect(xml).to.contain("<testClass ");
      expect(xml).to.contain("<testMethod ");
      expect(xml).to.match(/executionTime="\d+(?:\.\d+)?" unit="s"/);
    });

    it("a method that passed carries no alert, which is what passing means", async function () {
      this.timeout(180000);
      const xml = await (await testRun("ZCL_STG_SEGW_TEST")).text();
      const testClass = xml.match(/<testClass [^>]*>[\s\S]*?<testMethods>/)[0];
      // an SAP system omits a class's empty <alerts> entirely (measured)
      expect(testClass).to.not.contain("<alerts");
      const method = xml.match(/<testMethod [^>]*\/>/)[0];
      expect(method).to.not.contain("<alerts");
      expect(method).to.not.contain("<alert ");
    });

    it("discovers test classes and methods without running them", async function () {
      // Five cold HTTP runs: SEGW median main 6.71 s, fixed 6.57 s;
      // maximum across all objects/revisions 7.45 s. See docs/unit-risk.md.
      this.timeout(10000);
      const res = await call("/core/http/unit/object?type=CLAS%2FOC&name=ZCL_STG_SEGW_TEST");
      expect(res.status).to.equal(200);
      const found = await res.json();
      expect(found.object).to.deep.equal({type: "CLAS", name: "ZCL_STG_SEGW_TEST"});
      const tree = found.classes.find((item) => item.name === "LTCL_TREE");
      expect(tree).to.include({riskLevel: "harmless", durationCategory: "short", include: "testclasses"});
      expect(tree.methods.map((item) => item.name)).to.include("PROPERTIES_IN_FILE_ORDER");
    });

    it("Q2b: names the service and entity sets of a SEGW _DPC_EXT class", async () => {
      const res = await call("/core/http/segw/entitysets?class=ZCL_ZSTG_DEMO_DPC_EXT");
      expect(res.status).to.equal(200);
      const found = await res.json();
      expect(found).to.include({class: "ZCL_ZSTG_DEMO_DPC_EXT", service: "ZSTG_DEMO_SRV", mpc: "ZCL_ZSTG_DEMO_MPC_EXT"});
      expect(found.sets).to.deep.include({method: "TRAVELSET_GET_ENTITYSET", kind: "get_entityset", set: "TravelSet"});
      expect(found.sets).to.deep.include({method: "TRAVELSET_GET_ENTITY", kind: "get_entity", set: "TravelSet"});
      expect(found.sets.map((s) => s.set)).to.include.members(["TravelSet", "BookingSet", "PhotoSet", "StatusVHSet"]);
    });

    it("Q2b: 404s a class the registry does not know as a service's DPC", async () => {
      const res = await call("/core/http/segw/entitysets?class=ZCL_OSD_SCRATCH");
      expect(res.status).to.equal(404);
    });

    // Q3 "Readers": who references a CLAS or INTF (the reverse of Q2b's own
    // map), off the seeded cross-reference tables. `node tools/osd-xref.mjs
    // --who-calls <NAME>` names the same readers independently of this route
    // (tools/osd-xref-seed.mjs seeds WBCROSSGT from the same parse this
    // façade's own store reads), which is how these two classes were picked:
    // ZCL_ZSTG_DEMO_MPC_EXT is read by ZCL_STG_PHASE0_TEST (a class with its
    // own ABAP Unit tests) and by ZCL_ZSTG_DEMO_DPC_EXT (the _DPC_EXT of
    // ZSTG_DEMO_SRV), one of each; ZCL_STG_TAB_ZSTG_STATUS is a generated
    // leaf nothing reads.
    it("Q3: names who reads a class, one a test and one a registered service's DPC", async () => {
      const res = await call("/core/http/xref/readers?type=CLAS&name=ZCL_ZSTG_DEMO_MPC_EXT");
      expect(res.status).to.equal(200);
      const found = await res.json();
      expect(found.name).to.equal("ZCL_ZSTG_DEMO_MPC_EXT");
      expect(found.readers).to.deep.equal([
        {type: "CLAS", name: "ZCL_STG_PHASE0_TEST", include: "ZCL_STG_PHASE0_TEST", isTest: true, services: []},
        {type: "CLAS", name: "ZCL_ZSTG_DEMO_DPC_EXT", include: "ZCL_ZSTG_DEMO_DPC_EXT", isTest: false, services: ["ZSTG_DEMO_SRV"]},
      ]);
      expect(found.counts).to.deep.equal({readers: 2, tests: 1, services: 1});
    });

    it("Q3: an interface's own readers, and the class itself left out of them", async () => {
      const res = await call("/core/http/xref/readers?type=INTF&name=ZIF_STG_CDS_SOURCE");
      expect(res.status).to.equal(200);
      const found = await res.json();
      expect(found.counts.readers).to.be.greaterThan(50);
      expect(found.readers.map((r) => r.name)).to.not.include("ZIF_STG_CDS_SOURCE");
      // every entry is unique -- one row per reading object, not per reference
      expect(found.readers.map((r) => r.name)).to.deep.equal([...new Set(found.readers.map((r) => r.name))]);
    });

    it("B1: names what an edit would reach, transitively, and which of it carries tests", async () => {
      const res = await call("/core/http/xref/closure?type=CLAS&name=ZCL_ZSTG_DEMO_MPC_EXT");
      expect(res.status).to.equal(200);
      const found = await res.json();
      // no warm registry in this suite: the seeded cross-reference answers
      expect(found.source).to.equal("xref");
      expect(found.truncated).to.equal(false);
      const names = found.closure.map((o) => o.name);
      // the class itself, its direct readers, and what reads those in turn
      expect(names).to.include.members(["ZCL_ZSTG_DEMO_MPC_EXT", "ZCL_STG_PHASE0_TEST", "ZCL_ZSTG_DEMO_DPC_EXT"]);
      expect(names.length).to.be.greaterThan(3);
      expect(found.tests).to.include("ZCL_STG_PHASE0_TEST");
      expect(found.tests).to.not.include("ZCL_ZSTG_DEMO_DPC_EXT");
      expect(found.counts).to.deep.equal({objects: names.length, tests: found.tests.length});
    });

    it("B1: a closure of an unknown object is 404, of a program 400", async () => {
      expect((await call("/core/http/xref/closure?type=CLAS&name=ZCL_NOPE_NEVER")).status).to.equal(404);
      expect((await call("/core/http/xref/closure?type=PROG&name=ZCL_ZSTG_DEMO_MPC_EXT")).status).to.equal(400);
    });

    it("the service tree: each row with the class that answers and where it is declared", async () => {
      const res = await call("/core/http/services");
      expect(res.status).to.equal(200);
      const {services, counts} = await res.json();
      expect(Object.keys(counts)).to.include.members(["ODATA", "ICF", "APP"]);
      const demo = services.find((s) => s.kind === "ODATA" && s.name === "ZSTG_DEMO_SRV");
      expect(demo).to.include({
        path: "/sap/opu/odata/sap/ZSTG_DEMO_SRV",
        handler: "ZCL_ZSTG_DEMO_DPC_EXT",
        handlerUri: "/sap/bc/adt/oo/classes/zcl_zstg_demo_dpc_ext",
        mpc: "ZCL_ZSTG_DEMO_MPC_EXT",
      });
      expect(demo.source).to.match(/\.iwsv\.xml$/);
      expect(demo.handlerSource).to.match(/\.clas\.abap$/);
      expect(demo.mpcSource).to.match(/\.clas\.abap$/);
      expect(demo.helpers).to.be.an("array");
      const icf = services.find((s) => s.kind === "ICF" && s.handlerUri !== undefined);
      expect(icf.handlerUri).to.match(/^\/sap\/bc\/adt\/oo\/classes\//);
      const app = services.find((s) => s.kind === "APP");
      expect(app.app).to.be.a("string");
      expect(app.handler).to.equal(undefined);
      expect(app.source).to.match(/webapp|packs/);
    });

    it("the transaction inventory includes every registry row and its declaring source", async () => {
      const res = await call("/core/http/transactions");
      expect(res.status).to.equal(200);
      const {transactions} = await res.json();
      const note = transactions.find((one) => one.tcode === "ZOSD_NOTE");
      expect(note).to.include({kind: "CLASS", source: "src/webgui/zosd_note.tran.xml"});
      expect(note.className).to.be.a("string");
      expect(transactions.every((one) => one.source.endsWith(".tran.xml"))).to.equal(true);
    });

    it("Q3: an object nothing reads answers an empty list, not an error", async () => {
      const res = await call("/core/http/xref/readers?type=CLAS&name=ZCL_STG_TAB_ZSTG_STATUS");
      expect(res.status).to.equal(200);
      expect(await res.json()).to.deep.equal({name: "ZCL_STG_TAB_ZSTG_STATUS", source: "xref", readers: [], counts: {readers: 0, tests: 0, services: 0}});
    });

    it("Q3: refuses a type that is not CLAS or INTF", async () => {
      const res = await call("/core/http/xref/readers?type=PROG&name=ZCL_ZSTG_DEMO_MPC_EXT");
      expect(res.status).to.equal(400);
    });

    it("Q3: 404s a class that does not exist", async () => {
      const res = await call("/core/http/xref/readers?type=CLAS&name=ZCL_OSD_NOPE_NOPE");
      expect(res.status).to.equal(404);
    });

    it("runs one selected method through the Workbench endpoint", async function () {
      this.timeout(180000);
      const res = await call("/core/http/unit/object/run?type=CLAS%2FOC&name=ZCL_STG_SEGW_TEST" +
        "&testClass=LTCL_TREE&method=PROPERTIES_IN_FILE_ORDER", {method: "POST"});
      expect(res.status).to.equal(200);
      const run = await res.json();
      expect(run.counts).to.include({classes: 1, methods: 1, passed: 1, failed: 0});
      expect(run.testClasses[0].name).to.equal("LTCL_TREE");
      expect(run.testClasses[0].testMethods.map((item) => item.name))
        .to.deep.equal(["PROPERTIES_IN_FILE_ORDER"]);
    });

    it("passes an ADT testclass/testmethod fragment to the isolated runner", async function () {
      this.timeout(180000);
      const body = `<?xml version="1.0" encoding="UTF-8"?>
<aunit:runConfiguration xmlns:aunit="http://www.sap.com/adt/aunit" xmlns:adtcore="http://www.sap.com/adt/core">
  <adtcore:objectReferences>
    <adtcore:objectReference adtcore:uri="/sap/bc/adt/oo/classes/zcl_stg_segw_test#testclass=LTCL_TREE;testmethod=PROPERTIES_IN_FILE_ORDER"/>
  </adtcore:objectReferences>
</aunit:runConfiguration>`;
      const res = await call("/abapunit/testruns", {method: "POST", body});
      expect(res.status).to.equal(200);
      const answer = await res.text();
      expect(answer).to.contain('testClass adtcore:name="LTCL_TREE"');
      expect(answer).to.contain('testMethod adtcore:name="PROPERTIES_IN_FILE_ORDER"');
      expect(answer.match(/<testMethod /g)).to.have.length(1);
    });

    it("refuses an ADT-selected test class that does not belong to the object", async function () {
      this.timeout(180000);
      const body = `<?xml version="1.0" encoding="UTF-8"?>
<aunit:runConfiguration xmlns:aunit="http://www.sap.com/adt/aunit" xmlns:adtcore="http://www.sap.com/adt/core">
  <adtcore:objectReferences>
    <adtcore:objectReference adtcore:uri="/sap/bc/adt/oo/classes/zcl_stg_segw_test#testclass=DOES_NOT_EXIST"/>
  </adtcore:objectReferences>
</aunit:runConfiguration>`;
      const res = await call("/abapunit/testruns", {method: "POST", body});
      expect(res.status).to.equal(404);
      expect(await res.text()).to.contain("does not belong");
    });

    it("reports malformed ADT test selectors as a request error", async () => {
      const body = `<?xml version="1.0" encoding="UTF-8"?>
<aunit:runConfiguration xmlns:aunit="http://www.sap.com/adt/aunit" xmlns:adtcore="http://www.sap.com/adt/core">
  <adtcore:objectReferences>
    <adtcore:objectReference adtcore:uri="/sap/bc/adt/oo/classes/zcl_stg_segw_test#testclass=%"/>
  </adtcore:objectReferences>
</aunit:runConfiguration>`;
      const res = await call("/abapunit/testruns", {method: "POST", body});
      expect(res.status).to.equal(400);
      expect(await res.text()).to.contain("ExceptionInvalidRequest");
    });

    for (const selector of ["#testclass=", "#testmethod=CHECK", "#testclass=LTCL_TREE;testmethod="]) {
      it(`refuses incomplete ADT selector ${selector}`, async () => {
        const body = `<?xml version="1.0" encoding="UTF-8"?>
<aunit:runConfiguration xmlns:aunit="http://www.sap.com/adt/aunit" xmlns:adtcore="http://www.sap.com/adt/core">
  <adtcore:objectReferences>
    <adtcore:objectReference adtcore:uri="/sap/bc/adt/oo/classes/zcl_stg_segw_test${selector}"/>
  </adtcore:objectReferences>
</aunit:runConfiguration>`;
        const res = await call("/abapunit/testruns", {method: "POST", body});
        expect(res.status).to.equal(400);
        expect(await res.text()).to.contain("ExceptionInvalidRequest");
      });
    }

    it("does not attach another object reference's selector to the first object", async () => {
      const body = `<?xml version="1.0" encoding="UTF-8"?>
<aunit:runConfiguration xmlns:aunit="http://www.sap.com/adt/aunit" xmlns:adtcore="http://www.sap.com/adt/core">
  <adtcore:objectReferences>
    <adtcore:objectReference adtcore:uri="/sap/bc/adt/oo/classes/zcl_stg_segw_test"/>
    <adtcore:objectReference adtcore:uri="/sap/bc/adt/oo/classes/zcl_zosd_test_demo#testclass=LTCL_DEMO"/>
  </adtcore:objectReferences>
</aunit:runConfiguration>`;
      const res = await call("/abapunit/testruns", {method: "POST", body});
      expect(res.status).to.equal(400);
      expect(await res.text()).to.contain("exactly one object reference");
    });

    it("refuses a selected method that does not belong to the object", async () => {
      const res = await call("/core/http/unit/object/run?type=CLAS%2FOC&name=ZCL_STG_SEGW_TEST" +
        "&testClass=LTCL_TREE&method=DOES_NOT_EXIST", {method: "POST"});
      expect(res.status).to.equal(404);
      expect(await res.text()).to.contain("does not belong");
    });

    it("every class and method navigates by its semantic source member selector", async function () {
      this.timeout(180000);
      const xml = await (await testRun("ZCL_STG_SEGW_TEST")).text();
      expect(xml).to.match(/navigationUri="[^"]*\/includes\/testclasses#type=CLAS%2FOCL;name=LTCL_[^"]+"/);
      expect(xml).to.match(/navigationUri="[^"]*\/includes\/testclasses#type=CLAS%2FOLD;name=LTCL_[^" ]+(?:%20)+[A-Z_]+"/);
      expect(xml).not.to.contain("/source/main");
      const target = xml.match(/navigationUri="([^"]*\/includes\/testclasses#[^"]+)"/)[1];
      const source = await call(target.replace("/sap/bc/adt", ""), {headers: {accept: "text/plain"}});
      expect(source.status).to.equal(200);
      expect(source.headers.get("content-type")).to.equal("text/plain; charset=utf-8");
      expect(await source.text()).to.equal(store.read("CLAS", "ZCL_STG_SEGW_TEST", "testclasses").source);
    });

    it("answers the occurrence-marker follow-up without discarding the navigation URI", async () => {
      const uri = "/sap/bc/adt/oo/classes/zcl_stg_segw_test/includes/testclasses#type=CLAS%2FOCL;name=LTCL_TREE";
      const res = await call(`/abapsource/occurencemarkers?uri=${encodeURIComponent(uri)}`, {
        method: "POST",
        headers: {"content-type": "text/plain", accept: "application/*"},
        body: "CLASS ltcl DEFINITION FOR TESTING. ENDCLASS.",
      });
      expect(res.status).to.equal(200);
      expect(res.headers.get("content-type")).to.contain("application/xml");
      const xml = await res.text();
      expect(xml).to.contain("<occurrenceInfo");
      expect(xml).to.contain("<occurrences/>");
    });

    it("maps a test include URI back through its packages to the owning class", async () => {
      const uri = "/sap/bc/adt/oo/classes/zcl_stg_segw_test/includes/testclasses#start=10,0";
      const res = await call(`/repository/nodepath?uri=${encodeURIComponent(uri)}`, {method: "POST"});
      expect(res.status).to.equal(200);
      const xml = await res.text();
      expect(xml).to.contain("<projectexplorer:nodepath");
      expect(xml).to.contain('adtcore:name="$STG_TEST"');
      expect(xml).to.contain('adtcore:name="$STG_TEST_UNIT"');
      expect(xml).to.contain('adtcore:name="ZCL_STG_SEGW_TEST"');
      expect(xml).to.contain('adtcore:type="CLAS/OC"');
      expect(xml).to.not.contain("includes/testclasses");
    });

    it("refuses an occurrence-marker request without its source URI", async () => {
      const res = await call("/abapsource/occurencemarkers", {method: "POST", body: "source"});
      expect(res.status).to.equal(400);
      expect(await res.text()).to.contain("uri is required");
    });

    it("a test run that names nothing is refused", async () => {
      const res = await call("/abapunit/testruns", {method: "POST", body: "<aunit:runConfiguration/>"});
      expect(res.status).to.equal(400);
    });

    it("the test run is advertised now that it answers", async () => {
      expect(await (await call("/discovery")).text()).to.contain('href="/sap/bc/adt/abapunit/testruns"');
    });
  });

  describe("activating", () => {
    const activate = (name, headers = {}) => call("/activation?method=activate&preauditRequested=true", {
      method: "POST", headers,
      body: `<?xml version="1.0" encoding="UTF-8"?>
<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">
  <adtcore:objectReference adtcore:uri="/sap/bc/adt/oo/classes/${String(name).toLowerCase()}" adtcore:name="${name}"/>
</adtcore:objectReferences>`,
    });

    // A clean activation is answered with its properties, all true, and no
    // messages — the system's own answer (a4h-adt.jsonl:489). This test used
    // to expect an empty body, on the note that a successful activation
    // "answers nothing at all"; the capture says otherwise.
    // A save changes the object, not only its source. The client re-reads
    // the object after a save and expects a newer one back — a system has an
    // inactive version now (a4h-adt.jsonl:486-487: PUT, then the class
    // document 200 with a new tag). Read back unchanged, with the same tag,
    // the client took its own copy for the newer one and showed nothing.
    it("a written object reads as inactive with a new tag; check-only activation keeps the generation source", async function () {
      this.timeout(120000);
      const before = await call(`/oo/classes/${SCRATCH.toLowerCase()}`);
      const tagBefore = before.headers.get("etag");
      const {handle} = await lock();
      await call(`/oo/classes/${SCRATCH}/source/main?lockHandle=${handle}`, {method: "PUT", body: SOURCE + "* touched\n"});
      const after = await call(`/oo/classes/${SCRATCH.toLowerCase()}?version=inactive`);
      expect(after.status).to.equal(200);
      expect(after.headers.get("etag"), "a save is a change to the object").to.not.equal(tagBefore);
      expect(await after.text()).to.contain('adtcore:version="inactive"');
      const activated = await activate(SCRATCH);
      expect(activated.status).to.equal(200);
      const again = await call(`/oo/classes/${SCRATCH.toLowerCase()}?version=workingArea`);
      // This suite disables transpilation: passing the check cannot put
      // this scratch class into the live generation or promote its source.
      expect(await again.text()).to.contain('adtcore:version="inactive"');
      const active = await call(`/oo/classes/${SCRATCH}/source/main?version=active`);
      expect(active.status).to.equal(404);
      expect(await active.text()).to.include("ExceptionResourceNotFound");
    });

    it("source that holds activates, and says so with its properties", async function () {
      this.timeout(60000);
      const {handle} = await lock();
      const saved = await call(`/oo/classes/${SCRATCH}/source/main?lockHandle=${handle}`, {method: "PUT", body: SOURCE});
      const res = await activate(SCRATCH, {"if-match": saved.headers.get("etag")});
      expect(res.status).to.equal(200);
      expect(res.headers.get("content-type")).to.equal("application/xml; charset=utf-8");
      expect(await res.text()).to.equal('<?xml version="1.0" encoding="utf-8"?><chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist"><chkl:properties checkExecuted="true" activationExecuted="true" generationExecuted="true"/></chkl:messages>');
    });

    it("does not activate bytes that replaced the checked revision", async function () {
      this.timeout(60000);
      store.write("CLAS", SCRATCH, SOURCE);
      const opened = await call(`/oo/classes/${SCRATCH}/source/main`);
      const checkedTag = opened.headers.get("etag");
      const concurrent = SOURCE.replace("'hello'", "'newer'");
      store.write("CLAS", SCRATCH, concurrent);
      try {
        const res = await activate(SCRATCH, {"if-match": checkedTag});
        expect(res.status).to.equal(412);
        expect(await res.text()).to.contain("source changed after it was checked");
        expect(store.read("CLAS", SCRATCH).source).to.equal(concurrent);
      } finally {
        store.write("CLAS", SCRATCH, SOURCE);
      }
    });

    it("source that does not hold comes back as messages, not as an empty success", async function () {
      this.timeout(60000);
      const {handle} = await lock();
      await call(`/oo/classes/${SCRATCH}/source/main?lockHandle=${handle}`, {
        method: "PUT",
        body: SOURCE.replace("rv = 'hello'.", "rv = undefined_variable_here."),
      });
      const res = await activate(SCRATCH);
      expect(res.status).to.equal(200);
      const xml = await res.text();
      expect(xml).to.contain('activationExecuted="false"');
      expect(xml).to.match(/<msg /);
      expect(xml.toUpperCase()).to.contain(SCRATCH);
    });

    it("source that holds but breaks its callers does not activate", async function () {
      this.timeout(120000);
      // the object is written back whole and healthy first, then a caller
      store.write("CLAS", SCRATCH, SOURCE);
      store.write("CLAS", CALLER, CALLER_SOURCE);
      expect(store.check("CLAS", CALLER).issues).to.have.length(0);
      // the caller is part of the system: active, as a caller is. One that was
      // never activated is not built and does not hold an activation back
      const activating = new Set([`CLAS ${SCRATCH}`, `CLAS ${CALLER}`]);
      const checked = [SCRATCH, CALLER].map(name => store.activate("CLAS", name, {activating}));
      expect(checked.every(result => result.active)).to.equal(true);
      store.completeActivations(checked);

      // the rename: legal ABAP, self-consistent, and it takes the method
      // the caller calls out from under it
      const renamed = SOURCE.replaceAll("greet", "greet_zzz");
      const {handle} = await lock();
      await call(`/oo/classes/${SCRATCH}/source/main?lockHandle=${handle}`, {method: "PUT", body: renamed});

      // the object alone passes its own check, which is why this is the
      // case that used to come back as an empty success
      expect(store.check("CLAS", SCRATCH).issues).to.have.length(0);

      const res = await activate(SCRATCH);
      expect(res.status).to.equal(200);
      const xml = await res.text();
      expect(xml).to.contain('activationExecuted="false"');
      // it names the caller that broke, not only the object that was written
      expect(xml.toUpperCase()).to.contain(CALLER);
      expect(xml).to.contain("greet");

      store.write("CLAS", SCRATCH, SOURCE);
    });

    it("an activation of nothing is refused rather than reported as success", async () => {
      const res = await call("/activation?method=activate", {method: "POST", body: "<adtcore:objectReferences/>"});
      expect(res.status).to.equal(400);
    });

    it("activation is advertised now that it answers", async () => {
      const xml = await (await call("/discovery")).text();
      expect(xml).to.contain('href="/sap/bc/adt/activation"');
    });
  });

  // Q6a "Notebook SQL" (docs/vscode-extension.md): a notebook cell runs
  // over the same freestyle route a real ADT's SQL Pane uses
  // (tools/adt-facade.mjs `datapreview/freestyle`, ~2358); the route itself
  // is already covered in test/adt-facade.mjs, this is the one round trip
  // against the demo data seeded the way this suite's own `before()` seeds
  // it (test/start.mjs, through the same `call()`/CSRF session every other
  // test here uses, rather than a bare fetch).
  describe("Q6a: notebook SQL", () => {
    it("posts a SELECT and gets rows back, column-oriented", async () => {
      const res = await call("/datapreview/freestyle?rowNumber=100", {
        method: "POST",
        headers: {"content-type": "text/plain; charset=utf-8"},
        body: "SELECT travel_id, description FROM zstg_demo ORDER BY travel_id",
      });
      expect(res.status).to.equal(200);
      const generation = res.headers.get("x-osd-generation");
      expect(generation, "every façade answer names its generation (docs/generations.md)").to.be.a("string").with.length.greaterThan(0);
      const xml = await res.text();
      expect(xml).to.contain("<dataPreview:tableData");
      expect(xml).to.contain('dataPreview:name="TRAVEL_ID"');
      expect(xml).to.contain("<dataPreview:data>T0001</dataPreview:data>");
    });
  });

  // Q6b "Classrun" (docs/vscode-extension.md, docs/adt-facade.md): ADT's F9,
  // "Run as ABAP Application (Console)" -- POST /sap/bc/adt/oo/classrun/<name>,
  // text/plain back. ZCL_OSD_CLASSRUN_DEMO (src/classrun/) is the tracked
  // fixture every host builds, so this runs against the same object the
  // live smoke and the VS Code extension's own fixture test use; the dump
  // case below writes and activates a scratch class of its own, the way
  // "activating" above does, because the tracked fixture never fails.
  describe("Q6b: classrun", () => {
    it("runs a class implementing IF_OO_ADT_CLASSRUN and answers what it wrote", async () => {
      const res = await call("/oo/classrun/ZCL_OSD_CLASSRUN_DEMO", {method: "POST"});
      expect(res.status).to.equal(200);
      expect(res.headers.get("content-type")).to.contain("text/plain");
      const text = await res.text();
      expect(text).to.contain("hello from classrun");
      // the table: a header of column names, then one tab-separated row per line
      expect(text).to.match(/ID\tNAME/);
      expect(text).to.contain("first");
      expect(text).to.contain("second");
    });

    it("a class that does not implement IF_OO_ADT_CLASSRUN is refused, not silently run", async () => {
      // written here rather than assumed from an earlier describe's own
      // test, so this holds whether the suite runs whole or filtered
      store.write("CLAS", SCRATCH, SOURCE);
      const res = await call(`/oo/classrun/${SCRATCH}`, {method: "POST"});
      expect(res.status).to.equal(400);
      expect(await res.text()).to.contain("IF_OO_ADT_CLASSRUN");
    });

    it("an unknown class is 404, the same shape every other object read answers", async () => {
      const res = await call("/oo/classrun/ZCL_NOT_A_THING_AT_ALL", {method: "POST"});
      expect(res.status).to.equal(404);
      expect(await res.text()).to.contain("exc:exception");
    });

    it("classrun is advertised in discovery, the system's own template (no accept types)", async () => {
      const xml = await (await call("/discovery")).text();
      expect(xml).to.contain('href="/sap/bc/adt/oo/classrun"');
      expect(xml).to.contain('term="classrun" scheme="http://www.sap.com/adt/categories/oo"');
      expect(xml).to.contain("/sap/bc/adt/oo/classrun/{classname}{?profilerId}");
    });

    // Q6b's own tracked fixture for this (src/classrun/zcl_osd_classrun_dumper.clas.abap)
    // rather than a class written and activated in this test, on purpose:
    // tools/osd-classrun.mjs shares this process's own live connection and
    // module graph (it must, to run under the same dialog step every other
    // request does), and Node pins that graph for the process's life, the
    // same fact tools/osd-serve.mjs's own header documents for the whole
    // project. A class transpiled a moment ago in THIS process is not
    // guaranteed to import correctly yet; one that was already part of the
    // tree when this suite's `before()` booted is.
    it("a class that writes and then dumps: the output before it survives, the dump is recorded, nothing half-written", async function () {
      this.timeout(30000);
      const dumpSql = "SELECT dump_id, runtime_error FROM zosd_dump WHERE objname = 'ZCL_OSD_CLASSRUN_DUMPER'";
      const readDumps = () => dialogStep(async () => (await data.query(dumpSql, {max: 10000})).rows, "Q6b inspect dumps");
      const before = await readDumps();
      const beforeIds = new Set(before.map(row => row.dump_id));
      const res = await call("/oo/classrun/ZCL_OSD_CLASSRUN_DUMPER", {method: "POST"});
      expect(res.status).to.equal(200);
      const text = await res.text();
      expect(text).to.contain("before the dump");
      expect(text).to.match(/Runtime error:.*ZERODIVIDE/i);

      const after = await readDumps();
      const created = after.filter(row => !beforeIds.has(row.dump_id));
      expect(created, `classrun must create a new dump (before ${before.length}, after ${after.length})`).to.have.length(1);
      expect(created[0].runtime_error.toUpperCase()).to.contain("ZERODIVIDE");

      // the same table Q4's hotspots and Q6a's own notebook read
      // (tools/osd-dumps.mjs ZOSD_DUMP): the dump this run just caused is in it
      const sqlRes = await call("/datapreview/freestyle?rowNumber=5", {
        method: "POST",
        headers: {"content-type": "text/plain; charset=utf-8"},
        body: "SELECT objname, runtime_error FROM zosd_dump WHERE objname = 'ZCL_OSD_CLASSRUN_DUMPER' ORDER BY dump_id DESC",
      });
      const sqlXml = await sqlRes.text();
      expect(sqlXml).to.contain("ZCL_OSD_CLASSRUN_DUMPER");
      expect(sqlXml.toUpperCase()).to.contain("ZERODIVIDE");
    });
  });
});


describe("tools/adt-facade: publication state", function () {
  this.timeout(30000);
  const name = "ZCL_OSD_PUBLICATION";
  const source = SOURCE.replaceAll("zcl_osd_scratch", "zcl_osd_publication");
  let root;
  let store;
  let server;
  let token;
  let context;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "osd-adt-publish-"));
    mkdirSync(join(root, "src"), {recursive: true});
    writeFileSync(join(root, "abaplint.jsonc"), readFileSync("abaplint.jsonc", "utf8"));
    store = new ObjectStore({root, libs: []});
    store.write("CLAS", name, source);
    const app = express();
    app.use(express.raw({type: "*/*", limit: "16mb"}));
    app.use(adtRouter({store}).router);
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    const res = await fetch(`http://localhost:${server.address().port}/sap/bc/adt/core/discovery`,
      {method: "HEAD", headers: {"x-csrf-token": "fetch"}});
    token = res.headers.get("x-csrf-token");
    context = (res.headers.getSetCookie?.() ?? []).join("; ").match(/sap-contextid=([^;]+)/)?.[1];
  });

  after(async () => {
    await server?.close();
    rmSync(root, {recursive: true, force: true});
  });

  const activate = () => fetch(`http://localhost:${server.address().port}/sap/bc/adt/activation?method=activate`, {
    method: "POST",
    headers: {cookie: `sap-contextid=${context}`, "x-csrf-token": token, "x-sap-adt-sessiontype": "stateful"},
    body: `<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core"><adtcore:objectReference adtcore:uri="/sap/bc/adt/oo/classes/${name.toLowerCase()}" adtcore:name="${name}"/></adtcore:objectReferences>`,
  });

  it("keeps the source inactive after a failed publish, then completes a successful retry", async () => {
    store.publish = async () => ({ok: false, transpile: {error: "ENOSPC"}});
    const failed = await activate();
    expect((await failed.text())).to.contain('activationExecuted="false"');
    expect(store.stateOf(store.find("CLAS", name)).version).to.equal("inactive");

    store.publish = async () => {activeFixture(root); return {ok: true, generation: liveHash(root), recycled: false};};
    const passed = await activate();
    expect((await passed.text())).to.contain('activationExecuted="true"');
    expect(store.stateOf(store.find("CLAS", name)).version).to.equal("active");
  });

  it("does not activate a source saved while publication is pending", async () => {
    store.write("CLAS", name, source);
    let release;
    store.publish = () => new Promise((resolve) => { release = resolve; });
    const pending = activate();
    for (let i = 0; i < 100 && release === undefined; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(release).to.be.a("function");
    // The build read the checked revision before the next save. Keep that
    // snapshot; creating one from the newer bytes would simulate publication
    // of those bytes and make stateOf correctly recognize them as active.
    activeFixture(root);
    const generation = liveHash(root);
    store.write("CLAS", name, source.replace("'hello'", "'newer'"));
    release({ok: true, generation, recycled: false});
    const response = await pending;
    expect(await response.text()).to.contain('activationExecuted="false"');
    expect(store.stateOf(store.find("CLAS", name)).version).to.equal("inactive");
  });
});

describe("tools/adt-facade: notebook scratch after failed activation", function () {
  let root;
  let store;
  let server;
  let token;
  let context;
  const roots = [
    {path: "src", writable: true},
    {path: "packs/notebook-scratch/src", writable: true, pack: "notebook-scratch"},
  ];
  const name = "ZCL_OSD_NOTEBOOK_CELL";
  const valid = SOURCE.replaceAll("zcl_osd_scratch", "zcl_osd_notebook_cell");
  const invalid = valid.replace("rv = 'hello'.", "rv = .");

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "osd-notebook-failure-"));
    for (const layer of roots) mkdirSync(join(root, layer.path), {recursive: true});
    store = new ObjectStore({root, roots, libs: []});
    store.publish = async () => {
      if (store.read("CLAS", name).source === invalid) return {ok: false, transpile: {issues: [{issues: [{message: "invalid ABAP"}]}]}};
      activeFixture(root, roots.map(layer => layer.path));
      return {ok: true};
    };
    store.classrun = async () => ({run: async () => ({ok: true, text: "hello", ms: 1})});
    const app = express();
    app.use(express.raw({type: "*/*", limit: "16mb"}));
    app.use(adtRouter({store}).router);
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    const res = await fetch(`http://localhost:${server.address().port}/sap/bc/adt/core/discovery`,
      {method: "HEAD", headers: {"x-csrf-token": "fetch"}});
    token = res.headers.get("x-csrf-token");
    context = (res.headers.getSetCookie?.() ?? []).join("; ").match(/sap-contextid=([^;]+)/)?.[1];
  });

  after(async () => {
    await server?.close();
    rmSync(root, {recursive: true, force: true});
  });

  const send = async (source) => fetch(`http://localhost:${server.address().port}/sap/bc/adt/notebook/abap`, {
    method: "POST",
    headers: {cookie: `sap-contextid=${context}`, "x-csrf-token": token,
      "content-type": "application/json"},
    body: JSON.stringify({source}),
  });
  const restarted = () => new ObjectStore({root, roots, libs: []});
  const reportedVersion = async () => {
    const response = await fetch(`http://localhost:${server.address().port}/sap/bc/adt/oo/classes/${name.toLowerCase()}?version=workingArea`);
    expect(response.status).to.equal(200);
    return (await response.text()).match(/adtcore:version="([^"]+)"/)?.[1];
  };

  it("removes a first cell that fails activation before the next startup", async () => {
    const failed = await send(invalid);
    expect(failed.status, await failed.text()).to.equal(422);
    expect(restarted().find("CLAS", name)).to.equal(undefined);
  });

  it("restores the last working cell when a replacement fails activation", async () => {
    const first = await send(valid);
    expect(first.status, await first.text()).to.equal(200);
    expect(await reportedVersion()).to.equal("active");
    const failed = await send(invalid);
    expect(failed.status, await failed.text()).to.equal(422);
    expect(restarted().read("CLAS", name).source).to.equal(valid);
    expect(await reportedVersion()).to.equal("active");
  });

  it("restores the source when publication throws", async () => {
    store.publish = async () => { throw new Error("build interrupted"); };
    const failed = await send(invalid);
    expect(failed.status, await failed.text()).to.equal(500);
    expect(restarted().read("CLAS", name).source).to.equal(valid);
    expect(await reportedVersion()).to.equal("active");
  });

  it("keeps a previously inactive cell inactive after a failed replacement", async () => {
    const pending = valid.replace("'hello'", "'pending'");
    store.write("CLAS", name, pending, "main", {root: roots[1].path});
    expect(await reportedVersion()).to.equal("inactive");
    store.publish = async () => ({ok: false, error: "invalid ABAP"});
    const failed = await send(invalid);
    expect(failed.status, await failed.text()).to.equal(422);
    expect(restarted().read("CLAS", name).source).to.equal(pending);
    expect(await reportedVersion()).to.equal("inactive");
  });
});

describe("tools/adt-facade: create and delete over the wire", () => {
  let server;
  let port;
  let root;
  let store;
  let token;
  let context;

  before(async function () {
    this.timeout(120000);
    // a temporary system, so a created object never lands in this repo
    root = mkdtempSync(join(tmpdir(), "osd-adt-"));
    mkdirSync(join(root, "src", "demo"), {recursive: true});
    mkdirSync(join(root, "src", "zosd_test"), {recursive: true});
    writeFileSync(join(root, "abaplint.jsonc"), readFileSync("abaplint.jsonc", "utf8"));
    writeFileSync(join(root, "src", "zosd_test", "package.devc.xml"), `<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT_DEVC" serializer_version="v1.0.0">
 <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DEVC><CTEXT>test packages</CTEXT></DEVC></asx:values></asx:abap>
</abapGit>
`);
    writeFileSync(join(root, "src", "demo", "package.devc.xml"), `<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT_DEVC" serializer_version="v1.0.0">
 <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DEVC><CTEXT>demo</CTEXT></DEVC></asx:values></asx:abap>
</abapGit>
`);
    store = new ObjectStore({root, libs: []});
    const app = express();
    app.disable("x-powered-by");
    app.use(express.raw({type: "*/*", limit: "16mb"}));
    app.use(adtRouter({store, transpileOnActivate: false, abap: await adtAbap()}).router);
    await new Promise((resolve) => {
      server = app.listen(0, resolve);
      server.keepAliveTimeout = 120000;
      server.headersTimeout = 125000;
    });
    port = server.address().port;
    const res = await fetch(`http://localhost:${port}/sap/bc/adt/core/discovery`, {method: "HEAD", headers: {"x-csrf-token": "fetch"}});
    token = res.headers.get("x-csrf-token");
    context = (res.headers.getSetCookie?.() ?? []).join("; ").match(/sap-contextid=([^;]+)/)?.[1];
  });

  after(async () => {
    store.unwatch();
    await server.close();
    rmSync(root, {recursive: true, force: true});
  });

  const call = (path, options = {}) => fetch(`http://localhost:${port}/sap/bc/adt${path}`, {
    ...options,
    headers: {cookie: `sap-contextid=${context}`, "x-csrf-token": token, "x-sap-adt-sessiontype": "stateful", ...(options.headers ?? {})},
  });

  const createBody = (type, name, description, pkg) => {
    const roots = {CLAS: "class:abapClass", INTF: "intf:abapInterface", PROG: "program:abapProgram", DDLS: "ddl:ddlSource"};
    const el = roots[type];
    const ns = el.split(":")[0];
    return `<?xml version="1.0" encoding="UTF-8"?>
<${el} xmlns:${ns}="http://www.sap.com/adt/${{CLAS:"oo/classes",INTF:"oo/interfaces",PROG:"programs/programs",DDLS:"ddic/ddlsources"}[type]}" xmlns:adtcore="http://www.sap.com/adt/core"
  adtcore:description="${description}" adtcore:name="${name}" adtcore:type="${type}" adtcore:responsible="OSD">
  <adtcore:packageRef adtcore:name="${pkg}"/>
</${el}>`;
  };

  it("POST to the class collection creates the object on disk and answers empty 200", async () => {
    const res = await call("/oo/classes", {method: "POST", headers: {"content-type": "application/*"}, body: createBody("CLAS", "ZCL_MADE_ADT", "made over the wire", "$STG_DEMO")});
    expect(res.status, await res.text().catch(() => "")).to.equal(200);
    expect(res.headers.get("location")).to.equal(null);
    // it is on disk, in the folder of its package, with the header beside it
    expect(existsSync(join(root, "src/demo/zcl_made_adt.clas.abap"))).to.equal(true);
    expect(readFileSync(join(root, "src/demo/zcl_made_adt.clas.xml"), "utf8")).to.contain("made over the wire");
    // and the façade now reads back the created class
    const doc = await call("/oo/classes/zcl_made_adt");
    expect(doc.status).to.equal(200);
    expect(await doc.text()).to.contain('adtcore:name="ZCL_MADE_ADT"');
  });

  it("a recreated class keeps its new active skeleton across a save and store restart", async () => {
    const name = "ZCL_RECREATE_ADT", path = "/oo/classes/zcl_recreate_adt";
    await store.write("CLAS", name, "* previous generation\n", "main", {root: "src"});
    activeFixture(root);
    await store.delete("CLAS", name);
    const made = await call("/oo/classes", {method: "POST", headers: {"content-type": "application/xml"},
      body: createBody("CLAS", name, "recreated", "$STG_DEMO")});
    expect(made.status).to.equal(200);
    let handle;
    try {
      const active = store.read("CLAS", name, "main", "active").source;
      expect(active).to.contain(`CLASS ${name.toLowerCase()} DEFINITION`);
      expect(active).not.to.contain("previous generation");
      const locked = await call(path + "?_action=LOCK&accessMode=MODIFY", {method: "POST"});
      expect(locked.status).to.equal(200);
      handle = /<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/.exec(await locked.text())[1];
      expect((await call(path + "/source/main?lockHandle=" + handle, {method: "PUT", body: active + "* draft\n"})).status).to.equal(200);
      const restarted = new ObjectStore({root, libs: []});
      expect(restarted.read("CLAS", name, "main", "active").source).to.equal(active);
      expect(restarted.read("CLAS", name, "main", "inactive").source).to.equal(active + "* draft\n");
    } finally {
      if (handle) expect((await call(path + "?lockHandle=" + handle, {method: "DELETE"})).status).to.equal(200);
      else if (store.find("CLAS", name)) store.delete("CLAS", name);
    }
  });

  it("a create for a package that is not there is a refusal a client can read", async () => {
    const res = await call("/oo/interfaces", {method: "POST", headers: {"content-type": "application/*"}, body: createBody("INTF", "ZIF_NOWHERE", "x", "$NOPE")});
    expect(res.status).to.equal(404);
    expect(await res.text()).to.contain("ExceptionResourceNotFound");
  });

  it("program create answers SAP's observed 200 without a representation", async () => {
    const name = "ZOSD_MADE_EMPTY";
    const collection = "/programs/programs";
    const res = await call(collection, {method: "POST",
      headers: {"content-type": "application/vnd.sap.adt.programs.programs.v2+xml"},
      body: createBody("PROG", name, "a report", "$STG_DEMO")});
    expect(res.status).to.equal(200);
    expect(await res.text()).to.equal("");
    expect(res.headers.get("content-type")).to.equal(null);
    expect(res.headers.get("location")).to.equal(null);
    // The request's collection and name are the client's object identity.
    const object = `${collection}/${encodeURIComponent(name.toLowerCase())}`;
    const doc = await call(object);
    expect(doc.status).to.equal(200);
    expect(await doc.text()).to.contain(`adtcore:name="${name}"`);
    const source = await call(object + "/source/main");
    expect(source.status).to.equal(200);
    expect(await source.text()).to.contain(`REPORT ${name.toLowerCase()}`);
  });

  it("a second program create returns SAP's observed creation failure", async () => {
    await call("/programs/programs", {method: "POST", headers: {"content-type": "application/*"}, body: createBody("PROG", "ZOSD_MADE_REP", "a report", "$STG_DEMO")});
    const again = await call("/programs/programs", {method: "POST", headers: {"content-type": "application/*"}, body: createBody("PROG", "ZOSD_MADE_REP", "a report", "$STG_DEMO")});
    // SAP's program-only XI 001 refusal, observed 2026-10-04.
    expect(again.status).to.equal(500);
    const xml = await again.text();
    expect(xml).to.contain('type id="ExceptionResourceCreationFailure"');
    expect(xml).to.contain("A program or include already exists with the name ZOSD_MADE_REP");
    expect(xml).to.contain('<entry key="T100KEY-ID">XI</entry>');
    expect(xml).to.contain('<entry key="T100KEY-NO">001</entry>');
    expect(xml).to.contain('<entry key="T100KEY-V1">ZOSD_MADE_REP</entry>');
  });

  it("DELETE on the object removes it and its header, and a second delete is a 404", async () => {
    await call("/ddic/ddl/sources", {method: "POST", headers: {"content-type": "application/*"}, body: createBody("DDLS", "ZOSD_MADE_CDS", "a view", "$STG_DEMO")});
    expect(existsSync(join(root, "src/demo/zosd_made_cds.ddls.asddls"))).to.equal(true);
    const gone = await call("/ddic/ddl/sources/zosd_made_cds", {method: "DELETE"});
    expect(gone.status).to.equal(200);
    expect(existsSync(join(root, "src/demo/zosd_made_cds.ddls.asddls"))).to.equal(false);
    expect(existsSync(join(root, "src/demo/zosd_made_cds.ddls.xml")), "the header went too").to.equal(false);
    const twice = await call("/ddic/ddl/sources/zosd_made_cds", {method: "DELETE"});
    expect(twice.status).to.equal(404);
  });

  // vsp's integration suite found it: LOCK, a stateless GET, then the PUT
  // with the handle. A4H keeps the lock through the stateless request;
  // this used to drop it and answer the PUT with a 409.
  describe("locks across requests and sessions", () => {
    const LOCKED = "ZCL_MADE_LOCKS";
    const lockIt = async (caller = call) => {
      const res = await caller(`/oo/classes/${LOCKED}?_action=LOCK&accessMode=MODIFY`, {method: "POST"});
      const xml = await res.text();
      return {status: res.status, xml, handle: xml.match(/<LOCK_HANDLE>([^<]*)<\/LOCK_HANDLE>/)?.[1]};
    };
    const unlockIt = (handle, caller = call) => caller(`/oo/classes/${LOCKED}?_action=UNLOCK&lockHandle=${handle}`, {method: "POST"});
    // a second session: its own logon, its own cookie and token; the same
    // user as the first when no user is named
    const otherSession = async (user) => {
      const res = await fetch(`http://localhost:${port}/sap/bc/adt/core/discovery`, {method: "HEAD",
        headers: {"x-csrf-token": "fetch", ...(user === undefined ? {} : {authorization: "Basic " + Buffer.from(`${user}:x`).toString("base64")})}});
      const id = (res.headers.getSetCookie?.() ?? []).join("; ").match(/sap-contextid=([^;]+)/)?.[1];
      const other = (path, options = {}) => fetch(`http://localhost:${port}/sap/bc/adt${path}`, {
        ...options,
        headers: {cookie: `sap-contextid=${id}`, "x-csrf-token": res.headers.get("x-csrf-token"), "x-sap-adt-sessiontype": "stateful", ...(options.headers ?? {})},
      });
      return {id, other};
    };

    before(async () => {
      const made = await call("/oo/classes", {method: "POST", headers: {"content-type": "application/*"}, body: createBody("CLAS", LOCKED, "locked", "$STG_DEMO")});
      expect(made.status).to.equal(200);
    });

    it("a stateless request in between keeps the lock, as A4H does", async () => {
      const {handle} = await lockIt();
      const read = await call(`/oo/classes/${LOCKED}/source/main`, {headers: {"x-sap-adt-sessiontype": "stateless"}});
      expect(read.status).to.equal(200);
      const source = await read.text();
      const res = await call(`/oo/classes/${LOCKED}/source/main?lockHandle=${handle}`, {method: "PUT", body: source});
      expect(res.status, await res.text()).to.equal(200);
      await unlockIt(handle);
    });

    // A4H, two stateful sessions: 403, ExceptionResourceNoAccess, the holder
    // in T100 EU 510 (V1 user, V2 object)
    const expectLockedBy = ({status, xml}, user) => {
      expect(status).to.equal(403);
      expect(xml).to.contain('<type id="ExceptionResourceNoAccess"/>');
      expect(xml).to.contain(`<message lang="EN">User ${user} is currently editing ${LOCKED}</message>`);
      expect(xml).to.contain(`<localizedMessage lang="EN">User ${user} is currently editing ${LOCKED}</localizedMessage>`);
      expect(xml).to.contain('<entry key="T100KEY-ID">EU</entry>');
      expect(xml).to.contain('<entry key="T100KEY-NO">510</entry>');
      expect(xml).to.contain(`<entry key="T100KEY-V1">${user}</entry>`);
      expect(xml).to.contain(`<entry key="T100KEY-V2">${LOCKED}</entry>`);
      expect(xml).to.match(/<entry key="LONGTEXT">[^<]+<\/entry>/);
    };

    it("the same user in another session is refused too, because the lock is the session's", async () => {
      const {handle} = await lockIt();
      const {id, other} = await otherSession();
      expectLockedBy(await lockIt(other), "OSD");
      await unlockIt(handle);
      await fetch(`http://localhost:${port}/sap/public/bc/icf/logoff`, {headers: {cookie: `${SESSION_COOKIE}=${id}`}});
    });

    it("an object locked in one session is refused to another, naming the holder", async () => {
      const {handle} = await lockIt();
      const {other} = await otherSession("OTHERDEV");
      const refused = await lockIt(other);
      expectLockedBy(refused, "OSD");
      // the holder's second LOCK is refused too, preserving its first handle
      expectLockedBy(await lockIt(), "OSD");
      // released by the holder, the other session gets it -- and gives it back
      await unlockIt(handle);
      const taken = await lockIt(other);
      expect(taken.status).to.equal(200);
      expect(taken.handle).to.have.length.greaterThan(8);
      const first = await lockIt();
      expectLockedBy(first, "OTHERDEV");
      await unlockIt(taken.handle, other);
      const back = await lockIt();
      expect(back.status).to.equal(200);
      await unlockIt(back.handle);
    });

    it("a logoff releases the session's locks", async () => {
      const {id, other} = await otherSession("OTHERDEV");
      expect((await lockIt(other)).status).to.equal(200);
      expect((await lockIt()).status).to.equal(403);
      const off = await fetch(`http://localhost:${port}/sap/public/bc/icf/logoff`, {headers: {cookie: `${SESSION_COOKIE}=${id}`}});
      expect(off.status).to.equal(200);
      const after = await lockIt();
      expect(after.status).to.equal(200);
      await unlockIt(after.handle);
    });

    it("another session cannot delete what one session holds", async () => {
      const DOOMED = "ZCL_MADE_DOOMED";
      const made = await call("/oo/classes", {method: "POST", headers: {"content-type": "application/*"}, body: createBody("CLAS", DOOMED, "doomed", "$STG_DEMO")});
      expect(made.status).to.equal(200);
      const {id, other} = await otherSession("OTHERDEV");
      const locked = await other(`/oo/classes/${DOOMED}?_action=LOCK&accessMode=MODIFY`, {method: "POST"});
      expect(locked.status).to.equal(200);
      const handle = /<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/.exec(await locked.text())[1];
      const refused = await call(`/oo/classes/${DOOMED.toLowerCase()}`, {method: "DELETE"});
      expect(refused.status).to.equal(423);
      expect(await refused.text()).to.contain("ExceptionResourceInvalidLockHandle");
      expect(existsSync(join(root, "src/demo/zcl_made_doomed.clas.abap")), "still there").to.equal(true);
      // the holder may, and its lock goes with the object
      const gone = await other(`/oo/classes/${DOOMED.toLowerCase()}?lockHandle=${handle}`, {method: "DELETE"});
      expect(gone.status).to.equal(200);
      expect(existsSync(join(root, "src/demo/zcl_made_doomed.clas.abap"))).to.equal(false);
      await fetch(`http://localhost:${port}/sap/public/bc/icf/logoff`, {headers: {cookie: `${SESSION_COOKIE}=${id}`}});
    });

    it("the security session advertised and deleted is the one the middleware chose", async () => {
      const holder = await otherSession("OTHERDEV");
      const bystander = await otherSession("THIRDDEV");
      expect((await lockIt(holder.other)).status).to.equal(200);
      // the context cookie names the holder, the session cookie the bystander:
      // the middleware picks the holder, and so must the advertised URL
      const mixed = {cookie: `sap-contextid=${holder.id}; ${SESSION_COOKIE}=${bystander.id}`};
      const poll = await holder.other("/core/http/sessions", {headers: mixed});
      const url = /href="([^"]*\/core\/http\/sessions\/[0-9A-F]+)"/.exec(await poll.text())?.[1];
      expect(url).to.be.a("string");
      const own = await holder.other("/core/http/sessions", {headers: {cookie: `sap-contextid=${holder.id}`}});
      expect(await own.text(), "the holder's own poll names the same URL").to.contain(url);
      const ended = await fetch(`http://localhost:${port}${url}`, {method: "DELETE",
        headers: {...mixed, "x-csrf-token": poll.headers.get("x-csrf-token")}});
      expect(ended.status).to.equal(200);
      // the holder's session ended, so its lock went with it
      const mine = await lockIt();
      expect(mine.status, "the holder's session is the one that ended").to.equal(200);
      await unlockIt(mine.handle);
      await fetch(`http://localhost:${port}/sap/public/bc/icf/logoff`, {headers: {cookie: `${SESSION_COOKIE}=${bystander.id}`}});
    });

    it("a logoff carrying two cookies for two sessions ends only the one the context cookie names", async () => {
      const holder = await otherSession("OTHERDEV");
      const bystander = await otherSession("THIRDDEV");
      expect((await lockIt(holder.other)).status).to.equal(200);
      // the context cookie names the bystander, the session cookie the holder
      const off = await fetch(`http://localhost:${port}/sap/public/bc/icf/logoff`,
        {headers: {cookie: `sap-contextid=${bystander.id}; ${SESSION_COOKIE}=${holder.id}`}});
      expect(off.status).to.equal(200);
      expectLockedBy(await lockIt(), "OTHERDEV");
      await fetch(`http://localhost:${port}/sap/public/bc/icf/logoff`, {headers: {cookie: `${SESSION_COOKIE}=${holder.id}`}});
      const mine = await lockIt();
      expect(mine.status).to.equal(200);
      await unlockIt(mine.handle);
    });

    const releaseDuringBody = async (withAbap) => {
      // Synchronised on the request itself, not on a timer: the first chunk
      // reaching the body reader proves enough of the request has started to
      // release the lock before its remaining chunks arrive.
      let bodyReached;
      const reached = new Promise((resolve) => {
        bodyReached = resolve;
      });
      const bare = express();
      bare.use((req, res, next) => {
        if (req.method === "PUT") {
          const on = req.on.bind(req);
          req.on = (event, listener) => event === "data"
            ? on(event, (chunk) => {
              listener(chunk);
              bodyReached();
            })
            : on(event, listener);
        }
        next();
      });
      bare.use(adtRouter({store, transpileOnActivate: false, ...(withAbap ? {abap: await adtAbap()} : {})}).router);
      const server2 = await new Promise((resolve) => {
        const s = bare.listen(0, () => resolve(s));
      });
      try {
        const port2 = server2.address().port;
        const hello = await fetch(`http://localhost:${port2}/sap/bc/adt/core/discovery`, {method: "HEAD", headers: {"x-csrf-token": "fetch"}});
        const id = (hello.headers.getSetCookie?.() ?? []).join("; ").match(/sap-contextid=([^;]+)/)?.[1];
        const headers = {cookie: `sap-contextid=${id}`, "x-csrf-token": hello.headers.get("x-csrf-token"), "x-sap-adt-sessiontype": "stateful"};
        const at = (path, options = {}) => fetch(`http://localhost:${port2}/sap/bc/adt${path}`, {...options, headers: {...headers, ...(options.headers ?? {})}});
        const locked = await at(`/oo/classes/${LOCKED}?_action=LOCK&accessMode=MODIFY`, {method: "POST"});
        const handle = (await locked.text()).match(/<LOCK_HANDLE>([^<]*)<\/LOCK_HANDLE>/)?.[1];
        expect(handle).to.have.length.greaterThan(8);
        const before = store.read("CLAS", LOCKED).source;
        const status = new Promise((resolve, reject) => {
          const put = request({
            host: "localhost", port: port2, method: "PUT",
            path: `/sap/bc/adt/oo/classes/${LOCKED}/source/main?lockHandle=${handle}`,
            headers: {...headers, "content-type": "text/plain", "transfer-encoding": "chunked"},
          }, (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode));
          });
          put.on("error", reject);
          put.write("* half a source\n");
          reached.then(async () => {
            await at(`/oo/classes/${LOCKED}?_action=UNLOCK&lockHandle=${handle}`, {method: "POST"});
            put.end("* and the rest\n");
          }).catch(reject);
        });
        expect(await status, withAbap ? "ABAP front" : "host").to.equal(withAbap ? 423 : 409);
        expect(store.read("CLAS", LOCKED).source, "nothing written").to.equal(before);
      } finally {
        await new Promise((resolve) => server2.close(resolve));
      }
    };
    it("host: a lock released while the PUT's body is still arriving does not write", () => releaseDuringBody(false));
    it("ABAP front: a lock released while the PUT's body is still buffering does not write", () => releaseDuringBody(true));
  });

  it("POST on a class's includes creates the test include, under the class's lock", async () => {
    const made = await call("/oo/classes", {method: "POST", headers: {"content-type": "application/*"}, body: createBody("CLAS", "ZCL_MADE_INCL", "gets tests", "$STG_DEMO")});
    expect(made.status).to.equal(200);
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<class:abapClassInclude xmlns:class="http://www.sap.com/adt/oo/classes" xmlns:adtcore="http://www.sap.com/adt/core"
  adtcore:name="ZCL_MADE_INCL" class:includeType="testclasses"/>`;
    const include = "/oo/classes/zcl_made_incl/includes";
    // no lock, no include
    const unlocked = await call(include, {method: "POST", headers: {"content-type": "application/*"}, body});
    expect(unlocked.status).to.equal(409); // unmeasured; keeps the previous answer
    expect(existsSync(join(root, "src/demo/zcl_made_incl.clas.testclasses.abap"))).to.equal(false);

    const locked = await call("/oo/classes/zcl_made_incl?_action=LOCK&accessMode=MODIFY", {method: "POST"});
    const handle = (await locked.text()).match(/<LOCK_HANDLE>([^<]*)<\/LOCK_HANDLE>/)?.[1];
    const res = await call(`${include}?lockHandle=${handle}`, {method: "POST", headers: {"content-type": "application/*"}, body});
    expect(res.status, await res.text()).to.equal(201);
    expect(res.headers.get("location")).to.equal("/sap/bc/adt/oo/classes/zcl_made_incl/includes/testclasses");
    expect(readFileSync(join(root, "src/demo/zcl_made_incl.clas.testclasses.abap"), "utf8")).to.equal("");
    // the next move is the PUT of its source, which the same handle carries
    const put = await call(`${include}/testclasses?lockHandle=${handle}`, {method: "PUT", body: "* tests\n"});
    expect(put.status).to.equal(200);
    const again = await call(`${include}?lockHandle=${handle}`, {method: "POST", headers: {"content-type": "application/*"}, body});
    expect(again.status, "an include that is there is not created twice").to.equal(409);
    const bogus = await call(`${include}?lockHandle=${handle}`, {method: "POST", headers: {"content-type": "application/*"},
      body: body.replace("testclasses", "nonsense")});
    expect(bogus.status).to.equal(400);
    await call(`/oo/classes/zcl_made_incl?_action=UNLOCK&lockHandle=${handle}`, {method: "POST"});
  });

  // vsp's repro: a package created stateless was there for the create and
  // gone for the nodestructure right after it -- and for quick search, ever.
  it("a created package stays in the tree, the search, lock and delete, after a rebuild too", async () => {
    const stateless = {"x-sap-adt-sessiontype": "stateless"};
    const res = await call("/packages?sap-client=001&sap-language=EN", {method: "POST", headers: {"content-type": "application/*", ...stateless},
      body: `<?xml version="1.0" encoding="UTF-8"?>
<pack:package xmlns:pack="http://www.sap.com/adt/packages" xmlns:adtcore="http://www.sap.com/adt/core"
  adtcore:description="vsp ci probe" adtcore:name="$ZOSD_TEST_VSPCI" adtcore:type="DEVC/K" adtcore:responsible="DEVELOPER">
  <pack:attributes pack:packageType="development"/>
  <pack:superPackage adtcore:name="$ZOSD_TEST"/>
  <pack:applicationComponent/>
  <pack:transport>
    <pack:softwareComponent pack:name="LOCAL"/>
    <pack:transportLayer pack:name=""/>
  </pack:transport>
  <pack:subPackages/>
</pack:package>`});
    expect(res.status, await res.text()).to.equal(201);
    expect(res.headers.get("location")).to.equal("/sap/bc/adt/packages/%24zosd_test_vspci");
    expect(existsSync(join(root, "src/zosd_test/vspci/package.devc.xml"))).to.equal(true);

    const visible = async (when) => {
      const tree = await call("/repository/nodestructure?parent_name=%24ZOSD_TEST_VSPCI&parent_type=DEVC%2FK&withShortDescriptions=true",
        {method: "POST", headers: stateless});
      expect(tree.status, `${when}: nodestructure ${await tree.clone().text()}`).to.equal(200);
      const parent = await (await call("/repository/nodestructure?parent_name=%24ZOSD_TEST&parent_type=DEVC%2FK&withShortDescriptions=true",
        {method: "POST", headers: stateless})).text();
      expect(parent, `${when}: listed under its parent`).to.contain("$ZOSD_TEST_VSPCI");
      const found = await (await call("/repository/informationsystem/search?operation=quickSearch&query=%24ZOSD_TEST*&maxResults=51&objectType=DEVC%2FK",
        {headers: stateless})).text();
      expect(found, `${when}: quick search`).to.contain('adtcore:name="$ZOSD_TEST_VSPCI"');
    };
    // the real disk watcher: the create's own write makes it drop the index
    // (store.index undefined), and the next request rebuilds it
    for (let i = 0; i < 100 && store.index !== undefined; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(store.index, "the watcher fired on the create's write").to.equal(undefined);
    await visible("after the watcher fired");
    // and a rebuild forced by hand
    store.build();
    await visible("after a rebuild");

    const locked = await call("/packages/%24zosd_test_vspci?_action=LOCK&accessMode=MODIFY", {method: "POST"});
    expect(locked.status).to.equal(200);
    const handle = (await locked.text()).match(/<LOCK_HANDLE>([^<]*)<\/LOCK_HANDLE>/)?.[1];
    expect(handle).to.have.length.greaterThan(8);
    await call(`/packages/%24zosd_test_vspci?_action=UNLOCK&lockHandle=${handle}`, {method: "POST"});
    const gone = await call("/packages/%24zosd_test_vspci", {method: "DELETE"});
    expect(gone.status, await gone.text()).to.equal(200);
    expect(existsSync(join(root, "src/zosd_test/vspci/package.devc.xml"))).to.equal(false);
  });

  it("what abapGit writes on disk, the façade serves without a restart", async () => {
    expect((await call("/oo/interfaces/zif_from_git")).status).to.equal(404);
    writeFileSync(join(root, "src/demo/zif_from_git.intf.abap"), "INTERFACE zif_from_git PUBLIC.\nENDINTERFACE.\n");
    writeFileSync(join(root, "src/demo/zif_from_git.intf.xml"), `<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT_INTF" serializer_version="v1.0.0">
 <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><VSEOINTERF><CLSNAME>ZIF_FROM_GIT</CLSNAME><LANGU>E</LANGU><DESCRIPT>pulled</DESCRIPT><EXPOSURE>2</EXPOSURE><STATE>1</STATE><UNICODE>X</UNICODE></VSEOINTERF></asx:values></asx:abap>
</abapGit>
`);
    let status = 404;
    for (let i = 0; i < 50 && status === 404; i++) {
      status = (await call("/oo/interfaces/zif_from_git")).status;
      if (status === 404) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    expect(status, "the watcher noticed the new files").to.equal(200);
  });
});
