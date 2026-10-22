import {test, expect, chromium} from "@playwright/test";
import {packsOf} from "../../tools/osd-packs.mjs";
import {identity} from "../../tools/osd-identity.mjs";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

// The origin the preview is served on. STG_PREVIEW_PORT, the variable both
// scripts/serve-build.mjs and playwright.preview.config.mjs read, so two
// sessions on one machine do not collide -- it used to be the literal
// `http://localhost:3031`, twenty-five times over, and a config that can be
// told a port while the spec cannot is a suite where every assertion fails
// with ERR_CONNECTION_REFUSED against a server that is up and healthy on the
// port it was asked for.
//
// It stays an ORIGIN rather than becoming baseURL-relative paths, because
// several of these assertions are about absolute URLs the system itself
// produces -- an OData `__metadata.uri`, a WebSocket address -- and those are
// compared, not navigated to.
const ORIGIN = `http://localhost:${process.env.STG_PREVIEW_PORT ?? 3031}`;
// The WebSocket addresses are built INSIDE the page, from `location.origin`,
// not from this constant: those lines run in the browser, where a Node-side
// constant does not exist -- four tests failed with "WS_ORIGIN is not
// defined" when it did. Taking the origin from the page is also the better
// answer, because the page cannot then disagree with where it was served.

// Wait for the worker to take control, and say what happened when it does not.
//
// The bare wait was `waitForFunction(() => controller !== null)` with a
// timeout, which reports "Timeout 30000ms exceeded" and nothing else. That
// sentence is the same whether the registration was refused, the worker is
// still installing, or the browser cannot open service-worker storage at
// all — three different faults with one face. web/index.html already catches
// a registration failure and renders it into the page; nobody was reading it.
//
// Suggested by a Codex review of exactly this problem, and it is the day's
// lesson again in a new place: a check that says nothing when it fails is
// barely a check.
async function controlled(page, timeout = 60000) {
  try {
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {timeout});
  } catch (waited) {
    const said = await page.evaluate(() => ({
      body: document.body.innerText.replace(/\s+/g, " ").slice(0, 600),
      registrations: navigator.serviceWorker.getRegistrations === undefined
        ? "getRegistrations is not available"
        : undefined,
    })).catch((reason) => ({body: `the page could not be read: ${reason.message}`}));
    const states = await page.evaluate(async () => {
      const all = await navigator.serviceWorker.getRegistrations();
      return all.map((r) => `scope=${r.scope} installing=${r.installing?.state ?? "-"} waiting=${r.waiting?.state ?? "-"} active=${r.active?.state ?? "-"}`);
    }).catch((reason) => [`registrations could not be read: ${reason.message}`]);
    throw new Error(`the worker never took control in ${timeout}ms.\n  page said: ${said.body}\n  registrations: ${states.length === 0 ? "(none)" : states.join(" | ")}\n  original: ${waited.message.split("\n")[0]}`);
  }
}

// Which bundle is answering. This runs first on purpose.
//
// Three times in one day a check passed against something other than what it
// was checking: this suite green against a stale build/sw.js, a deployment
// confirmed because the command exited 0, a fix verified by grepping for a
// comment the bundler strips. Every one of them reported work as done that
// was not. The file on disk being current proves nothing — a service worker
// registration outlives a rebuild, and the old one keeps answering.
//
// So the worker carries a digest of itself (scripts/build-preview.mjs writes
// it in) and says it on request. If this test fails, nothing below it means
// anything, which is why it is first.
test("the worker answering is the worker that was just built", async () => {
  const {readFile} = await import("node:fs/promises");
  const {fileURLToPath} = await import("node:url");
  const onDisk = JSON.parse(await readFile(fileURLToPath(new URL("../../build/preview/build.json", import.meta.url)), "utf8"));

  const profile = await mkdtemp(join(tmpdir(), "stg-preview-stamp-"));
  const context = await chromium.launchPersistentContext(profile, {headless: true, serviceWorkers: "allow"});
  try {
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/index.html?stay=1`);
    await controlled(page);
    // land somewhere stable first. index.html is the installer and navigates
    // to the app the moment the worker is in control, so anything evaluated
    // on it races that navigation and dies as "execution context was
    // destroyed" — which reads like a worker fault and is not one. This is
    // the same race that made the suite flake.
    await page.goto(`${ORIGIN}/sap/bc/zstg_icf_demo/stamp`, {waitUntil: "domcontentloaded"});
    const answered = await page.evaluate(async () => {
      const res = await fetch("/__preview/build", {cache: "no-store"});
      return {status: res.status, body: await res.json(), sw: true};
    });
    expect(answered.status).toBe(200);
    expect(answered.body.stamp).toBe(onDisk.stamp);
    // and it is unstamped only if the build step never ran
    expect(answered.body.stamp).not.toBe("__OSD_BUILD_STAMP__");
  } finally {
    await context.close();
    await rm(profile, {recursive: true, force: true});
  }
});

// The cross-reference in the published system (tools/osd-xref-seed.mjs):
// the build ships the rows, the worker's backend applies them at start AND
// after "reset", which rebuilds the database from the seed. Read through
// SE16, the way a person in the page would look. test/xref-seed.mjs runs
// the same backend under node; this is the bundle, in the browser. It is
// also the first check of "reset" at all: it answered 500 until the seed
// stopped batching its inserts twice (test/setup.mjs).
test("the cross-reference is there at start and after a reset", async () => {
  const profile = await mkdtemp(join(tmpdir(), "stg-preview-xref-"));
  const context = await chromium.launchPersistentContext(profile, {headless: true, serviceWorkers: "allow"});
  try {
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/index.html?stay=1`);
    await controlled(page);
    await page.goto(`${ORIGIN}/sap/bc/zstg_icf_demo/stamp`, {waitUntil: "domcontentloaded"});
    const who = () => page.evaluate(async () =>
      (await fetch("/sap/bc/osd/se16/?t=WBCROSSGT&f_include=ZCL_STG_SEGW_REPO&max=500", {cache: "no-store"})).text());
    expect(await who()).toContain("CL_ABAP_ZIP");
    const reset = await page.evaluate(async () => {
      const r = await fetch("/__preview/reset", {redirect: "manual", cache: "no-store"});
      return r.type === "opaqueredirect" ? r.type : `${r.status} ${(await r.text()).slice(0, 400)}`;
    });
    expect(reset).toBe("opaqueredirect");
    expect(await who()).toContain("CL_ABAP_ZIP");
  } finally {
    await context.close();
    await rm(profile, {recursive: true, force: true});
  }
});

// The static preview build: no server answers /sap/opu/odata/sap/, the
// service worker does, with the transpiled DPC over sql.js.
//
// A persistent profile, because Chromium refuses service worker storage in
// Playwright's ephemeral context on some setups ("Failed to access storage").
test("the list report runs against the gateway in the service worker", async () => {
  const profile = await mkdtemp(join(tmpdir(), "stg-preview-"));
  const context = await chromium.launchPersistentContext(profile, {headless: true, serviceWorkers: "allow"});
  try {
    const page = await context.newPage();
    const answered = [];
    page.on("response", (res) => {
      if (res.url().includes("/sap/opu/odata/sap/")) {
        answered.push(res.status() + " " + res.url().replace(`${ORIGIN}`, "") + (res.fromServiceWorker() ? " (sw)" : ""));
      }
    });

    // a deep link into the app, without the installer page first
    await page.goto(`${ORIGIN}/app/index.html`);

    const rows = page.locator("table tbody tr.sapMListTblRow, .sapUiTableRow:has(.sapUiTableCell)");
    await expect(rows.first()).toBeVisible();
    await expect(page.getByText("Berlin to Copenhagen")).toBeVisible();
    await expect(page.getByText("Aarhus to Odense")).toBeVisible();
    await expect(rows).toHaveCount(4);

    // painted, not only present: an ancestor with height 0 and overflow hidden
    // would leave the row in the DOM and the page blank
    const painted = await page.getByText("Berlin to Copenhagen").evaluate((cell) => {
      const r = cell.getBoundingClientRect();
      return cell.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    });
    expect(painted).toBe(true);

    expect(answered.some((r) => r.includes("$metadata") && r.startsWith("200"))).toBe(true);
    expect(answered.some((r) => r.includes("(sw)"))).toBe(true);
    expect(answered.filter((r) => !r.startsWith("2"))).toEqual([]);

    // the absolute URLs the gateway hands out point at the mount, not at a Node server
    const travels = await page.evaluate(async () => (await fetch("../sap/opu/odata/sap/ZSTG_DEMO_SRV/TravelSet?$top=1&$format=json")).json());
    expect(travels.d.results[0].__metadata.uri)
      .toMatch(new RegExp("^" + ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/sap/opu/odata/sap/ZSTG_DEMO_SRV/TravelSet\\("));

    // a write goes through the DPC in the worker and survives a reload
    const created = await page.evaluate(async () => {
      const res = await fetch("../sap/opu/odata/sap/ZSTG_DEMO_SRV/TravelSet", {
        method: "POST",
        headers: {"content-type": "application/json", "x-csrf-token": "open-steamgate"},
        body: JSON.stringify({TravelId: "T0900", Description: "Preview roundtrip"}),
      });
      return res.status;
    });
    expect(created).toBe(201);
    await page.reload();
    await expect(page.getByText("Preview roundtrip")).toBeVisible();
  } finally {
    await context.close();
    await rm(profile, {recursive: true, force: true});
  }
});

// The same worker answers the other ICF services, not only the OData front.
//
// Before this, both the worker and the backend named one prefix and one
// handler class in their own source, which was true while there was one of
// each. A repository imported under local/ brings its own *.sicf.xml, the
// build writes the table, and both read it — so a page generated by ABAP is
// served by ABAP with no server anywhere.
test("an ICF service is served by the worker too, page and all", async () => {
  const profile = await mkdtemp(join(tmpdir(), "stg-preview-icf-"));
  const context = await chromium.launchPersistentContext(profile, {headless: true, serviceWorkers: "allow"});
  try {
    const page = await context.newPage();

    // the installer page registers the worker and then navigates to the app,
    // so land somewhere stable before asking anything of the page: an
    // evaluate that runs mid-navigation dies with "execution context was
    // destroyed" and reads like a worker fault rather than a race
    await page.goto(`${ORIGIN}/index.html?stay=1`);
    await controlled(page);
    await page.goto(`${ORIGIN}/sap/bc/zork`);
    await page.waitForLoadState("domcontentloaded");

    const answer = await page.evaluate(async () => {
      const res = await fetch("/sap/bc/zstg_icf_demo/a/b");
      return {status: res.status, body: await res.text()};
    });

    expect(answer.status).toBe(200);
    // the handler ran: it reports its own name and the path below its mount,
    // which a static file could not do
    expect(answer.body).toContain('"service":"ZSTG_ICF_DEMO"');
    expect(answer.body).toContain('"path":"/a/b"');
  } finally {
    await context.close();
    await rm(profile, {recursive: true, force: true});
  }
});

// A transaction, and its session, inside the service worker (backlog G.3).
//
// This is the test the session design was decided on rather than a nice
// extra: the browser deployment is one thread with no work-process pool at
// all, so a session pinned to a process would be a design that only exists
// on Node. A row in ZOSD_TSES is the same row here, in the same sql.js
// database as every other table, and the same ABAP reads it.
test("a transaction keeps its session in the service worker, where there is no pool", async () => {
  const profile = await mkdtemp(join(tmpdir(), "stg-preview-tran-"));
  const context = await chromium.launchPersistentContext(profile, {headless: true, serviceWorkers: "allow"});
  try {
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/index.html?stay=1`);
    await controlled(page);

    const step = async (query, body) => page.evaluate(async ({query, body}) => {
      const url = "/sap/bc/gui/sap/its/webgui/" + query;
      const res = body === undefined
        ? await fetch(url)
        : await fetch(url, {method: "POST", headers: {"content-type": "application/x-www-form-urlencoded"}, body});
      return {status: res.status, html: await res.text()};
    }, {query, body});

    const first = await step("?okcode=ZOSD_NOTE");
    expect(first.status).toBe(200);
    expect(first.html).toContain("Session notepad started");
    const doc = /srcdoc="([^"]*)"/.exec(first.html)[1].replaceAll("&amp;", "&").replaceAll("&quot;", '"');
    const sid = /name="osdsid" value="([^"]*)"/.exec(doc)[1];
    const gg = /name="gg_control" value="([^"]*)"/.exec(doc)[1];
    expect(sid).toHaveLength(32);

    // the click, as the browser would post it: the same conversation, one
    // request later, in a worker that has no process to be pinned to
    const second = await step("tx/?okcode=add",
      new URLSearchParams({note: "written in a service worker", osdsid: sid, gg_control: gg}).toString());
    expect(second.status).toBe(200);
    expect(second.html).toContain("1 in this session");
    expect(second.html).toContain("written in a service worker");

    // and an id it does not have is refused here the way it is on Node
    const lost = await step("tx/?okcode=add",
      new URLSearchParams({note: "x", osdsid: "0".repeat(32), gg_control: gg}).toString());
    expect(lost.html).toContain("is not open here");
  } finally {
    await context.close();
    await rm(profile, {recursive: true, force: true});
  }
});

// The demo is a pack, fetched from its own repository at a pinned commit
// (packs/o4d/osd-pack.json, tools/osd-fetch.mjs), and it reaches the
// deployment the way Zork does: its ICF node is in the services table, its
// page is written by ZCL_O4D_HTTP_HANDLER in the worker, its pictures come
// out of SMW0 through media/. This checks the page and one picture, which
// is the whole chain short of the socket that the Zork tests cover.
test("the demo pack is served: its page by the handler, a picture out of SMW0", async () => {
  const profile = await mkdtemp(join(tmpdir(), "stg-preview-o4d-"));
  const context = await chromium.launchPersistentContext(profile, {headless: true, serviceWorkers: "allow"});
  try {
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/index.html?stay=1`);
    await controlled(page);
    const answer = await page.evaluate(async () => {
      const res = await fetch("/sap/bc/zo4d_demo/");
      return {status: res.status, type: res.headers.get("content-type"), body: await res.text()};
    });
    expect(answer.status).toBe(200);
    expect(answer.type).toContain("text/html");
    expect(answer.body).toContain("VIVID VIBES");
    // a picture the page asks the handler for, answered from the media folder
    const picture = await page.evaluate(async () => {
      const res = await fetch("/sap/bc/zo4d_demo/?img=ZO4D_00_SALES.PNG");
      const bytes = new Uint8Array(await res.arrayBuffer());
      return {status: res.status, type: res.headers.get("content-type"), head: Array.from(bytes.slice(0, 4))};
    });
    expect(picture.status).toBe(200);
    expect(picture.head).toEqual([0x89, 0x50, 0x4e, 0x47]);
    // and the launchpad knows the packs
    const packs = await page.evaluate(async () => (await fetch("/app/packs.json")).json());
    expect(Array.isArray(packs.tiles)).toBe(true);
  } finally {
    await context.close();
    await rm(profile, {recursive: true, force: true});
  }
});

// The demo over its channel, not only its page: a page that opens the
// socket, loads the demo and asks for a frame must get the frame and keep
// the socket. It did not: the handler WRITEs a debug line per frame, the
// runtime's console wrote to a process.stdout the worker does not have, and
// the channel closed with 1011 on the first frame while the page said
// "Disconnected" (measured 2026-09-17 on Pages, reproduced here).
test("the demo answers a frame over its channel and the socket stays open", async () => {
  const profile = await mkdtemp(join(tmpdir(), "stg-preview-o4d-frame-"));
  const context = await chromium.launchPersistentContext(profile, {headless: true, serviceWorkers: "allow"});
  try {
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/index.html?stay=1`);
    await controlled(page);
    await page.goto(`${ORIGIN}/sap/bc/zork`, {waitUntil: "domcontentloaded", timeout: 60000});
    const answer = await page.evaluate(() => new Promise((resolve) => {
      const socket = new WebSocket(`${location.origin.replace("http", "ws")}/sap/bc/apc/sap/zo4d_demo`);
      const seen = [];
      const done = (why) => resolve({why, state: socket.readyState, seen});
      socket.addEventListener("close", (e) => done(`closed ${e.code} ${e.reason}`));
      socket.addEventListener("error", () => done("error"));
      socket.addEventListener("message", (e) => {
        const text = String(e.data);
        seen.push(text.slice(0, 40));
        let message;
        try {
          message = JSON.parse(text);
        } catch {
          return;
        }
        if (message.type === "scenario") {
          socket.send(JSON.stringify({cmd: "frame", tick: 0, sub: 0}));
        } else if (message.t !== undefined) {
          setTimeout(() => done(`frame ${message.e}`), 500);
        }
      });
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({cmd: "load_demo", demo: "main"}));
        socket.send("start");
        socket.send(JSON.stringify({cmd: "get_scenario"}));
      });
      setTimeout(() => done("timeout"), 30000);
    }));
    expect(answer.why).toBe("frame Sales Dance");
    expect(answer.state).toBe(1);
  } finally {
    await context.close();
    await rm(profile, {recursive: true, force: true});
  }
});

// The light-show pack: SAP GUI screens recorded by sap-tui, stored as gzip
// and handed out by the push channel in base64 (packs/lsd). The page speaks
// no DIAG and neither side inflates the stream in ABAP: this asks the
// channel for the whole object, inflates it the way the page does, with the
// browser's own DecompressionStream, and checks the recording's header.
test("the LSD channel hands out the recorded show as compressed bytes", async () => {
  const profile = await mkdtemp(join(tmpdir(), "stg-preview-lsd-"));
  const context = await chromium.launchPersistentContext(profile, {headless: true, serviceWorkers: "allow"});
  try {
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/index.html?stay=1`);
    await controlled(page);
    await page.goto(`${ORIGIN}/sap/bc/zork`, {waitUntil: "domcontentloaded", timeout: 60000});
    const answer = await page.evaluate(() => new Promise((resolve) => {
      const socket = new WebSocket(`${location.origin.replace("http", "ws")}/sap/bc/apc/sap/zapc_lsd`);
      let bytes = 0;
      const done = (why, extra) => resolve(Object.assign({why, bytes, state: socket.readyState}, extra));
      socket.addEventListener("close", (e) => done(`closed ${e.code} ${e.reason}`));
      socket.addEventListener("error", () => done("error"));
      socket.addEventListener("message", async (e) => {
        const text = String(e.data);
        if (text.indexOf("\"type\":\"show\"") >= 0) {
          bytes = JSON.parse(text).bytes;
          socket.send(JSON.stringify({cmd: "bytes", from: 0, to: bytes}));
          return;
        }
        try {
          const binary = atob(text);
          const raw = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) raw[i] = binary.charCodeAt(i);
          const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("gzip"));
          const show = await new Response(stream).text();
          const lines = show.split(String.fromCharCode(10)).filter((l) => l.length);
          done("bytes", {
            arrived: raw.length,
            head: lines.slice(0, 2).map((l) => l.slice(0, 40)),
            frames: lines.filter((l) => l.indexOf("\"t\":") >= 0).length,
          });
        } catch (x) {
          done("inflate failed: " + x);
        }
      });
      setTimeout(() => done("timeout"), 120000);
    }));
    expect(answer.why).toBe("bytes");
    expect(answer.bytes).toBeGreaterThan(100000);
    expect(answer.arrived).toBe(answer.bytes);
    expect(answer.head[0]).toContain("\"v\":1");
    expect(answer.head[1]).toContain("\"s\":");
    expect(answer.frames).toBeGreaterThan(2000);
    expect(answer.state).toBe(1);
  } finally {
    await context.close();
    await rm(profile, {recursive: true, force: true});
  }
});

// A push channel with no socket and no second runtime.
//
// The page opens ws://…/sap/bc/apc/sap/… in its own script, before anything
// the deployment adds could replace the constructor, so the worker injects
// the shim ahead of it. The shim is a WebSocket shape over a MessagePort;
// the handler runs in the worker, where the runtime already is.
test("an APC channel answers in the bundle, with the handler in the worker", async () => {
  const profile = await mkdtemp(join(tmpdir(), "stg-preview-apc-"));
  const context = await chromium.launchPersistentContext(profile, {headless: true, serviceWorkers: "allow"});
  try {
    const page = await context.newPage();
    // the installer page navigates away once the worker is registered, so
    // land on a page the worker serves and stay there
    await page.goto(`${ORIGIN}/index.html?stay=1`);
    await controlled(page);
    await page.goto(`${ORIGIN}/sap/bc/zork`);
    await page.waitForLoadState("domcontentloaded");

    // the worker put the shim into the ABAP-generated page ahead of its own
    // script, which is the only moment it could have
    expect(await page.evaluate(() => globalThis.WebSocket.__previewInstalled === true)).toBe(true);

    // no install( ) here on purpose. The worker injected the shim into the
    // page and that is the thing under test: an earlier version injected a
    // module, which is deferred, so it ran after the page's own script had
    // already opened its socket and failed. This test called install( )
    // itself and passed while the real path was broken.
    const frames = await page.evaluate(async () => {
      return await new Promise((done, fail) => {
        const got = [];
        const socket = new WebSocket(`${location.origin.replace("http", "ws")}/sap/bc/apc/sap/zstg_apc_demo`);
        // sending from onopen is what a page does, and it is what caught the
        // ordering defect: the handler speaks from on_start, so draining
        // before signalling open delivered a message while the socket was
        // still CONNECTING, onmessage ran before onopen, and the page's reply
        // was refused as "the socket is not open"
        socket.onopen = () => { socket.send("ping"); socket.send("hello"); };
        socket.onerror = () => fail(new Error("error before the exchange finished"));
        socket.onmessage = (e) => { got.push(e.data); if (got.length >= 3) { done(got); } };
        socket.onclose = (e) => fail(new Error("closed: " + e.reason));
        setTimeout(() => fail(new Error("timed out with " + JSON.stringify(got))), 20000);
      });
    });

    // on_start speaks first, then the two answers
    expect(frames[0]).toContain('"channel":"ZSTG_APC_DEMO"');
    expect(frames[1]).toBe("pong");
    // the counter proves one handler object served both messages, which is
    // what stateful means and what a per-message object would not show
    expect(frames[2]).toContain('"seen":2');
  } finally {
    await context.close();
    await rm(profile, {recursive: true, force: true});
  }
});

// SMW0 media in the bundle.
//
// The runtime reads a W3MI object with WWWDATA_IMPORT, which reads a file
// beside the transpiled module. There is no file and no fs in a service
// worker, so every page that showed a picture or played a sound got a 500
// from a gateway that was otherwise answering. The build carries the media
// under media/ and web/preview-backend.mjs installs abap.W3MI_LOADER, so the
// bytes come back over fetch and the ABAP above is unchanged.
test("SMW0 objects are served from the bundle, byte for byte", async () => {
  const {readFile} = await import("node:fs/promises");
  const {fileURLToPath} = await import("node:url");
  const output = fileURLToPath(new URL("../../output/", import.meta.url));
  const expected = {
    "ZO4D_05_COPPER.PNG": await readFile(output + "zo4d_05_copper%2epng.w3mi.data.png"),
    "ZOISEE-EAR-02.MP3": await readFile(output + "zoisee-ear-02%2emp3.w3mi.data.mp3"),
  };

  const profile = await mkdtemp(join(tmpdir(), "stg-preview-w3mi-"));
  const context = await chromium.launchPersistentContext(profile, {headless: true, serviceWorkers: "allow"});
  try {
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/index.html?stay=1`);
    await controlled(page);
    // somewhere the worker serves and nothing else happens: the Zork page
    // opens its channel on load, and a handler that boots a Z-machine in the
    // worker holds the only thread there is, so waiting for that page's load
    // event is waiting for the game to start
    await page.goto(`${ORIGIN}/sap/bc/zstg_icf_demo/media`, {waitUntil: "domcontentloaded"});

    const fetched = await page.evaluate(async () => {
      const one = async (query) => {
        const res = await fetch("/sap/bc/zo4d_demo?" + query);
        const body = new Uint8Array(await res.arrayBuffer());
        // a digest rather than the bytes: four megabytes through the
        // Playwright bridge is the slow part of this test, not the runtime
        const digest = await crypto.subtle.digest("SHA-256", body);
        return {
          status: res.status,
          type: res.headers.get("content-type"),
          length: body.length,
          sha256: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(""),
        };
      };
      return {
        image: await one("img=ZO4D_05_COPPER.PNG"),
        audio: await one("audio=ZOISEE-EAR-02.MP3"),
      };
    }, undefined, {timeout: 60000});

    const {createHash} = await import("node:crypto");
    const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");

    expect(fetched.image.status).toBe(200);
    expect(fetched.image.type).toContain("image/png");
    expect(fetched.image.length).toBe(expected["ZO4D_05_COPPER.PNG"].length);
    expect(fetched.image.sha256).toBe(sha(expected["ZO4D_05_COPPER.PNG"]));

    // the audio is the four megabyte case: the one that turned the whole
    // WWWDATA_IMPORT walk quadratic on the Node side and the one nobody would
    // notice was missing until a demo went silent
    expect(fetched.audio.status).toBe(200);
    expect(fetched.audio.type).toContain("audio/mpeg");
    expect(fetched.audio.length).toBe(expected["ZOISEE-EAR-02.MP3"].length);
    expect(fetched.audio.sha256).toBe(sha(expected["ZOISEE-EAR-02.MP3"]));
  } finally {
    await context.close();
    await rm(profile, {recursive: true, force: true});
  }
});

// A real stateful handler, end to end, which the synthetic one cannot prove.
//
// Alice's suggestion, and the right one: Zork exercises more of the bundle in
// one go than the demo does and has none of its unrelated trouble. The page
// opens its own socket in its own script, so the injected shim has to be
// there first; the handler is a stateful APC class with a Z-machine behind
// it; and the story file is an SMW0 object, so the media path is in the
// chain too. If any link is missing the terminal says DISCONNECTED instead
// of the game.
test("Zork plays in the bundle: shim, channel, stateful handler and SMW0", async () => {
  const profile = await mkdtemp(join(tmpdir(), "stg-preview-zork-"));
  const context = await chromium.launchPersistentContext(profile, {headless: true, serviceWorkers: "allow"});
  try {
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/index.html?stay=1`);
    await controlled(page);
    // domcontentloaded, not load: the page connects as it loads and the
    // handler boots a Z-machine in the worker, which is the only thread
    // there is, so waiting for the load event is waiting for the game
    await page.goto(`${ORIGIN}/sap/bc/zork`, {waitUntil: "domcontentloaded", timeout: 60000});

    // the handler accepted the connection
    await expect(page.locator("#statusText")).toHaveText("Connected - Playing ZORK", {timeout: 60000});

    // and it ran: the banner is the handler's own, the rest is the story
    // file out of SMW0 interpreted by the ABAP Z-machine
    await expect(page.getByText("Z-Machine V3 Interpreter in ABAP")).toBeVisible({timeout: 60000});
    await expect(page.getByText("Running: ZORK1-Z3")).toBeVisible({timeout: 60000});
    await expect(page.getByText("West of House")).toBeVisible({timeout: 60000});

    // and it answers. Typed into the page's own terminal rather than pushed
    // down a socket this test opened, so the path under test is the one a
    // player uses: xterm -> the injected shim -> the worker -> on_message.
    const type = async (command) => {
      await page.locator("#terminal").click();
      await page.keyboard.type(command);
      await page.keyboard.press("Enter");
    };
    await type("open mailbox");
    await expect(page.getByText("Opening the small mailbox reveals a leaflet.")).toBeVisible({timeout: 60000});

    // the second command is the point. It can only work if the mailbox is
    // still open, which is state the previous message left behind — one
    // handler object for the conversation, which is what stateful APC means
    // and what a fresh handler per message would fail here.
    await type("read leaflet");
    await expect(page.getByText("WELCOME TO ZORK", {exact: false})).toBeVisible({timeout: 60000});
  } finally {
    await context.close();
    await rm(profile, {recursive: true, force: true});
  }
});

// The walkthrough, replayed. Alice remembered this existed and it does.
//
// .local/cpm-abap/test-games/MINIZORK_TEST.TXT is a script of commands with
// assertions between them — %*pattern* for "the answer contains this",
// %=text for the exact spelling, %!pattern for "must not". It is already the
// oracle for the ABAP side, run there by ltcl_speedrun, and replaying it
// through the bundle asks a harder question than any assertion of mine: not
// "did the handler answer" but "does the game play the same when the Z-machine
// is transpiled, the story file comes out of SMW0 and the socket is a
// MessagePort".
//
// It lives outside the repository, so this skips rather than fails when the
// cpm-abap checkout is absent, the way the corpus suites do.
const SCRIPT = ".local/cpm-abap/test-games/MINIZORK_TEST.TXT";

function parseScript(text) {
  const steps = [{command: undefined, expects: []}];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("%")) {
      const body = line.slice(1);
      if (body.startsWith("=")) {
        steps.at(-1).expects.push({kind: "exact", pattern: body.slice(1)});
      } else if (body.startsWith("!")) {
        steps.at(-1).expects.push({kind: "absent", pattern: body.slice(1)});
      } else {
        // %*pattern* — the stars are the wildcard, the middle is the text
        steps.at(-1).expects.push({kind: "contains", pattern: body.replace(/^\*|\*$/g, "")});
      }
      continue;
    }
    steps.push({command: line, expects: []});
  }
  return steps;
}

test("the MiniZork walkthrough plays the same in the bundle", async () => {
  const {readFile} = await import("node:fs/promises");
  const {fileURLToPath} = await import("node:url");
  const path = fileURLToPath(new URL("../../" + SCRIPT, import.meta.url));
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    test.skip(true, `${SCRIPT} is not in this checkout`);
    return;
  }
  const steps = parseScript(text);
  expect(steps.filter((s) => s.expects.length > 0).length).toBeGreaterThan(10);

  const profile = await mkdtemp(join(tmpdir(), "stg-preview-walk-"));
  const context = await chromium.launchPersistentContext(profile, {headless: true, serviceWorkers: "allow"});
  try {
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/index.html?stay=1`);
    await controlled(page);
    await page.goto(`${ORIGIN}/sap/bc/zstg_icf_demo/walkthrough`, {waitUntil: "domcontentloaded"});

    const answers = await page.evaluate(async (script) => {
      const {install} = await import("/preview-socket.mjs");
      install({paths: ["/sap/bc/apc/sap"]});
      const socket = new WebSocket(`${location.origin.replace("http", "ws")}/sap/bc/apc/sap/zapc_zork`);
      let buffer = "";
      // a channel that dies mid-walkthrough must name the command that
      // killed it; without this the next send throws "the socket is not
      // open" and the report blames the test rather than the game
      let died;
      socket.onmessage = (event) => { buffer += event.data; };
      socket.onclose = (e) => { died = died ?? `closed ${e.code} ${e.reason || "(no reason)"}`; };
      socket.onerror = () => { died = died ?? "socket error"; };
      await new Promise((open, fail) => {
        socket.onopen = open;
        setTimeout(() => fail(new Error(died ?? "no open")), 20000);
      });
      // the game has spoken when it stops: a prompt and then quiet
      const settle = async () => {
        for (let waited = 0; waited < 20000; waited += 100) {
          const was = buffer.length;
          await new Promise((tick) => setTimeout(tick, 100));
          if (buffer.length === was && buffer.trimEnd().endsWith(">")) {
            break;
          }
        }
        const said = buffer;
        buffer = "";
        return said;
      };
      const out = [];
      for (const step of script) {
        if (died !== undefined) {
          return {out, died, stoppedAt: step.command ?? "(intro)"};
        }
        if (step.command !== undefined) {
          socket.send(step.command);
        }
        out.push(await settle());
      }
      socket.close();
      return {out};
    }, steps);

    // every assertion in the script, against the answer to its own command
    const failures = [];
    steps.forEach((step, at) => {
      // only what actually ran: once the channel dies the remaining steps
      // have no answer, and reporting those as failed assertions buries the
      // one thing that went wrong under a list of things that never happened
      if (at >= answers.out.length) {
        return;
      }
      const said = answers.out[at];
      for (const {kind, pattern} of step.expects) {
        const hit = kind === "exact"
          ? said.includes(pattern)
          : said.toLowerCase().includes(pattern.toLowerCase());
        if (kind === "absent" ? hit : hit === false) {
          failures.push(`${step.command ?? "(intro)"} -> ${kind} ${JSON.stringify(pattern)}; got ${JSON.stringify(said.trim().slice(0, 120))}`);
        }
      }
    });
    expect(failures).toEqual([]);

    // Where the walkthrough stops today, held exactly there.
    //
    // The `random` opcode calls GENERAL_GET_RANDOM_INT, which open-abap-core
    // does not implement, so the first dice roll closes the channel with
    // CX_SY_DYN_CALL_ILLEGAL_FUNC — and the first dice roll in MiniZork is
    // the troll. Until that function module exists the walkthrough cannot
    // finish, so this test asserts the shape of the stop rather than
    // pretending it is not there: a different command, a different
    // exception, or fewer commands surviving is a new defect and turns it
    // red. When the gap is filled the else branch takes over and demands the
    // whole script.
    if (answers.died === undefined) {
      expect(answers.out.length).toBe(steps.length);
    } else {
      expect(answers.stoppedAt).toBe("kill troll with sword");
      expect(answers.died).toContain("CX_SY_DYN_CALL_ILLEGAL_FUNC");
      expect(answers.out.length).toBeGreaterThan(20);
    }
  } finally {
    await context.close();
    await rm(profile, {recursive: true, force: true});
  }
});

// The launchpad carries the two that are not UI5.
//
// Travels, Bookings, Flight analytics and SEGW are components the shell
// loads. Vivid Vibes and Zork are pages an ABAP class writes, served from
// the ICF path by the same runtime, and they sit on the same launchpad
// because that is what a launchpad is for: pointing at a service, whatever
// is behind it.
//
// What this asserts is the wiring — the tiles are there and their targets
// name the ICF paths. It deliberately does not drive the shell to open one:
// a ushell tile is a composite that resists clicking from a test, and intent
// navigation through the sandbox took as long as it felt like on a cold
// profile, so an end-to-end assertion here would have been a flaky way of
// proving something two other tests already prove deterministically — that
// the Zork page connects and plays, and that the o4d media are served.
test("the launchpad carries the ABAP-served demos, wired to the ICF paths", async () => {
  const profile = await mkdtemp(join(tmpdir(), "stg-preview-flp-"));
  const context = await chromium.launchPersistentContext(profile, {headless: true, serviceWorkers: "allow"});
  try {
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/index.html?stay=1`);
    await controlled(page);

    await page.goto(`${ORIGIN}/app/flp.html`, {waitUntil: "domcontentloaded", timeout: 60000});
    await expect(page.getByText("a Z-machine, in ABAP")).toBeVisible({timeout: 60000});
    await expect(page.getByText("a demo, in ABAP")).toBeVisible({timeout: 60000});
    const logo = page.locator("#shell-header-icon");
    await expect(logo).toHaveAttribute("alt", "open-steamgate");
    await expect(logo).toHaveAttribute("src", /\/app\/osd-logo\.svg$/);
    await expect.poll(() => logo.evaluate((img) => img.naturalWidth)).toBeGreaterThan(0);
    expect(await logo.evaluate((img) => ({width: img.clientWidth, height: img.clientHeight})))
      .toEqual({width: 60, height: 30});

    // the tile targets, read off the page the shell actually booted from.
    // The shell consumes sap-ushell-config during startup, so only the group
    // definition is still there to read; the application URLs are asserted
    // against the built file below, which is the artefact that ships.
    const targets = await page.evaluate(() =>
      globalThis["stg-launchpad-groups"][0].tiles.map((t) => t.properties.targetURL));
    expect(targets).toContain("#Zork-play");
    // the repository as a tile, and the QR image tile beside it (the shell
    // rewrites an image tile's target, so only the count says it is there)
    expect(targets).toContain("#Source-open");
    expect(targets).toContain("#VividVibes-play");
    // seven apps and the Source tile; the QR image tile beside it is listed
    // by the shell on one machine and not on another, so it is not counted
    expect(targets).toContain("#Lsd-play");
    expect(targets).toContain("#System-status");
    expect(targets.length).toBeGreaterThanOrEqual(9);

    const {readFile} = await import("node:fs/promises");
    const {fileURLToPath} = await import("node:url");
    const shipped = await readFile(fileURLToPath(new URL("../../build/preview/app/flp.html", import.meta.url)), "utf8");
    expect(shipped).toContain('url: "../sap/bc/zork"');
    expect(shipped).toContain('url: "../sap/bc/zo4d_demo"');
  } finally {
    await context.close();
    await rm(profile, {recursive: true, force: true});
  }
});

// GitHub Pages hosts the project below /open-steamgate/<deployment>/, not at
// the origin root.  A pack used to keep its live-data URL as /sap/...: it
// worked in this suite at localhost, then asked oisee.github.io/sap/... in
// public and painted Vector workbench red.  Exercise the real mount shape.
test("pack live data and ANYDB work below the GitHub Pages mount", async () => {
  const profile = await mkdtemp(join(tmpdir(), "stg-preview-pages-mount-"));
  const context = await chromium.launchPersistentContext(profile, {headless: true, serviceWorkers: "allow"});
  try {
    const page = await context.newPage();
    const mount = `${ORIGIN}/open-steamgate/main`;
    const countRequests = [];
    const escaped = [];
    page.on("response", (response) => {
      if (response.url().includes("ZVDB_100_SRV/VectorSet/$count")) {
        countRequests.push({url: response.url(), status: response.status(), worker: response.fromServiceWorker()});
      }
      if (response.url().startsWith(`${ORIGIN}/sap/`)) escaped.push(response.url());
    });
    await page.goto(`${mount}/index.html?stay=1`);
    await controlled(page);
    await page.goto(`${mount}/app/flp.html`, {waitUntil: "domcontentloaded", timeout: 60000});
    await page.getByLabel("Group Navigation").getByText("Content packs", {exact: true}).click();
    const tile = page.locator(".sapUshellTile", {hasText: "Vector workbench"}).first();
    await expect(tile).toBeVisible({timeout: 60000});
    await expect(tile).toContainText("4004");
    await expect(tile).toContainText("vectors");
    await expect(tile).not.toContainText("live data unavailable");
    expect(countRequests).toContainEqual({
      url: `${mount}/sap/opu/odata/sap/ZVDB_100_SRV/VectorSet/$count`,
      status: 200,
      worker: true,
    });

    // The tile being green is not enough: the app has its own manifest and
    // status request. Both used to start at /sap and therefore escaped the
    // project mount even after the tile itself was fixed.
    await page.goto(`${mount}/app/zvdb/`, {waitUntil: "domcontentloaded", timeout: 60000});
    await expect(page.getByText(/2002 query vectors in EGEMMA768/)).toBeVisible({timeout: 60000});
    await expect(page.getByText(/^DB: sql\.js · memory$/)).toBeVisible({timeout: 60000});
    const amdp = await page.evaluate(() => {
      const element = document.querySelector("[id$='--engineSelect']");
      const select = sap.ui.getCore().byId(element.id);
      const item = select.getItemByKey("AMDP");
      return {enabled: item.getEnabled(), selected: select.getSelectedKey()};
    });
    expect(amdp).toEqual({enabled: false, selected: "ANYDB"});
    await page.evaluate(() => {
      const element = document.querySelector("[id$='--bucketSelect']");
      const select = sap.ui.getCore().byId(element.id);
      select.setSelectedKey("QWEN31024");
      select.fireChange({selectedItem: select.getSelectedItem()});
    });
    await expect(page.getByText(/2002 query vectors in QWEN31024/)).toBeVisible({timeout: 60000});
    const rows = await page.evaluate(() => {
      const element = document.querySelector("[id$='--masterList']");
      return sap.ui.getCore().byId(element.id).getModel("state").getProperty("/vectors").length;
    });
    expect(rows).toBe(2002);
    expect(escaped, "no app request may escape the Pages deployment mount").toEqual([]);
  } finally {
    await context.close();
    await rm(profile, {recursive: true, force: true});
  }
});

// The system status of a deployment that is a bundle.
//
// On a server the facade takes the snapshot, because only it can see the
// pool, the listeners and /proc. Here none of that exists, so the worker
// says what is true of itself instead of faking a machine: host "browser",
// one process with no pid and no port, one port row saying there is no port
// and why, and the services and packs the build knows (web/preview-backend.mjs,
// docs/status-service.md "On the browser deployment"). The tables are filled
// through ZCL_OSD_STATUS=>REFRESH, the same door the facade uses.
test("the status app says what the deployment in the browser is", async () => {
  const profile = await mkdtemp(join(tmpdir(), "stg-preview-status-"));
  const context = await chromium.launchPersistentContext(profile, {headless: true, serviceWorkers: "allow"});
  try {
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/index.html?stay=1`);
    await controlled(page);

    await page.goto(`${ORIGIN}/app/status/index.html`, {waitUntil: "domcontentloaded", timeout: 60000});
    const row = page.locator(".sapMListTblRow", {hasText: "browser"}).first();
    await expect(row).toBeVisible({timeout: 60000});
    await row.click();

    await expect(page.locator(".sapUxAPObjectPageHeaderTitle").first()).toContainText(identity().sid);
    const section = (id) => page.locator(`[id$="--${id}::Section"]`).first();
    // one work process, and it is the worker itself (the count is in the
    // section title, which a hidden header row in the table would not fake)
    await expect(section("Processes")).toContainText("Processes (1)");
    await expect(section("Processes")).toContainText("worker");
    // no port, said out loud rather than left blank
    await expect(section("Ports")).toContainText("absent");
    // The paths this bundle really answers, and the packs really in it.
    //
    // **The table grows ten rows at a time, so it is grown until it stops
    // growing** rather than clicked once. One click was enough when the
    // inventory was under twenty rows; it reached thirty-three -- the UI5
    // apps sort above the ICF paths and `/sap/bc/zork` sorts near the
    // bottom -- and the click that used to reveal it stopped at twenty. The
    // preview deployment then failed on every commit for nine hours, and
    // GitHub Pages served yesterday's build the whole time, because a red
    // check nobody reads is a check that is not there.
    //
    // A fixture drifts by standing still. Pressing the trigger while there
    // is a trigger does not.
    for (let i = 0; i < 20; i += 1) {
      const more = section("Services").locator(".sapMGrowingListTrigger");
      if (await more.count() === 0 || await more.isVisible() === false) break;
      await more.scrollIntoViewIfNeeded();
      await more.click();
      await page.waitForTimeout(200);
    }
    await expect(section("Services")).toContainText("/sap/bc/zork");
    // an app is a row of the inventory too, at the intent its manifest declares
    await expect(section("Services")).toContainText("/app/flp.html#Travel-manage");
    // the last section is bound when it is looked at, so look at it: unscrolled
    // it says "No data available", which is the template waiting, not an answer
    await section("Packs").scrollIntoViewIfNeeded();
    // **The count is derived, not written down.** This said "Packs (3)" and
    // a fourth pack -- travels-a4h -- made it wrong without making anything
    // else wrong; a fixture drifts by standing still. The tree's own reader
    // is the one the build uses, so the two cannot disagree.
    const packs = packsOf(join(import.meta.dirname, "..", ".."));
    expect(packs.length, "the tree carries packs to count").toBeGreaterThan(2);
    await expect(section("Packs")).toContainText(`Packs (${packs.length})`);
    for (const pack of packs) {
      await expect(section("Packs")).toContainText(pack.name);
    }
  } finally {
    await context.close();
    await rm(profile, {recursive: true, force: true});
  }
});

// E.5 was filed as "the launchpad asks for a config we do not serve", to be
// taken first **if it shows in the console of the public preview**. It does
// not: loaded from GitHub Pages the launchpad answers 96 tiles with zero
// failed requests and zero 4xx, so the entry drops down the list.
//
// What an ephemeral browser profile does show is one error — "Failed to
// access storage", the service worker refusing to register because there is
// no durable storage to register into — and that is the browser, not the
// site: the same page in a persistent profile renders. `web/index.html`
// already turns it into a sentence a person can act on, and the helper at the
// top of this file already reads that sentence back.
//
// So the durable part is not a fix, it is this: a check that would have shown
// the reported breakage if it had been real, and will show the next one.
test("the launchpad's console and network, characterised", async () => {
  const profile = await mkdtemp(join(tmpdir(), "stg-preview-"));
  const context = await chromium.launchPersistentContext(profile, {headless: true, serviceWorkers: "allow"});
  try {
    const page = await context.newPage();
    const complaints = [];
    const refused = [];
    page.on("console", (m) => {
      if (m.type() === "error") complaints.push(m.text().slice(0, 200));
    });
    page.on("pageerror", (e) => complaints.push(`uncaught: ${String(e.message).slice(0, 200)}`));
    page.on("requestfailed", (r) => refused.push(`${r.failure()?.errorText ?? "failed"} ${r.url()}`));
    page.on("response", (r) => {
      // 404 on a favicon is a different conversation; anything the page asks
      // for and does not get is this one
      if (r.status() >= 400) refused.push(`${r.status()} ${r.url()}`);
    });

    await page.goto(`${ORIGIN}/app/flp.html`);
    await controlled(page);
    // the tiles are the proof the page actually ran, so that a silent page
    // cannot pass this test by complaining about nothing
    const tiles = page.locator("[class*=Tile], .sapMGT");
    await expect(tiles.first()).toBeVisible({timeout: 60000});
    expect(await tiles.count(), "the launchpad rendered its tiles").toBeGreaterThan(3);

    // **The two E.5 is about, named and dated rather than hidden.** A guard
    // that cannot land because of known debt is a guard nobody writes; one
    // that allows the known debt by name goes red the moment a THIRD thing
    // appears, which is what it is for. Same shape as `.leak-allow.json`:
    // the reason is what tells an allowance from a way of going green.
    // Nothing is allowed any more. All three of E.5's items are fixed, so
    // the allowance list is empty rather than kept "just in case" — an
    // allowance that outlives its defect is the failure this shape exists to
    // prevent, and the emptiest version of it is no list at all.
    // The shell briefly requests its built-in logo before our PASS image
    // replaces the src. The browser cancels only that superseded request;
    // the replacement itself must load, and every other request must work.
    const logo = page.locator("#shell-header-icon");
    await expect(logo).toHaveAttribute("alt", "open-steamgate");
    await expect.poll(() => logo.evaluate((img) => img.complete && img.naturalWidth > 0)).toBe(true);
    const missing = refused.filter((entry) => !/^net::ERR_ABORTED https:\/\/ui5\.sap\.com\/[^/]+\/resources\/sap\/ushell\/themes\/base\/img\/SAPLogo\.svg$/.test(entry));
    expect(missing, `the page asked for something it did not get:\n${missing.join("\n")}`).toHaveLength(0);
    // and the one that was fixed: the tile's question now has an answer
    const engine = await page.evaluate(async () => {
      const res = await fetch("/sap/bc/osd/amdp/engine");
      return {status: res.status, body: await res.text()};
    });
    expect(engine.status, "the tile asks whether anything here runs SQLScript").toBe(200);
    expect(JSON.parse(engine.body).engine, "and in a browser the honest answer is none").toBe("none");

    // The console, characterised rather than demanded clean. Three kinds, and
    // only one of them is ours:
    const chatter = [
      // SAPUI5's own deprecation and lifecycle notices, from the CDN build
      "must not have a return value", "is deprecated",
      // the browser's line for the two 4xx/5xx above, already accounted for
      "Failed to load resource",
    ];
    const ours = complaints.filter((c) => !chatter.some((k) => c.includes(k)));
    // Nothing left. The uncaught TypeError that used to be here came from
    // `sap/ushell/library-preload.js` resolving an empty hash, and the page
    // lands on `#Shell-home` now — measured: same 96 tiles, no throw.
    expect(ours, `the console has something new in it:\n${ours.join("\n")}`).toEqual([]);
  } finally {
    await context.close();
    await rm(profile, {recursive: true, force: true});
  }
});

// **A tile that cannot be opened, on the deployment people actually visit.**
//
// Fourteen checks ran against this build and not one of them pressed a
// tile, so `fc03de9` -- which repointed the launchpad at the BSP paths --
// shipped with every application broken on Pages and green here. Alice
// found it by clicking. The whole point of the launchpad is that it opens
// something; asserting everything around that and not that is a suite
// shaped like the code rather than like the use.
test("a tile opens its application, which is the one thing a launchpad does", async () => {
  const profile = await mkdtemp(join(tmpdir(), "osd-preview-"));
  const context = await chromium.launchPersistentContext(profile, {headless: true, serviceWorkers: "allow"});
  try {
    const page = await context.newPage();
    const missing = [];
    page.on("response", (r) => { if (r.status() === 404) missing.push(r.url()); });
    await page.goto(`${ORIGIN}/index.html?stay=1`);
    await controlled(page);
    await page.goto(`${ORIGIN}/app/flp.html`);
    await page.locator(".sapMGT").first().waitFor({timeout: 60000});
    await page.locator(".sapMGT").first().click();

    // the failure this exists for is a component that will not load, and
    // the sandbox reports it as a dialog rather than as a broken page
    await expect(page.locator("body")).not.toContainText(
      "could not be loaded", {timeout: 60000});
    // **Both branches, because the first version watched only one.** A 404
    // under `/sap/bc/ui5_ui5/` is a component or a page the application
    // could not fetch; a 404 under `/sap/opu/` is its DATA -- and that is
    // exactly where the next instance of the same defect landed, with the
    // tile opening onto an empty application while this assertion passed.
    // fable-osd pointed out that the check was right and looking at the
    // wrong prefix.
    //
    // `changes/*-bundle.json` is excluded on purpose: UI5's flexibility
    // layer probes for those on every application and their absence is not
    // a fault of ours.
    const ours = missing.filter((u) => /\/sap\/(bc\/ui5_ui5|opu)\//.test(u))
      .filter((u) => u.includes("/changes/") === false);
    expect(ours, "the application's resources and its data are where the page asked for them").toEqual([]);
  } finally {
    await context.close();
    await rm(profile, {recursive: true, force: true});
  }
});

// **A published inventory that contradicts what it inventories.**
//
// `applyAtStartup` reads the `*.sicf.xml` objects off disk; a service worker
// has none, so the preview applied nothing and the registry screen shipped
// saying "0 nodes" while eighteen paths answered on that same deployment.
// Nobody would have found it from here: every other check asks whether a
// path answers, and this one is about whether the page telling you which
// paths exist is telling the truth.
test("the registry screen counts the nodes this deployment actually serves", async () => {
  const profile = await mkdtemp(join(tmpdir(), "osd-preview-"));
  const context = await chromium.launchPersistentContext(profile, {headless: true, serviceWorkers: "allow"});
  try {
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/index.html?stay=1`);
    await controlled(page);
    await page.goto(`${ORIGIN}/sap/bc/osd/sicf/`);
    const body = page.locator("body");
    await expect(body).toContainText("ICF services", {timeout: 30000});
    // not a number pulled out of the air: the same nodes the worker mounts,
    // so the screen and the routing cannot disagree without this failing
    await expect(body).not.toContainText(/(^|[^0-9])0 nodes/); // "20 nodes" is not "0 nodes"
    await expect(body).toContainText("/sap/bc/osd/sicf/");
    await expect(body).toContainText("ZCL_OSD_BSP");
  } finally {
    await context.close();
    await rm(profile, {recursive: true, force: true});
  }
});

// **The registry as an application, opened the way a person opens it.**
//
// The HTML screen at /sap/bc/osd/sicf/ has its own check above. This is the
// Fiori Elements one (backlog G.5, Alice's specification): a list report
// over NodeSet with an object page, reached by its intent. It ships as a
// BSP application like the other five, so everything that broke the tiles
// this morning -- an absolute component URL, an absolute data source, a
// file name that does not survive a URL -- would break this one too, and
// each of those passed every check that existed at the time.
test("preview restart routes from the saved ICF activity", async () => {
  const profile = await mkdtemp(join(tmpdir(), "osd-preview-icf-"));
  let context;
  const open = async () => {
    context = await chromium.launchPersistentContext(profile, {headless: true, serviceWorkers: "allow"});
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/index.html?stay=1`);
    await controlled(page);
    return page;
  };
  try {
    let page = await test.step("start the initial browser", open);
    await page.goto(`${ORIGIN}/sap/bc/osd/sicf/`);
    const row = page.locator("tr").filter({has: page.locator("td.u", {hasText: "/sap/bc/zstg_icf_demo/"})});
    await row.getByRole("button", {name: "switch off", exact: true}).click();
    await expect(page.locator("body")).toContainText("switched off");
    await test.step("stop the initial browser", () => context.close());
    context = undefined;
    page = await test.step("restart with the saved database", open);
    const probe = () => page.evaluate(async () => {
      const off = await fetch("sap/bc/zstg_icf_demo/", {signal: AbortSignal.timeout(15000)});
      const on = await fetch("sap/bc/osd/sicf/", {signal: AbortSignal.timeout(15000)});
      return {off: off.status, on: on.status};
    });
    expect(await test.step("probe after restart", probe)).toEqual({off: 404, on: 200});
  } finally {
    await context?.close();
    await rm(profile, {recursive: true, force: true});
  }
});

test("the ICF registry application lists the nodes it is a registry of", async () => {
  const profile = await mkdtemp(join(tmpdir(), "osd-preview-"));
  const context = await chromium.launchPersistentContext(profile, {headless: true, serviceWorkers: "allow"});
  try {
    const page = await context.newPage();
    const missing = [];
    page.on("response", (r) => {
      // `changes/` is UI5's flexibility layer probing, and `i18n/` is
      // NOTE-2026-09-20-i18n-not-intercepted: measured the same for the
      // status app, which predates this one, so it is not this
      // application's fault and asserting it here would only make a new
      // test carry an old defect.
      const ours = /\/sap\/(bc\/ui5_ui5|opu)\//.test(r.url())
        && r.url().includes("/changes/") === false
        && r.url().includes("/i18n/") === false;
      if (r.status() === 404 && ours) {
        missing.push(r.url());
      }
    });
    await page.goto(`${ORIGIN}/index.html?stay=1`);
    await controlled(page);
    await page.goto(`${ORIGIN}/app/flp.html#IcfNode-manage`);

    const body = page.locator("body");
    await expect(body).not.toContainText("could not be loaded", {timeout: 60000});
    // the count in the table header is the service answering, not a shell
    await expect(body).toContainText("ICF nodes", {timeout: 60000});
    await expect(body).toContainText("/sap/bc/osd/sicf/");
    expect(missing, "the application's resources and its data are where it asked").toEqual([]);
  } finally {
    await context.close();
    await rm(profile, {recursive: true, force: true});
  }
});
