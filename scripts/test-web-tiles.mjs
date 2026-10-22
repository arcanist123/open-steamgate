// Every launchpad tile of the web extension, clicked in Chromium inside the
// Fiori webview (docs/vscode-web.md, "Launchpad tiles"). Called by
// scripts/test-web-probe.mjs after its Fiori checks; the launchpad panel is
// open. The markers are what the GitHub Pages preview shows for the same tile.
import {join} from "node:path";

const UI5 = [
  // tile title, intent, texts the app shows on Pages
  {tile: "Travels", hash: "#Travel-manage", texts: ["T0001", "Berlin to Copenhagen"], photo: true},
  {tile: "Bookings", hash: "#Booking-display", texts: ["Ada Lovelace", "B002"]},
  {tile: "Flight analytics", hash: "#Flight-analyze", texts: ["Flight bookings (24)"]},
  {tile: "NYC taxi analytics", hash: "#Taxi-analyze", texts: ["Taxi trips", "JFK Airport"]},
  {tile: "SEGW", hash: "#SegwProject-manage", texts: ["ZSTG_MAPPED", "Entity Types"]},
  {tile: "ICF services", hash: "#IcfNode-manage", texts: ["ICF nodes", "/sap/bc/apc/sap/zapc_zork/"]},
  {tile: "System status", hash: "#System-status", texts: ["Systems (1)", "browser"]},
];

const sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

// The page runtime's media cache stays bounded while a document shows one
// distinct gateway picture after another, and a failed load is not kept.
async function mediaCache(frame) {
  const outcome = await frame.evaluate(async () => {
    const bridge = window.osdBridge;
    const photo = bridge.stats.media.find((one) => /PhotoSet\(.*\/\$value$/.test(one));
    if (!photo) return {error: `no PhotoSet $value among ${JSON.stringify(bridge.stats.media)}`};
    const url = (virtual) => new URL(`../${virtual.slice(1)}`, document.baseURI).href;
    const revoked = bridge.stats.revoked;
    for (let n = 0; n < 40; n++) {
      const image = new Image();
      image.src = url(`${photo}?osd-n=${n}`);
      await image.osdPending;
      if (!image.src.startsWith("blob:")) return {error: `picture ${n} not loaded: ${image.src}`};
      image.src = "";
    }
    const missing = photo.replace(/PhotoSet\(.*\)/, "PhotoSet('OSD-NO-SUCH-PHOTO')");
    const broken = new Image();
    broken.src = url(missing);
    await broken.osdPending;
    return {cached: bridge.mediaCached(), revoked: bridge.stats.revoked - revoked, missing};
  });
  if (outcome.error) throw new Error(`media cache: ${outcome.error}`);
  if (outcome.cached.length > 17 || outcome.revoked < 23) {
    throw new Error(`media cache: ${outcome.cached.length} blobs kept, ${outcome.revoked} revoked after 40 distinct pictures`);
  }
  if (outcome.cached.includes(outcome.missing)) throw new Error(`media cache: the failed load ${outcome.missing} is kept`);
  return `40 distinct pictures: ${outcome.cached.length} blobs kept, ${outcome.revoked} revoked, a failed load not kept`;
}

// The observer works on a changed attribute alone and hooks each frame once:
// style changes on an ancestor of a frame scan nothing and hook nothing.
async function observerWork(frame) {
  const outcome = await frame.evaluate(async () => {
    const stats = window.osdBridge.stats;
    const before = {scans: stats.scans, frameHooks: stats.frameHooks, frames: document.querySelectorAll("iframe").length};
    for (let n = 0; n < 30; n++) {
      document.body.style.outlineWidth = `${n % 2}px`;
      await new Promise((done) => setTimeout(done, 0));
    }
    return {before, after: {scans: stats.scans, frameHooks: stats.frameHooks}};
  });
  const {before, after} = outcome;
  if (!(before.frames > 0)) throw new Error("observer: the page has no frame");
  if (after.scans !== before.scans || after.frameHooks !== before.frameHooks || before.frameHooks < before.frames) {
    throw new Error(`observer: 30 style changes on <body> over ${before.frames} frame(s): scans ${before.scans} -> ${after.scans}, frame hooks ${before.frameHooks} -> ${after.frameHooks}`);
  }
  return `30 style changes on <body>: no rescan, ${after.frameHooks} frame hook(s) for ${before.frames} frame(s)`;
}

// A demo's music: loaded over the bridge, decoded and playing, and no media
// or play error recorded by the page runtime.
async function audioPlays(frame, what) {
  let state;
  for (const until = Date.now() + 60000; Date.now() < until; await sleep(500)) {
    state = await frame.evaluate(() => ({media: window.osdBridge.mediaState(), stats: JSON.parse(JSON.stringify(window.osdBridge.stats))}));
    if (state.media.some((one) => !one.paused && one.time > 0 && one.ready >= 2 && one.error === 0)) break;
  }
  const errors = state.stats.errors.filter((one) => /^(?:media|play) /.test(one) && !/AbortError|interrupted/.test(one));
  if (errors.length > 0) throw new Error(`${what}: ${errors.join("; ")}`);
  if (state.stats.played.length === 0) throw new Error(`${what}: nothing played (media ${JSON.stringify(state.stats.media)})`);
  const playing = state.media.find((one) => !one.paused && one.time > 0 && one.ready >= 2 && one.error === 0);
  if (!playing) throw new Error(`${what}: no audio playing: ${JSON.stringify(state.media)}`);
  return `audio ${playing.source} playing at ${playing.time.toFixed(1)} s`;
}
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export async function fioriTiles(page, {shots, fioriFrame, packs, only, survey = false}) {
  const wanted = (name) => !only || only.some((one) => name.startsWith(one));
  const results = [];
  // survey: record a tile that fails and go on (to measure a build that
  // lacks a feature); otherwise the first failure fails the test
  const attempt = async (tile, work) => {
    if (!survey) return work();
    try { await work(); } catch (error) {
      results.push({tile, after: `FAIL ${String(error?.message ?? error).split("\n")[0].slice(0, 200)}`, shot: await shot(tile).catch(() => undefined)});
      for (const other of page.context().pages()) if (other !== page) await other.close().catch(() => undefined);
      await page.keyboard.press("Escape").catch(() => undefined);
    }
  };
  const launchpadTab = () => page.locator(".tabs-container .tab").filter({hasText: "Fiori Launchpad"}).first();
  const home = async () => {
    await launchpadTab().click();
    const frame = await fioriFrame(page, () => !!window.osdBridge && !!window["sap-ushell-config"] &&
      [...document.querySelectorAll(".sapUshellTile")].length > 0, undefined, "Launchpad");
    await frame.evaluate(() => { window.location.hash = "#Shell-home"; });
    await frame.waitForFunction(() => [...document.querySelectorAll(".sapUshellTile")].some((tile) =>
      tile.textContent.includes("Data browser") && tile.offsetParent !== null), undefined, {timeout: 60000});
    return frame;
  };
  const tileOf = (frame, name) => frame.locator(".sapUshellTile").filter({hasText: name}).first();
  const shot = async (name) => {
    const path = join(shots, `tile-${slug(name)}.png`);
    await page.screenshot({path});
    return path;
  };
  const closeTab = async (title) => {
    const tab = page.locator(".tabs-container .tab").filter({hasText: title}).first();
    await tab.click({button: "middle"});
    await tab.waitFor({state: "detached", timeout: 30000}).catch(() => undefined);
  };
  // A gateway page in a panel of its own (the extension's answer to the
  // window the launchpad opens): the frame whose document shows `text`.
  const gatewayFrame = (text, what) => fioriFrame(page, (wanted) => !!window.osdBridge && !window["sap-ushell-config"] &&
    (document.body?.innerText ?? "").includes(wanted), text, what);

  // UI5 applications inside the launchpad.
  for (const app of UI5.filter((one) => wanted(one.tile))) {
    await attempt(app.tile, async () => {
      const launchpad = await home();
      await tileOf(launchpad, app.tile).click();
      await launchpad.waitForFunction((texts) => texts.every((text) => document.body.innerText.includes(text)), app.texts, {timeout: 180000});
      if (!(await launchpad.evaluate(() => window.location.hash)).startsWith(app.hash)) throw new Error(`${app.tile}: not at ${app.hash}`);
      let note = app.texts.join(", ");
      if (app.photo) {
        // PhotoSet pictures: the gateway's bytes as a blob: URL (sap.m.Avatar
        // paints them as a background image), decoded by the browser
        const decoded = () => launchpad.evaluate(async () => {
          const urls = [...new Set([...document.querySelectorAll("img, [style*='blob:']")].map((element) =>
            element instanceof HTMLImageElement ? element.src : /url\("?(blob:[^")]+)/.exec(element.style.backgroundImage)?.[1])
            .filter((url) => url?.startsWith("blob:")))];
          const sizes = await Promise.all(urls.map((url) => new Promise((done) => {
            const image = new Image();
            image.onload = () => done(image.naturalWidth);
            image.onerror = () => done(0);
            image.src = url;
          })));
          return sizes.filter((width) => width > 0).length;
        });
        let pictures = 0;
        for (const until = Date.now() + 60000; pictures === 0 && Date.now() < until; await sleep(500)) pictures = await decoded();
        if (pictures === 0) throw new Error("Travels: no PhotoSet picture decoded");
        note += `; ${pictures} PhotoSet picture(s) decoded; ${await mediaCache(launchpad)}`;
      }
      results.push({tile: app.tile, after: note, shot: await shot(app.tile)});
    });
  }

  // Tiles greyed because this host has no ADT facade or SQLScript engine
  // (on Pages too: the AMDP tile is live only where DuckDB-Wasm answers).
  for (const [tile, reason] of [["Workbench", "needs the ADT facade"], ["AMDP sandbox", "needs a database that speaks it"]].filter(([one]) => wanted(one))) {
    await attempt(tile, async () => {
      const launchpad = await home();
      const element = tileOf(launchpad, tile);
      const text = await element.innerText();
      if (!text.includes(reason)) throw new Error(`${tile}: not greyed (${text})`);
      await element.click();
      await sleep(2000);
      if ((await launchpad.evaluate(() => window.location.hash)) !== "#Shell-home") throw new Error(`${tile}: a greyed tile navigated`);
      results.push({tile, after: `greyed: ${reason}`, shot: await shot(tile)});
    });
  }

  // ICF pages: Pages opens a window, the extension a panel.
  const icf = [
    {tile: "Zork I", title: "ZORK", ready: "West of House", pack: "zork", async act(frame) {
      await frame.locator(".xterm").first().click();
      await page.keyboard.type("open mailbox", {delay: 40});
      await page.keyboard.press("Enter");
      await frame.waitForFunction(() => document.body.innerText.includes("reveals a leaflet"), undefined, {timeout: 60000});
      return "typed 'open mailbox': 'Opening the small mailbox reveals a leaflet.'";
    }},
    {tile: "WEBGUI", title: "Easy Success", ready: "Easy Success", async act(frame) {
      // a transaction from the command field (a form GET re-rendered through the gateway)
      await frame.locator("form.cmdbox input").first().fill("ZOSD_NOTE");
      await frame.locator("form.cmdbox input").first().press("Enter");
      const next = await fioriFrame(page, () => !!window.osdBridge && /okcode=ZOSD_NOTE/i.test(document.baseURI) &&
        document.body.innerText.length > 0, undefined, "WEBGUI after the command field");
      await next.waitForFunction(() => document.body.innerText.includes("Session notepad"), undefined, {timeout: 60000});
      const observed = await observerWork(next);
      // and a form of the transaction itself: a line added to the notepad
      const line = `web extension ${Date.now()}`;
      // a form POST with target="_top" (method, body and hidden session
      // fields) inside the WEBGUI's sandboxed HTML viewer frame
      const viewer = next.frameLocator("iframe#GUI-2");
      await viewer.locator("#note-form input[name=note]").fill(line);
      await viewer.locator("#note-form #add").click();
      await fioriFrame(page, (wanted) => !!window.osdBridge && [...document.querySelectorAll("iframe")].some((frame) =>
        frame.contentDocument?.body?.innerText.includes(wanted)), line, "WEBGUI notepad line");
      return `ZOSD_NOTE from the command field (Session notepad), then Add (form POST): the line is listed; ${observed}`;
    }},
    {tile: "System information", title: "System information", ready: "transpiled", async act() {
      return "runtime row 'ABAP transpiled to JavaScript'";
    }},
    {tile: "Data browser", title: "Data browser", ready: "entities the system can read", async act(frame) {
      await frame.locator('a[href="?t=ZC_STG_TRAVEL"]').first().click();
      await fioriFrame(page, () => !!window.osdBridge && document.body.innerText.includes("ZC_STG_TRAVEL") &&
        document.body.innerText.includes("row(s)") && document.body.innerText.includes("Berlin to Copenhagen"), undefined, "Data browser rows");
      return "clicked ZC_STG_TRAVEL: '4 row(s)', row T0001 'Berlin to Copenhagen'";
    }},
    {tile: "Vivid Vibes", title: "VIVID VIBES", ready: "Click START", pack: "o4d", async act(frame) {
      await frame.getByText("START DEMO").first().click();
      await frame.waitForFunction(() => /Part 1\/2 \| Bar: [1-9]/.test(document.body.innerText), undefined, {timeout: 120000});
      return `START: 'Part 1/2 | Bar: n' advancing over the push channel; ${await audioPlays(frame, "Vivid Vibes")}`;
    }},
    {tile: "LSD", title: "LSD", ready: "press PLAY", pack: "lsd", async act(frame) {
      await frame.getByText("Play").first().click();
      await frame.waitForFunction(() => /Playing\s+\d+:\d+.*screen [1-9]\d* \//.test(document.body.innerText), undefined, {timeout: 120000});
      return `Play: 'Playing m:ss - screen n / N' over the push channel; ${await audioPlays(frame, "LSD")}`;
    }},
  ];
  for (const one of icf.filter((tile) => wanted(tile.tile))) {
    await attempt(one.tile, async () => {
      if (one.pack && !packs.includes(one.pack)) {
        results.push({tile: one.tile, after: `not in this build (pack ${one.pack} not selected)`});
        return;
      }
      const launchpad = await home();
      await tileOf(launchpad, one.tile).click();
      const frame = await gatewayFrame(one.ready, one.tile);
      const after = await one.act(frame);
      const stats = await fioriFrame(page, () => !!window.osdBridge && !window["sap-ushell-config"], undefined, one.tile)
        .then((current) => current.evaluate(() => JSON.parse(JSON.stringify(window.osdBridge.stats))));
      // a picture or a sound the page asked for and did not get fails the tile
      const failed = stats.errors.filter((error) => /^media /.test(error));
      if (failed.length > 0) throw new Error(`${one.tile}: ${failed.join("; ")}`);
      results.push({tile: one.tile, after: `${after}; media ${stats.media.length}, sockets ${stats.sockets.length}`, shot: await shot(one.tile)});
      await closeTab(one.title);
    });
  }

  // Source and the QR tile beside it: an outside address goes to openExternal,
  // which VS Code confirms in a dialog.
  for (const [tile, nth] of [["Source", 0], ["(QR image tile)", 1]].filter(([one]) => wanted(one))) {
    await attempt(tile, async () => {
      const launchpad = await home();
      const element = nth === 0 ? tileOf(launchpad, "oisee/open-steamgate")
        : launchpad.locator(".sapUshellTile").filter({has: launchpad.locator("img[src*='qr-github']")}).first();
      // VS Code either confirms the outside address in a dialog or opens it
      // in a new browser window, depending on its trusted-domain state
      const windows = [];
      const count = (other) => windows.push(other);
      page.context().on("page", count);
      const opened = page.context().waitForEvent("page", {timeout: 30000}).then((other) => ({other}));
      const dialog = page.locator(".monaco-dialog-box").filter({hasText: "github.com/oisee/open-steamgate"}).first();
      const asked = dialog.waitFor({timeout: 30000}).then(() => ({dialog}));
      await element.click();
      const outcome = await Promise.race([opened, asked]);
      let after;
      if (outcome.dialog) {
        after = "VS Code asks to open https://github.com/oisee/open-steamgate";
        var path = await shot(tile);
        await dialog.getByRole("button", {name: "Cancel"}).click();
      } else {
        await outcome.other.waitForURL(/github\.com\/oisee\/open-steamgate/, {timeout: 30000}).catch(() => undefined);
        const url = outcome.other.url();
        if (!/^https:\/\/github\.com\/oisee\/open-steamgate\/?$/.test(url)) throw new Error(`${tile}: opened ${url}`);
        await sleep(3000);
        // one window, and not also the webview's own page (VS Code's link handler)
        if (windows.length !== 1) throw new Error(`${tile}: ${windows.length} windows: ${windows.map((one) => one.url()).join(", ")}`);
        after = `openExternal: one new browser window at ${url}`;
        var path = await shot(tile);
        await outcome.other.close();
      }
      page.context().off("page", count);
      results.push({tile, after, shot: path});
    });
  }
  await home();
  return results;
}
