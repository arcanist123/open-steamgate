// The test run of OSD: ABAP Unit for one object, shaped the way ADT
// reports it.
//
// A client does not ask "did it pass". It asks for a program, its test
// classes, their test methods, and for each method the alerts, which is
// where the human-readable failure lives. So this returns exactly that
// tree, and the façade renders it as
//
//   runResult > program > testClasses > testClass > testMethods >
//   testMethod > alerts > alert > title, details/detail, stack/stackEntry
//
// The names and attributes are vsp's, taken from what its client actually
// unmarshals, not from a memory of ADT: a method with no alert passed, a
// method with one did not, and severity and kind separate a failed
// assertion from an exception or a dump.
//
// What runs the tests is the transpiled runtime, the same modules the
// gateway serves from. Which classes and methods exist comes from the
// parse, not from the generated index, so a test that was written and not
// yet transpiled is reported as such instead of silently missing.
import {fileURLToPath} from "node:url";
import {existsSync, readFileSync, realpathSync, rmSync} from "node:fs";
import {unitCommand} from "./osd-host.mjs";
// Detached unit/debug children can be launched from the serving runtime.
import {spawn} from "./osd-child-process.mjs";
import {tmpdir} from "node:os";
import {basename, join} from "node:path";
import {resolveFrame} from "./osd-where.mjs";
export {statementAfter} from "./osd-where.mjs";
import {ObjectStore, NotFound} from "./osd-store.mjs";
import {runsAs} from "./osd-main.mjs";
import {UnitRisk, scheduledRisk} from "./osd-unit-risk.mjs";
import {hookDatabase} from "./osd-dialog-step.mjs";
import {sendIPC} from "./osd-ipc.mjs";
import {installUnitAssert} from "./osd-unit-assert.mjs";

// ADT's own words for what a class declares
const RISK = {HARMLESS: "harmless", DANGEROUS: "dangerous", CRITICAL: "critical"};
const DURATION = {SHORT: "short", MEDIUM: "medium", LONG: "long"};

// what the program element calls the object
const ADT_TYPE = {CLAS: "CLAS/OC", INTF: "INTF/OI", PROG: "PROG/P", FUGR: "FUGR/F"};

/** The environment `runDetached` spawns its child with: its own database,
 *  always. A run inherits the server's environment, and since the server
 *  keeps its rows in a file by default, an inherited STG_DB=file would have
 *  the test writing into the rows the application serves. So the run gets a
 *  file of its own -- a copy of the base image, made by its own setup --
 *  and the file goes when the run does. Isolation is the point of a
 *  detached run; this keeps it, exactly as before, when `options.dbEnv` is
 *  not given.
 *
 *  `options.dbEnv` is the VS Code extension's "run tests on a different
 *  database" setting (docs/vscode-extension.md, "Databases"): tests can run
 *  on HANA while the live system stays on SQLite, or the other way round.
 *  It is a plain env-shaped object (`{STG_DB: "hana", HANA_SCHEMA: ...}`),
 *  never argv, so a password in it never shows in `ps`. `hana` and
 *  `postgres` carry their own isolation -- a dedicated schema or database
 *  the caller already chose -- so they get none of the throwaway-file
 *  machinery below and `dbEnv` is passed through as given; `file` and
 *  `duckdb`, explicit or defaulted, still get a file of their own, the same
 *  as the no-`dbEnv` path. */
export function unitChildEnv(options = {}, parentEnv = process.env) {
  const dbEnv = options.dbEnv;
  const requested = dbEnv?.STG_DB ?? parentEnv.STG_DB;
  const ownsFile = dbEnv === undefined || (requested !== "hana" && requested !== "postgres");
  let inherited = {...parentEnv, ...dbEnv};
  if (options.inspectPort !== undefined) {
    const port = typeof options.inspectPort === "number" ? options.inspectPort
      : typeof options.inspectPort === "string" && /^\d+$/.test(options.inspectPort) ? Number(options.inspectPort) : NaN;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`invalid inspector port: ${options.inspectPort}`);
    }
    inherited.NODE_OPTIONS = [
      inherited.NODE_OPTIONS,
      `--inspect${options.waitForDebugger === true ? "-brk" : ""}=127.0.0.1:${port} --enable-source-maps`,
    ].filter((value) => value !== undefined && value !== "").join(" ");
  }
  if (ownsFile === false) {
    return {env: inherited, ownPath: undefined};
  }
  const ownPath = join(tmpdir(), `osd-unit-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sqlite`);
  return {
    env: {...inherited, STG_DB: requested === "duckdb" ? "duckdb" : "file", STG_DB_PATH: ownPath},
    ownPath,
  };
}

// One parser implementation for the runner and the PARSE UNIT_PLAN command.
export function unitClasses(store, type, name) {
  const entry = store.find(type, name);
  if (entry === undefined) {
    throw new NotFound(type, name);
  }
  const object = store.registry().getObject(type, entry.name);
  if (object === undefined || object.getABAPFiles === undefined) {
    return {object: entry, classes: []};
  }
  const classes = [];
  for (const file of object.getABAPFiles()) {
    const filename = file.getFilename();
    const implementations = new Map(file.getInfo().listClassImplementations().map((i) => [i.name.toUpperCase(), i]));
    for (const definition of file.getInfo().listClassDefinitions()) {
      if (definition.isForTesting !== true || definition.isAbstract === true) {
        continue;
      }
      // a method's position is where its body is, not where it was
      // declared: a client that follows the URI wants the code
      const bodies = new Map((implementations.get(definition.name.toUpperCase())?.methods ?? [])
        .map((m) => [m.token.strUpper, m.token.getStart()]));
      const methods = definition.methods.filter((m) => m.isForTesting === true).map((m) => {
        const at = bodies.get(m.name.toUpperCase()) ?? m.identifier?.token?.getStart?.();
        return {
          name: m.name.toUpperCase(),
          // the transpiler keys FRIENDS_ACCESS_INSTANCE and the exports in lower case;
          // ABAP names are case-insensitive, so `First_Test` must still be found
          method: m.name.toLowerCase(),
          line: at?.getRow?.() ?? at?.row ?? 1,
          column: at?.getCol?.() ?? at?.col ?? 1,
        };
      });
      classes.push({
        name: definition.name.toUpperCase(),
        localClass: definition.name.toLowerCase(),
        riskLevel: RISK[definition.riskLevel] ?? "harmless",
        durationCategory: DURATION[definition.duration] ?? "short",
        // ADT reports an undeclared level as harmless; a scheduler must
        // not believe that (tools/osd-unit-risk.mjs scheduledRisk)
        riskLevelDeclared: RISK[definition.riskLevel] !== undefined,
        durationDeclared: DURATION[definition.duration] !== undefined,
        include: includeOf(filename),
        source: filename,
        module: basename(filename).replace(/\.abap$/, ".mjs"),
        line: definition.identifier?.token?.getStart?.().getRow() ?? 1,
        column: definition.identifier?.token?.getStart?.().getCol() ?? 1,
        testMethods: methods,
      });
    }
  }
  return {object: entry, classes};
}

// Warm-up can be slow while doing synchronous work, but an unresolved
// async stage must not keep discovery waiting forever. Reset the silence
// deadline when a stage finishes, and let queued completion run before timing out.
export async function waitUnitWarmup(store) {
  const ready = store.unitReady;
  if (ready === undefined) return;
  const silenceMs = Number(process.env.OSD_TRANSITION_MS ?? 30000);
  const started = Date.now();
  const late = Symbol("late");
  let settled = false;
  ready.then(() => {settled = true;}, () => {settled = true;});
  for (;;) {
    let timer;
    const deadline = (store.unitWarmHeard ?? started) + silenceMs;
    const result = await Promise.race([ready, new Promise((resolve) => {
      timer = setTimeout(() => resolve(late), Math.max(0, deadline - Date.now()));
    })]).finally(() => clearTimeout(timer));
    if (result !== late) return;
    await new Promise((resolve) => setImmediate(resolve));
    if (settled) {await ready;return;}
    if ((store.unitWarmHeard ?? started) + silenceMs > Date.now()) continue;
    // Abandon this wait, including for later requests: discovery can use
    // the runner directly even if the background graph never finishes.
    if (store.unitReady === ready) delete store.unitReady;
    throw new Error(`unit plan pre-warm silent for ${silenceMs} ms`);
  }
}

export async function unitPlan(store, type, name, {risk = false} = {}) {
  await waitUnitWarmup(store);
  const runner = await store.unit();
  const plan = runner.classes(type, name);
  return risk ? runner.withRisk(plan) : plan;
}

// Pre-warm in discovery order: find() needs the object index before the
// registry. Building that index invalidates any earlier parse, so warming
// only the registry/graph made the first GET parse the entire tree again.
export async function warmUnitPlan(store) {
  const started = performance.now();
  store.unitWarmHeard = Date.now();
  store.list();
  const runner = await store.unit();
  store.unitWarmHeard = Date.now();
  runner.risk ??= new UnitRisk(store);
  await runner.risk.writesReached("");
  store.unitWarmHeard = Date.now();
  return {ms: performance.now() - started, objects: Array.from(store.registry().getObjects()).length};
}

export class UnitRun {
  constructor(store = new ObjectStore()) {
    this.store = store;
  }

  // the test classes of an object, from the parse: what would run, without
  // running it. The façade uses this for a testruns request that only asks
  // what tests there are.
  classes(type, name) {
    return unitClasses(this.store, type, name);
  }

  // The plan with what the declarations are checked against
  // (tools/osd-unit-risk.mjs): the writes the object's tests reach, and per
  // class the risk it is scheduled with and whether the runtime guard
  // watches it -- a class declared HARMLESS in which the static check found
  // nothing. A class the check flagged is scheduled DANGEROUS and not
  // guarded: it says HARMLESS, the check says otherwise, and failing it for
  // a write the check already reported would only fail it twice.
  async withRisk(plan) {
    this.risk ??= new UnitRisk(this.store);
    let reached;
    try {
      reached = await this.risk.writesReached(plan.object.name);
    } catch (error) {
      // no cross-reference, no verdict: every class runs alone and unguarded,
      // which is what an undeclared one gets, and the discovery still answers
      return {...plan, writes: [], writesTotal: 0, riskError: String(error?.message ?? error),
        classes: plan.classes.map((testClass) => ({...testClass, schedule: "dangerous", guard: false}))};
    }
    return {
      ...plan,
      writes: reached.writes,
      writesTotal: reached.total,
      dynamicCalls: reached.dynamicCalls,
      dynamicCallsTotal: reached.dynamicCallsTotal,
      classes: plan.classes.map((testClass) => {
        const schedule = scheduledRisk(testClass, [...reached.writes, ...(reached.dynamicCalls ?? [])]);
        return {...testClass, schedule, guard: schedule === "harmless"};
      }),
    };
  }

  // the run itself, in this process. Every method is timed and every throw
  // is caught, because one failure must not hide the methods after it: ADT
  // reports the whole tree, not the first thing that went wrong.
  async run(type, name, options = {}) {
    const started = Date.now();
    // a detached run is handed the plan the parent already parsed, because
    // parsing the system again in the child costs seconds and answers the
    // same
    const {object, classes} = options.plan ?? this.classes(type, name);
    const wanted = (c) => options.testClass === undefined || c.name === String(options.testClass).toUpperCase();
    const wantedMethod = (m) => options.method === undefined || m.name === String(options.method).toUpperCase();

    const program = {
      name: object.name,
      type: ADT_TYPE[object.type] ?? object.type,
      objectType: object.type,
    };
    const output = join(this.store.root, "output");
    if (existsSync(join(output, "init.mjs")) === false) {
      throw new NotTranspiled();
    }
    // the runtime and its database: in this process it is the one the
    // caller already booted, which is why the façade runs a test in a
    // child rather than over its own live data (see runDetached)
    await this.store.data().boot();
    installUnitAssert(globalThis.abap);

    const testClasses = [];
    for (const declared of classes.filter(wanted)) {
      const testClass = {...declared, testMethods: [], alerts: []};
      delete testClass.module;
      const file = join(output, declared.module);
      if (existsSync(file) === false) {
        testClass.alerts.push({
          kind: "exception",
          severity: "fatal",
          title: `${declared.name} has not been transpiled: ${declared.module} is not in output/`,
          details: ["Activate the object, or run the transpile, and ask again."],
          stack: [],
        });
        testClasses.push(testClass);
        options.onClassEnd?.(testClass);
        continue;
      }
      // The runtime guard (the first consumer of the database hooks,
      // tools/osd-dialog-step.mjs): a class scheduled as HARMLESS runs with
      // its writes to DDIC tables failing, from class_setup to
      // class_teardown. The failure is a JavaScript error, not an ABAP
      // exception, so a CATCH in the test does not swallow it.
      const guarded = declared.guard === true;
      const unguard = guarded ? hookDatabase("abap-unit-risk-guard", {
        write(operation, table) {
          throw new HarmlessWrote(declared.name, operation, table);
        },
      }) : undefined;
      try {
        let local;
        try {
          const module = await import(specifier(file));
          local = module[declared.localClass];
          if (local === undefined) {
            throw new Error(`${declared.localClass} is not exported by ${declared.module}`);
          }
          if (local.class_setup) {
            await local.class_setup();
          }
        } catch (error) {
          testClass.alerts.push(this.#alert(error, "class_setup"));
          testClasses.push(testClass);
          options.onClassEnd?.(testClass);
          continue;
        }

        for (const method of declared.testMethods.filter(wantedMethod)) {
          options.onMethodStart?.(declared.name, method.name);
          const result = await this.#method(local, method, options);
          testClass.testMethods.push(result);
          options.onMethodEnd?.(result);
        }

        try {
          if (local.class_teardown) {
            await local.class_teardown();
          }
        } catch (error) {
          testClass.alerts.push(this.#alert(error, "class_teardown"));
        }
        testClasses.push(testClass);
        options.onClassEnd?.(testClass);
      } finally {
        unguard?.();
      }
    }

    const methods = testClasses.flatMap((c) => c.testMethods);
    const failed = methods.filter((m) => m.alerts.length > 0).length;
    return {
      program,
      testClasses,
      counts: {
        classes: testClasses.length,
        methods: methods.length,
        passed: methods.length - failed,
        failed,
        classAlerts: testClasses.reduce((n, c) => n + c.alerts.length, 0),
      },
      ok: failed === 0 && testClasses.every((c) => c.alerts.length === 0),
      ms: Date.now() - started,
    };
  }

  // one method: setup, the method, teardown, each of them able to fail on
  // its own. The instance is new every time, the way ABAP Unit does it.
  async #method(local, declared, options) {
    const started = Date.now();
    const alerts = [];
    let test;
    try {
      options.onStage?.("setup");
      test = await (new local()).constructor_();
      await call(test, "setup");
    } catch (error) {
      alerts.push(this.#alert(error, "setup"));
    }
    if (alerts.length === 0) {
      try {
        options.onStage?.("execution");
        const run = test.FRIENDS_ACCESS_INSTANCE[declared.method]();
        await (options.timeout === 0 ? run : deadline(run, options.timeout ?? 60000, declared.name));
      } catch (error) {
        alerts.push(this.#alert(error, declared.method));
      }
      try {
        options.onStage?.("teardown");
        await call(test, "teardown");
      } catch (error) {
        alerts.push(this.#alert(error, "teardown"));
      }
    }
    const ms = Date.now() - started;
    return {
      name: declared.name,
      type: "TEST/M",
      executionTime: (ms / 1000).toFixed(3),
      unit: "s",
      ms,
      line: declared.line,
      column: declared.column,
      alerts,
    };
  }

  // a thrown thing becomes an alert, with the stack read back through the
  // source maps first
  #alert(error, where) {
    if (error instanceof HarmlessWrote) return {...guardAlert(error.testClass, error.table, this.#stack(error)), stage: where};
    return alertOf(error, where, this.#stack(error));
  }

  // the JS stack, back through the source maps, so an entry names the ABAP
  // file and line rather than the module the transpiler wrote. Only the
  // transpiled modules are kept: the frames of this runner are ours, not
  // the developer's, and a client would only have to scroll past them.
  #stack(error) {
    const out = [];
    // Node resolves imported generation symlinks. Stack paths name the
    // generation's output, so compare against that directory as well.
    const output = join(this.store.root, "output");
    const resolvedOutput = realpathSync(output);
    for (const line of String(error?.stack ?? "").split("\n").slice(1, 20)) {
      const at = /\((?:file:\/\/)?([^()]+\.mjs):(\d+):(\d+)\)/.exec(line) ?? /at (?:async )?(?:file:\/\/)?([^ ()]+\.mjs):(\d+):(\d+)/.exec(line);
      if (at === null) {
        continue;
      }
      const [, file, row, column] = at;
      if ([output, resolvedOutput].some(path => decodeURIComponent(file).startsWith(path + "/")) === false) {
        continue;
      }
      const mapped = this.#map(file, Number(row), Number(column));
      const entry = mapped ?? {name: `${basename(file)}, line ${row}`, uri: basename(file), line: Number(row)};
      // the same line twice, once from where it was raised and once from
      // the frame that raised it, reads as noise
      if (out.at(-1)?.name !== entry.name) {
        out.push(entry);
      }
    }
    return out;
  }

  // the mapping itself lives in osd-where.mjs, which is the only copy: two
  // copies of a thing whose whole job is to be accurate is how they stop
  // agreeing. Only the shape the facade wants is built here.
  #map(file, row, column) {
    const found = resolveFrame(file, row, column);
    if (found === undefined) {
      return undefined;
    }
    return {name: `${found.file}, line ${found.line}`, uri: found.file, line: found.line, column: found.column};
  }

  // the run the façade wants: a child process, because a test writes to the
  // database and the server's own rows must not be what it writes to. The
  // child boots its own runtime, about a second, against its own in-memory
  // database, and prints the same object as JSON.
  runDetached(type, name, options = {}) {
    const started = Date.now();
    const plan = options.plan ?? this.classes(type, name);
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new Error("ABAP Unit run cancelled"));
        return;
      }
      const args = [type, name, "--json", "--plan-stdin"];
      if (options.timeout !== undefined) args.push("--timeout", String(options.timeout));
      if (options.testClass !== undefined) {
        args.push("--class", options.testClass);
      }
      if (options.method !== undefined) {
        args.push("--method", options.method);
      }
      const {env, ownPath} = unitChildEnv(options);
      const [cmd, ...argv] = unitCommand(fileURLToPath(new URL(import.meta.url)), args);
      const child = spawn(cmd, argv, {
        cwd: this.store.root,
        stdio: ["pipe", "pipe", "pipe", "ipc"],
        env,
      });
      let killTimer, testTimer, timedOut, current, stage, methodStarted;
      const completed = [], methods = [];
      const abort = () => {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
        killTimer.unref();
      };
      // A parent watchdog can interrupt a synchronous ABAP loop. The
      // child's Promise deadline alone cannot run while its event loop is busy.
      child.on("message", message => {
        try {
          if (timedOut) return;
          if (message.kind === "unit-method-start") {
            current = message;
            methodStarted = Date.now();
            stage = "setup";
            if (options.timeout > 0) testTimer = setTimeout(() => {
              timedOut = {...current, stage, ms: Date.now() - methodStarted};
              abort();
            }, options.timeout);
          } else if (message.kind === "unit-stage") stage = message.stage;
          else if (message.kind === "unit-method-end") {
            clearTimeout(testTimer);
            methods.push(message.method);
          } else if (message.kind === "unit-class-end") {
            completed.push(message.testClass);
            methods.length = 0;
          }
        } catch (error) { abort(); reject(error); }
      });
      options.signal?.addEventListener("abort", abort, {once: true});
      if (options.signal?.aborted) abort();
      const tidy = () => {
        if (ownPath === undefined) {
          return;
        }
        for (const suffix of ["", "-wal", "-shm", ".forking"]) {
          rmSync(ownPath + suffix, {force: true});
        }
      };
      child.stdin.on("error", (error) => {
        if (!options.signal?.aborted) reject(error);
      });
      child.stdin.end(JSON.stringify(plan));
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => {
        out += d.toString();
      });
      child.stderr.on("data", (d) => {
        err += d.toString();
      });
      child.on("close", (code) => {
        try {
          options.signal?.removeEventListener("abort", abort);
          clearTimeout(killTimer);
          clearTimeout(testTimer);
          tidy();
          if (options.signal?.aborted) {
            reject(new Error("ABAP Unit run cancelled"));
            return;
          }
          // A watchdog can fire after the child printed its final result,
          // before close is delivered. Only an explicit run abort overrides JSON.
          const start = out.indexOf("{");
          if (start >= 0) {
            try { resolve(JSON.parse(out.slice(start))); return; }
            catch (error) {
              if (!timedOut) throw new RunFailed(code, `${error.message}: ${`${out}${err}`.slice(-2000)}`);
            }
          }
          if (timedOut) {
            const declared = plan.classes.find(c => c.name === timedOut.testClass);
            const selected = declared.testMethods.filter(m => options.method === undefined || m.name === String(options.method).toUpperCase());
            const at = selected.findIndex(m => m.name === timedOut.method);
            const testMethods = [...methods, {name: timedOut.method, ms: timedOut.ms, alerts: [{
              kind: "timeout", severity: "fatal", stage: timedOut.stage,
              title: `${timedOut.method} did not finish within ${options.timeout} ms`, details: [], stack: [],
            }]}, ...selected.slice(at + 1).map(m => ({name: m.name, ms: 0, skipped: true, alerts: []}))];
            const testClasses = [...completed, {...declared, alerts: [], testMethods}];
            const allMethods = testClasses.flatMap(c => c.testMethods);
            resolve({program: {name, type: ADT_TYPE[type] ?? type, objectType: type}, testClasses, ok: false,
              counts: {classes: testClasses.length, methods: allMethods.length,
                passed: allMethods.filter(m => !m.skipped && !m.alerts.length).length,
                failed: allMethods.filter(m => m.alerts.length).length,
                classAlerts: testClasses.reduce((n, c) => n + c.alerts.length, 0)}, ms: Date.now() - started});
            return;
          }
          if (start < 0) {
            const failure = new RunFailed(code, `${out}${err}`.slice(-2000));
            const selected = plan.classes.filter(c => options.testClass === undefined || c.name === String(options.testClass).toUpperCase());
            if (selected.length === 1) {
              // A boot crash belongs to the sole class in this child. Other
              // targets can still run in fresh children; malformed JSON and
              // process/pipe failures remain runner/transport failures.
              resolve({program: {name, type: ADT_TYPE[type] ?? type, objectType: type}, ok: false,
                testClasses: [{...selected[0], testMethods: [], alerts: [{kind: "shortDump", severity: "fatal",
                  stage: "execution", title: failure.message, details: [], stack: []}]}],
                counts: {classes: 1, methods: 0, passed: 0, failed: 0, classAlerts: 1}, ms: Date.now() - started});
            } else reject(failure);
            return;
          }
        } catch (error) { reject(error); }
      });
      child.on("error", error => {
        options.signal?.removeEventListener("abort", abort);
        clearTimeout(killTimer); clearTimeout(testTimer);
        tidy(); reject(error);
      });
    });
  }
}

// A thrown thing becomes an alert. Three kinds, because a client shows them
// differently: an assertion that did not hold, an ABAP exception that
// nobody caught, and a failure of the runtime itself. Exported because the
// mapping is the interesting half and it can be checked without a runtime.
export function alertOf(error, where, stack = []) {
  const text = (value) => {
    const out = value?.get?.();
    return typeof out === "string" ? out.trimEnd() : undefined;
  };
  const details = [];
  // where the runtime says it was raised, unless the mapped stack already
  // starts there
  const raised = error?.EXTRA_CX;
  if (raised?.INTERNAL_FILENAME !== undefined) {
    const first = {name: `${raised.INTERNAL_FILENAME}, line ${raised.INTERNAL_LINE}`, uri: raised.INTERNAL_FILENAME, line: raised.INTERNAL_LINE};
    stack = stack[0]?.name === first.name ? stack : [first, ...stack];
  }

  const className = error?.constructor?.name;
  if (className === "kernel_cx_assert") {
    const expected = typeof error.expected?.get?.() === "string" ? error.expected.get() : undefined;
    const actual = typeof error.actual?.get?.() === "string" ? error.actual.get() : undefined;
    if (expected !== undefined && expected !== "") {
      details.push(`Expected [${expected}]`);
    }
    if (actual !== undefined && actual !== "") {
      details.push(`Actual [${actual}]`);
    }
    details.push(`Raised in ${where}`);
    return {kind: "failedAssertion", severity: "critical", stage: where,
      title: text(error.msg) ?? "Unit test assertion failed", details, stack,
      ...(error.assertion ? {assertion: error.assertion} : {}),
      ...(expected !== undefined ? {expected} : {}), ...(actual !== undefined ? {actual} : {})};
  }

  // an ABAP exception: the transpiled class is the name a developer knows
  if (error?.INTERNAL_ID !== undefined || typeof error?.get_text === "function") {
    const message = text(error.msg) ?? text(error.textid) ?? undefined;
    if (message !== undefined) {
      details.push(message);
    }
    details.push(`Raised in ${where}`);
    return {kind: "exception", severity: "critical", stage: where, title: `Exception ${(className ?? "unknown").toUpperCase()} was not caught`, details, stack};
  }

  details.push(`Raised in ${where}`);
  return {kind: error?.code === "TEST_TIMEOUT" ? "timeout" : "shortDump", severity: "fatal", stage: where,
    title: String(error?.message ?? error), details, stack};
}

// Where a failure really is.
//
// The transpiler maps a generated line to the position where the previous
// ABAP statement ended, so a stack entry read straight out of the map

// setup and teardown live in three places: the class, the friends instance
// the transpiler wraps it in, and the superclass of that
async function call(test, what) {
  if (test[what]) {
    await test[what]();
  }
  const friends = test.FRIENDS_ACCESS_INSTANCE;
  if (friends?.[what]) {
    await friends[what]();
  }
  if (friends?.SUPER?.[what]) {
    await friends.SUPER[what]();
  }
}

// a test that never returns must not take the request with it
function deadline(promise, ms, name) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`${name} did not finish within ${ms} ms`), {code: "TEST_TIMEOUT"})), ms);
    }),
  ]);
}

// abapGit writes a namespace as #, an import specifier needs it encoded
function specifier(file) {
  return "file://" + file.replaceAll("#", "%23");
}

function includeOf(filename) {
  const match = /\.clas\.(locals_def|locals_imp|macros|testclasses)\.abap$/.exec(filename);
  return match === null ? "main" : {locals_def: "definitions", locals_imp: "implementations", macros: "macros", testclasses: "testclasses"}[match[1]];
}

async function text(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// the runtime guard's refusal: a write by a class scheduled as HARMLESS
export class HarmlessWrote extends Error {
  constructor(testClass, operation, table) {
    super(`RISK LEVEL HARMLESS but wrote to ${table}`);
    this.testClass = testClass;
    this.operation = operation;
    this.table = table;
  }
}

function guardAlert(testClass, table, stack = []) {
  return {
    kind: "riskLevel",
    severity: "critical",
    title: `RISK LEVEL HARMLESS but wrote to ${table}`,
    details: [`${testClass} declares RISK LEVEL HARMLESS and ran in parallel with other tests; it wrote to ${table}.`,
      "Declare RISK LEVEL DANGEROUS (or CRITICAL), or keep the test off the database."],
    stack,
  };
}

export class NotTranspiled extends Error {
  constructor() {
    super("there is no output/ yet: the tests run against the transpiled runtime, so transpile first");
    this.code = "NOT_TRANSPILED";
  }
}

export class RunFailed extends Error {
  constructor(code, output) {
    super(`the test run exited with ${code} and printed no result: ${output}`);
    this.code = "RUN_FAILED";
  }
}

export async function main(args) {
  const [type, name] = args;
  if (name === undefined) {
    console.log("usage: osd-unit.mjs TYPE NAME [--class LTCL_X] [--method DOES_Y] [--json] [--detached]");
    return 2;
  }
  const at = (flag) => {
    const i = args.indexOf(flag);
    return i < 0 ? undefined : args[i + 1];
  };
  const send = message => { if (process.send) sendIPC(process, message); };
  const options = {testClass: at("--class"), method: at("--method"),
    ...(at("--timeout") !== undefined ? {timeout: Number(at("--timeout"))} : {}),
    onMethodStart: (testClass, method) => send({kind: "unit-method-start", testClass, method}),
    onMethodEnd: method => send({kind: "unit-method-end", method}),
    onStage: stage => send({kind: "unit-stage", stage}),
    onClassEnd: testClass => send({kind: "unit-class-end", testClass})};
  if (args.includes("--plan-stdin")) {
    options.plan = JSON.parse(await text(process.stdin));
  }
  const runner = new UnitRun();
  const result = args.includes("--detached")
    ? await runner.runDetached(type, name, options)
    : await runner.run(type, name, options);
  if (args.includes("--json")) {
    console.log(JSON.stringify(result, undefined, 1));
    return result.ok ? 0 : 1;
  }
  console.log(`${result.program.name}: ${result.counts.methods} methods in ${result.counts.classes} test classes, ${result.counts.passed} passed, ${result.counts.failed} failed, ${result.ms} ms`);
  for (const testClass of result.testClasses) {
    console.log(`  ${testClass.name} (${testClass.riskLevel}, ${testClass.durationCategory})`);
    for (const alert of testClass.alerts) {
      console.log(`    ! ${alert.title}`);
    }
    for (const method of testClass.testMethods) {
      console.log(`    ${method.alerts.length === 0 ? "ok  " : "FAIL"} ${method.name} ${method.executionTime}s`);
      for (const alert of method.alerts) {
        console.log(`         ${alert.kind}: ${alert.title}`);
        for (const detail of alert.details) {
          console.log(`         ${detail}`);
        }
        for (const entry of alert.stack.slice(0, 3)) {
          console.log(`         at ${entry.name}`);
        }
      }
    }
  }
  return result.ok ? 0 : 1;
}

if (runsAs("osd-unit.mjs")) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
    console.error(`${error.code ?? "ERROR"}: ${error.message}`);
    process.exit(1);
  });
}
