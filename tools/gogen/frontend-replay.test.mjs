import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync, readdirSync} from "node:fs";
import {recordLowering, replayLowering} from "./frontend-replay.mjs";
import {compactLowering} from "./frontend-object-cache.mjs";
import {serialize, deserialize} from "node:v8";

const program = () => ({wanted: new Set(["BASE"]), sigs: new Map(), skipped: [], currentClass: undefined});
test("guard compaction preserves distinct primitive lookup arguments", () => {
  const keys = [null, undefined, NaN, Infinity, -Infinity, 0, false, true, "null", "undefined", "NaN", "Infinity", "-Infinity", "0", "false", "true", ""];
  for (const first of keys) for (const second of keys) {
    if (Object.is(first, second)) continue;
    const recorded = recordLowering({reg: null, m: new Map([[first, "A"], [second, "A"]])},
      (p) => [p.m.get(first), p.m.get(second), p.m.get(first), p.m.get(second)].join(","));
    assert.equal(recorded.ir, "A,A,A,A");
    assert.ok(recorded.replay);
    assert.equal(recorded.replay.ops.length, 2, `${String(first)} / ${String(second)}`);
    const persisted = deserialize(serialize(compactLowering(recorded)));
    assert.equal(persisted.replay.ops.length, 2);
    assert.equal(replayLowering({m: new Map([[first, "A"], [second, "A"]])}, persisted.replay), true);
    assert.equal(replayLowering({m: new Map([[first, "A"], [second, "B"]])}, persisted.replay), false);
    assert.equal(replayLowering({reg: null, m: new Map([[first, "A"], [second, "A"]])}, recorded.replay), true);
    assert.equal(replayLowering({reg: null, m: new Map([[first, "A"], [second, "B"]])}, recorded.replay), false);
  }
});

test("guard compaction preserves signed zero for collections that distinguish it", () => {
  class SignedMap extends Map {
    get(key) { return super.get(Object.is(key, -0) ? "-0" : key); }
  }
  const recorded = recordLowering({m: new SignedMap([[0, "A"], ["-0", "A"]])},
    (p) => [p.m.get(0), p.m.get(-0)].join(","));
  assert.equal(recorded.ir, "A,A");
  assert.ok(recorded.replay);
  assert.equal(recorded.replay.ops.length, 2);
  const persisted = deserialize(serialize(compactLowering(recorded)));
  assert.equal(persisted.replay.ops.length, 2);
  assert.equal(replayLowering({m: new SignedMap([[0, "A"], ["-0", "A"]])}, persisted.replay), true);
  assert.equal(replayLowering({m: new SignedMap([[0, "A"], ["-0", "B"]])}, persisted.replay), false);
  assert.equal(replayLowering({m: new SignedMap([[0, "A"], ["-0", "A"]])}, recorded.replay), true);
  assert.equal(replayLowering({m: new SignedMap([[0, "A"], ["-0", "B"]])}, recorded.replay), false);
});

test("a shallow program trial isolates replay's ordered collection and scalar effects", () => {
  const recorded = recordLowering(program(), (p) => {
    p.sigs.set("NEW", {type: "i"});
    assert.equal(p.sigs.get("NEW").type, "i");
    p.wanted.add("ADDED"); p.skipped.push("effect"); p.currentClass = "CALLER";
  });
  const original = program(); original.sigs.set("BASE", {type: "i"});
  const trial = {...original};
  assert.equal(replayLowering(trial, recorded.replay), true);
  assert.deepEqual([...original.sigs], [["BASE", {type: "i"}]]);
  assert.deepEqual([...original.wanted], ["BASE"]);
  assert.deepEqual(original.skipped, []); assert.equal(original.currentClass, undefined);
  assert.deepEqual([...trial.sigs.keys()], ["BASE", "NEW"]);
  assert.deepEqual([...trial.wanted], ["BASE", "ADDED"]);
  assert.deepEqual(trial.skipped, ["effect"]); assert.equal(trial.currentClass, "CALLER");
});
test("replay checks dependency membership and preserves ordered effects atomically", () => {
  const first = program();
  const cached = recordLowering(first, (p) => {
    p.currentClass = "CALLER";
    p.sigs.set("CALLER=>RUN", {type: "i"});
    assert.equal(p.sigs.get("CALLER=>RUN").type, "i");
    if (!p.wanted.has("DEPENDENCY")) p.skipped.push("dependency absent");
    return {name: "CALLER"};
  });
  assert.ok(cached.replay);
  const next = program();
  next.wanted.add("UNRELATED");
  assert.ok(replayLowering(next, cached.replay));
  assert.deepEqual(next.sigs, first.sigs);
  assert.deepEqual(next.skipped, first.skipped);
  assert.ok(next.wanted.has("UNRELATED"));
  const changed = program();
  changed.wanted.add("DEPENDENCY");
  assert.equal(replayLowering(changed, cached.replay), false);
  assert.equal(changed.sigs.size, 0);
  assert.equal(changed.currentClass, undefined);
  assert.deepEqual(changed.skipped, []);
});

test("nested mutations and previous-class traversal refuse caching", () => {
  const p = program();
  p.sigs.set("BASE=>RUN", {type: "i"});
  assert.equal(recordLowering(p, (p) => { p.sigs.get("BASE=>RUN").type = "int8"; }).replay, undefined);
  p.classes = [];
  assert.equal(recordLowering(p, (p) => p.classes.length).replay, undefined);
});

test("a reused read encoding never hides a nested change", () => {
  const p = program();
  p.sigs.set("BASE=>RUN", {type: "i"});
  // the second read reuses the first encoding; the final check still sees the change
  assert.equal(recordLowering(p, (p) => {
    const sig = p.sigs.get("BASE=>RUN");
    sig.type = "int8";
    return p.sigs.get("BASE=>RUN").type;
  }).replay, undefined);
  // repeated reads of an unchanged input replay, and refuse a changed one
  const cached = recordLowering(program(), (p) => [...p.wanted].length + [...p.wanted].length);
  assert.equal(cached.replay.ops.filter((op) => op.kind === "read").length, 1);
  assert.ok(replayLowering(program(), cached.replay));
  const changed = program();
  changed.wanted.add("OTHER");
  assert.equal(replayLowering(changed, cached.replay), false);
});

// Each lowering below changes an input behind the recorder's back, reads it,
// and puts it back: only the intermediate read can see the change.
test("a nested change undone between reads of an alias still guards the second read", () => {
  const program = (shared) => {
    const a = {type: "i"};
    return {sigs: new Map([["A", a], ["B", shared ? a : {type: "i"}]])};
  };
  const cached = recordLowering(program(true), (p) => {
    const a = p.sigs.get("A");
    a.type = "int8";
    const ir = p.sigs.get("B").type;
    a.type = "i";
    return ir;
  });
  assert.equal(cached.ir, "int8");
  assert.equal(cached.replay, undefined);
});

test("collections changed and restored between reads still guard the second read", () => {
  // a Map whose value is an array must not compare as a flattened pair
  const map = new Map([["x", ["y"]], ["q", "r"]]);
  assert.equal(recordLowering({m: map}, (p) => {
    const first = [...p.m].length;
    map.set("x", "y");
    const second = [...p.m].map(([, v]) => typeof v).join();
    map.set("x", ["y"]);
    return [first, second];
  }).replay, undefined);
  const set = new Set(["A"]);
  assert.equal(recordLowering({wanted: set}, (p) => {
    const first = [...p.wanted].length;
    set.add("C");
    const second = [...p.wanted].length;
    set.delete("C");
    return first + second;
  }).replay, undefined);
  // an array whose iterator hides its elements
  class Fixed extends Array { *[Symbol.iterator]() { yield "fixed"; } }
  const program = (shared) => {
    const a = Fixed.from(["i"]);
    return {sigs: new Map([["A", a], ["B", shared ? a : Fixed.from(["i"])]])};
  };
  assert.equal(recordLowering(program(true), (p) => {
    const a = p.sigs.get("A");
    a[0] = "int8";
    const ir = p.sigs.get("B")[0];
    a[0] = "i";
    return ir;
  }).replay, undefined);
  // an undefined first encoding is still the first one
  const x = Object.defineProperty({type: undefined}, "toJSON", {value() { return this.type; }});
  assert.equal(recordLowering({x}, (p) => { p.x.type = "i"; return p.x.type; }).replay, undefined);
});

test("a definition without a resolved owning artifact declines replay", () => {
  class ClassDefinition {
    getName() { return "LCL_X"; }
    getFilename() { return "zcl_a.clas.locals_imp.abap"; }
    getStart() { return {getRow: () => 3, getCol: () => 7}; }
  }
  const cached = recordLowering({localDefs: new Map([["ZCL_A:LCL_X", new ClassDefinition()]])},
    (p) => p.localDefs.get("ZCL_A:LCL_X").getName());
  assert.equal(cached.replay, undefined);
});

test("assigning a collection refuses replay, including a first chained write", () => {
  for (const value of [new Map(), new Set(), new WeakMap(), new WeakSet(), []]) {
    const first = program();
    const cached = recordLowering(first, (p) => {
      const raw = (p.output ??= value);
      if (raw instanceof Map) raw.set("TYPE", 80);
      if (raw instanceof Set) raw.add("TYPE");
      if (Array.isArray(raw)) raw.push("TYPE");
    });
    assert.equal(cached.replay, undefined);
    assert.equal(replayLowering(program(), cached.replay), false);
  }
});

test("frontend program state is initialized eagerly", () => {
  for (const file of readdirSync(import.meta.dirname).filter((f) => /^frontend.*\.mjs$/.test(f))) {
    assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), "utf8"),
      /\b(?:program|PROGRAM)\s*\.\s*\w+\s*\?\?=/, file);
  }
});

test("oversized fingerprints refuse caching and stop further recording without losing effects", () => {
  const p = program();
  const oversized = {value: "x".repeat((1 << 20) + 1)};
  p.sigs.set("BIG", oversized);
  const result = recordLowering(p, (tracked) => {
    for (let i = 0; i < 10000; i++) assert.equal(tracked.sigs.get("BIG"), oversized);
    tracked.wanted.add("AFTER");
    return 42;
  });
  assert.equal(result.ir, 42);
  assert.equal(result.replay, undefined);
  assert.equal(p.wanted.has("AFTER"), true);
});

test("a large transcript falls back to lowering instead of retaining partial guards", () => {
  const p = program();
  const result = recordLowering(p, (tracked) => {
    for (let i = 0; i < 100000; i++) tracked.wanted.has(String(i));
    tracked.skipped.push("still lowered");
    return {name: "BIG"};
  });
  assert.equal(result.replay, undefined);
  assert.deepEqual(p.skipped, ["still lowered"]);
});

test("an oversized current input refuses replay atomically", () => {
  const p = program(); p.sigs.set("VALUE", "small");
  const cached = recordLowering(p, (tracked) => {
    tracked.skipped.push("effect"); tracked.sigs.get("VALUE");
  });
  assert.ok(cached.replay);
  const next = program(); next.sigs.set("VALUE", "x".repeat((1 << 20) + 1));
  assert.equal(replayLowering(next, cached.replay), false);
  assert.deepEqual(next.skipped, []);
});

test("guard values distinguish JSON collisions, recursively and after persistence", () => {
  const values = [undefined, null, NaN, Infinity, -Infinity, -0, 0, false, true, "0",
    {}, {a: undefined}, {a: null}, {a: NaN}, {a: -0}, {a: 0}, [], [undefined], [null], Array(1),
    new Map(), {map: []}, new Map([["x", undefined]]), new Map([["x", null]]),
    new Set(), {set: []}, new Set([undefined]), new Set([null]),
    new Date(0), new Date(1), new Date(NaN), "1970-01-01T00:00:00.000Z", 0n, 1n,
    Object.assign(Object.create(null), {a: 1}), {a: 1}];
  for (let i = 0; i < values.length; i++) {
    const recorded = recordLowering({m: new Map([["value", values[i]]])}, (p) => p.m.get("value"));
    assert.ok(recorded.replay, `supported guard value ${i}`);
    for (const replay of [recorded.replay, deserialize(serialize(compactLowering(recorded))).replay]) {
      for (let j = 0; j < values.length; j++) {
        assert.equal(replayLowering({m: new Map([["value", values[j]]])}, replay), !!replay && i === j,
          `guard value ${i} against ${j}`);
      }
    }
  }
});

test("fingerprints use stable object keys and preserve collection order and aliasing", () => {
  const first = {a: undefined, b: {n: -0}};
  const recorded = recordLowering({value: first}, (p) => p.value);
  assert.ok(recorded.replay);
  assert.equal(replayLowering({value: {b: {n: -0}, a: undefined}}, recorded.replay), true);
  const shared = {};
  for (const [value, changed] of [[{a: shared, b: shared}, {a: {}, b: {}}],
    [new Map([["a", 1], ["b", 2]]), new Map([["b", 2], ["a", 1]])],
    [new Set([1, 2]), new Set([2, 1])]]) {
    const recorded = recordLowering({value}, (p) => p.value instanceof Map ? [...p.value] : p.value instanceof Set ? [...p.value] : p.value);
    assert.ok(recorded.replay);
    assert.equal(replayLowering({value: changed}, recorded.replay), false);
  }
});

test("unsupported guard values refuse caching without invoking user serialization", () => {
  let calls = 0;
  class Custom { constructor() { this.a = 1; } }
  const values = [Symbol("x"), () => 1, new Custom(), new WeakMap(), new WeakSet(), /x/,
    {toJSON() { calls++; return null; }}, {[Symbol("x")]: 1}, new Proxy({}, {}),
    Object.defineProperty({}, "constructor", {get() { calls++; return Object; }}),
    Object.defineProperty({}, "x", {get() { calls++; return 1; }, enumerable: true})];
  for (const value of values) {
    const result = recordLowering({value}, (p) => p.value);
    assert.equal(result.ir, value);
    assert.equal(result.replay, undefined);
  }
  assert.equal(calls, 0);
});

test("a caught index read is recorded as a keyed read, like Map.get", async () => {
  const {caughtIndex} = await import("./frontend-hierarchy.mjs");
  const index = (parents) => caughtIndex({}, new Set(["LEAF"]), (name) => parents[name]);
  const recorded = recordLowering({reg: null, caught: index({LEAF: "CX_A"})}, (p) => String(p.caught.get(JSON.stringify(["CX_A"]))));
  assert.equal(recorded.ir, "true");
  assert.ok(recorded.replay, "the caught index is not fingerprinted whole");
  assert.deepEqual(recorded.replay.ops.map((op) => [op.kind, op.key, op.method]), [["read", "caught", "get"]]);
  assert.equal(replayLowering({reg: null, caught: index({LEAF: "CX_A"})}, recorded.replay), true);
  assert.equal(replayLowering({reg: null, caught: index({LEAF: "CX_B"})}, recorded.replay), false);
});
