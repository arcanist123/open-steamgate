// The dedicated-reader path of the osd-hana module against fakes only (no
// network, no database): --create-reader / --drop-reader through the reader's
// clientFactory seam, scripted with the E1 answers, plus the secret store.
// The doctor/sidecar tests live in test/osd-hana-doctor.mjs; the shared
// fixtures in test/osd-hana/harness.mjs and the FAKE hdb client in
// test/osd-hana/fake-client.mjs.
//
// Every guard here has a named mutation behind it: the test goes red when the
// guard is removed. The mutations are listed in REPORT.md next to each test.
import {expect} from "chai";
import {mkdirSync, statSync, writeFileSync, chmodSync} from "node:fs";
import {join} from "node:path";

import {
  DEFAULT_READER_NAME, ConsentRefused, ReaderError,
  createReader, dropReader, generateReaderPassword, quoteIdentifier, readerStoreKey, validateReaderName,
} from "../tools/osd-hana/reader.mjs";
import {UsageError, parseFlags, readEnvFile} from "../tools/osd-hana/connect.mjs";
import {fileSecretStore} from "../tools/osd-hana/secret-store.mjs";
import {HOST, PASSWORD, SCHEMA, USER, makeHarness} from "./osd-hana/harness.mjs";
import {SUCCESS_RULES, fakeClientFactory} from "./osd-hana/fake-client.mjs";

const h = makeHarness();

before(h.before);
after(h.after);

describe("tools/osd-hana: the dedicated reader", function () {
  this.timeout(20_000);

  it("validates the reader name: only a name that is ours, ^OSD_[A-Z0-9_]{1,26}$ (critic M-2; mutation: admit any uppercase name -> red)", function () {
    expect(validateReaderName(DEFAULT_READER_NAME)).to.equal("OSD_READER");
    expect(validateReaderName("OSD_R")).to.equal("OSD_R");
    // the database's own accounts are names, not readers: none of them may
    // pass -- the old pattern admitted SYSTEM and SYS straight into
    // DROP USER ... CASCADE
    for (const bad of ["SYSTEM", "SYS", "_SYS_REPO", "OSDX", "X; DROP USER Y", 'AB"C', "1ABC", "osd_reader", "TOO_LONG_NAME_OVER_THIRTY_ONE_XY", "", "A-B", `OSD_${"A".repeat(27)}`]) {
      expect(() => validateReaderName(bad), bad).to.throw(ReaderError);
    }
    // and createReader itself refuses a bad name before anything is built
    // or sent -- the entry point is the guard, not the helper alone
    const {log, factory} = fakeClientFactory(SUCCESS_RULES);
    return createReader({
      connection: {host: HOST, port: 39015, user: USER, password: PASSWORD},
      schema: SCHEMA, readerName: "SYSTEM", yes: true,
      store: h.store(), clientFactory: factory,
    }).then(
      () => expect.fail("should refuse"),
      (error) => {
        expect(error).to.be.an.instanceof(ReaderError);
        expect(error.message).to.include("UNQUOTED");
      }).then(() => {
        expect(log.statements).to.have.length(0);
        expect(log.connections).to.have.length(0);
      });
  });

  it("drop-reader without a matching stored secret refuses and names the one SQL line, sending nothing (critic M-2b; mutation: drop the ownership check -> red)", async function () {
    // the store holds no entry for this host + port + database + name: this
    // tool did not create a reader here, so it must not drop one -- the
    // refusal hands the administrator the single statement to run by hand
    const {log, factory} = fakeClientFactory(SUCCESS_RULES);
    await dropReader({
      connection: {host: HOST, port: 39015, user: USER, password: PASSWORD},
      readerName: DEFAULT_READER_NAME, yes: true, store: h.store(), clientFactory: factory,
    }).then(
      () => expect.fail("should refuse"),
      (error) => {
        expect(error).to.be.an.instanceof(ReaderError);
        expect(error.message).to.include("DROP USER OSD_READER CASCADE");
      });
    expect(log.connections).to.have.length(0);
    expect(log.statements).to.have.length(0);
  });

  it("drop-reader refuses a stored secret that belongs to another host or database (the entry must match exactly)", async function () {
    const secretStore = h.store();
    secretStore.set(
      {user: DEFAULT_READER_NAME, password: "gone-soon-42", schema: SCHEMA, host: "other.example.test", port: 39015, database: "TEN"},
      readerStoreKey({host: "other.example.test", port: 39015, database: "TEN"}, DEFAULT_READER_NAME));
    const {log, factory} = fakeClientFactory(SUCCESS_RULES);
    await dropReader({
      connection: {host: HOST, port: 39015, user: USER, password: PASSWORD},
      readerName: DEFAULT_READER_NAME, yes: true, store: secretStore, clientFactory: factory,
    }).then(
      () => expect.fail("should refuse"),
      (error) => expect(error).to.be.an.instanceof(ReaderError));
    expect(log.connections).to.have.length(0);
    expect(log.statements).to.have.length(0);
  });

  it("drop-reader refuses to drop the login it is connected as (critic M-2c; mutation: remove the identity check -> red)", async function () {
    // the current login is necessarily in SYS.USERS; a reader name that IS
    // the login means DROP USER <the administrator itself> CASCADE
    const secretStore = h.store();
    h.seedStore(secretStore, {host: HOST, port: 39015});
    const {log, factory} = fakeClientFactory(SUCCESS_RULES);
    await dropReader({
      connection: {host: HOST, port: 39015, user: "osd_reader", password: PASSWORD},
      readerName: DEFAULT_READER_NAME, yes: true, store: secretStore, clientFactory: factory,
    }).then(
      () => expect.fail("should refuse"),
      (error) => {
        expect(error).to.be.an.instanceof(ReaderError);
        expect(error.message.toLowerCase()).to.include("login");
      });
    expect(log.connections).to.have.length(0);
    expect(log.statements).to.have.length(0);
  });

  it("quotes identifiers as measured: \" doubled, ' passing through", async function () {
    expect(quoteIdentifier('AB"S')).to.equal('"AB""S"');
    expect(quoteIdentifier("O'A")).to.equal("\"O'A\"");
    // and the GRANT statement the plan shows carries the doubled form
    const {factory} = fakeClientFactory(SUCCESS_RULES);
    const seen = [];
    await createReader({
      connection: {host: HOST, port: 39015, user: USER, password: PASSWORD},
      schema: 'AB"S', readerName: DEFAULT_READER_NAME, yes: true, store: h.store(),
      clientFactory: async (options) => {
        const client = await factory(options);
        const exec = client.exec.bind(client);
        client.exec = async (sql, params) => {
          seen.push({sql, params});
          return exec(sql, params);
        };
        return client;
      },
    }).then(() => {
      const grant = seen.find((s) => s.sql.includes("GRANT SELECT"));
      expect(grant.sql).to.include('ON SCHEMA "AB""S"');
    });
  });

  it("requires consent: no --yes and no TTY means nothing is sent (mutation: consent always given -> red)", async function () {
    const {log, factory} = fakeClientFactory(SUCCESS_RULES);
    await createReader({
      connection: {host: HOST, port: 39015, user: USER, password: PASSWORD},
      schema: SCHEMA, readerName: DEFAULT_READER_NAME, yes: false, isTTY: false,
      store: h.store(), clientFactory: factory,
    }).then(
      () => expect.fail("should refuse"),
      (error) => expect(error).to.be.an.instanceof(ConsentRefused));
    expect(log.statements).to.have.length(0);
    expect(log.connections).to.have.length(0);
  });

  it("asks on a TTY and proceeds on 'yes'", async function () {
    const {log, factory} = fakeClientFactory(SUCCESS_RULES);
    const result = await createReader({
      connection: {host: HOST, port: 39015, user: USER, password: PASSWORD},
      schema: SCHEMA, readerName: DEFAULT_READER_NAME, yes: false, isTTY: true,
      prompt: async () => "yes",
      store: h.store(), clientFactory: factory,
    });
    expect(log.statements.some((s) => s.sql.startsWith("CREATE USER"))).to.equal(true);
    expect(result.user).to.equal(DEFAULT_READER_NAME);
    // a declined prompt sends nothing
    const log2 = fakeClientFactory(SUCCESS_RULES);
    await createReader({
      connection: {host: HOST, port: 39015, user: USER, password: PASSWORD},
      schema: SCHEMA, yes: false, isTTY: true, prompt: async () => "no",
      store: h.store(), clientFactory: log2.factory,
    }).then(() => expect.fail("should refuse"), (error) => expect(error).to.be.an.instanceof(ConsentRefused));
    expect(log2.log.statements).to.have.length(0);
  });

  it("runs the E1 statement sequence and proves a SELECT as the reader; the generated password never shows in any message (mutation: print it -> red)", async function () {
    const {log, factory} = fakeClientFactory(SUCCESS_RULES);
    const said = [];
    const secretStore = h.store();
    const result = await createReader({
      connection: {host: HOST, port: 39015, user: USER, password: PASSWORD},
      schema: SCHEMA, readerName: DEFAULT_READER_NAME, yes: true,
      store: secretStore, clientFactory: factory, say: (text) => said.push(text),
    });
    const statements = log.statements.map((s) => s.sql);
    // exact shapes, in order (E1: user unquoted, schema quoted as identifier);
    // the existence-guard SELECT comes first (critic M-B)
    expect(statements[0]).to.equal("SELECT COUNT(*) AS N FROM SYS.USERS WHERE USER_NAME = ?");
    expect(statements[1]).to.match(/^CREATE USER OSD_READER PASSWORD "[A-Za-z0-9]{28}" NO FORCE_FIRST_PASSWORD_CHANGE$/);
    expect(statements[2]).to.equal("ALTER USER OSD_READER DISABLE PASSWORD LIFETIME");
    expect(statements[3]).to.equal(`GRANT SELECT ON SCHEMA "${SCHEMA}" TO OSD_READER`);
    expect(statements.some((s) => s.includes(`FROM "${SCHEMA}"."TADIR"`))).to.equal(true);
    // the password is recoverable only from the one statement that carries it
    // and from the store -- never from the return value (critic M-A)
    const password = /PASSWORD "([^"]+)"/.exec(statements[1])[1];
    expect(result.password).to.equal(undefined);
    expect(result.user).to.equal(DEFAULT_READER_NAME);
    expect(result.schema).to.equal(SCHEMA);
    // the proof ran as the reader, with the reader's own password
    const proofConnection = log.connections.find((c) => c.user === "OSD_READER");
    expect(proofConnection.password).to.equal(password);
    // the generated password: >= 24 chars, upper + lower + digit, nothing to escape
    expect(password.length).to.be.at.least(24);
    expect(password).to.match(/^[A-Za-z0-9]+$/);
    expect(password).to.match(/[A-Z]/).and.to.match(/[a-z]/).and.to.match(/[0-9]/);
    expect(generateReaderPassword()).to.not.equal(generateReaderPassword());
    // and it is in none of the messages, in no thrown error -- only the mask
    const everything = said.join("\n");
    expect(everything).to.not.include(password);
    expect(everything).to.include("***");
    // the secret is stored where the doctor says, keyed by this connection
    expect(said.join("\n")).to.include(secretStore.location(DEFAULT_READER_NAME));
    const adminConnection = {host: HOST, port: 39015, user: USER, password: PASSWORD};
    expect(secretStore.get(readerStoreKey(adminConnection, DEFAULT_READER_NAME)).password).to.equal(password);
    expect(secretStore.get(readerStoreKey(adminConnection, DEFAULT_READER_NAME)).host).to.equal(HOST);
  });

  it("the tenant database reaches EVERY connection of the reader path (critic M-3; mutation: drop databaseName from the proof/drop connect -> red)", async function () {
    // administrator connect, reader proof connect, drop-reader connect:
    // one place builds the options, so all of them must carry the tenant
    // database -- otherwise the proof logs on to the wrong database and
    // drop-reader's 'absence proved' is checked where the user survives
    const {log, factory} = fakeClientFactory(SUCCESS_RULES);
    const connection = {host: HOST, port: 39015, user: USER, password: PASSWORD, database: "TENANT1"};
    const secretStore = h.store();
    await createReader({connection, schema: SCHEMA, yes: true, store: secretStore, clientFactory: factory});
    // and the stored secret names the tenant, so the ownership key can only
    // ever match the same database again
    expect(secretStore.get(readerStoreKey(connection, DEFAULT_READER_NAME)).database).to.equal("TENANT1");
    await dropReader({connection, yes: true, store: secretStore, clientFactory: factory});
    expect(log.connections.length).to.be.at.least(3);
    for (const options of log.connections) {
      expect(options.databaseName, `connect as ${options.user}`).to.equal("TENANT1");
    }
  });

  it("binds catalogue comparisons, never concatenates them (mutation: concatenate -> red)", async function () {
    // the SYS.USERS absence proof of drop-reader takes the reader name as a
    // bound parameter (and the drop below is allowed: the store holds an
    // entry for exactly this connection and name)
    const {log, factory} = fakeClientFactory(SUCCESS_RULES);
    const dropStore = h.store();
    const dropConnection = {host: HOST, port: 39015, user: USER, password: PASSWORD};
    h.seedStore(dropStore, dropConnection);
    await dropReader({
      connection: dropConnection,
      yes: true, store: dropStore, clientFactory: factory,
    });
    const sysUsers = log.statements.find((s) => s.sql.includes("FROM SYS.USERS"));
    expect(sysUsers.sql).to.include("USER_NAME = ?");
    expect(sysUsers.params).to.deep.equal([DEFAULT_READER_NAME]);
    // the schema owner lookup (run when the GRANT is refused) takes the
    // schema as a bound parameter too
    const log2 = fakeClientFactory([
      {match: /CREATE USER/, rows: []},
      {match: /ALTER USER/, rows: []},
      {match: /GRANT SELECT/, error: 258, message: "insufficient privilege"},
      {match: /FROM SYS\.SCHEMAS/, rows: [{OWNER_NAME: "SCHEMA_OWNER_LOGIN"}]},
      {match: /DROP USER/, rows: []},
    ]);
    await createReader({
      connection: {host: HOST, port: 39015, user: USER, password: PASSWORD},
      schema: SCHEMA, yes: true, store: h.store(), clientFactory: log2.factory,
    }).catch(() => {}); // the 258 message is asserted elsewhere
    const schemas = log2.log.statements.find((s) => s.sql.includes("FROM SYS.SCHEMAS"));
    expect(schemas.sql).to.include("UPPER(SCHEMA_NAME) = UPPER(?)");
    expect(schemas.params).to.deep.equal([SCHEMA]);
    expect(schemas.sql).to.not.include(SCHEMA);
  });

  it("M-B: a user that already exists is never CREATEd over and never dropped -- the name-taken message points at --reader-name and --drop-reader (mutation: send CREATE/DROP anyway -> red)", async function () {
    // the catalogue says OSD_READER already exists: somebody else's reader,
    // or ours and in use by a running extract -- the create path must refuse
    // WITHOUT sending CREATE (over somebody's user) and WITHOUT any DROP
    const {log, factory} = fakeClientFactory([
      {match: /FROM SYS\.USERS/, rows: [{N: 1}]},
    ]);
    await createReader({
      connection: {host: HOST, port: 39015, user: USER, password: PASSWORD},
      schema: SCHEMA, yes: true, store: h.store(), clientFactory: factory,
    }).then(
      () => expect.fail("should refuse"),
      (error) => {
        expect(error).to.be.an.instanceof(ReaderError);
        expect(error.message).to.include("taken");
        expect(error.message).to.include("--reader-name");
        expect(error.message).to.include("--drop-reader");
        expect(error.message).to.not.include("dropped");
      });
    expect(log.statements.some((s) => s.sql.startsWith("CREATE USER"))).to.equal(false);
    expect(log.statements.some((s) => s.sql.startsWith("DROP USER"))).to.equal(false);
  });

  it("M-B: a failed CREATE USER sends NO DROP for any failure of the CREATE itself -- 331, 412, anything (mutation: drop on CREATE failure -> red)", async function () {
    // 331 = the name existed after all (the pre-create check raced): still
    // nobody this run created, so still no DROP
    const cases = [
      {error: 331, message: "user name already exists: OSD_READER", expect: ["taken"]},
      {error: 412, message: "password policy violation", expect: ["412", "password policy"]},
      {error: 421, message: "the create failed", expect: ["created nothing"]},
    ];
    for (const {error, message, expect: expected} of cases) {
      const {log, factory} = fakeClientFactory([
        {match: /FROM SYS\.USERS/, rows: [{N: 0}]},
        {match: /CREATE USER/, error, message},
        {match: /DROP USER/, rows: []},
      ]);
      await createReader({
        connection: {host: HOST, port: 39015, user: USER, password: PASSWORD},
        schema: SCHEMA, yes: true, store: h.store(), clientFactory: factory,
      }).then(
        () => expect.fail("should refuse"),
        (caught) => {
          expect(caught).to.be.an.instanceof(ReaderError);
          expect(caught.message).to.not.include("dropped");
          for (const part of expected) expect(caught.message).to.include(part);
        });
      expect(log.statements.some((s) => s.sql.startsWith("DROP USER"))).to.equal(false, `error ${error} must not drop`);
    }
  });

  it("M-B: 331 gets the name-taken message; 412 gets the password-policy message (the generator's alphabet never satisfies a special-character policy)", async function () {
    const {factory} = fakeClientFactory([
      {match: /FROM SYS\.USERS/, rows: [{N: 0}]},
      {match: /CREATE USER/, error: 331, message: "user name already exists"},
    ]);
    await createReader({
      connection: {host: HOST, port: 39015, user: USER, password: PASSWORD},
      schema: SCHEMA, yes: true, store: h.store(), clientFactory: factory,
    }).then(
      () => expect.fail("should refuse"),
      (error) => {
        expect(error.message).to.include("taken");
        expect(error.message).to.include("--reader-name");
        expect(error.message).to.include("--drop-reader");
      });
    const {factory: f2} = fakeClientFactory([
      {match: /FROM SYS\.USERS/, rows: [{N: 0}]},
      {match: /CREATE USER/, error: 412, message: "password policy violation"},
    ]);
    await createReader({
      connection: {host: HOST, port: 39015, user: USER, password: PASSWORD},
      schema: SCHEMA, yes: true, store: h.store(), clientFactory: f2,
    }).then(
      () => expect.fail("should refuse"),
      (error) => {
        expect(error.message).to.include("412");
        expect(error.message).to.include("password policy");
        expect(error.message).to.not.include(PASSWORD);
      });
  });

  it("explains 258 on CREATE USER and sends no DROP (nothing was created)", async function () {
    const {log, factory} = fakeClientFactory([
      {match: /CREATE USER/, error: 258, message: "insufficient privilege"},
    ]);
    await createReader({
      connection: {host: HOST, port: 39015, user: USER, password: PASSWORD},
      schema: SCHEMA, yes: true, store: h.store(), clientFactory: factory,
    }).then(
      () => expect.fail("should refuse"),
      (error) => {
        expect(error).to.be.an.instanceof(ReaderError);
        expect(error.message).to.include("may not create users");
        expect(error.message).to.include("USER ADMIN");
        expect(error.message).to.include("READ ONLY");
      });
    expect(log.statements.some((s) => s.sql.startsWith("DROP USER"))).to.equal(false);
  });

  it("explains 258 on GRANT, names the schema owner, and drops the reader it had created (mutation: no cleanup -> red)", async function () {
    const {log, factory} = fakeClientFactory([
      {match: /CREATE USER/, rows: []},
      {match: /ALTER USER/, rows: []},
      {match: /GRANT SELECT/, error: 258, message: "insufficient privilege"},
      {match: /FROM SYS\.SCHEMAS/, rows: [{OWNER_NAME: "SCHEMA_OWNER_LOGIN"}]},
      {match: /DROP USER/, rows: []},
    ]);
    await createReader({
      connection: {host: HOST, port: 39015, user: USER, password: PASSWORD},
      schema: SCHEMA, yes: true, store: h.store(), clientFactory: factory,
    }).then(
      () => expect.fail("should refuse"),
      (error) => {
        expect(error).to.be.an.instanceof(ReaderError);
        expect(error.message).to.include("may not grant the schema");
        expect(error.message).to.include("SCHEMA_OWNER_LOGIN");
      });
    expect(log.statements.some((s) => s.sql.startsWith("DROP USER OSD_READER CASCADE"))).to.equal(true);
  });

  it("drops the reader on a later failure and reports the real cause (mutation: keep the half reader -> red)", async function () {
    const {log, factory} = fakeClientFactory([
      {match: /CREATE USER/, rows: []},
      {match: /ALTER USER/, error: 421, message: "phase failed"},
      {match: /DROP USER/, rows: []},
    ]);
    await createReader({
      connection: {host: HOST, port: 39015, user: USER, password: PASSWORD},
      schema: SCHEMA, yes: true, store: h.store(), clientFactory: factory,
    }).then(
      () => expect.fail("should refuse"),
      (error) => {
        expect(error).to.be.an.instanceof(ReaderError);
        expect(error.message).to.include("421");
        expect(error.message).to.include("dropped again");
      });
    expect(log.statements.some((s) => s.sql.startsWith("DROP USER OSD_READER CASCADE"))).to.equal(true);
  });

  it("a failed CREATE USER drops nothing and says the reader was not touched -- 'user absent' belongs to the cleanup of failures AFTER a successful create (mutation: drop on CREATE failure -> red)", async function () {
    // the old behaviour ran DROP USER after ANY CREATE failure (and read a
    // 332 from it as "user absent"): M-B forbids the DROP outright -- this
    // run created no user, so it may remove none
    const {log, factory} = fakeClientFactory([
      {match: /CREATE USER/, error: 421, message: "the create failed"},
      {match: /DROP USER/, error: 332, message: "invalid user name"},
    ]);
    await createReader({
      connection: {host: HOST, port: 39015, user: USER, password: PASSWORD},
      schema: SCHEMA, yes: true, store: h.store(), clientFactory: factory,
    }).then(
      () => expect.fail("should refuse"),
      (error) => {
        expect(error.message).to.include("the create failed");
        expect(error.message).to.include("created nothing");
        expect(error.message).to.not.include("dropped");
      });
    expect(log.statements.some((s) => s.sql.startsWith("DROP USER"))).to.equal(false);
  });

  it("enforces the secret file modes: dir 0700, file 0600, fchmod even when they existed (mutation: drop fchmod -> red)", function () {
    const dir = join(h.root, `modes-${Math.random().toString(16).slice(2)}`);
    const secretPath = join(dir, "reader-secret.json");
    // a loose pre-existing store: the store must tighten it, not keep it
    mkdirSync(dir, {recursive: true, mode: 0o755});
    writeFileSync(secretPath, `{"OTHER": {"x": 1}}\n`, {mode: 0o644});
    chmodSync(secretPath, 0o644);
    const s = fileSecretStore(dir);
    s.set({user: "OSD_READER", password: "not-a-real-password-42"}, "OSD_READER");
    expect(statSync(dir).mode & 0o777).to.equal(0o700);
    expect(statSync(secretPath).mode & 0o777).to.equal(0o600);
    expect(s.get("OSD_READER").password).to.equal("not-a-real-password-42");
    expect(s.get("OTHER")).to.deep.equal({x: 1});
    s.delete("OSD_READER");
    expect(s.get("OSD_READER")).to.equal(undefined);
    expect(s.get("OTHER")).to.deep.equal({x: 1}); // another reader's secret stays
  });

  it("drop-reader: DROP ... CASCADE, absence proved, secret removed (mutation: skip store.delete -> red)", async function () {
    const {log, factory} = fakeClientFactory(SUCCESS_RULES);
    const secretStore = h.store();
    const connection = {host: HOST, port: 39015, user: USER, password: PASSWORD};
    h.seedStore(secretStore, connection);
    const said = [];
    const result = await dropReader({
      connection,
      readerName: DEFAULT_READER_NAME, yes: true, store: secretStore,
      clientFactory: factory, say: (text) => said.push(text),
    });
    expect(result.dropped).to.equal(true);
    expect(result.absent).to.equal(true);
    expect(log.statements.some((s) => s.sql === "DROP USER OSD_READER CASCADE")).to.equal(true);
    expect(log.statements.some((s) => s.sql.includes("FROM SYS.USERS"))).to.equal(true);
    expect(secretStore.get(readerStoreKey(connection, DEFAULT_READER_NAME))).to.equal(undefined);
    expect(said.join("\n")).to.include("absence proved");
  });

  it("drop-reader on an absent user: 332 is fine, the secret still goes", async function () {
    const {log, factory} = fakeClientFactory([
      {match: /DROP USER/, error: 332, message: "invalid user name"},
      {match: /FROM SYS\.USERS/, rows: [{N: 0}]},
    ]);
    const secretStore = h.store();
    const connection = {host: HOST, port: 39015, user: USER, password: PASSWORD};
    h.seedStore(secretStore, connection);
    const result = await dropReader({
      connection,
      yes: true, store: secretStore, clientFactory: factory,
    });
    expect(result.dropped).to.equal(false);
    expect(result.absent).to.equal(true);
    expect(secretStore.get(readerStoreKey(connection, DEFAULT_READER_NAME))).to.equal(undefined);
  });

  it("M-A: --create-reader --yes --json reports {user, schema, stored_at} and the generated password is in no output (mutation: return the password -> red)", async function () {
    // the documented machine-readable path is the one a CI log captures: the
    // generated password must be in NONE of it -- the store is its only sink
    const {log, factory} = fakeClientFactory(SUCCESS_RULES);
    const secretStore = h.store();
    const code = await h.runDoctor(["--create-reader", "--yes", "--json"], {
      scenario: "owner-tenant",
      deps: {clientFactory: factory, store: secretStore},
    });
    expect(code, h.allText()).to.equal(0);
    const create = log.statements.find((s) => s.sql.startsWith("CREATE USER"));
    const password = /PASSWORD "([^"]+)"/.exec(create.sql)[1];
    expect(password).to.be.a("string").with.length.at.least(24);
    // the password that went on the wire: not in stdout, not in stderr, not
    // in the JSON document
    expect(h.allText()).to.not.include(password);
    const document = JSON.parse(h.out.find((l) => l.trimStart().startsWith("{")));
    expect(JSON.stringify(document.reader)).to.not.include(password);
    expect(document.reader.user).to.equal(DEFAULT_READER_NAME);
    expect(document.reader.schema).to.equal(SCHEMA);
    expect(document.reader.stored_at).to.be.a("string");
    // and the value --json reported is exactly what the store holds
    const stored = secretStore.get(readerStoreKey({host: HOST, port: 39015}, DEFAULT_READER_NAME));
    expect(stored.password).to.equal(password);
    expect(document.reader.stored_at).to.equal(stored.stored_at);
  });

  it("through the doctor: --create-reader runs the whole path and exits 0", async function () {
    const {log, factory} = fakeClientFactory(SUCCESS_RULES);
    const secretStore = h.store();
    const code = await h.runDoctor(["--create-reader", "--yes"], {
      scenario: "owner-tenant",
      deps: {clientFactory: factory, store: secretStore},
    });
    expect(code).to.equal(0);
    expect(log.statements.some((s) => s.sql.startsWith("CREATE USER"))).to.equal(true);
    // the stored secret is keyed by this connection (host, port, database, name)
    expect(secretStore.get(readerStoreKey({host: HOST, port: 39015}, DEFAULT_READER_NAME))).to.not.equal(undefined);
  });

  it("the env file feeds the connection, unknown keys are refused", function () {
    const envPath = join(h.root, "bed.env");
    writeFileSync(envPath, ["# a test bed", "HANA_HOST=bed.example.test", "HANA_PORT=39015", "HANA_DATABASE=TEN", "HANA_USER=BEDUSER", "HANA_PASSWORD=bed-password-1", "HANA_SCHEMA=BEDSCHEMA"].join("\n"));
    const {flags} = parseFlags(["--env-file", envPath], {valueFlags: ["env-file"], booleanFlags: []});
    expect(flags["env-file"]).to.equal(envPath);
    const badPath = join(h.root, "bad.env");
    writeFileSync(badPath, "HANA_HOSTNAME=x\n");
    expect(() => readEnvFile(badPath)).to.throw(UsageError);
    expect(() => readEnvFile(join(h.root, "no-such.env"))).to.throw(UsageError);
  });
});
