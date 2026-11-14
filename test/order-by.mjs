// The commas of a dynamic ORDER BY (tools/osd-order-by.mjs, ANORMALIES
// "dynamic-order-by-blanks"): the clause bodies Open SQL accepts, the
// SELECT texts the runtime hands a client, and one real SQLite client that
// refuses the blank-separated form without the wrapper and sorts with it.
import assert from "node:assert/strict";
import {orderByList, orderByWithCommas, installOrderByCommas} from "../tools/osd-order-by.mjs";
import runtime from "@abaplint/runtime";
import {SQLiteDatabaseClient} from "../tools/sqlite-heap-client.mjs";

describe("dynamic ORDER BY: blank-separated columns get their commas", () => {
  it("f1 f2", () => {
    assert.equal(orderByList("so_id so_item_pos"), "so_id, so_item_pos");
  });

  it("f1 DESCENDING f2: a direction stays with its column", () => {
    assert.equal(orderByList("name DESCENDING id"), "name DESCENDING, id");
    assert.equal(orderByList(" a ASCENDING  b DESCENDING "), "a ASCENDING, b DESCENDING");
  });

  it("a~f1 b~f2", () => {
    assert.equal(orderByList("s~SO_ID i~SO_ITEM_POS"), "s~SO_ID, i~SO_ITEM_POS");
  });

  it("already comma-separated: unchanged, a mixed one completed", () => {
    assert.equal(orderByList("a, b DESCENDING"), "a, b DESCENDING");
    assert.equal(orderByList("a,b c"), "a, b, c");
  });

  it("PRIMARY KEY, one column and anything not a plain list pass unchanged", () => {
    assert.equal(orderByList("PRIMARY KEY"), "PRIMARY KEY");
    assert.equal(orderByList("a DESCENDING"), "a DESCENDING");
    assert.equal(orderByList("\"a\" , \"b\""), "\"a\" , \"b\"");
    assert.equal(orderByList("upper( a ) b"), "upper( a ) b");
  });

  it("only the trailing clause of a SELECT, literals and UP TO left alone", () => {
    assert.equal(orderByWithCommas("SELECT a FROM t WHERE x = ' ORDER BY y z' UP TO 5 ROWS ORDER BY a b"),
      "SELECT a FROM t WHERE x = ' ORDER BY y z' UP TO 5 ROWS ORDER BY a, b");
    assert.equal(orderByWithCommas("SELECT a FROM t ORDER BY a DESC b LIMIT 3"), "SELECT a FROM t ORDER BY a DESC, b LIMIT 3");
    assert.equal(orderByWithCommas("SELECT a FROM t ORDER BY PRIMARY KEY"), "SELECT a FROM t ORDER BY PRIMARY KEY");
    assert.equal(orderByWithCommas("SELECT a FROM t WHERE b = 'c d'"), "SELECT a FROM t WHERE b = 'c d'");
  });

  it("a real SQLite client: refused without, sorted with", async () => {
    const previous = globalThis.abap;
    globalThis.abap = new runtime.ABAP();
    const make = async () => {
      const db = new SQLiteDatabaseClient();
      await db.connect();
      await db.execute("CREATE TABLE zt (grp TEXT, id TEXT); INSERT INTO zt VALUES ('B','1'),('A','2'),('A','1');");
      return db;
    };
    const select = "SELECT zt~grp, zt~id FROM zt ORDER BY zt~grp zt~id DESCENDING";
    try {
      const bare = await make();
      await assert.rejects(() => bare.select({select}));
      const wrapped = installOrderByCommas(await make());
      const {rows} = await wrapped.select({select});
      assert.deepEqual(rows.map((r) => `${r.grp}${r.id}`), ["A2", "A1", "B1"]);
    } finally {
      globalThis.abap = previous;
    }
  });
});
