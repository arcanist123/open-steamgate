import {expect} from "chai";
import express from "express";
import {servingFront} from "../tools/osd-serving-front.mjs";

const listen = app => new Promise(resolve => {
  const server = app.listen(0, "127.0.0.1", () => resolve(server));
});
const address = server => `http://127.0.0.1:${server.address().port}`;
const close = server => new Promise(resolve => server.close(resolve));

describe("VS Code serving front identity", () => {
  const identity = {launcherPid: 12345, launcherIdentity: "front-identity"};
  const metadata = {...identity, warmStatus: () => ({state: "primed"}), bind: () => ["127.0.0.1"]};
  it("retains front identity when a worker recycles during fetch and the fallback proxy succeeds", async () => {
    const worker = express();
    worker.get("/osd/serving", (_req, res) => res.json({ready: true, generation: "new-worker", pid: 22222}));
    const nextWorker = await listen(worker);
    const runtime = {running: true, generation: "old-worker", url: "http://127.0.0.1:1",
      async ensure() { this.url = address(nextWorker); this.generation = "new-worker"; }};
    let fetches = 0;
    const app = express();
    app.all("/osd/serving", servingFront(runtime, {...metadata, startingWaitMs: 10, fetchAnswer: async () => {
      fetches++;
      // The worker dies while fetch is reading its response. ensure() in
      // the real fallback proxy picks up the replacement's URL/generation.
      runtime.running = false;
      throw Error("worker recycled during fetch");
    }}));
    const front = await listen(app);
    try {
      const response = await fetch(`${address(front)}/osd/serving`);
      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(fetches).to.equal(1);
      expect(body).to.include({...identity, ready: true, generation: "new-worker", pid: 22222});
      expect(body.warm).to.deep.equal({state: "primed"});
      expect(response.headers.get("content-length")).to.equal(String(Buffer.byteLength(JSON.stringify(body))));
    } finally { await close(front); await close(nextWorker); }
  });
  it("keeps the child's X-OSD-Generation on the re-serialised answer (the shared host contract)", async () => {
    const worker = express();
    worker.get("/osd/serving", (_req, res) => res.set("X-OSD-Generation", "gen-1 warm-unverified").json({ready: true, generation: "gen-1 warm-unverified", pid: 7}));
    const child = await listen(worker);
    const runtime = {running: true, url: address(child), async ensure() {}};
    const app = express();
    app.all("/osd/serving", servingFront(runtime, {...metadata, startingWaitMs: 10}));
    const front = await listen(app);
    try {
      const response = await fetch(`${address(front)}/osd/serving`);
      expect(response.status).to.equal(200);
      expect(response.headers.get("x-osd-generation")).to.equal("gen-1 warm-unverified");
      expect((await response.json()).generation).to.equal("gen-1 warm-unverified");
    } finally { await close(front); await close(child); }
  });
  it("adds identity to normal, starting, non-GET and failed fallback responses", async () => {
    const worker = express();
    worker.all("/osd/serving", (_req, res) => res.json({ready: true, generation: "worker", launcherPid: 99, launcherIdentity: "worker"}));
    const child = await listen(worker);
    const runtime = {running: true, url: address(child), async ensure() {}};
    const app = express();
    let failFetch = false;
    app.all("/osd/serving", servingFront(runtime, {...metadata, startingWaitMs: 10, fetchAnswer: (...args) => {
      if (failFetch) throw Error("worker died");
      return fetch(...args);
    }}));
    const front = await listen(app);
    try {
      const url = `${address(front)}/osd/serving`;
      expect(await fetch(url).then(r => r.json())).to.include({...identity, ready: true});
      runtime.booting = {phase: "seeding", since: Date.now()}; runtime.running = false;
      expect(await fetch(url).then(r => r.json())).to.include({...identity, starting: true});
      delete runtime.booting; runtime.running = true;
      expect(await fetch(url, {method: "POST"}).then(r => r.json())).to.include(identity);
      failFetch = true;
      runtime.recycling = true;
      runtime.ensure = () => new Promise(() => {});
      const starting = await fetch(url);
      expect(starting.status).to.equal(503);
      expect(await starting.json()).to.include({...identity, starting: true, phase: "recycling"});
      runtime.ensure = async () => { throw Error("replacement failed"); };
      const response = await fetch(url);
      expect(response.status).to.equal(503);
      expect(await response.json()).to.include(identity);
    } finally { await close(front); await close(child); }
  });
});
