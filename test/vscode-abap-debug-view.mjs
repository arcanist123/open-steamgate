import {expect} from "chai";
import runtime from "@abaplint/runtime";
import {readFileSync, mkdtempSync, writeFileSync, rmSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createRequire} from "node:module";
const require = createRequire(import.meta.url);
const {customDescriptionGenerator, customPropertiesGenerator} = require("../editors/vscode/abap-debug-view.js");
const {debuggerConfiguration} = require("../editors/vscode/lib.js");
const description = new Function(`return (${customDescriptionGenerator});`)();
const properties = new Function(`return (${customPropertiesGenerator});`)();
const t = runtime.ABAP ? new runtime.ABAP().types : runtime.types;
const describeValue = (value) => description.call(value, "default JS");
const props = (value) => properties.call(value);

describe("VS Code ABAP values (serialized js-debug generators)", () => {
  const cases = [
    ["Character", () => new t.Character(20).set("ABC"), "'ABC' (c20)"],
    ["String", () => new t.String().set("ABC  "), "'ABC  ' (string)"],
    ["Integer", () => new t.Integer().set(-42), "-42 (i)"],
    ["Integer8", () => new t.Integer8().set("9223372036854775807"), "9223372036854775807 (int8)"],
    ["Packed", () => new t.Packed({length: 8, decimals: 2}).set("12.50"), "12.50 (p8,2)"],
    ["large Packed", () => new t.Packed({length: 16, decimals: 2}).set("12345678901234567890.12"), "12345678901234567890.12 (p16,2)"],
    ["negative Packed", () => new t.Packed({length: 8, decimals: 2}).set("-0.05"), "-0.05 (p8,2)"],
    ["Float", () => new t.Float().set(1.5), "1.5000000000000000E+00 (f)"],
    ["Date", () => new t.Date().set("20261003"), "2026-10-03 (d)"],
    ["Time", () => new t.Time().set("123456"), "12:34:56 (t)"],
    ["XString", () => new t.XString().set("ABCDEF"), "ABCDEF (xstring)"],
    ["Hex", () => new t.Hex({length: 4}).set("ABCD"), "ABCD0000 (x4)"],
  ];
  for (const [name, make, expected] of cases) {
    it(`shows ${name} without runtime fields`, () => {
      const value = make();
      expect(describeValue(value)).to.equal(expected);
      expect(props(value)).to.deep.equal({});
    });
  }
  it("preserves leading CHAR spaces and escapes quotes and control characters", () => {
    expect(describeValue(new t.Character(20).set(" A'B\n"))).to.equal("' A''B\\n' (c20)");
  });
  it("shows initial scalars", () => {
    expect(describeValue(new t.Character(20))).to.equal("'' (c20)");
    expect(describeValue(new t.Packed({length: 8, decimals: 2}))).to.equal("0.00 (p8,2)");
    expect(describeValue(new t.Date())).to.equal("0000-00-00 (d)");
    expect(describeValue(new t.Time())).to.equal("00:00:00 (t)");
  });
  it("rejects inexact numeric Packed storage without calling runtime methods", () => {
    for (const raw of [1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
      const value = new t.Packed({length: 8, decimals: 2});
      value.value = raw;
      value.get = () => {throw Error("must not inspect via get()");};
      expect(describeValue(value)).to.equal("default JS");
      expect(props(value)).to.equal(value);
    }
  });
  it("returns prototype-free property bags for all ABAP expansions", () => {
    class Probe {
      static INTERNAL_TYPE = "CLAS";
      static INTERNAL_NAME = "ZCL_DEBUG_PROBE";
    }
    const structure = new t.Structure({field: new t.Integer()});
    const object = new t.ABAPObject();
    object.set(new Probe());
    const symbol = new t.FieldSymbol(structure);
    symbol.assign(structure);
    const reference = new t.DataReference(structure);
    reference.assign(structure);
    for (const value of [structure, new t.Table(structure), new t.HashedTable(structure),
      new t.FieldSymbol(structure), symbol,
      new t.DataReference(structure), reference,
      object, new t.ABAPObject(), new Probe()]) {
      const shown = props(value);
      expect(Object.getPrototypeOf(shown)).to.equal(null);
      expect("__proto__" in shown).to.equal(false);
    }
  });
  it("expands nested structures by declared component name and identity", () => {
    const nested = new t.Structure({amount: new t.Packed({length: 8, decimals: 2}).set("12.50")});
    const fields = {name: new t.Character(20).set("ABC"), nested};
    const value = new t.Structure(fields);
    expect(describeValue(value)).to.equal("{…} (structure)");
    expect(props(value)).to.deep.equal(fields);
    expect(Object.getPrototypeOf(props(value))).to.equal(null);
    expect(props(value).nested).to.equal(nested);
    expect(describeValue(props(value).nested)).to.equal("{…} (structure)");
    expect(describeValue(props(nested).amount)).to.equal("12.50 (p8,2)");
  });
  for (const type of ["STANDARD", "SORTED"]) {
    it(`shows ${type.toLowerCase()} rows from 1 and caps expansion at 100`, () => {
      const options = {primaryKey: {name: "primary_key", type, keyFields: ["TABLE_LINE"], isUnique: true}};
      const value = type === "HASHED" ? new t.HashedTable(new t.Integer(), options) : new t.Table(new t.Integer(), options);
      expect(describeValue(value)).to.equal(`[0 rows] (${type.toLowerCase()} table)`);
      expect(Object.keys(props(value))).to.deep.equal([]);
      for (let i = 1; i <= 103; i++) {
        if (type === "HASHED") value.insert(new t.Integer().set(i));
        else value.append(new t.Integer().set(i));
      }
      expect(describeValue(value)).to.equal(`[103 rows] (${type.toLowerCase()} table)`);
      const shown = props(value);
      expect(Object.keys(shown)).to.have.length(101);
      expect(shown["1"]).to.equal(value.array()[0]);
      expect(describeValue(shown["100"])).to.equal("100 (i)");
      expect(shown["…more"]).to.equal("3 more rows (first 100 shown)");
    });
  }
  it("does not enumerate or count hashed backing storage even for a preview", () => {
    const value = new t.HashedTable(new t.Integer());
    let enumerations = 0;
    let methodCalls = 0;
    value.value = new Proxy({}, {ownKeys() {enumerations++; throw Error("unbounded enumeration");}});
    value.getArrayLength = () => {methodCalls++; throw Error("unbounded count");};
    value.array = () => {methodCalls++; throw Error("unbounded copy");};
    expect(describeValue(value)).to.equal("[rows not enumerated] (hashed table)");
    expect(Object.keys(props(value))).to.deep.equal(["…rows"]);
    expect(enumerations).to.equal(0);
    expect(methodCalls).to.equal(0);
  });
  it("uses only the first 100 indexed standard/sorted rows", () => {
    for (const type of ["STANDARD", "SORTED"]) {
      const value = new t.Table(new t.Integer(), {primaryKey: {type}});
      const rows = Array.from({length: 1000}, () => new t.Integer().set(42));
      let reads = 0;
      let enumerations = 0;
      value.value = new Proxy(rows, {
        ownKeys() {enumerations++; throw Error("enumeration");},
        getOwnPropertyDescriptor(target, key) {
          if (key !== "length") {reads++; if (Number(key) >= 100) throw Error("past cap");}
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });
      const shown = props(value);
      expect(shown["100"]).to.equal(rows[99]);
      expect(shown["…more"]).to.equal("900 more rows (first 100 shown)");
      expect(reads).to.equal(100);
      expect(enumerations).to.equal(0);
    }
  });
  it("caps scalar previews before escaping, trimming or uppercasing", () => {
    for (const value of [new t.String().set("'".repeat(1000000)), new t.XString().set("AB".repeat(500000)), new t.Character(1000000).set("A")]) {
      expect(describeValue(value).length).to.be.lessThan(550);
      expect(describeValue(value)).to.include("…");
      expect(props(value)).to.deep.equal({});
      expect(Object.getOwnPropertyDescriptor(value, "value").value.length).to.equal(1000000);
    }
  });
  it("keeps a table header visible separately from rows", () => {
    const value = new t.Table(new t.Integer(), {withHeader: true});
    expect(props(value).header).to.equal(value.header);
    expect(Object.keys(props(value))).to.deep.equal(["header"]);
  });
  for (const name of ["FieldSymbol", "DataReference"]) {
    it(`shows ${name} targets, initial state and cycles safely`, () => {
      const value = new t[name](new t.Integer());
      expect(describeValue(value)).to.equal(name === "FieldSymbol" ? "-> unassigned (field symbol)" : "-> initial (data reference)");
      expect(props(value)).to.deep.equal({});
      const target = new t.Structure({count: new t.Integer().set(42)});
      value.assign(target);
      expect(describeValue(value)).to.equal("-> {…} (structure)");
      expect(props(value)["->"]).to.equal(target);
      value.assign(new t.Integer().set(42));
      expect(describeValue(value)).to.equal("-> 42 (i)");
      value.assign(value);
      expect(describeValue(value)).to.equal("-> -> … (reference cycle/limit)");
    });
  }
  it("formats CASTING float storage as the declared hex field symbol without mutation", () => {
    const source = new t.Float().set(1.5);
    const value = new t.FieldSymbol(new t.Hex({length: 8}));
    value.assign(source);
    value.setCasting();
    value.getPointer = () => {throw Error("must not invoke reinterpretation");};
    expect(describeValue(value)).to.equal("-> 000000000000F83F (x8)");
    const child = props(value)["->"];
    expect(describeValue(child)).to.equal("000000000000F83F (x8)");
    expect(source.getRaw()).to.equal(1.5);
    expect(value.pointer).to.equal(source);
    expect(value.type.get()).to.equal("0000000000000000");
  });
  it("checks stored assignment before CASTING after unassignment", () => {
    const value = new t.FieldSymbol(new t.Hex({length: 8}));
    value.assign(new t.Float().set(1.5));
    value.setCasting();
    value.unassign();
    value.getPointer = () => {throw Error("unassigned reinterpretation");};
    expect(describeValue(value)).to.equal("-> unassigned (field symbol)");
    expect(props(value)).to.deep.equal({});
    expect(value.pointer).to.equal(undefined);
  });
  it("formats CASTING hex storage as declared CHAR and keeps date-to-date storage", () => {
    const source = new t.Hex({length: 4}).set("41004200");
    const value = new t.FieldSymbol(new t.Character(2));
    value.assign(source);
    value.setCasting();
    expect(describeValue(value)).to.equal("-> 'AB' (c2)");
    expect(describeValue(props(value)["->"])).to.equal("'AB' (c2)");
    expect(source.get()).to.equal("41004200");
    const date = new t.Date().set("20261003");
    const dateSymbol = new t.FieldSymbol(new t.Date());
    dateSymbol.assign(date);
    dateSymbol.setCasting();
    expect(props(dateSymbol)["->"]).to.equal(date);
  });
  it("shows object class and public, private and inherited attributes without methods", () => {
    class zcl_demo {
      static INTERNAL_TYPE = "CLAS";
      static INTERNAL_NAME = "ZCL_DEMO";
      count = new t.Integer().set(42);
      me = new t.ABAPObject().set(this);
      FRIENDS_ACCESS_INSTANCE = Object.assign(Object.create({inherited: new t.String().set("base")}), {secret: new t.Character(5).set("abc"), method() {throw Error("must not run");}});
    }
    const object = new zcl_demo();
    const value = new t.ABAPObject({qualifiedName: "ZCL_BASE"}).set(object);
    expect(describeValue(value)).to.equal("ZCL_DEMO (object)");
    expect(describeValue(object)).to.equal("ZCL_DEMO (object)");
    expect(Object.keys(props(value))).to.deep.equal(["count", "secret", "inherited"]);
    expect(props(object).secret).to.equal(object.FRIENDS_ACCESS_INSTANCE.secret);
    expect(describeValue(new t.ABAPObject())).to.equal("initial (object)");
  });
  it("falls back unchanged for unknown objects, primitives and throwing accessors", () => {
    for (const value of [{get() {return 42;}}, new Date(), [], null, undefined, 42, "text", new Proxy({}, {get() {throw Error("no");}})]) {
      expect(describeValue(value)).to.equal("default JS");
      expect(props(value)).to.equal(value);
    }
    const broken = new t.Character(2);
    broken.get = () => {throw Error("broken");};
    expect(describeValue(broken)).to.equal("'' (c2)");
    expect(props(broken)).to.deep.equal({});
  });
  it("falls back when CASTING metadata is renamed, malformed or accessor-backed", () => {
    for (const shape of ["renamed", "malformed", "accessor"]) {
      const value = new t.FieldSymbol(new t.Hex({length: 8}));
      value.assign(new t.Float().set(1.5));
      value.setCasting();
      if (shape === "renamed") {
        value.renamedCasting = value.casting;
        delete value.casting;
      } else if (shape === "malformed") value.casting = "true";
      else Object.defineProperty(value, "casting", {get() {throw Error("must not read casting");}});
      expect(describeValue(value)).to.equal("default JS");
      expect(props(value)).to.equal(value);
    }
  });
  it("falls back when table classification metadata is unavailable", () => {
    for (const shape of ["renamed", "malformed", "accessor", "primary", "type", "unknown type", "primary accessor", "type accessor"]) {
      const value = new t.Table(new t.Integer(), {primaryKey: {type: "SORTED"}});
      value.append(new t.Integer().set(42));
      if (shape === "renamed") {
        value.renamedOptions = value.options;
        delete value.options;
      } else if (shape === "malformed") value.options = null;
      else if (shape === "accessor") Object.defineProperty(value, "options", {get() {throw Error("must not read options");}});
      else if (shape === "primary") value.options.primaryKey = null;
      else if (shape === "type") delete value.options.primaryKey.type;
      else if (shape === "unknown type") value.options.primaryKey.type = "RENAMED_SORTED";
      else if (shape === "primary accessor") Object.defineProperty(value.options, "primaryKey", {get() {throw Error("must not read primary key");}});
      else Object.defineProperty(value.options.primaryKey, "type", {get() {throw Error("must not read type");}});
      expect(describeValue(value)).to.equal("default JS");
      expect(props(value)).to.equal(value);
    }
  });
  it("keeps standard tables with explicit default options projected", () => {
    for (const options of [undefined, {}, {primaryKey: undefined}, {primaryKey: {type: undefined}}]) {
      const value = new t.Table(new t.Integer(), options);
      value.append(new t.Integer().set(42));
      expect(describeValue(value)).to.equal("[1 rows] (standard table)");
      expect(props(value)["1"]).to.equal(value.array()[0]);
    }
  });
  it("never invokes unknown getters, lookalike methods or ABAP application accessors", () => {
    let calls = 0;
    const target = new t.Character(4).set("SAFE");
    const mutate = () => {calls++; target.set("BAD"); return () => 42;};
    const unknown = {};
    for (const key of ["get", "getQualifiedName", "constructor"]) Object.defineProperty(unknown, key, {get: mutate});
    class Character {
      getQualifiedName() {return "fake";}
      get() {mutate(); return "fake";}
    }
    const accessor = new Character();
    Object.defineProperty(accessor, "value", {get: mutate});
    for (const value of [unknown, new Character(), accessor]) {
      expect(describeValue(value)).to.equal("default JS");
      expect(props(value)).to.equal(value);
    }
    class Demo {
      static INTERNAL_TYPE = "CLAS";
      static INTERNAL_NAME = "DEMO";
      count = target;
      get FRIENDS_ACCESS_INSTANCE() {return mutate();}
      get dangerous() {return mutate();}
    }
    expect(Object.keys(props(new Demo()))).to.deep.equal(["count"]);
    expect(calls).to.equal(0);
    expect(target.get()).to.equal("SAFE");
  });
  it("reads runtime data without executing overridden methods or formatting during expansion", () => {
    let calls = 0;
    const value = new t.Character(4).set("SAFE");
    value.get = () => {calls++; value.set("BAD"); return "BAD";};
    expect(describeValue(value)).to.equal("'SAFE' (c4)");
    expect(props(value)).to.deep.equal({});
    expect(calls).to.equal(0);
    expect(Object.getOwnPropertyDescriptor(value, "value").value).to.equal("SAFE");
  });
  it("does not coerce lookalike metadata or invoke inherited CASTING setters", () => {
    let calls = 0;
    class Character {
      value = "SAFE";
      length = {toString() {calls++; return "4";}};
      getQualifiedName() {}
      get() {calls++; return this.value;}
    }
    const fake = new Character();
    expect(describeValue(fake)).to.equal("default JS");
    expect(props(fake)).to.equal(fake);
    class Hex {
      constructor() {
        Object.defineProperty(this, "value", {value: "0000"});
        this.length = 2;
      }
      set value(_value) {calls++;}
      getQualifiedName() {}
      get() {calls++;}
    }
    const symbol = new t.FieldSymbol(new Hex());
    symbol.assign(new t.Float().set(1.5));
    symbol.setCasting();
    expect(describeValue(symbol)).to.equal("-> 000000000000F83F (x2)");
    expect(describeValue(props(symbol)["->"])).to.equal("000000000000F83F (x2)");
    expect(calls).to.equal(0);
  });
  it("preserves IEEE-754 CASTING bits at numeric boundaries", () => {
    for (const number of [-0, -1.5, Number.MIN_VALUE, 2 ** -1022, 1.9999999999999998, Number.MAX_VALUE, Infinity]) {
      const buffer = Buffer.alloc(8);
      buffer.writeDoubleLE(number);
      const symbol = new t.FieldSymbol(new t.Hex({length: 8}));
      // An f calculation beyond the double range raises since
      // abaplint/transpiler#2256, so set() refuses an infinity. The view
      // formats whatever the storage holds and never calls set(), so that
      // one bit pattern goes into the storage directly.
      const float = new t.Float();
      if (Number.isFinite(number)) float.set(number);
      else float.value = number;
      expect(Object.is(float.getRaw(), number)).to.equal(true);
      symbol.assign(float);
      symbol.setCasting();
      expect(describeValue(symbol)).to.equal("-> " + buffer.toString("hex").toUpperCase() + " (x8)");
    }
  });
  it("uses independent documented scientific-format fixtures, regardless of runtime get()", () => {
    // SAP's WRITE formatting rules describe scientific notation for f. These
    // literals use our locale-independent period policy, not a SAP GUI capture.
    const fixtures = JSON.parse(readFileSync(new URL("./fixtures/abap-debug-formats.json", import.meta.url)));
    for (const {input, expected} of fixtures.float) {
      const value = new t.Float().set(input);
      value.get = () => {throw Error("fixture must not derive from get()");};
      expect(describeValue(value)).to.equal(expected);
    }
    const char = new t.Character(5).set("AB");
    expect(describeValue(char)).to.equal("'AB' (c5)");
    expect(Object.getOwnPropertyDescriptor(char, "value").value).to.equal("AB   ");
  });
  it("renders renamed bundled runtime constructors after the binary's actual name restoration", function () {
    this.timeout(30000);
    const dir = mkdtempSync(join(tmpdir(), "osd-debug-bundle-"));
    try {
      const binary = readFileSync(new URL("../bin/osd.mjs", import.meta.url), "utf8");
      const begin = binary.indexOf("for (const [key, value] of Object.entries(runtime.types");
      const end = binary.indexOf('\nif (typeof Bun', begin);
      expect(begin).to.be.greaterThan(0);
      expect(end).to.be.greaterThan(begin);
      const restore = binary.slice(begin, end);
      const input = join(dir, "fixture.mjs");
      const output = join(dir, "bundle.cjs");
      writeFileSync(input, `import runtime from ${JSON.stringify(require.resolve("@abaplint/runtime"))};
const t = runtime.types;
const description = (${customDescriptionGenerator});
const properties = (${customPropertiesGenerator});
// Force the collision observed in the binary, even if a bundler version keeps it.
Object.defineProperty(t.Date, "name", {value: "Date2", configurable: true});
Object.defineProperty(t.String, "name", {value: "String2", configurable: true});
const date = new t.Date().set("20261003");
const string = new t.String().set("ABC  ");
const before = [description.call(date, "default JS"), properties.call(date) === date];
${restore}
console.log(JSON.stringify({before, names: [t.Date.name, t.String.name],
  descriptions: [description.call(date), description.call(string)],
  children: [Object.keys(properties.call(date)), Object.keys(properties.call(string))]}));`);
      execFileSync("bun", ["build", input, "--target=node", "--outfile", output], {stdio: "pipe"});
      const result = JSON.parse(execFileSync(process.execPath, [output], {encoding: "utf8"}));
      expect(result.before).to.deep.equal(["default JS", true]);
      expect(result.names).to.deep.equal(["Date", "String"]);
      expect(result.descriptions).to.deep.equal(["2026-10-03 (d)", "'ABC  ' (string)"]);
      expect(result.children).to.deep.equal([[], []]);
    } finally {rmSync(dir, {recursive: true, force: true});}
  });
  it("installs both executable generators for system and ABAP Unit sessions", () => {
    for (const target of ["system", "unit"]) {
      const config = debuggerConfiguration(9400, {target});
      expect(config.customDescriptionGenerator).to.equal(customDescriptionGenerator);
      expect(config.customPropertiesGenerator).to.equal(customPropertiesGenerator);
    }
  });
});
