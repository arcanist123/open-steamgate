// The guided TWO-LOGIN create flow of the osd-hana module against fakes only
// (no network, no database): the role worked out from the probe, ALL
// statements of BOTH logins shown on one consent screen from one statement
// source, each statement sent by the login that must run it, the failure
// rules (anything after CREATE is dropped again by the administrator
// connection, the only one that can), the write-refusal proof, and the
// sidecar's probe run AS THE READER. The single-login mechanics live in
// test/osd-hana-reader.mjs; the shared fixtures in test/osd-hana/harness.mjs.
//
// Every guard here has a named mutation behind it: the test goes red when the
// guard is removed. The mutations are listed in REPORT.md next to each test.
import {expect} from "chai";
import {PassThrough} from "node:stream";

import {
  DEFAULT_READER_NAME, READER_PASSWORD_MASK, ReaderError,
  createReader, readerStoreKey,
} from "../tools/osd-hana/reader.mjs";
import {HOST, PASSWORD, SCHEMA, USER, makeHarness} from "./osd-hana/harness.mjs";
import {SUCCESS_RULES, fakeClientFactory} from "./osd-hana/fake-client.mjs";

const h = makeHarness();

before(h.before);
after(h.after);

// the two logins of the two-login fixtures: the present login (USER, the
// administrator in the admin-role cases) and the second login
const OWNER = "OWNERLOGIN";
const OWNER_PW = "owner-password-41";
const ADMIN = "ADMINLOGIN";
const ADMIN_PW = "admin-password-40";

describe("tools/osd-hana: the guided two-login create flow", function () {
  this.timeout(20_000);

  // ------------------------------------------------- the statement source

  it("one statement source: the consent screen shows ALL statements of BOTH logins (grouped by who runs them) and the executed list equals the printed list modulo the password mask (mutation: GRANT CATALOG READ dropped from the plan -> red)", async function () {
    const {log, factory} = fakeClientFactory(SUCCESS_RULES);
    const said = [];
    await createReader({
      connection: {host: HOST, port: 39015, user: USER, password: PASSWORD},
      schema: SCHEMA, readerName: DEFAULT_READER_NAME, yes: true,
      store: h.store(), clientFactory: factory, say: (text) => said.push(text),
    });
    const consent = said[0];
    // both groups, with the login that runs each
    expect(consent).to.include(`as THIS login (it is both the administrator and the schema owner) -- ${USER}`);
    // every printed statement, in order
    const printed = [...consent.matchAll(/^    (.*?)   -- /gm)].map((m) => m[1]);
    expect(printed.map((sql) => sql.replace(new RegExp(READER_PASSWORD_MASK.replace(/[*]/g, "\\$&"), "g"), "PW")))
      .to.deep.equal([
        `CREATE USER ${DEFAULT_READER_NAME} PASSWORD "PW" NO FORCE_FIRST_PASSWORD_CHANGE`,
        `ALTER USER ${DEFAULT_READER_NAME} DISABLE PASSWORD LIFETIME`,
        `GRANT CATALOG READ TO ${DEFAULT_READER_NAME}`,
        `GRANT SELECT ON SCHEMA "${SCHEMA}" TO ${DEFAULT_READER_NAME}`,
      ]);
    // the executed mutating statements are exactly the printed ones
    const executed = log.statements.map((s) => s.sql)
      .filter((sql) => /^(CREATE USER|ALTER USER|GRANT SELECT|GRANT CATALOG READ) /.test(sql));
    const password = /PASSWORD "([^"]+)"/.exec(executed[0])[1];
    expect(executed).to.deep.equal(printed.map((sql) => sql.split(READER_PASSWORD_MASK).join(password)));
  });

  // ------------------------------------------------------- who runs what

  it("role admin (the doctor's probe said so): CREATE/ALTER/CATALOG READ run on the present login's connection, GRANT SELECT on the schema owner's -- per-login scripted answers (mutation: the GRANT SELECT sent as the administrator -> red)", async function () {
    const {log, factory} = fakeClientFactory(SUCCESS_RULES);
    const secretStore = h.store();
    const connection = {host: HOST, port: 39015, user: USER, password: PASSWORD};
    await createReader({
      connection, schema: SCHEMA, readerName: DEFAULT_READER_NAME, yes: true,
      role: "admin", secondLogin: {user: OWNER, password: OWNER_PW},
      store: secretStore, clientFactory: factory,
    });
    // both logins connected
    expect(log.connections.some((c) => c.user === USER)).to.equal(true);
    expect(log.connections.some((c) => c.user === OWNER)).to.equal(true);
    // the administrator's three, as the administrator
    for (const prefix of ["CREATE USER", "ALTER USER", "GRANT CATALOG READ"]) {
      const sent = log.statements.filter((s) => s.sql.startsWith(prefix));
      expect(sent, prefix).to.have.length(1);
      expect(sent[0].user, prefix).to.equal(USER);
    }
    // the owner's statement, as the owner -- and with the owner's PASSWORD,
    // never the administrator's
    const grant = log.statements.find((s) => s.sql.startsWith("GRANT SELECT"));
    expect(grant.user).to.equal(OWNER);
    const ownerConnect = log.connections.find((c) => c.user === OWNER);
    expect(ownerConnect.password).to.equal(OWNER_PW);
    // neither extra password is stored: the store holds the READER's secret only
    const stored = secretStore.get(readerStoreKey(connection, DEFAULT_READER_NAME));
    expect(stored.password).to.not.equal(OWNER_PW);
    expect(stored.password).to.not.equal(PASSWORD);
    expect(JSON.stringify(stored)).to.not.include(OWNER_PW);
  });

  it("role owner: CREATE/ALTER/CATALOG READ run on the administrator's (second) connection, GRANT SELECT on the present login's (mutation: the roles' connections swapped -> red)", async function () {
    const {log, factory} = fakeClientFactory(SUCCESS_RULES);
    await createReader({
      connection: {host: HOST, port: 39015, user: OWNER, password: OWNER_PW},
      schema: SCHEMA, readerName: DEFAULT_READER_NAME, yes: true,
      role: "owner", secondLogin: {user: ADMIN, password: ADMIN_PW},
      store: h.store(), clientFactory: factory,
    });
    for (const prefix of ["CREATE USER", "ALTER USER", "GRANT CATALOG READ"]) {
      const sent = log.statements.filter((s) => s.sql.startsWith(prefix));
      expect(sent, prefix).to.have.length(1);
      expect(sent[0].user, prefix).to.equal(ADMIN);
    }
    const grant = log.statements.find((s) => s.sql.startsWith("GRANT SELECT"));
    expect(grant.user).to.equal(OWNER);
    const adminConnect = log.connections.find((c) => c.user === ADMIN);
    expect(adminConnect.password).to.equal(ADMIN_PW);
  });

  // ------------------------------------------------------------ failures

  it("a GRANT SELECT refused to the owner (258) drops the reader -- by the ADMINISTRATOR connection -- and names which login failed at which statement (mutation: keep the half reader -> red)", async function () {
    const {log, factory} = fakeClientFactory([
      {match: /CREATE USER/, rows: []},
      {match: /ALTER USER/, rows: []},
      {match: /GRANT CATALOG READ/, rows: []},
      {user: OWNER, match: /GRANT SELECT/, error: 258, message: "insufficient privilege"},
      {match: /FROM SYS\.M_DATABASE/, rows: [{SYSTEM_ID: "SYSID-FIXTURE-1", DATABASE_NAME: "TEN"}]},
      {match: /FROM SYS\.USERS/, rows: [{N: 0}]},
      {match: /DROP USER/, rows: []},
    ]);
    await createReader({
      connection: {host: HOST, port: 39015, user: USER, password: PASSWORD},
      schema: SCHEMA, readerName: DEFAULT_READER_NAME, yes: true,
      role: "admin", secondLogin: {user: OWNER, password: OWNER_PW},
      store: h.store(), clientFactory: factory,
    }).then(
      () => expect.fail("should refuse"),
      (error) => {
        expect(error).to.be.an.instanceof(ReaderError);
        expect(error.message).to.include(`schema-owner login ${OWNER} failed at`);
        expect(error.message).to.include(`GRANT SELECT ON SCHEMA "${SCHEMA}" TO ${DEFAULT_READER_NAME}`);
        expect(error.message).to.include("258");
        expect(error.message).to.include("dropped again");
      });
    // the DROP ran on the ADMINISTRATOR connection (the only one that can)
    const drop = log.statements.find((s) => s.sql === `DROP USER ${DEFAULT_READER_NAME} CASCADE`);
    expect(drop, "the reader must be dropped again").to.not.equal(undefined);
    expect(drop.user).to.equal(USER);
  });

  it("the owner's password being wrong (logon refused) drops the reader and names the owner login (mutation: no cleanup -> red)", async function () {
    const log = {connections: [], statements: []};
    const factory = async (options) => {
      log.connections.push(options);
      if (options.user === OWNER) {
        throw Object.assign(new Error("authentication failed"), {code: 401});
      }
      return {
        exec: async (sql, params = []) => {
          log.statements.push({sql, params, user: options.user});
          for (const rule of SUCCESS_RULES) {
            if (rule.match.test(sql) && rule.error === undefined) return {rows: rule.rows ?? []};
            if (rule.match.test(sql) && rule.error !== undefined) throw Object.assign(new Error(rule.message), {code: rule.error});
          }
          return {rows: []};
        },
        disconnect: async () => {},
      };
    };
    await createReader({
      connection: {host: HOST, port: 39015, user: USER, password: PASSWORD},
      schema: SCHEMA, readerName: DEFAULT_READER_NAME, yes: true,
      role: "admin", secondLogin: {user: OWNER, password: OWNER_PW},
      store: h.store(), clientFactory: factory,
    }).then(
      () => expect.fail("should refuse"),
      (error) => {
        expect(error).to.be.an.instanceof(ReaderError);
        expect(error.message).to.include(`schema-owner login ${OWNER} failed at`);
        expect(error.message).to.include("log on");
        expect(error.message).to.include("dropped again");
      });
    expect(log.statements.some((s) => s.sql === `DROP USER ${DEFAULT_READER_NAME} CASCADE`)).to.equal(true);
  });

  it("an administrator statement failing after CREATE (ALTER 421) drops the reader and names the administrator login and the statement (mutation: the drop skipped -> red)", async function () {
    const {log, factory} = fakeClientFactory([
      {match: /CREATE USER/, rows: []},
      {match: /ALTER USER/, error: 421, message: "phase failed"},
      {match: /FROM SYS\.M_DATABASE/, rows: [{SYSTEM_ID: "SYSID-FIXTURE-1", DATABASE_NAME: "TEN"}]},
      {match: /FROM SYS\.USERS/, rows: [{N: 0}]},
      {match: /DROP USER/, rows: []},
    ]);
    await createReader({
      connection: {host: HOST, port: 39015, user: OWNER, password: OWNER_PW},
      schema: SCHEMA, readerName: DEFAULT_READER_NAME, yes: true,
      role: "owner", secondLogin: {user: ADMIN, password: ADMIN_PW},
      store: h.store(), clientFactory: factory,
    }).then(
      () => expect.fail("should refuse"),
      (error) => {
        expect(error).to.be.an.instanceof(ReaderError);
        expect(error.message).to.include("421");
        expect(error.message).to.include("dropped again");
        expect(error.message).to.include(ADMIN); // which login
        expect(error.message).to.include("ALTER USER"); // WHICH statement (critic S-2)
        expect(error.message).to.not.include(OWNER_PW);
        expect(error.message).to.not.include(ADMIN_PW);
      });
    expect(log.statements.some((s) => s.sql === `DROP USER ${DEFAULT_READER_NAME} CASCADE`)).to.equal(true);
  });

  it("GRANT CATALOG READ refused with 258: the message names the login and the statement and gives this grant its own ways-on (--no-catalog-read, or a login that may grant it); the reader is dropped (critic S-2 / probe P2; mutation: the catch-all buries the statement -> red)", async function () {
    const {log, factory} = fakeClientFactory([
      {match: /GRANT CATALOG READ/, error: 258, message: "insufficient privilege"},
      ...SUCCESS_RULES.filter((r) => !/GRANT CATALOG READ/.test(r.match.source)),
    ]);
    const secretStore = h.store();
    const connection = {host: HOST, port: 39015, user: USER, password: PASSWORD};
    await createReader({
      connection, schema: SCHEMA, readerName: DEFAULT_READER_NAME, yes: true,
      role: "admin", secondLogin: {user: OWNER, password: OWNER_PW},
      store: secretStore, clientFactory: factory,
    }).then(
      () => expect.fail("should refuse"),
      (error) => {
        expect(error).to.be.an.instanceof(ReaderError);
        expect(error.message).to.include(`administrator login ${USER} failed at`);
        expect(error.message).to.include(`GRANT CATALOG READ TO ${DEFAULT_READER_NAME}`);
        expect(error.message).to.include("258");
        // this refusal's own ways-on
        expect(error.message).to.include("--no-catalog-read");
        expect(error.message).to.include("dropped again");
      });
    expect(log.statements.some((s) => s.sql === `DROP USER ${DEFAULT_READER_NAME} CASCADE`)).to.equal(true);
    expect(secretStore.get(readerStoreKey(connection, DEFAULT_READER_NAME)), "no secret for a dropped reader").to.equal(undefined);
  });

  it("GRANT CATALOG READ refused with another error (331): the message still names the login and the statement, and the reader is dropped (critic S-2; mutation: the catch-all buries the statement -> red)", async function () {
    const {log, factory} = fakeClientFactory([
      {match: /GRANT CATALOG READ/, error: 331, message: "grant not possible here"},
      ...SUCCESS_RULES.filter((r) => !/GRANT CATALOG READ/.test(r.match.source)),
    ]);
    await createReader({
      connection: {host: HOST, port: 39015, user: USER, password: PASSWORD},
      schema: SCHEMA, readerName: DEFAULT_READER_NAME, yes: true,
      role: "both",
      store: h.store(), clientFactory: factory,
    }).then(
      () => expect.fail("should refuse"),
      (error) => {
        expect(error).to.be.an.instanceof(ReaderError);
        expect(error.message).to.include(`administrator login ${USER} failed at`);
        expect(error.message).to.include(`GRANT CATALOG READ TO ${DEFAULT_READER_NAME}`);
        expect(error.message).to.include("331");
        expect(error.message).to.include("dropped again");
      });
    expect(log.statements.some((s) => s.sql === `DROP USER ${DEFAULT_READER_NAME} CASCADE`)).to.equal(true);
  });

  // -------------------------------------------------------- the proofs

  it("after success: the UPDATE probe must be REFUSED -- a reader that CAN write is dropped and the run fails loudly (mutation: accept a writable reader -> red)", async function () {
    // the write probe succeeds on this database: the reader is NOT read-only
    const {log, factory} = fakeClientFactory(SUCCESS_RULES.filter((r) => !/SET "PGMID"/.test(r.match.source)));
    await createReader({
      connection: {host: HOST, port: 39015, user: USER, password: PASSWORD},
      schema: SCHEMA, readerName: DEFAULT_READER_NAME, yes: true,
      store: h.store(), clientFactory: factory,
    }).then(
      () => expect.fail("a reader that can write must fail the run"),
      (error) => {
        expect(error).to.be.an.instanceof(ReaderError);
        expect(error.message).to.include("THE READER CAN WRITE");
        expect(error.message).to.include(`UPDATE "${SCHEMA}"."TADIR" SET "PGMID" = "PGMID" WHERE 1 = 0`);
        expect(error.message).to.include("dropped again");
      });
    expect(log.statements.some((s) => s.sql === `DROP USER ${DEFAULT_READER_NAME} CASCADE`)).to.equal(true);
  });

  it("the write probe answers 257 (a syntax error, not 258): that is NOT a proof -- the reader is dropped, no secret is stored, and the run fails loudly naming the outcome (critic M-1; mutation: any error counts as refused -> red)", async function () {
    const {log, factory} = fakeClientFactory([
      {match: /SET "PGMID" = "PGMID"/, error: 257, message: "sql syntax error: incorrect syntax near SET"},
      ...SUCCESS_RULES.filter((r) => !/SET "PGMID" = "PGMID"/.test(r.match.source)),
    ]);
    const secretStore = h.store();
    const connection = {host: HOST, port: 39015, user: USER, password: PASSWORD};
    await createReader({
      connection, schema: SCHEMA, readerName: DEFAULT_READER_NAME, yes: true,
      store: secretStore, clientFactory: factory,
    }).then(
      () => expect.fail("a 257 proves nothing -- the run must fail"),
      (error) => {
        expect(error).to.be.an.instanceof(ReaderError);
        expect(error.message).to.include("COULD NOT PROVE");
        expect(error.message).to.include("the database answered a DIFFERENT error");
        expect(error.message).to.include("257");
        expect(error.message).to.include(`UPDATE "${SCHEMA}"."TADIR" SET "PGMID" = "PGMID" WHERE 1 = 0`);
        // only 258 proves the refusal: 257 is dropped without a hand-out
        expect(error.message).to.not.include("proof the reader cannot write");
      });
    expect(log.statements.some((s) => s.sql === `DROP USER ${DEFAULT_READER_NAME} CASCADE`)).to.equal(true);
    expect(secretStore.get(readerStoreKey(connection, DEFAULT_READER_NAME)), "no secret for a dropped reader").to.equal(undefined);
  });

  it("the write probe loses the connection (no SQL error at all): NOT a proof -- the reader is dropped, no secret is stored, the run says the connection died (critic M-1; mutation: a thrown probe counts as refused -> red)", async function () {
    const base = fakeClientFactory(SUCCESS_RULES);
    const factory = async (options) => {
      const client = await base.factory(options);
      const exec = client.exec;
      client.exec = async (sql, params) => {
        if (/SET "PGMID" = "PGMID"/.test(sql)) throw new Error("socket hang up ECONNRESET");
        return exec(sql, params);
      };
      return client;
    };
    const secretStore = h.store();
    const connection = {host: HOST, port: 39015, user: USER, password: PASSWORD};
    await createReader({
      connection, schema: SCHEMA, readerName: DEFAULT_READER_NAME, yes: true,
      store: secretStore, clientFactory: factory,
    }).then(
      () => expect.fail("a lost connection proves nothing -- the run must fail"),
      (error) => {
        expect(error).to.be.an.instanceof(ReaderError);
        expect(error.message).to.include("COULD NOT PROVE");
        expect(error.message).to.include("no SQL error arrived");
        expect(error.message).to.include("ECONNRESET");
        expect(error.message).to.not.include("proof the reader cannot write");
      });
    expect(base.log.statements.some((s) => s.sql === `DROP USER ${DEFAULT_READER_NAME} CASCADE`)).to.equal(true);
    expect(secretStore.get(readerStoreKey(connection, DEFAULT_READER_NAME)), "no secret for a dropped reader").to.equal(undefined);
  });

  it("after success, the write probe refused: the proof is said, with the exact statement shape (mutation: the write proof removed -> red)", async function () {
    const {log, factory} = fakeClientFactory(SUCCESS_RULES);
    const said = [];
    await createReader({
      connection: {host: HOST, port: 39015, user: USER, password: PASSWORD},
      schema: SCHEMA, readerName: DEFAULT_READER_NAME, yes: true,
      store: h.store(), clientFactory: factory, say: (text) => said.push(text),
    });
    expect(log.statements.some((s) => s.sql === `UPDATE "${SCHEMA}"."TADIR" SET "PGMID" = "PGMID" WHERE 1 = 0`)).to.equal(true);
    expect(said.join("\n")).to.include("proof the reader cannot write");
    expect(said.join("\n")).to.include("read 42 rows");
  });

  it("--no-catalog-read: GRANT CATALOG READ is neither printed nor sent, and the stored entry records catalog_read: false (mutation: the grant sent anyway -> red)", async function () {
    const {log, factory} = fakeClientFactory(SUCCESS_RULES);
    const said = [];
    const secretStore = h.store();
    const connection = {host: HOST, port: 39015, user: USER, password: PASSWORD};
    await createReader({
      connection, schema: SCHEMA, readerName: DEFAULT_READER_NAME, yes: true, catalogRead: false,
      store: secretStore, clientFactory: factory, say: (text) => said.push(text),
    });
    const all = said.join("\n");
    expect(all).to.not.include("GRANT CATALOG READ");
    expect(log.statements.some((s) => s.sql.startsWith("GRANT CATALOG READ"))).to.equal(false);
    expect(secretStore.get(readerStoreKey(connection, DEFAULT_READER_NAME)).catalog_read).to.equal(false);
  });

  it("the onCreated hook (the doctor's reader probe) runs AFTER the proofs and the store, with the generated password; the password is in no message (mutation: the hook dropped -> red)", async function () {
    const {log, factory} = fakeClientFactory(SUCCESS_RULES);
    const said = [];
    const secretStore = h.store();
    const connection = {host: HOST, port: 39015, user: USER, password: PASSWORD};
    let hookSaw;
    await createReader({
      connection, schema: SCHEMA, readerName: DEFAULT_READER_NAME, yes: true,
      store: secretStore, clientFactory: factory, say: (text) => said.push(text),
      onCreated: async (info) => {
        // the secret is already stored when the hook runs
        hookSaw = {...info, stored: secretStore.get(readerStoreKey(connection, DEFAULT_READER_NAME)) !== undefined};
      },
    });
    expect(hookSaw).to.not.equal(undefined);
    expect(hookSaw.user).to.equal(DEFAULT_READER_NAME);
    expect(hookSaw.catalogRead).to.equal(true);
    expect(hookSaw.stored).to.equal(true);
    expect(hookSaw.password).to.match(/^[A-Za-z0-9]{28}$/);
    expect(said.join("\n")).to.not.include(hookSaw.password);
    // the reader path opened exactly three connections: administrator,
    // owner (here the same login), and the reader proof
    expect(log.connections.filter((c) => c.user === DEFAULT_READER_NAME)).to.have.length(1);
  });

  // --------------------------------------------- the doctor's guided flow

  it("the doctor works the role out from the probe: an administrator login drives the two-login flow with --owner-user + $OSD_HANA_OWNER_PASSWORD; the consent screen shows BOTH groups; the extra password is never stored (mutation: the second login ignored -> red)", async function () {
    const {log, factory} = fakeClientFactory(SUCCESS_RULES);
    const secretStore = h.store();
    const code = await h.runDoctor(["--create-reader", "--yes", "--owner-user", OWNER], {
      scenario: "admin-system",
      env: {OSD_HANA_OWNER_PASSWORD: OWNER_PW},
      deps: {clientFactory: factory, store: secretStore},
    });
    expect(code, h.allText()).to.equal(0);
    const text = h.allText();
    // both groups on the consent screen, named by login
    expect(text).to.include(`as the ADMINISTRATOR login ${USER}`);
    expect(text).to.include(`as the SCHEMA OWNER login ${OWNER}`);
    // the statements were sent by the right logins
    const grant = log.statements.find((s) => s.sql.startsWith("GRANT SELECT"));
    expect(grant.user).to.equal(OWNER);
    const create = log.statements.find((s) => s.sql.startsWith("CREATE USER"));
    expect(create.user).to.equal(USER);
    // the extra password: used on the wire, in no message, in no store entry
    const ownerConnect = log.connections.find((c) => c.user === OWNER);
    expect(ownerConnect.password).to.equal(OWNER_PW);
    expect(text).to.not.include(OWNER_PW);
    expect(JSON.stringify(secretStore.get(readerStoreKey({host: HOST, port: 39015}, DEFAULT_READER_NAME)))).to.not.include(OWNER_PW);
  });

  it("the doctor asks on a terminal and takes the catalogue's suggested owner login when the prompt answers empty (mutation: the suggestion never shown -> red)", async function () {
    const {log, factory} = fakeClientFactory(SUCCESS_RULES);
    const asked = [];
    const code = await h.runDoctor(["--create-reader", "--yes"], {
      scenario: "admin-system",
      isTTY: true,
      deps: {
        clientFactory: factory, store: h.store(), stderr: {isTTY: true},
        prompt: async (question) => {
          asked.push(question);
          // empty answer to the login question: the suggestion must be used
          return question.includes("login") ? "" : OWNER_PW;
        },
      },
    });
    expect(code, h.allText()).to.equal(0);
    // the question showed the catalogue's suggestion (SYS.SCHEMAS answer)
    expect(asked.some((q) => q.includes("schema owner login") && q.includes("[SCHEMA_OWNER_LOGIN]"))).to.equal(true);
    const grant = log.statements.find((s) => s.sql.startsWith("GRANT SELECT"));
    expect(grant.user).to.equal("SCHEMA_OWNER_LOGIN");
  });

  it("on a REAL terminal with the DEFAULT wiring (no injected prompt) the doctor asks: a visible question for the login name (the answer echoes), a hidden one for the password (nothing echoes) (critic M-2; mutation: the default prompts unwired -> red)", async function () {
    const {log, factory} = fakeClientFactory(SUCCESS_RULES);
    const stdin = new PassThrough();
    stdin.isTTY = true;
    stdin.setRawMode = () => {};
    const stderr = new PassThrough();
    stderr.isTTY = true;
    let stderrText = "";
    stderr.on("data", (chunk) => { stderrText += chunk.toString("utf8"); });
    const secretStore = h.store();
    const run = h.runDoctor(["--create-reader", "--yes"], {
      scenario: "admin-system",
      isTTY: true,
      deps: {clientFactory: factory, store: secretStore, stdin, stderr},
    });
    const waitFor = async (fragment) => {
      for (let i = 0; i < 500 && !stderrText.includes(fragment); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(stderrText.includes(fragment), `the doctor never asked: ${JSON.stringify(fragment)}`).to.equal(true);
    };
    // the visible question for the login NAME
    await waitFor("schema owner login");
    stdin.write(`${OWNER}\n`);
    // the hidden question for the password
    await waitFor(`password for ${OWNER}`);
    // the name reached stderr BEFORE the password question was asked: the
    // visible prompt echoed the typed answer
    expect(stderrText.includes(OWNER), "the typed login name must be echoed").to.equal(true);
    expect(stderrText.indexOf("password for")).to.be.greaterThan(stderrText.indexOf(OWNER));
    expect(stderrText).to.not.include(OWNER_PW);
    stdin.write(`${OWNER_PW}\n`);
    const code = await run;
    expect(code, h.allText() + "\n--stderr--\n" + stderrText).to.equal(0);
    // the hidden path NEVER echoes: no character of the password on stderr
    expect(stderrText).to.not.include(OWNER_PW);
    const grant = log.statements.find((s) => s.sql.startsWith("GRANT SELECT"));
    expect(grant, "the grant ran as the prompted login").to.not.equal(undefined);
    expect(grant.user).to.equal(OWNER);
  });

  it("stdin is a terminal but stderr is NOT: the doctor does not ask -- the TTY check is on BOTH streams, and the refusal text stays true (critic M-2; mutation: the stderr half of the TTY check dropped -> red)", async function () {
    const {log, factory} = fakeClientFactory(SUCCESS_RULES);
    const code = await h.runDoctor(["--create-reader", "--yes"], {
      scenario: "admin-system",
      isTTY: true,
      deps: {clientFactory: factory, store: h.store(), stderr: {isTTY: false}},
    });
    expect(code).to.equal(1);
    const text = h.allText();
    expect(text).to.include("Nothing was sent");
    expect(text).to.include("--owner-user");
    // nothing mutating went out: only the informational suggestion lookup ran
    expect(log.statements.every((s) => s.sql.startsWith("SELECT"))).to.equal(true);
  });

  it("the doctor refuses the two-login flow without the second login's password: $OSD_HANA_OWNER_PASSWORD named, nothing sent (mutation: the missing-password guard dropped -> red)", async function () {
    const {log, factory} = fakeClientFactory(SUCCESS_RULES);
    const code = await h.runDoctor(["--create-reader", "--yes", "--owner-user", OWNER], {
      scenario: "admin-system",
      deps: {clientFactory: factory, store: h.store()},
    });
    expect(code).to.equal(1);
    expect(h.allText()).to.include("OSD_HANA_OWNER_PASSWORD");
    expect(h.allText()).to.include("Nothing was sent");
    // the only connection is the read-only suggestion lookup -- no mutating
    // statement was sent
    expect(log.statements.every((s) => s.sql.startsWith("SELECT"))).to.equal(true);
    expect(log.statements.some((s) => /^(CREATE USER|ALTER USER|GRANT)/.test(s.sql))).to.equal(false);
  });

  it("the present login is the schema owner: the doctor asks for an administrator login (--admin-user + $OSD_HANA_ADMIN_PASSWORD) and the roles land on the right connections (mutation: the roles swapped -> red)", async function () {
    const {log, factory} = fakeClientFactory(SUCCESS_RULES);
    const code = await h.runDoctor(["--create-reader", "--yes", "--admin-user", ADMIN], {
      scenario: "owner-tenant",
      env: {OSD_HANA_ADMIN_PASSWORD: ADMIN_PW},
      deps: {clientFactory: factory, store: h.store()},
    });
    expect(code, h.allText()).to.equal(0);
    expect(h.allText()).to.include(`as the ADMINISTRATOR login ${ADMIN}`);
    expect(h.allText()).to.include(`as the SCHEMA OWNER login ${USER}`);
    const create = log.statements.find((s) => s.sql.startsWith("CREATE USER"));
    expect(create.user).to.equal(ADMIN);
    const grant = log.statements.find((s) => s.sql.startsWith("GRANT SELECT"));
    expect(grant.user).to.equal(USER);
  });

  it("a login that is NEITHER administrator nor owner: the doctor explains what is needed and sends NOTHING (mutation: CREATE attempted anyway -> red)", async function () {
    const {log, factory} = fakeClientFactory(SUCCESS_RULES);
    const code = await h.runDoctor(["--create-reader", "--yes"], {
      scenario: "other",
      deps: {clientFactory: factory, store: h.store()},
    });
    expect(code).to.equal(1);
    expect(h.allText()).to.include("neither an administrator");
    expect(h.allText()).to.include("GRANT CATALOG READ");
    expect(h.allText()).to.include("Nothing was sent");
    expect(log.connections).to.have.length(0);
    expect(log.statements).to.have.length(0);
  });

  it("after success the doctor runs the sidecar's probe AS THE READER and shows its verdict -- the reader sees the database as 'other', not as its creator (mutation: the reader probe dropped -> red)", async function () {
    const {factory} = fakeClientFactory(SUCCESS_RULES);
    const code = await h.runDoctor(["--create-reader", "--yes"], {
      scenario: "roles",
      deps: {clientFactory: factory, store: h.store()},
    });
    expect(code, h.allText()).to.equal(0);
    const text = h.allText();
    expect(text).to.include("the reader's own probe");
    // the reader's verdict is the reader's, not the administrator's: the
    // fake answers the reader probe with class "other" and ITS OWN counts
    // (5 source rows, not the main login's 1234)
    expect(text).to.include("another kind of login");
    expect(text).to.include("5 source rows (REPOSRC)");
    expect(text).to.include("logged on as OSD_READER");
    // and in --json the reader's probe document is there too
    const code2 = await h.runDoctor(["--create-reader", "--yes", "--json"], {
      scenario: "roles",
      deps: {clientFactory: factory, store: h.store()},
    });
    expect(code2).to.equal(0);
    const document = JSON.parse(h.out.find((l) => l.trimStart().startsWith("{")));
    expect(document.reader_probe.login_class).to.equal("other");
    expect(document.reader.user).to.equal(DEFAULT_READER_NAME);
  });

  it("--no-catalog-read through the doctor: the grant is not sent and the doctor says procedures cannot be extracted with this reader (mutation: the warning lost -> red)", async function () {
    const {log, factory} = fakeClientFactory(SUCCESS_RULES);
    const code = await h.runDoctor(["--create-reader", "--yes", "--no-catalog-read"], {
      scenario: "both",
      deps: {clientFactory: factory, store: h.store()},
    });
    expect(code, h.allText()).to.equal(0);
    expect(log.statements.some((s) => s.sql.startsWith("GRANT CATALOG READ"))).to.equal(false);
    expect(h.allText()).to.not.include("GRANT CATALOG READ TO");
    expect(h.allText()).to.include("CANNOT extract database procedures");
  });
});
