import {expect} from "chai";
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {PIPELINE, prune, seedImage, seedImageKey} from "../tools/osd-seed-image.mjs";
import {SQLiteDatabaseClient} from "../tools/sqlite-heap-client.mjs";

const SCHEMA = "CREATE TABLE zt (id NCHAR(4), val NCHAR(10));";
const INSERT = ["INSERT INTO zt VALUES ('0001', 'seeded');"];

describe("the memory database's seed image (tools/osd-seed-image.mjs)", function () {
  this.timeout(30000);
  let root, base, priorAbap;
  before(() => { priorAbap = globalThis.abap; globalThis.abap ??= {}; });
  after(() => { globalThis.abap = priorAbap; });
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "osd-seed-image-"));
    base = join(root, "base");
    for (const file of PIPELINE) {
      mkdirSync(dirname(join(root, file)), {recursive: true});
      cpSync(resolve(file), join(root, file));
    }
  });
  afterEach(() => rmSync(root, {recursive: true, force: true}));
  const env = () => ({OSD_ROOT: root, STG_DB_BASE: base});
  const seeded = async (image) => {
    const db = new SQLiteDatabaseClient();
    await db.connect();
    await db.execute(SCHEMA);
    await db.execute(INSERT);
    image.save(db);
    return db;
  };

  describe("the key names the code that decides the stored values", () => {
    for (const file of PIPELINE) {
      it(`changes when ${file} changes`, () => {
        const before = seedImageKey(root, SCHEMA, INSERT);
        writeFileSync(join(root, file), readFileSync(join(root, file), "utf8") + "\n// changed\n");
        expect(seedImageKey(root, SCHEMA, INSERT)).not.to.equal(before);
      });
    }
    it("has no image when a pipeline file is missing", () => {
      rmSync(join(root, "tools", "sql-literals.mjs"));
      expect(seedImage(SCHEMA, INSERT, env())).to.equal(undefined);
    });
  });

  describe("an image is used only after it proves itself", () => {
    it("loads a sound image with its rows and without the stamp", async () => {
      const image = seedImage(SCHEMA, INSERT, env());
      await seeded(image);
      expect(existsSync(image.file)).to.equal(true);
      const db = new SQLiteDatabaseClient();
      expect(await image.load(db)).to.equal(true);
      expect(db.sqlite.exec("SELECT val FROM zt")[0].values).to.deep.equal([["seeded"]]);
      expect(db.sqlite.exec("PRAGMA user_version")[0].values[0][0]).to.equal(0);
    });
    const damaged = {
      "an empty file": () => Buffer.alloc(0),
      "bytes that are not a database": () => Buffer.from("not a database at all, just bytes".repeat(200)),
      "a truncated image": (good) => good.subarray(0, Math.floor(good.length / 2)),
      "a sound database without this key's stamp": (good, plain) => plain,
    };
    for (const [what, make] of Object.entries(damaged)) {
      it(`treats ${what} as a miss, removes it and leaves a clean connection`, async () => {
        const image = seedImage(SCHEMA, INSERT, env());
        const plain = Buffer.from((await seeded({save() {}})).export());
        await seeded(image);
        const good = readFileSync(image.file);
        writeFileSync(image.file, make(good, plain));
        const db = new SQLiteDatabaseClient();
        let loaded;
        const said = console.error;
        console.error = () => {};
        try { loaded = await image.load(db); } finally { console.error = said; }
        expect(loaded).to.equal(false);
        expect(existsSync(image.file)).to.equal(false);
        await db.connect();
        expect(db.sqlite.exec("SELECT name FROM sqlite_master")).to.deep.equal([]);
      });
    }
  });

  it("keeps the newest images and drops stale temporaries", () => {
    mkdirSync(base, {recursive: true});
    const now = Date.now();
    const names = [];
    for (let i = 0; i < 11; i++) {
      const path = join(base, `heap-${String(i).padStart(24, "0")}.sqlite`);
      writeFileSync(path, "x");
      utimesSync(path, (now - i * 60000) / 1000, (now - i * 60000) / 1000);
      names.push(path);
    }
    const stale = join(base, "heap-x.sqlite.1.tmp"), fresh = join(base, "heap-y.sqlite.2.tmp");
    writeFileSync(stale, "x");
    utimesSync(stale, (now - 2 * 3600000) / 1000, (now - 2 * 3600000) / 1000);
    writeFileSync(fresh, "x");
    prune(base, names[10], now);
    expect(names.map(existsSync)).to.deep.equal([...Array(8).fill(true), false, false, true]);
    expect([existsSync(stale), existsSync(fresh)]).to.deep.equal([false, true]);
  });
});
