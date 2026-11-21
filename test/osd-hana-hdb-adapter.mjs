// tools/osd-hana/hdb-adapter.mjs held to the REAL `hdb` module.
//
// The reader once called `hdb.createConnection` (hdb has no such export) and
// passed bind parameters as `client.exec`'s options argument; every reader
// test injected a fake that spoke the same invented API, so they were green
// against nothing. The rule here is the recorded-probe rule: the fake may not
// invent. The fake driver below is a Proxy that refuses any member the
// installed hdb's Client / Statement prototypes do not have, so an adapter
// that calls an invented method fails here, not on a customer's database.
// No database: the only socket opened is a connect to a port nobody listens on.
import {expect} from "chai";
import {createRequire} from "node:module";
import {createServer} from "node:net";

import hdb from "hdb";
import {CONNECTION_FAILED, hdbClientFactory, mapHdbError, toResult} from "../tools/osd-hana/hdb-adapter.mjs";

const require = createRequire(import.meta.url);
const Statement = require("hdb/lib/protocol/Statement.js");
const SqlError = require("hdb/lib/protocol/data/SqlError.js");

/** Every member reachable on an instance of the real class (own + inherited). */
function realMembers(proto) {
  const names = new Set();
  for (let p = proto; p !== null && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const name of Object.getOwnPropertyNames(p)) names.add(name);
  }
  return names;
}
const CLIENT_MEMBERS = realMembers(hdb.Client.prototype);
const STATEMENT_MEMBERS = realMembers(Statement.prototype);

/** A fake object that may only be asked for what the real prototype has. */
function strict(kind, allowed, impl, calls) {
  return new Proxy(impl, {
    get(target, name) {
      if (typeof name !== "string" || name === "then") return target[name];
      if (!allowed.has(name)) throw new Error(`the fake ${kind} was asked for "${name}", which the installed hdb ${kind} does not have`);
      if (!(name in target)) throw new Error(`test fake ${kind} lacks "${name}" (real hdb has it; script it)`);
      const value = target[name];
      return typeof value === "function" ? (...args) => { calls.push(`${kind}.${name}`); return value.apply(target, args); } : value;
    },
  });
}

/** A driver whose createClient is the real export's NAME and whose objects
 *  answer only to real member names. `script` decides the callbacks. */
function strictDriver(script = {}) {
  const calls = [];
  const created = [];
  const driver = {
    createClient(options) {
      created.push(options);
      const statement = strict("Statement", STATEMENT_MEMBERS, {
        exec: (values, cb) => setImmediate(() => cb(script.stmtError ?? null, script.stmtResult ?? [{N: values.length}])),
        drop: (cb) => setImmediate(() => cb(null)),
      }, calls);
      return strict("Client", CLIENT_MEMBERS, {
        on: () => {},
        connect: (cb) => setImmediate(() => cb(script.connectError ?? null)),
        exec: (sql, cb) => {
          if (typeof cb !== "function") throw new Error("exec's second argument is OPTIONS in hdb; the adapter must not pass parameters there");
          setImmediate(() => cb(script.execError ?? null, script.execResult ?? []));
        },
        prepare: (sql, cb) => setImmediate(() => cb(script.prepareError ?? null, statement)),
        disconnect: (cb) => setImmediate(() => cb(null)),
        close: () => {},
      }, calls);
    },
  };
  // the driver itself may only expose what the real module exports
  for (const name of Object.keys(driver)) {
    if (typeof hdb[name] !== "function") throw new Error(`the fake driver exports "${name}", which hdb does not`);
  }
  return {driver, calls, created};
}

async function deadPort() {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const {port} = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

describe("tools/osd-hana: the hdb adapter against the real driver", function () {
  describe("the installed hdb has the API the adapter calls (the fake may not invent)", function () {
    it("exports createClient and NOT createConnection (the defect this module fixes)", function () {
      expect(hdb.createClient).to.be.a("function");
      expect(hdb).to.not.have.property("createConnection");
    });

    it("a real Client has connect, exec, prepare, disconnect, close and on", function () {
      const client = hdb.createClient({host: "127.0.0.1", port: 1});
      for (const name of ["connect", "exec", "prepare", "disconnect", "close", "on"]) {
        expect(client[name], name).to.be.a("function");
      }
    });

    it("a real Statement has exec and drop", function () {
      expect(Statement.prototype.exec).to.be.a("function");
      expect(Statement.prototype.drop).to.be.a("function");
    });

    it("a database error read off the wire carries a NUMERIC code (258 stays 258)", function () {
      const message = "insufficient privilege";
      const buffer = Buffer.alloc(32 + message.length);
      buffer.writeInt32LE(258, 0);
      buffer.writeInt32LE(0, 4);
      buffer.writeInt32LE(message.length, 8);
      buffer.writeInt8(1, 12);
      buffer.write("HY000", 13, "ascii");
      buffer.write(message, 18, "utf8");
      const error = SqlError.read({buffer});
      expect(error.code).to.equal(258);
      expect(error.message).to.equal(message);
      expect(mapHdbError(error)).to.equal(error);
    });
  });

  describe("the adapter's calls, through a fake that answers only to real names", function () {
    it("connects through createClient with the options as given (databaseName, TLS)", async function () {
      const {driver, calls, created} = strictDriver();
      const options = {host: "h", port: 30015, user: "U", password: "P", databaseName: "TEN", useTLS: true, ca: "PEM", servername: "n"};
      const client = await hdbClientFactory({driver})(options);
      expect(created).to.deep.equal([options]);
      expect(calls).to.include("Client.connect");
      await client.disconnect();
      expect(calls.slice(-2)).to.deep.equal(["Client.disconnect", "Client.close"]);
    });

    it("a statement WITHOUT parameters goes through client.exec(sql, cb); a count is no rows", async function () {
      const {driver, calls} = strictDriver({execResult: 1});
      const client = await hdbClientFactory({driver})({});
      expect(await client.exec("DROP USER OSD_X CASCADE")).to.deep.equal({rows: []});
      expect(calls).to.include("Client.exec");
      expect(calls).to.not.include("Client.prepare");
    });

    it("a statement WITH parameters is prepared, executed with the values, and dropped (mutation: params to client.exec -> red)", async function () {
      const {driver, calls} = strictDriver({stmtResult: [{N: 0}]});
      const client = await hdbClientFactory({driver})({});
      const result = await client.exec("SELECT COUNT(*) AS N FROM SYS.USERS WHERE USER_NAME = ?", ["OSD_READER"]);
      expect(result).to.deep.equal({rows: [{N: 0}]});
      expect(calls).to.deep.equal(["Client.on", "Client.connect", "Client.prepare", "Statement.exec", "Statement.drop"]);
    });

    it("the statement is dropped even when its execution fails, and the error keeps its number", async function () {
      const {driver, calls} = strictDriver({stmtError: Object.assign(new Error("insufficient privilege"), {code: 258})});
      const client = await hdbClientFactory({driver})({});
      const error = await client.exec("SELECT ? FROM DUMMY", [1]).then(() => undefined, (e) => e);
      expect(error.code).to.equal(258);
      expect(calls).to.include("Statement.drop");
    });

    it("a driver failure on connect becomes CONNECTION_FAILED with the driver's code kept", async function () {
      const {driver} = strictDriver({connectError: Object.assign(new Error("Could not connect to any host"), {code: "EHDBOPENCONN"})});
      const error = await hdbClientFactory({driver})({}).then(() => undefined, (e) => e);
      expect(error.code).to.equal(CONNECTION_FAILED);
      expect(error.driverCode).to.equal("EHDBOPENCONN");
      expect(error.message).to.include("Could not connect");
    });
  });

  describe("the mapping", function () {
    it("numbers pass, string codes become CONNECTION_FAILED, codeless errors stay as thrown", function () {
      const db = Object.assign(new Error("x"), {code: 332});
      expect(mapHdbError(db)).to.equal(db);
      const net = mapHdbError(Object.assign(new Error("connect ECONNREFUSED"), {code: "ECONNREFUSED"}));
      expect(net.code).to.equal(CONNECTION_FAILED);
      expect(net.driverCode).to.equal("ECONNREFUSED");
      const bug = new TypeError("boom");
      expect(mapHdbError(bug)).to.equal(bug);
    });

    it("toResult: rows stay rows, a count is none", function () {
      expect(toResult([{A: 1}])).to.deep.equal({rows: [{A: 1}]});
      expect(toResult(3)).to.deep.equal({rows: []});
      expect(toResult(undefined)).to.deep.equal({rows: []});
    });
  });

  describe("the REAL driver, no database", function () {
    it("connect to a port nobody listens on comes back as CONNECTION_FAILED (the doctor's exit-2 path)", async function () {
      this.timeout(20000);
      const port = await deadPort();
      const error = await hdbClientFactory()({host: "127.0.0.1", port, user: "U", password: "P"}).then(() => undefined, (e) => e);
      expect(error, "a connect to a dead port must fail").to.be.an("error");
      expect(error.code).to.equal(CONNECTION_FAILED);
      expect(error.driverCode).to.be.a("string").and.match(/^E/);
      expect(error.message).to.include(String(port));
    });
  });
});
