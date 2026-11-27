// The second sieve: what SQL a system actually ran (backlog W.1, O.1).
//
// The first sieve compares what two systems ANSWER. This one compares what
// they DID to get there, and it exists because the database seam is the one
// place where being wrong is invisible from outside: a missing MANDT, an
// ORDER BY that differs, an N+1 where the system issues one statement, a
// different FOR ALL ENTRIES chunking -- every one of those can come out with
// the right answer by accident, and none of them shows in a response body.
//
// It is nearly free on our side and that is the argument for doing it first.
// All transpiled ABAP talks to exactly ONE object,
// `abap.context.databaseConnections["DEFAULT"]`, with eleven methods
// (docs/db-backends.md). So there is one interception point, no new protocol,
// and nothing in the ABAP to change.
//
// The shape is deliberately the same as the first sieve's
// (tools/osd-compare.mjs): named rules, each with a reason it is allowed to
// mask a difference, only the structural ones on by default, and what fired
// reported rather than applied quietly. "Identical" and "identical after
// masking three generated names" are different claims.
//
//   node tools/osd-sql-trace.mjs a.ndjson b.ndjson [--rule literals]
import {appendFileSync, readFileSync} from "node:fs";
import {basename} from "node:path";

/** the members of the seam that issue SQL, and how to read the statement out */
const STATEMENT_OF = {
  execute: (args) => (Array.isArray(args[0]) ? args[0].join(";\n") : String(args[0] ?? "")),
  select: (args) => String(args[0]?.select ?? ""),
  openCursor: (args) => String(args[0]?.select ?? ""),
  insert: (args) => `INSERT INTO ${args[0]?.table} (${(args[0]?.columns ?? []).join(",")}) ` +
    `VALUES (${(args[0]?.values ?? []).join(",")})`,
  update: (args) => `UPDATE ${args[0]?.table} SET ${(args[0]?.set ?? []).join(", ")} WHERE ${args[0]?.where}`,
  delete: (args) => `DELETE FROM ${args[0]?.table}` + (args[0]?.where ? ` WHERE ${args[0].where}` : ""),
  native: (args) => String(args[0]?.sql ?? ""),
};

/** the table a statement touches, for the summary a trace is read for.
 *  Taken from the OPTIONS where the seam gives them, and from the text only
 *  where it does not -- a regular expression over SQL is a guess, and the
 *  seam is not. */
export function tableOf(op, args, sql = "") {
  const named = args?.[0]?.table;
  if (typeof named === "string" && named !== "") return named.replace(/["\u0027]/g, "").toUpperCase();
  // `CREATE TABLE 'x' (...)` names its table too, and 105 of them -- the
  // whole schema -- were landing under `(none)` and costing 78 ms of a
  // 441 ms run. `(none)` has to mean "this statement genuinely has no
  // table", not "I could not tell": a bucket that means the second is the
  // third value wearing a table's clothes, and it was the largest row on
  // the screen (2026-09-19, found by reading my own instrument's output).
  //
  // The quote is matched as any of the three an engine may use, because
  // SQLite writes `'x'` where the others write `"x"`.
  const match = /\bFROM\s+["'`]?(\w+)["'`]?/i.exec(sql)
    ?? /\bINTO\s+["'`]?(\w+)["'`]?/i.exec(sql)
    ?? /\bUPDATE\s+["'`]?(\w+)["'`]?/i.exec(sql)
    ?? /\b(?:CREATE|DROP|ALTER)\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?["'`]?(\w+)["'`]?/i.exec(sql);
  return match === null || match === undefined ? undefined : match[1].toUpperCase();
}

/** how many rows came back, where the answer says so */
export function rowsOf(answer) {
  if (answer === null || typeof answer !== "object") return undefined;
  if (Array.isArray(answer.rows)) return answer.rows.length;
  if (typeof answer.dbcnt === "number") return answer.dbcnt;
  return undefined;
}

/** the members that mark the shape of the LUW rather than issue a statement */
const MARKERS = ["beginTransaction", "commit", "rollback"];

/**
 * Record every statement a client is asked for.
 *
 * Wrapping rather than editing each client, for the same reason the trimming
 * rule became a module: four clients exist and a fifth is expected, and a
 * tracer written into one of them is a tracer three clients do not have.
 */
export function installSqlTrace(client, sink, {label, enabled} = {}) {
  if (client === undefined || client.__sqlTraced === true) return client;
  // **The wrapper has to be free when nothing is listening.** A screen that
  // can turn tracing on at runtime needs the wrapper installed at all times,
  // and a wrapper that builds a statement string and reads a clock for every
  // one of the 6793 statements of a unit run would be a tax on a feature
  // nobody switched on. `enabled` is checked FIRST and the call goes
  // straight through when it is false.
  const listening = typeof enabled === "function" ? enabled : () => true;
  let n = 0;
  const record = (entry) => {
    try {
      sink({...entry, label});
    } catch {
      // a tracer that can break the thing it traces is worse than no tracer
    }
  };
  for (const [op, statementOf] of Object.entries(STATEMENT_OF)) {
    const original = client[op];
    if (typeof original !== "function") continue;
    client[op] = function (...args) {
      if (listening() !== true) return original.apply(this, args);
      // **Timed around the call, and written after it.** A trace without a
      // duration cannot answer the question a trace is opened for -- which
      // statement cost the request -- and writing the entry before the call
      // is what makes a duration impossible to add later. `ms` is rounded to
      // a tenth: a microsecond figure invites a comparison between two runs
      // that is noise, and the sieve next door compares statements, not
      // clocks.
      const index = n++;
      const sql = statementOf(args);
      const started = performance.now();
      // a call that threw carries `error` (its code): the entry is what was
      // asked for, and a refused write was asked for and not sent
      const done = (rows, error) => {
        record({n: index, op, sql, ms: Math.round((performance.now() - started) * 10) / 10,
          table: tableOf(op, args, sql), rows,
          ...(error === undefined ? {} : {error: String(error?.code ?? "error")})});
      };
      let answer;
      try {
        answer = original.apply(this, args);
      } catch (error) {
        done(undefined, error ?? "error");
        throw error;
      }
      if (answer !== null && typeof answer?.then === "function") {
        return answer.then((value) => {
          done(rowsOf(value));
          return value;
        }, (error) => {
          done(undefined, error ?? "error");
          throw error;
        });
      }
      done(rowsOf(answer));
      return answer;
    };
  }
  for (const op of MARKERS) {
    const original = client[op];
    if (typeof original !== "function") continue;
    client[op] = function (...args) {
      if (listening() !== true) return original.apply(this, args);
      record({n: n++, op, sql: ""});
      return original.apply(this, args);
    };
  }
  Object.defineProperty(client, "__sqlTraced", {value: true, configurable: true});
  return client;
}

/** a sink that appends one JSON object per line -- `.ndjson`, never `.jsonl`,
 *  because an extension `.gitignore` names swallows a file on one machine and
 *  not on another (docs/retro-2026-09-17.md) */
export function fileSink(path) {
  return (entry) => appendFileSync(path, JSON.stringify(entry) + "\n");
}

export function readTrace(path) {
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
}

// Every rule says what it masks and WHY it is allowed to. A rule that cannot
// answer "why is this allowed to differ?" should not exist.
export const RULES = {
  whitespace: {
    always: true,
    why: "a statement's formatting is not its meaning, and two builders indent differently",
    apply: (sql) => sql.replace(/\s+/g, " ").trim(),
  },
  "generated-names": {
    always: true,
    why: "the splitter names each materialised relation with a process counter, so the NAME differs " +
      "between two runs of the same program by construction; the shape of the statement does not",
    apply: (sql) => sql.replace(/OSD_(STEP|SWEEP|VS_HANA)_\d+(_\d+)?/g, "OSD_$1_n")
      .replace(/"?#?AMDP_IN_\w+"?/g, "{temp}"),
  },
  "session-clock": {
    always: true,
    why: "PUT HERE BY A RUN, not predicted: two `npm run unit` runs in two processes differ in 34 of 7075 " +
      "statements and every one of them comes from ZOSD_TSES -- a session id built from the clock, its " +
      "created/touched stamps, and the 16 reads that carry the id in a WHERE. A session identity is the " +
      "PROCESS, not the program. Deliberately narrow: a 32-digit run and a date-shaped 14-digit stamp, " +
      "never `\\d+`, because the first sieve nearly masked its own row counts with a rule that wide",
    apply: (sql) => sql.replace(/\b\d{32}\b/g, "{session}")
      .replace(/\b20\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{6}\b/g, "{stamp}"),
  },
  literals: {
    always: false,
    why: "ASKED FOR BY NAME: two systems holding different data run the same statements over different " +
      "values. Masking them compares the program; leaving them compares the program AND the data, which " +
      "is the right default when both sides are ours",
    apply: (sql) => sql.replace(/'((?:[^']|'')*)'/g, "'?'"),
  },
  numbers: {
    always: false,
    why: "ASKED FOR BY NAME, and rarely: a bare number is usually a LIMIT or an offset, and masking those " +
      "hides exactly the difference this sieve exists to find",
    apply: (sql) => sql.replace(/\b\d+\b/g, "?"),
  },
};

/** canonical form, plus the names of the rules that actually changed something */
export function canonical(sql, wanted = []) {
  const fired = [];
  let text = String(sql ?? "");
  for (const [name, rule] of Object.entries(RULES)) {
    if (!rule.always && !wanted.includes(name)) continue;
    const after = rule.apply(text);
    if (after !== text) fired.push(name);
    text = after;
  }
  return {text, fired};
}

/**
 * Compare two traces, statement by statement, in order.
 *
 * Order is part of the answer here and is not sorted away: an N+1 is a
 * difference in COUNT and a reordered read is a difference in POSITION, and
 * both are findings. The first difference is named with its index, because
 * everything after the first is usually the same difference again.
 */
export function compareTraces(a, b, {rules = []} = {}) {
  const fired = new Set();
  const shape = (trace) => trace.map((entry) => {
    const {text, fired: f} = canonical(entry.sql, rules);
    for (const one of f) fired.add(one);
    return {op: entry.op, sql: text};
  });
  const left = shape(a);
  const right = shape(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i];
    const y = right[i];
    if (x === undefined) return {same: false, at: i, kind: "b ran more statements", b: y, counts: [left.length, right.length], masked: [...fired]};
    if (y === undefined) return {same: false, at: i, kind: "a ran more statements", a: x, counts: [left.length, right.length], masked: [...fired]};
    if (x.op !== y.op || x.sql !== y.sql) {
      return {same: false, at: i, kind: "different statement", a: x, b: y, counts: [left.length, right.length], masked: [...fired]};
    }
  }
  return {same: true, statements: left.length, masked: [...fired]};
}

/**
 * What a trace is opened for: where the request went, and what it did twice.
 *
 * This is the analysis a screen would show (backlog G.10), written before the
 * screen on purpose -- the backlog's own warning is that G.10 built first is
 * "a handsome page with no consumer and no normaliser behind it". The
 * normaliser is next door and the analysis is here; the page is then a
 * rendering job.
 *
 * `repeated` is the one the response sieve cannot see at all. The same
 * statement, with only its VALUES differing, run once per row is an N+1: the
 * answer is right and the system did the work n times. It is found by
 * counting canonical statements with the literals masked, which is the one
 * place masking literals is the point rather than a concession.
 */
export function summarise(trace, {slowest = 5, repeated = 5} = {}) {
  const statements = trace.filter((e) => e.sql !== undefined && e.sql !== "");
  const byTable = new Map();
  const byShape = new Map();
  let ms = 0;
  for (const entry of statements) {
    ms += entry.ms ?? 0;
    const table = entry.table ?? "(none)";
    const t = byTable.get(table) ?? {table, count: 0, ms: 0, rows: 0};
    t.count += 1;
    t.ms += entry.ms ?? 0;
    t.rows += entry.rows ?? 0;
    byTable.set(table, t);

    const shape = canonical(entry.sql, ["literals", "numbers"]).text;
    const s = byShape.get(shape) ?? {shape, count: 0, ms: 0, op: entry.op, table};
    s.count += 1;
    s.ms += entry.ms ?? 0;
    byShape.set(shape, s);
  }
  const markers = trace.filter((e) => MARKERS.includes(e.op));
  return {
    statements: statements.length,
    ms: Math.round(ms * 10) / 10,
    luw: {commits: markers.filter((m) => m.op === "commit").length,
      rollbacks: markers.filter((m) => m.op === "rollback").length},
    tables: [...byTable.values()].sort((a, b) => b.count - a.count),
    // "run more than once with only the values differing" is the shape; how
    // interesting it is depends on how many times, so it is ordered by that
    repeated: [...byShape.values()].filter((s) => s.count > 1).sort((a, b) => b.count - a.count).slice(0, repeated),
    slowest: [...statements].sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0)).slice(0, slowest)
      .map((e) => ({ms: e.ms, op: e.op, table: e.table, sql: canonical(e.sql).text.slice(0, 120)})),
  };
}

if (basename(process.argv[1] ?? "") === "osd-sql-trace.mjs") {
  const files = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--rule");
  if (process.argv.includes("--summary")) {
    const report = summarise(readTrace(files[0]));
    console.log(`${report.statements} statements, ${report.ms} ms, ` +
      `${report.luw.commits} commits, ${report.luw.rollbacks} rollbacks\n`);
    console.log("  table                  count      ms    rows");
    for (const t of report.tables.slice(0, 12)) {
      console.log(`  ${String(t.table).padEnd(22)}${String(t.count).padStart(5)}` +
        `${String(Math.round(t.ms)).padStart(8)}${String(t.rows).padStart(8)}`);
    }
    if (report.repeated.length > 0) {
      console.log("\n  run more than once with only the values differing -- an N+1 looks like this:");
      for (const r of report.repeated) {
        console.log(`  ${String(r.count).padStart(5)}x ${Math.round(r.ms)} ms  ${r.shape.slice(0, 110)}`);
      }
    }
    console.log("\n  slowest:");
    for (const one of report.slowest) console.log(`  ${String(one.ms).padStart(7)} ms  ${one.sql}`);
    console.log("\nA count is not a defect: a statement run twice may be two different reads.");
    console.log("What it is, is the only place an N+1 is visible at all -- the response sieve");
    console.log("cannot see one, because the answer is right.");
    process.exit(0);
  }
  const rules = process.argv.reduce((acc, a, i) => (a === "--rule" ? [...acc, process.argv[i + 1]] : acc), []);
  if (files.length !== 2) {
    console.log("osd-sql-trace: <a.ndjson> <b.ndjson> [--rule literals] [--rule numbers]");
    console.log("\nrules:");
    for (const [name, rule] of Object.entries(RULES)) {
      console.log(`  ${name.padEnd(16)} ${rule.always ? "always" : "by name"}  ${rule.why}`);
    }
    process.exit(2);
  }
  const verdict = compareTraces(readTrace(files[0]), readTrace(files[1]), {rules});
  if (verdict.same) {
    console.log(`identical: ${verdict.statements} statements` +
      (verdict.masked.length > 0 ? `, after masking ${verdict.masked.join(", ")}` : ", nothing masked"));
    process.exit(0);
  }
  console.log(`differ at statement ${verdict.at} of ${verdict.counts[0]}/${verdict.counts[1]}: ${verdict.kind}`);
  if (verdict.a) console.log(`  a  ${verdict.a.op}  ${verdict.a.sql.slice(0, 160)}`);
  if (verdict.b) console.log(`  b  ${verdict.b.op}  ${verdict.b.sql.slice(0, 160)}`);
  if (verdict.masked.length > 0) console.log(`  (masked: ${verdict.masked.join(", ")})`);
  process.exit(1);
}
