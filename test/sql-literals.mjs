import {expect} from "chai";
import {createRequire} from "node:module";
import {abapSelectToSql, outsideLiterals, splitLiterals} from "../tools/osd-sql-literals.mjs";
import {trimLiterals} from "../tools/sql-literals.mjs";
import {giveBackHdb} from "./hdb-stub.mjs";
import {HanaDatabaseClient} from "../tools/hana-client.mjs";
import {DuckDBDatabaseClient} from "../tools/duckdb-client.mjs";
import {FileSqliteClient} from "../tools/sqlite-file-client.mjs";
import {SQLiteDatabaseClient} from "../tools/sqlite-heap-client.mjs";
import {OsdPostgresClient} from "../tools/postgres-client.mjs";
import {rewritePreview} from "../tools/adt-single-select.mjs";
import {readQuery} from "../web/preview-runtime.mjs";

// A literal in a statement is a value, for every rewrite after the escaper
// as well (ANORMALIES.md, "SQL literals re-read as statement text"). Each
// value below was changed by the rewrites the clients ran over the whole
// statement, and beside it is what it was changed into: a client that still
// reads the value answers the decoy's row instead of none.
const VALUES = ["a~b", "A EQ B", "x DESCENDING", "x UP TO 9 ROWS", "x LIMIT 0", "q <ls_key> r",
  "O'Hara", "a`b", "--x", "a;b", "LEFT(name, 1)"];
const DECOYS = ["a.b", "A = B", "x DESC", "x", "substr(name, 1, 1)"];
const sqlText = (v) => "'" + v.replace(/'/g, "''") + "'";
// the statement as the runtime hands it to a client
const selectOf = (v, tail = "") => `SELECT b~name FROM zosd_lit AS b WHERE b~name = ${sqlText(v)} ORDER BY b~name DESCENDING${tail}`;

describe("SQL literals stay verbatim: no rewrite reads inside a quoted literal", function () {
  this.timeout(20000);

  describe("the helper", () => {
    it("rewrites the code and puts every literal back byte for byte", () => {
      for (const v of VALUES) {
        const sql = abapSelectToSql(selectOf(v, " UP TO 5 ROWS"), {substr: true});
        expect(sql).to.equal(`SELECT b.name FROM zosd_lit AS b WHERE b.name = ${sqlText(v)} ORDER BY b.name DESC LIMIT 5`);
      }
    });

    it("UP TO n ROWS inside a value adds no LIMIT", () => {
      expect(abapSelectToSql("SELECT * FROM t WHERE a = 'x UP TO 9 ROWS' OR a <> 'zz'"))
        .to.equal("SELECT * FROM t WHERE a = 'x UP TO 9 ROWS' OR a <> 'zz'");
    });

    it("$ patterns and an unterminated literal are data", () => {
      expect(outsideLiterals("a~b = '$1 $& $''' AND c~d = 'x~", (s) => s.replace(/~/g, ".")))
        .to.equal("a.b = '$1 $& $''' AND c.d = 'x~");
    });

    it("splits single-quoted literals and, when asked, backtick ones", () => {
      expect(splitLiterals("a = `x'y` AND b = 'p``q'", "'`").map((s) => s.text))
        .to.deep.equal(["a = ", "`x'y`", " AND b = ", "'p``q'"]);
    });

    it("trimLiterals reads the same literals and still trims", () => {
      expect(trimLiterals("a = 'x  ' AND b = 'it''s  ' AND c = '' AND d = 'open  "))
        .to.equal("a = 'x' AND b = 'it''s' AND c = '' AND d = 'open  ");
    });

    it("is linear in the length of a literal", () => {
      const sql = "SELECT * FROM t AS b WHERE b~a = '" + "a ''".repeat(70000) + "'";
      const start = Date.now();
      expect(abapSelectToSql(sql, {substr: true})).to.equal(sql.replace("b~a", "b.a"));
      expect(Date.now() - start).to.be.below(1000);
    });

    it("the ADT data preview's rewrite leaves values alone", () => {
      expect(rewritePreview("SELECT b~a FROM t AS b WHERE b~a = 'a~b DESCENDING'"))
        .to.equal("SELECT b.a FROM t AS b WHERE b.a = 'a~b DESCENDING'");
    });
  });

  // every engine the tree carries: the row found is exactly the row whose
  // column holds the value
  const engines = [
    ["SQLite (sql.js, the default and the preview)", async () => {
      const db = new SQLiteDatabaseClient();
      await db.connect();
      return db;
    }],
    ["SQLite file (node:sqlite)", async () => {
      const db = new FileSqliteClient();
      await db.connect();
      return db;
    }],
    ["DuckDB", async () => {
      const db = new DuckDBDatabaseClient();
      await db.connect();
      return db;
    }],
  ];
  for (const [name, open] of engines) {
    describe(name, () => {
      let db;
      let previous;
      before(async () => {
        previous = globalThis.abap;
        globalThis.abap ??= {Classes: {}, context: {databaseConnections: {}}};
        db = await open();
        await db.execute("CREATE TABLE zosd_lit (name VARCHAR(40));");
        for (const v of [...VALUES, ...DECOYS]) await db.execute(`INSERT INTO zosd_lit (name) VALUES (${sqlText(v)});`);
      });
      after(async () => {
        try { await db.disconnect(); } finally { globalThis.abap = previous; }
      });

      it("each value finds exactly its own row", async () => {
        for (const v of VALUES) {
          const {rows} = await db.select({select: selectOf(v)});
          expect(rows.map((r) => r.name), v).to.deep.equal([v]);
        }
      });

      it("UP TO n ROWS in a value limits nothing; UP TO in the code still does", async () => {
        const all = VALUES.length + DECOYS.length;
        let {rows} = await db.select({select: "SELECT b~name FROM zosd_lit AS b WHERE b~name = 'x UP TO 1 ROWS' OR b~name <> 'zz'"});
        expect(rows.length).to.equal(all);
        ({rows} = await db.select({select: "SELECT b~name FROM zosd_lit AS b WHERE b~name <> 'x UP TO 1 ROWS' UP TO 2 ROWS"}));
        expect(rows.length).to.equal(2);
      });

      it("a cursor reads the value as written too", async () => {
        const cursor = await db.openCursor({select: selectOf("x UP TO 9 ROWS")});
        const {rows} = await cursor.fetchNextCursor(1);
        await cursor.closeCursor();
        expect(rows.map((r) => r.name)).to.deep.equal(["x UP TO 9 ROWS"]);
      });
    });
  }

  describe("HANA (the driver channel, a stand-in driver)", () => {
    afterEach(giveBackHdb);
    const fakeHdb = () => {
      const sent = [];
      const require = createRequire(import.meta.url);
      const path = require.resolve("hdb");
      require.cache[path] = {
        id: path, filename: path, loaded: true,
        exports: {createClient: () => ({
          connect: (cb) => cb(undefined),
          setAutoCommit: () => undefined,
          exec: (sql, cb) => { sent.push(sql); cb(undefined, /^\s*SELECT/i.test(sql) ? [] : 1); },
          commit: (cb) => cb(undefined),
          rollback: (cb) => cb(undefined),
          end: () => undefined,
        })},
      };
      return sent;
    };

    it("the SQL handed to the driver holds every literal byte for byte, and no LIMIT a value chose", async () => {
      const sent = fakeHdb();
      const db = new HanaDatabaseClient({existingSchema: true, schema: "ZOSD_LIT", client: "001"});
      await db.connect();
      for (const v of VALUES) {
        sent.length = 0;
        await db.select({select: selectOf(v)});
        const sql = sent.find((s) => /^\s*SELECT/i.test(s));
        expect(sql, v).to.include(`= ${sqlText(v)}`);
        expect(sql, v).to.match(/ORDER BY B\.NAME DESC$|ORDER BY b\.name DESC$/i);
        if (v.includes("UP TO")) expect(sql, v).to.not.match(/LIMIT/);
      }
      await db.disconnect();
    });
  });

  describe("PostgreSQL (the query channel, no server)", () => {
    it("select sends every literal byte for byte and no LIMIT a value chose", async () => {
      const db = new OsdPostgresClient({password: "x"});
      const sent = [];
      db.query = async (sql) => { sent.push(sql); return {rows: []}; };
      db.pool = {};
      for (const v of VALUES) {
        sent.length = 0;
        await db.select({select: selectOf(v)});
        expect(sent).to.deep.equal([`SELECT b.name FROM zosd_lit AS b WHERE b.name = ${sqlText(v)} ORDER BY b.name DESC`]);
      }
    });

    it("a cursor does the same, whether the published client or this one reads it", async () => {
      const db = new OsdPostgresClient({password: "x"});
      const sent = [];
      db.pool = {};
      db.client = {query: async (sql) => { sent.push(sql); return {rows: []}; }};
      db.query = async (sql) => { sent.push(sql); return {rows: []}; };
      for (const v of ["a~b", "x UP TO 9 ROWS"]) {
        sent.length = 0;
        const cursor = await db.openCursor({select: `SELECT name FROM zosd_lit WHERE name = ${sqlText(v)} UP TO 3 ROWS`});
        await cursor.closeCursor();
        expect(sent).to.deep.equal([`SELECT name FROM zosd_lit WHERE name = ${sqlText(v)} LIMIT 3`]);
      }
    });
  });

  describe("the browser preview's SQL console", () => {
    it("reads UP TO off the code, not off a value", async () => {
      const seen = [];
      const client = {select: async ({select}) => { seen.push(select); return {rows: []}; }};
      await readQuery(client, "SELECT name FROM t WHERE name = 'x up to 1 rows'", 50);
      expect(seen[0]).to.equal("SELECT * FROM (SELECT name FROM t WHERE name = 'x up to 1 rows') AS osd_preview LIMIT 50");
    });
  });
});
