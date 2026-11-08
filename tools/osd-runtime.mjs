// The supervisor: what makes activated code actually run.
//
// A transpiled class becomes live only in a process that has not imported
// the old one, because Node pins a module graph for the life of a process
// and cache-busting one entry does not unpin the imports below it. So the
// serving runtime is a child (tools/osd-serve.mjs) and this replaces it.
//
// The order is deliberate and it is not the zero-downtime one. The old
// runtime is asked to go first, and only then does the new one start,
// because both of them would otherwise hold the same database file and the
// second to write would win. Correctness over a few hundred milliseconds:
// a recycle costs about a second, and the façade holds requests across it
// rather than failing them, which is what whenReady() is for.
//
// What this deliberately does not do: recycle on a write. Only a transpile
// that succeeded changes what a process would load, so only that is worth
// a new process.
//
// Every instance is (a source tree, a port, a database) and nothing here
// assumes there is one of them. Two of these can run side by side over two
// worktrees, which is what a branch under test would be.
import {randomBytes} from "node:crypto";
import {sendIPC, onIPCFailure} from "./osd-ipc.mjs";
import {attachStoreIPC} from "./osd-store-ipc.mjs";
// The serving supervisor launches runtime children while handling the local ADT session.
import {spawn} from "./osd-child-process.mjs";
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {liveHash} from "./osd-build.mjs";
import {exitHolds} from "./osd-exit-holds.mjs";
import {serveCommand} from "./osd-host.mjs";
import {runsAs} from "./osd-main.mjs";
import {inspectPortOf} from "./osd-inspector.mjs";

const CHILD = fileURLToPath(new URL("./osd-serve.mjs", import.meta.url));

// Every serving runtime this process started, so that none of them outlives
// it. A recycle kills the child it replaces, and nothing used to kill the
// last one when the supervisor itself went away: a long session left one
// process per run reparented to init, eight of them and 1.6 GB across three
// hours, found by vsp rather than by anything of ours. A child is not
// something to leave behind because the parent was not asked to tidy up.
const CHILDREN = new Set();

/** every serving child this process started and has not seen exit: for a
 *  test that must not leave one behind when the code under test is wrong */
export const liveChildren = () => [...CHILDREN];
export const servingStateSnapshot = () => liveChildren().map((child) => ({pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode}));
let reaperInstalled = false;

// The stop budget. The serving quiesce and the exit holds run side by side,
// so a stop takes the longest of them, not their sum: 55 s for serving
// children, within editors/vscode/launcher.js STOP_GRACE_MS (60 s). The
// exception is deliberate and older than this budget: a child still in its
// database step (tools/osd-boot-guard.mjs) keeps the boot limit,
// OSD_BOOT_TIMEOUT_MS or 15 min, because killing a seed half-way is worse
// than a late stop; then the stop can outlast the launcher's grace, and
// the launcher's SIGKILL may come first.
export const SERVING_QUIESCE_LIMIT_MS = 55000;
export const EXIT_HOLD_LIMIT_MS = 10000;

/** how long a stop waits for one serving child before it kills it */
export function quiesceLimitMs(child, env = process.env) {
  return child.osdDatabaseStep === true ? (Number(env.OSD_BOOT_TIMEOUT_MS) || 15 * 60 * 1000) : SERVING_QUIESCE_LIMIT_MS;
}

/** the longest a stop of these children can take (see above) */
export function stopBudgetMs(children, env = process.env) {
  return Math.max(EXIT_HOLD_LIMIT_MS, ...children.map((child) => quiesceLimitMs(child, env)));
}

/** quiesces `children` and waits for the exit holds alongside; resolves when
 *  both are done or past their limits. Called synchronously from a signal
 *  handler: the holds other handlers register in the same emit are counted. */
export async function stopChildren(children, {holdMs = EXIT_HOLD_LIMIT_MS, env = process.env} = {}) {
  // Let each worker finish its current request and close its database.
  // In particular DuckDB must checkpoint before the container exits.
  const quiesced = Promise.all(children.map(child => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, quiesceLimitMs(child, env));
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    sendIPC(child, {type: "quiesce", grace: 45000}, error => {
      if (error) child.kill("SIGTERM");
    });
  })));
  // Children another module started and killed on this signal (the warm
  // compiler's worker and verifier) are gone before the process is. The
  // supervisor's handler runs before theirs (it was installed first), so
  // their holds exist only once this emit is over: one turn first.
  await null;
  await Promise.all([quiesced, exitHolds(holdMs)]);
}

/** installs the supervisor's exit and signal handlers once (exported for
 *  test/warm-verifier.mjs, which signals a process that has them) */
export function reapOnExit() {
  if (reaperInstalled === true) {
    return;
  }
  reaperInstalled = true;
  const reap = () => {
    for (const child of CHILDREN) {
      try {
        child.kill("SIGKILL");
      } catch {
        // it is already gone, which is the outcome we wanted
      }
    }
    CHILDREN.clear();
  };
  let stopping = false;
  // exit handlers can only do synchronous work, and kill( ) is synchronous
  process.on("exit", reap);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      await stopChildren([...CHILDREN]);
      process.exit(0);
    });
  }
}

export class ServingRuntime {
  constructor(options = {}) {
    this.root = options.root ?? process.cwd();
    // the child by path under Node, `<binary> serve` when compiled
    this.command = options.command ?? serveCommand(CHILD);
    this.sourceBuild = options.command === undefined;
    // a fixed port for an instance someone has to reach by name; the
    // default is whatever the system gives, because a supervised runtime is
    // reached through the supervisor
    this.port = undefined;
    this.wanted = options.port;
    // where this instance's rows live. Two instances must not share one
    // file, and two runtimes of the same instance must not hold it at once,
    // which is why a recycle stops the old one first.
    this.database = options.database;
    this.env = options.env ?? {};
    this.adtSnapshot = options.adtSnapshot;
    this.adtCarry = undefined;
    // how long a starting child may say NOTHING (no output, no message)
    // before it counts as hung; a child that keeps saying it is booting
    // (tools/osd-serve.mjs sends "booting" every 5 s) is waited for up to
    // bootTimeout in all -- minutes on a remote HANA, not a request's 60 s
    this.timeout = options.timeout ?? 60000;
    this.bootTimeout = options.bootTimeout ?? (Number(process.env.OSD_BOOT_TIMEOUT_MS) || 15 * 60 * 1000);
    this.grace = options.grace ?? 2000;
    // epoch counts the processes this supervisor started; generation names
    // the code the current one runs — the live generation's hash when there
    // is one (tools/osd-build.mjs), the epoch as a string when there is not.
    // A recycle over unchanged code keeps its generation, which is the truth
    this.epoch = 0;
    this.generation = undefined;
    this.child = undefined;
    // the debugger on demand: undefined follows OSD_INSPECT, {port} is open,
    // null is closed on request (inspector() below)
    this.inspecting = undefined;
    this.ready = undefined;
    this.recycling = undefined;
    // the spawn in flight: a child exists before it says "ready", and
    // `running` only knows about a child that has said it
    this.starting = undefined;
    // a stop in flight: the child is no longer `running` from the moment it
    // is asked to go, and it holds the database until it has gone
    this.stopping = undefined;
    // how many stops were asked for: a recycle compares it to the count it
    // started with, and gives up when a stop arrived meanwhile
    this.stops = 0;
    // the exit of a child being stopped, whoever is stopping it
    this.exiting = undefined;
    // what the last unexpected death said, for a caller that wants to
    // report why nothing is serving rather than only that nothing is
    this.died = undefined;
  }

  // the address the façade proxies to; undefined until something is serving
  get url() {
    return this.port === undefined ? undefined : `http://127.0.0.1:${this.port}`;
  }

  get running() {
    return this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null;
  }

  // a promise that is resolved while a runtime is serving, pending while one
  // is being replaced, and rejected when there is none: the façade awaits
  // this before it forwards, so a request that arrives mid-recycle waits a
  // second instead of failing, and one that arrives after a crash is told
  // rather than sent to a port nothing is listening on
  whenReady() {
    return this.ready ?? Promise.reject(new NotServing());
  }

  // what every path that may spawn waits out first: a recycle (which has a
  // child of its own coming) and a stop (whose child still holds the
  // database). A spawn that did not wait them out was a second process on
  // the same file, found twice by review of #60.
  //
  // Returns nothing to await when nothing is busy, so the spawn that follows
  // happens in the same turn as the call -- a stop() on the next line then
  // finds it `starting` and stops it. And a stop asked for while this one
  // waited wins: what was asked before a stop is not started after it.
  #settled() {
    if ((this.recycling ?? this.stopping) === undefined) {
      return undefined;
    }
    const stops = this.stops;
    return (async () => {
      for (;;) {
        const busy = this.recycling ?? this.stopping;
        if (busy === undefined) break;
        await busy.catch(() => undefined);
      }
      if (this.stops !== stops) {
        throw new NotServing("stopped while this was waiting to start");
      }
    })();
  }


  async start() {
    const settling = this.#settled();
    if (settling !== undefined) await settling;
    if (this.running === true) {
      return {url: this.url, generation: this.generation, epoch: this.epoch, pid: this.child?.pid, started: false};
    }
    return this.#spawn();
  }

  // **One child at a time, counting the one that is still coming up.**
  // `running` is true only once a child has said "ready", so between the
  // spawn and that message a second caller -- an OData request, the status
  // refresh, a healthcheck -- saw "nothing is serving" and spawned another
  // child over the same database. SQLite tolerates two processes on one
  // file; DuckDB does not, and the file came back unreadable on the next
  // start ("Failed to deserialize: field id mismatch"). The window was a
  // second wide until the start-up grew by the cross-reference parse
  // (tools/osd-xref-seed.mjs), and then the image's DuckDB check fell in it.
  // Every path that spawns goes through here and joins the spawn in flight.

  // what a proxy wants when it does not care why nothing is serving: a
  // runtime, now. It waits out a recycle, starts one after a crash, and is
  // idempotent while one is up. The crash is not hidden, because the
  // generation it answers with is a new one.
  async ensure() {
    const settling = this.#settled();
    if (settling !== undefined) await settling;
    if (this.running === true) {
      return this.whenReady();
    }
    return this.#spawn();
  }

  // the old one goes, the new one comes up, and the caller learns when the
  // code it activated is the code that answers
  // **A stop wins over a recycle, and neither waits for the other.** The
  // order is decided when each is asked for, never by awaiting:
  //
  //   - recycle() asked while a stop is in progress is refused at once;
  //   - stop() asked while a recycle is in progress counts itself (`stops`),
  //     and the recycle checks that count after every await and before it
  //     spawns, and gives up; a child the recycle had already started is
  //     `starting`, which the stop waits for and then stops.
  //
  // The first version had stop() await the recycle and the recycle await
  // the stop, and `recycle(); stop();` never settled (found by review of
  // #60) -- with every later start() and ensure() stuck behind them.
  // A warm build's modules, loaded into the running process instead of
  // replacing it (tools/osd-hot.mjs). Only onto the generation the build
  // started from: a delta applied to another base is not that generation.
  // Rejects when the process is changing hands or the swap fails; the
  // caller recycles then.
  async hot(swap) {
    const child = this.child;
    if (this.running !== true || this.recycling !== undefined || this.stopping !== undefined) {
      throw new NotServing("nothing to swap into");
    }
    if (swap.from !== undefined && swap.from !== this.generation) {
      throw new Error(`the runtime carries ${this.generation}, and the swap is from ${swap.from}`);
    }
    const id = (this.hotSeq = (this.hotSeq ?? 0) + 1);
    const done = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.off("message", onMessage);
        reject(new Error("the warm swap did not answer within 30 s"));
      }, 30000);
      const onMessage = (message) => {
        if (message?.type !== "hot-done" || message.id !== id) {
          return;
        }
        child.off("message", onMessage);
        clearTimeout(timer);
        if (message.ok === true) {
          resolve(message);
        } else {
          reject(new Error(`the warm swap failed: ${message.error}`));
        }
      };
      child.on("message", onMessage);
      sendIPC(child, {type: "hot", id, generation: swap.generation, modules: swap.modules, only: swap.only, xrefRows: swap.xrefRows, verified: swap.verified === true}, error => {
        if (!error) return;
        child.off("message", onMessage);
        clearTimeout(timer);
        reject(error);
      });
    });
    this.generation = swap.generation;
    this.swaps = done.swaps;
    return done;
  }

  // The debugger on demand (tools/osd-inspector.mjs). `open` opens the
  // serving child's inspector on 127.0.0.1:<port> now, and every child this
  // runtime starts afterwards -- a recycle, a restart -- opens it at its
  // start on the same port, where a debugger attached with `restart` finds
  // it again. `open: false` closes it and keeps it closed, OSD_INSPECT
  // notwithstanding. Answers {open, port, url} ({pending: true} when no
  // child is serving yet: the next one opens it).
  //
  // **The serving child never calls node:inspector's close().** close()
  // joins the inspector's I/O thread, and that thread ends only when every
  // attached debugger has finished the WebSocket close handshake: until
  // then the child's event loop is blocked -- no IPC, no HTTP -- for as long
  // as the debugger takes, which is forever for one that does not answer
  // (Node documents close() as blocking; same on Node 22, 24 and 26). That
  // was the CI flake of test/osd-child.mjs: its CDP socket was still
  // closing when the door closed the inspector, and the child froze inside
  // close(). Recovering from a frozen close (kill it, checkpoint first, tell
  // a wedge from a busy child) grew a new edge with every review, so the
  // close is not made at all: closing, or moving to another port, is an
  // ordinary graceful recycle -- quiesce with its grace, commit, carry and
  // the exit-time save, then a new child started with the inspector off or
  // on the new port. Opening stays in-process: open() does not block. The
  // answer comes once the old child has exited ({recycled: true,
  // recovering: true}); /osd/ready says when the new one serves, so a
  // caller with a deadline (the VS Code extension's 15 s) is not held for
  // a boot.
  async inspector({open, port} = {}) {
    if (open === true && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      throw new Error(`invalid inspector port: ${port}`);
    }
    const before = this.inspecting;
    const requested = open === true ? {port} : null;
    this.inspecting = requested;
    const child = this.child;
    if (this.running !== true || child === undefined || this.starting !== undefined || this.stopping !== undefined) {
      return {open: open === true, port: open === true ? port : undefined, pending: true};
    }
    // what the serving child has open: the port it was started with, or the
    // one it opened on request (osdInspectPort, set in #spawnOne and below)
    const current = child.osdInspectPort;
    if (open !== true && current === undefined) {
      return {open: false, port: undefined, url: undefined};
    }
    if (open !== true || (current !== undefined && current !== port)) {
      const gone = child.exitCode !== null || child.signalCode !== null ? Promise.resolve()
        : new Promise((resolve) => child.once("exit", resolve));
      // its failure is what /osd/ready and the next request report
      this.recycle().catch(() => undefined);
      await gone;
      return {open: open === true, port: open === true ? port : undefined, url: undefined, recycled: true, recovering: true};
    }
    return this.#openInspector(child, port).catch((error) => {
      // A failed older request must not undo a newer desired state.
      if (this.inspecting === requested) this.inspecting = before;
      throw error;
    });
  }

  #openInspector(child, port) {
    const current = child.osdInspectPort;
    const id = (this.inspectSeq = (this.inspectSeq ?? 0) + 1);
    // counted as open from the moment it is asked: a request a busy child
    // answers after the timeout below still opens it, and a close must then
    // still recycle rather than believe there is nothing to close
    child.osdInspectPort = port;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.off("message", onMessage);
        child.off("exit", onExit);
        reject(new Error("the serving process did not answer the inspector request within 10 s"));
      }, 10000);
      const onMessage = (message) => {
        if (message?.type !== "inspector-done" || message.id !== id) {
          return;
        }
        child.off("message", onMessage);
        child.off("exit", onExit);
        clearTimeout(timer);
        if (message.ok === true) resolve(message);
        else {
          // refused (no V8 inspector, a bad host): nothing was opened
          child.osdInspectPort = current;
          reject(new Error(message.error));
        }
      };
      // a child recycled away answers nothing: do not hold the caller 10 s
      const onExit = () => {
        child.off("message", onMessage);
        clearTimeout(timer);
        reject(new Error("the serving process exited before it answered the inspector request"));
      };
      child.on("message", onMessage);
      child.once("exit", onExit);
      sendIPC(child, {type: "inspector", id, open: true, port}, error => {
        if (!error) return;
        child.off("message", onMessage);
        child.off("exit", onExit);
        clearTimeout(timer);
        reject(error);
      });
    }).then((done) => {
      child.osdInspectPort = done.port;
      return {open: done.open, port: done.port, url: done.url};
    });
  }

  // a cold transpile of the same inputs gave the same bytes (osd-warm verify)
  verified(generation) {
    if (this.running === true && this.generation === generation) {
      sendIPC(this.child, {type: "verified", generation});
    }
  }

  async recycle() {
    if (this.recycling !== undefined) {
      return this.recycling;
    }
    if (this.stopping !== undefined) {
      throw new NotServing("a stop is in progress; there is nothing to recycle");
    }
    const stops = this.stops;
    const stopped = () => {
      if (this.stops !== stops) throw new NotServing("stopped while recycling");
    };
    this.recycling = (async () => {
      const began = Date.now();
      let pending;
      this.ready = new Promise((resolve, reject) => {
        pending = {resolve, reject};
      });
      // nobody is waiting on this promise yet if the façade is idle, and an
      // unhandled rejection would take the process down with it
      this.ready.catch(() => undefined);
      try {
        // a child still coming up is a child: let it finish, then stop it,
        // rather than start a second one beside it
        await this.starting?.catch(() => undefined);
        stopped();
        // Parent callbacks hold the child's FIFO. Quiescing before they
        // finish can exhaust the grace and discard all ADT carry rows.
        // Bound this wait; stop() still quiesces immediately and wins.
        const drainUntil = Date.now() + this.grace + 8000;
        while (this.adtContexts?.size > 0 && Date.now() < drainUntil) {
          await new Promise(resolve => setTimeout(resolve, Math.min(10, drainUntil - Date.now())));
          stopped();
        }
        await this.#stopChild();
        stopped();
        const answer = await this.#spawn({announce: pending});
        // a stop that came while this one was coming up stops it, and a
        // recycle whose process is being stopped did not recycle anything.
        // Known and accepted (review of #60): when the stop overtakes a
        // spawn that succeeded, this rejects with "stopped while recycling"
        // although the new code did load and may have served requests in the
        // meantime. The caller hears that the recycle does not stand, which
        // is true once the stop has taken the process; it is not told that
        // the new generation was briefly live
        stopped();
        return {...answer, ms: Date.now() - began, recycled: true};
      } catch (error) {
        // whoever is waiting hears why; the next caller hears "nothing is
        // serving", because a stale error that never clears is a worse
        // answer than the plain truth
        pending.reject(error);
        this.ready = undefined;
        throw error;
      } finally {
        this.recycling = undefined;
      }
    })();
    return this.recycling;
  }

  async stop() {
    if (this.stopping !== undefined) {
      return this.stopping;
    }
    // counted before the first await, so a recycle in progress sees it
    this.stops += 1;
    const stopping = (async () => {
      // a child still booting is asked to go now rather than waited for: on
      // a remote HANA its boot takes minutes (tools/osd-serve.mjs exits on
      // "quiesce" until it serves)
      // (SIGTERM rather than a message, which can arrive before the child
      // listens: tools/osd-serve.mjs exits on it at once while booting, or
      // at the end of the database step if it is in it)
      const booting = this.bootingChild;
      if (booting !== undefined && booting.exitCode === null && booting.signalCode === null) {
        this.stoppedBooting = booting;
        booting.kill("SIGTERM");
        // outside the database step it goes at once and this is only the
        // insistence; inside it, the child finishes the step first, however
        // long a remote seed takes -- a hung one is still ended by the boot
        // limit, which stays armed until it exits (not by the silence limit:
        // the heartbeat is a timer and goes on while a HANA call hangs)
        if (booting.osdDatabaseStep !== true) {
          const kill = setTimeout(() => booting.kill("SIGKILL"), this.grace + 8000);
          kill.unref?.();
        }
      }
      // a child still coming up would outlive a stop that only looked at the
      // ready one -- including the one a recycle has just started
      await this.starting?.catch(() => undefined);
      await this.#stopChild();
      // and a child somebody else is already stopping (a recycle's) holds
      // the database until it has gone
      await this.exiting;
      this.ready = undefined;
      this.port = undefined;
    })();
    this.stopping = stopping;
    try {
      await stopping;
    } finally {
      if (this.stopping === stopping) this.stopping = undefined;
    }
  }

  #spawn(options = {}) {
    if (this.starting !== undefined) {
      // joined, and whoever waits on the announcement still hears it. Only
      // then: a `.then(undefined, undefined)` is a derived promise that
      // rejects with the spawn and that nobody catches -- an unhandled
      // rejection, which ends the process (found by review of #60)
      if (options.announce !== undefined) {
        this.starting.then(options.announce.resolve, options.announce.reject);
      }
      return this.starting;
    }
    const stops = this.stops;
    const starting = (async () => {
      if (this.sourceBuild && options.announce === undefined && !(this.env.OSD_OUTPUT ?? process.env.OSD_OUTPUT)) {
        const {ensureSourceBuild} = await import("./osd-source-build-view.mjs");
        await ensureSourceBuild(this.root, {OSD_OUTPUT: undefined, OSD_GENERATION: undefined});
      }
      if (this.stops !== stops) throw new NotServing("stopped while building");
      let answer = await this.#spawnOne();
      // Spawn captures the inspector env, but requests can change it while
      // that child boots. Read the desired state again before announcing
      // readiness, and repeat if another request arrives during reconciliation.
      for (;;) {
        if (this.stops !== stops) throw new NotServing("stopped while starting");
        const desired = this.inspecting === null ? undefined
          : this.inspecting?.port ?? inspectPortOf(process.env.OSD_INSPECT);
        const current = this.child?.osdInspectPort;
        if (current === desired) break;
        if (current === undefined) {
          const wanted = this.inspecting;
          try {
            await this.#openInspector(this.child, desired);
          } catch (error) {
            // a child that serves without the inspector is better than one
            // that never announces itself: the caller already has its
            // `pending` answer and sees the endpoint missing. The desired
            // state follows what the child has, unless a newer request came.
            console.error(`inspector not opened on the new runtime: ${error.message}`);
            if (this.inspecting !== wanted) continue;
            const has = this.child?.osdInspectPort;
            this.inspecting = has === undefined ? null : {port: has};
            break;
          }
        } else {
          await this.#stopChild();
          if (this.stops !== stops) throw new NotServing("stopped while starting");
          answer = await this.#spawnOne();
        }
      }
      this.ready = Promise.resolve(answer);
      options.announce?.resolve(answer);
      return answer;
    })();
    this.starting = starting;
    const clear = () => {
      if (this.starting === starting) this.starting = undefined;
    };
    starting.then(clear, clear);
    return starting;
  }

  #spawnOne() {
    // Capture at spawn, before child IPC. The temporary parent provider
    // reads both SQLite tables in one statement without queuing behind a
    // publication step that can itself be waiting for this boot.
    const carryEnabled = (this.env.OSD_ADT_ONE_RUNTIME ?? process.env.OSD_ADT_ONE_RUNTIME) === "1";
    const snapshot = Promise.resolve().then(() => carryEnabled ? this.adtSnapshot?.() : undefined);
    snapshot.catch(() => undefined);
    return new Promise((resolve, reject) => {
      const epoch = this.epoch + 1;
      const generation = liveHash(this.root) ?? String(epoch);
      // OSD_INSPECT=<port>: the child, not this process, opens the V8
      // inspector -- it is the one that runs the transpiled ABAP (this one
      // is the supervisor or the façade, which never does). Setting
      // NODE_OPTIONS on the whole shell before `npm start` would hand
      // --inspect to both processes on the same fixed port, and the second
      // one to bind loses silently ("address already in use", checked by
      // hand): the façade would get the inspector and the ABAP would not.
      // So this is the child's env only, folded onto whatever NODE_OPTIONS
      // this instance already carries (this.env, then process.env) rather
      // than replacing it.
      // ... or the inspector this runtime was asked to open (inspector()
      // above), which a recycle carries to the next child; closed on
      // request means closed, whatever the environment says
      const inspectPort = this.inspecting === null ? undefined
        : this.inspecting?.port ?? inspectPortOf(process.env.OSD_INSPECT);
      const nodeOptions = [
        this.env.NODE_OPTIONS ?? process.env.NODE_OPTIONS,
        inspectPort ? `--inspect=127.0.0.1:${inspectPort} --enable-source-maps` : undefined,
      ].filter((s) => s !== undefined && s !== "").join(" ");
      const oneRuntime = process.env.OSD_ADT_ONE_RUNTIME === "1" || this.env.OSD_ADT_ONE_RUNTIME === "1";
      this.adtStepKey = oneRuntime ? randomBytes(32).toString("hex") : undefined;
      const child = spawn(this.command[0], this.command.slice(1), {
        cwd: this.root,
        env: {
          ...process.env,
          // the tree, the port and the database are this instance's, and the
          // child is told rather than assuming
          OSD_ROOT: this.root,
          ...(this.wanted === undefined ? {} : {OSD_SERVE_PORT: String(this.wanted)}),
          ...(this.database === undefined ? {} : {STG_DB_PATH: this.database}),
          ...this.env,
          ...(this.adtStepKey === undefined ? {} : {OSD_ADT_STEP_KEY: this.adtStepKey}),
          OSD_GENERATION: generation,
          OSD_ADT_CARRY: carryEnabled ? "1" : "0",
          ...(nodeOptions === "" ? {} : {NODE_OPTIONS: nodeOptions}),
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      // the inspector this child was started with (inspector() above)
      child.osdInspectPort = inspectPort || undefined;
      child.on("message", (message) => {
        if (message?.type === "adt-carry") this.adtCarry = message.state;
        if (message?.type === "adt-state-request") {
          snapshot.then((state) => {
            sendIPC(child, {type: "adt-state", state: state ?? this.adtCarry,
              replace: state !== undefined});
          }, (error) => {
            console.error(`ADT snapshot failed: ${error.message}`);
            sendIPC(child, {type: "adt-state"});
          });
        }
      });
      if (process.env.OSD_ADT_ONE_RUNTIME === "1" || this.env.OSD_ADT_ONE_RUNTIME === "1") attachStoreIPC(child, this);
      reapOnExit();
      CHILDREN.add(child);

      // The tail of what the child said, and only the tail: every reader of
      // it below asks for the last 2000 characters. Keeping the whole log
      // instead cost about 2.5 KB a second for as long as a work process
      // served the demo, which writes a line a frame — found by profiling
      // (docs/demo-profile.md), never by a failure, because it costs no
      // frame time and only memory.
      const TAIL = 4000;
      let out = "";
      const say = (d) => {
        out += d.toString();
        if (out.length > TAIL * 2) out = out.slice(-TAIL);
      };
      child.stdout.on("data", say);
      child.stderr.on("data", say);

      // **What the child asks to have said, said.**
      //
      // Its stdout is captured into the tail above and printed nowhere: the
      // tail exists to explain a failure to start, and it is capped because
      // a work process serving the demo writes a line a frame
      // (docs/demo-profile.md). So everything the runtime said in a healthy
      // process -- the ICF registry's "kept aside" and "no object explains
      // it", every `runtime error:` line -- was produced, returned and seen
      // by nobody. "Never silently" is half the drift rule and it did not
      // hold in the configuration that actually serves.
      //
      // Forwarding the stream would reopen the cost the cap was measured
      // against, so the child **chooses**: a line it sends over the IPC
      // channel it already has is a line it says must be seen. That is not
      // a filter guessing which lines matter -- the writer decides, which is
      // the only party that can.
      child.on("message", (message) => {
        if (message?.type === "say" && typeof message.line === "string") {
          console.log(`[runtime] ${message.line}`);
        }
      });

      // **Refused once it has gone, not when it was told to go.** Rejecting
      // at the kill ended the spawn in flight while the child still held
      // the database, and an ensure() in that window started another.
      // **Silence, not slowness.** Two limits: `timeout` of silence (any
      // output or message resets it) and `bootTimeout` in all. A boot that
      // keeps talking is a boot, however long; one that says nothing for a
      // minute is hung. Progress goes to the log every 30 s, so a person
      // waiting on a remote database sees what it is doing.
      let timedOut;
      let phase = "starting";
      const bootStarted = Date.now();
      // what a proxy or /osd/serving can tell a client meanwhile
      this.booting = {phase, since: bootStarted, pid: child.pid};
      this.bootingChild = child;
      const giveUp = (why) => {
        timedOut = new NotServing(`the serving runtime ${why}: ${out.slice(-2000)}`);
        child.kill("SIGKILL");
      };
      let timer;
      // once "ready" (or gone) the boot is over: output after that is serving,
      // and must never re-arm a limit meant for starting
      let booted = false;
      const heard = () => {
        if (booted) return;
        // when the boot last said anything: a publish waiting for this
        // runtime to change hands waits on that, not on a fixed limit
        // (ObjectStore#bounded)
        if (this.bootingChild === child) this.booting.heard = Date.now();
        clearTimeout(timer);
        timer = setTimeout(() => giveUp(`said nothing for ${this.timeout} ms while starting (last: ${phase})`), this.timeout);
        timer.unref?.();
      };
      heard();
      const deadline = setTimeout(() => giveUp(`did not start within ${this.bootTimeout} ms (last: ${phase})`), this.bootTimeout);
      deadline.unref?.();
      const progress = setInterval(() => {
        console.log(`[runtime] still starting after ${Math.round((Date.now() - bootStarted) / 1000)} s: ${phase}`);
      }, 30000);
      progress.unref?.();
      const stopTimers = () => {
        booted = true;
        if (this.bootingChild === child) {
          this.booting = undefined;
          this.bootingChild = undefined;
        }
        clearTimeout(timer);
        clearTimeout(deadline);
        clearInterval(progress);
      };
      child.stdout.on("data", heard);
      child.stderr.on("data", heard);
      child.on("message", (message) => {
        if (message?.type === "booting" || message?.type === "say") {
          // the step comes from "booting" only; a line said meanwhile is news,
          // not the step (a seed's report would otherwise rename it)
          if (message.type === "booting" && typeof message.phase === "string") {
            phase = message.phase;
            // in the database step a stop is waited out by the child
            // (tools/osd-boot-guard.mjs), and must not be SIGKILLed meanwhile
            child.osdDatabaseStep = message.database === true;
            if (this.bootingChild === child) this.booting = {...this.booting, phase, last: message.last, database: child.osdDatabaseStep};
          }
          heard();
        }
      });

      // **`on`, not `once`, and that distinction cost every test in this
      // file.** The channel carried one kind of message for as long as it
      // existed, so `once` was the same thing as `on` with a guard -- until
      // the child started sending `{type: "say"}` before it is ready. The
      // first message then consumed the listener, the guard returned early,
      // and `ready` was never heard: ten tests failed with "the serving
      // runtime did not answer within 60000 ms", quoting the very line that
      // had eaten the listener.
      //
      // A handler removed by arrival rather than by content is a handler
      // that assumes the channel has one subject. This one takes itself off
      // when it has what it waited for.
      const onMessage = (message) => {
        if (message?.type !== "ready") {
          return;
        }
        // given up on already: its "ready" comes too late to count
        if (timedOut !== undefined) return;
        child.off("message", onMessage);
        stopTimers();
        // Consumed carry must not resurrect stale rows after a later crash.
        this.adtCarry = undefined;
        this.died = undefined;
        this.child = child;
        this.port = message.port;
        this.epoch = epoch;
        this.generation = generation;
        // a new process has taken no warm swaps (tools/osd-hot.mjs)
        this.swaps = 0;
        registryUpdate(this.root, (list) => [...list.filter((e) => e.pid !== message.pid), {
          pid: message.pid, port: this.port, generation, root: this.root, database: this.database ?? "memory", since: new Date().toISOString(),
        }]);
        const answer = {url: this.url, port: this.port, generation, epoch, pid: message.pid, ms: message.ms, started: true};
        resolve(answer);
      };
      child.on("message", onMessage);
      const unhookChannel = onIPCFailure(child, error => {
        // A spawned process still owns its database until exit. Keep the
        // start pending while it leaves so ensure cannot overlap two owners.
        if (child.pid !== undefined) child.kill("SIGTERM");
        else { stopTimers(); CHILDREN.delete(child); reject(error); } // spawn failed: no exit follows
      });

      child.once("exit", (code, signal) => {
        unhookChannel();
        stopTimers();
        CHILDREN.delete(child);
        registryUpdate(this.root, (list) => list.filter((e) => e.pid !== child.pid));
        // a recycle and a stop clear this.child before the exit arrives, so
        // reaching here with it still set means the runtime died on its own.
        // Then the readiness goes too: it described a process that is gone,
        // and handing that address to a proxy is a success report for work
        // that is not happening.
        if (this.child === child) {
          this.child = undefined;
          this.port = undefined;
          if (this.recycling === undefined) {
            this.ready = undefined;
            this.died = {generation, epoch, code, signal, at: Date.now(), output: out.slice(-2000)};
          }
        }
        // an exit before "ready" is a runtime that could not come up, and
        // the output is the only explanation anyone will get
        const stopped = this.stoppedBooting === child;
        if (stopped) this.stoppedBooting = undefined;
        reject(timedOut ?? (stopped ? new NotServing("stopped while starting")
          : new NotServing(`the serving runtime exited (${signal ?? code}) before it answered: ${out.slice(-2000)}`)));
      });
    });
  }

  // ask, then insist. A runtime that will not go away holds the database
  // file the next one needs.
  #stopChild() {
    const child = this.child;
    this.child = undefined;
    this.port = undefined;
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve();
    }
    const exiting = new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      // insisted on, then waited for: a stop is over when the process is,
      // because until then it holds the database the next one opens
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, this.grace + 8000);
      child.once("exit", done);
      sendIPC(child, {type: "quiesce", grace: this.grace}, error => {
        // the channel is already gone; SIGTERM still lets the database save
        if (error) child.kill("SIGTERM");
      });
    });
    this.exiting = exiting;
    const clear = () => {
      if (this.exiting === exiting) this.exiting = undefined;
    };
    exiting.then(clear);
    return exiting;
  }
}

// The registry: which runtimes exist, so twenty of them are a list and not
// a surprise. One JSON file per tree under .local/, rewritten whole by the
// supervisor on every start and exit; `osd-runtime.mjs ps` reads it and
// says which entries still answer to their pid.
export function registryPath(root) {
  return join(root, ".local", "instances.json");
}

export function registryRead(root) {
  try {
    return JSON.parse(readFileSync(registryPath(root), "utf8"));
  } catch {
    return [];
  }
}

function registryUpdate(root, change) {
  try {
    mkdirSync(join(root, ".local"), {recursive: true});
    // a process that died without its supervisor (a SIGKILL in a test, a
    // crash) never removed itself; every write drops what no longer answers
    const living = registryRead(root).filter((e) => {
      try {
        process.kill(e.pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    writeFileSync(registryPath(root), JSON.stringify(change(living), null, 2) + "\n");
  } catch {
    // a tree without a writable .local/ is served all the same
  }
}

export function instances(root) {
  return registryRead(root).map((e) => {
    let alive = false;
    try {
      process.kill(e.pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    return {...e, alive};
  });
}

export class NotServing extends Error {
  constructor(message = "no serving runtime is up") {
    super(message);
    this.code = "NOT_SERVING";
  }
}

async function main(args) {
  if (args[0] === "ps") {
    const list = instances(process.cwd());
    if (list.length === 0) {
      console.log("no runtimes registered");
    }
    for (const e of list) {
      console.log(`${e.alive ? "*" : "†"} pid ${e.pid}  :${e.port}  ${e.generation}  ${e.database}  since ${e.since}`);
    }
    return 0;
  }
  const runtime = new ServingRuntime();
  const first = await runtime.start();
  console.log(`serving generation ${first.generation} on ${first.url} after ${first.ms} ms`);
  if (args.includes("--recycle")) {
    const again = await runtime.recycle();
    console.log(`recycled to generation ${again.generation} on ${again.url} in ${again.ms} ms`);
  }
  if (args.includes("--stay") === false) {
    await runtime.stop();
    console.log("stopped");
  }
  return 0;
}

if (runsAs("osd-runtime.mjs")) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
    console.error(`${error.code ?? "ERROR"}: ${error.message}`);
    process.exit(1);
  });
}
