// The web extension's page host without VS Code (editors/vscode/web/page-host.mjs):
// a panel's push channels against the document's lifetime, the sandbox
// rewrite of a gateway page's frames, the media cache's in-use check, and the
// media file names.
import {expect} from "chai";
import {apcMailbox} from "../tools/osd-apc-mailbox.mjs";
import {mediaFileName, mediaUrlsInUse, pageChannels, sandboxScriptlessFrames} from "../editors/vscode/web/page-host.mjs";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return {promise, resolve, reject};
};
const tick = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((done) => setImmediate(done)); };
const PATH = "/sap/bc/apc/sap/zapc_demo";

// A gateway with the open / close semantics of web/preview-backend.mjs (a
// hosts map, one apcMailbox per channel, the entry registered before the
// first await, closeChannel(id, handle)) and a handler whose open the test
// finishes or fails by hand.
function gatewayLike() {
  const hosts = new Map();
  const log = [];
  const pendingOpens = [];
  const gateway = {
    openChannel(id, channel, send) {
      const mailbox = apcMailbox();
      const entry = {mailbox, id, live: true};
      hosts.set(id, entry);
      const step = deferred();
      pendingOpens.push({id, step});
      return mailbox.enqueue(async () => {
        await step.promise;
        if (mailbox.closed) return;
        log.push(`open ${id}`);
        send({apc: "open"});
      }).catch((error) => {
        if (hosts.get(id) === entry) hosts.delete(id);
        throw error;
      });
    },
    channelHandle: (id) => hosts.get(id),
    async channelMessage(id, text) {
      if (!hosts.has(id)) throw new Error(`no channel ${id}`);
      log.push(`message ${id} ${text}`);
    },
    async closeChannel(id, handle) {
      const entry = handle ?? hosts.get(id);
      if (hosts.get(id) === entry) hosts.delete(id);
      if (entry !== undefined) await entry.mailbox.closeTurn(async () => { entry.live = false; log.push(`close ${id}`); });
    },
  };
  return {gateway, hosts, log, pendingOpens};
}

function harness() {
  const {gateway, hosts, log, pendingOpens} = gatewayLike();
  const toPage = [];
  const services = deferred();
  let n = 0;
  const host = pageChannels({backend: async () => gateway, services: () => services.promise, newId: () => `doc${n += 1}`,
    describe: async (error) => String(error?.message ?? error), toPage: async (message) => { toPage.push(message); }});
  const release = () => services.resolve({channels: [{path: PATH}]});
  const open = (doc, id) => host.receive(doc, id, {type: "apc-open", id, path: PATH});
  const live = () => [...hosts.values()].filter((one) => one.live).map((one) => one.id);
  return {host, hosts, log, toPage, release, open, live, pendingOpens};
}

describe("vscode web page host: push channels belong to one document", () => {
  it("an open still loading the channel list does not survive the document's end", async () => {
    const {host, release, open, live} = harness();
    const {doc} = host.newDocument();
    const opening = open(doc, "apc-1");
    await tick();
    await host.closeAll();
    release();
    await opening;
    expect(live()).to.deep.equal([]);
    expect(host.channels.size).to.equal(0);
  });

  it("closing a CONNECTING socket cancels its pending open", async () => {
    const {host, toPage, release, open, live} = harness();
    const {doc} = host.newDocument();
    const opening = open(doc, "apc-1");
    await tick();
    await host.receive(doc, "apc-1", {type: "apc-close", id: "apc-1", code: 1000});
    release();
    await opening;
    expect(live()).to.deep.equal([]);
    expect(toPage.map((one) => one.apc)).to.deep.equal(["close"]);
  });

  it("an open that finished is closed with the document, and the old document reaches the page no more", async () => {
    const {host, toPage, release, open, live, pendingOpens} = harness();
    release();
    const {doc} = host.newDocument();
    const opening = open(doc, "apc-1");
    await tick();
    pendingOpens[0].step.resolve();
    await opening;
    expect(live()).to.deep.equal(["doc1:apc-1"]);
    toPage.length = 0;
    const {doc: next, ended} = host.newDocument();
    await ended;
    expect(next).to.equal("doc2");
    expect(live()).to.deep.equal([]);
    await host.receive(doc, "apc-1", {type: "apc-send", id: "apc-1", text: "late"});
    expect(toPage).to.deep.equal([]);
  });

  // critic round 4, MUST 1: while the document's end awaits a channel's
  // shutdown, that document opens another socket
  it("a document whose end is still closing its channels cannot open another one", async () => {
    const {host, release, open, live, pendingOpens, log} = harness();
    release();
    const {doc} = host.newDocument();
    const first = open(doc, "apc-1");
    await tick();
    pendingOpens[0].step.resolve();
    await first;
    const {ended} = host.newDocument();
    const second = open(doc, "apc-2");
    await tick();
    for (const one of pendingOpens.slice(1)) one.step.resolve();
    await Promise.all([ended, second]);
    expect(live()).to.deep.equal([]);
    expect(log.some((one) => one.includes("apc-2"))).to.equal(false);
    expect(host.channels.size).to.equal(0);
  });

  // critic round 4, MUST 2: overlapping replacements, the replacement reuses
  // apc-1, then the old document's open fails
  it("a stale open's failure closes only its own channel, never the replacement's", async () => {
    const {host, release, open, live, pendingOpens, toPage} = harness();
    release();
    const {doc: a} = host.newDocument();
    const old = open(a, "apc-1");
    await tick();
    host.newDocument();
    const {doc: c} = host.newDocument();
    const fresh = open(c, "apc-1");
    await tick();
    pendingOpens[1].step.resolve();
    await fresh;
    expect(live()).to.deep.equal(["doc3:apc-1"]);
    pendingOpens[0].step.reject(new Error("handler refused"));
    await old;
    await tick();
    expect(live()).to.deep.equal(["doc3:apc-1"]);
    await host.receive(c, "apc-1", {type: "apc-send", id: "apc-1", text: "still here"});
    expect(toPage.filter((one) => one.doc === c).map((one) => one.apc)).to.deep.equal(["open"]);
    expect(toPage.filter((one) => one.doc !== c)).to.deep.equal([]);
  });

  it("a socket id is opened once per document", async () => {
    const {host, release, open, live, pendingOpens, toPage} = harness();
    release();
    const {doc} = host.newDocument();
    const first = open(doc, "apc-1");
    await tick();
    pendingOpens[0].step.resolve();
    await first;
    await open(doc, "apc-1");
    expect(pendingOpens).to.have.length(1);
    expect(live()).to.deep.equal(["doc1:apc-1"]);
    expect(toPage.at(-1)).to.include({apc: "close", code: 1008});
  });

  it("messages without the current document's name are ignored", async () => {
    const {host, release, open, pendingOpens} = harness();
    release();
    host.newDocument();
    await open(undefined, "apc-1");
    await open("doc9", "apc-1");
    expect(pendingOpens).to.have.length(0);
  });

  it("an unknown path is refused with 1008", async () => {
    const {host, toPage, release} = harness();
    release();
    const {doc} = host.newDocument();
    await host.receive(doc, "apc-1", {type: "apc-open", id: "apc-1", path: "/sap/bc/apc/sap/nothing"});
    expect(toPage).to.deep.equal([{type: "apc", doc, id: "apc-1", apc: "close", code: 1008, reason: "no channel on /sap/bc/apc/sap/nothing"}]);
    expect(host.channels.size).to.equal(0);
  });
});

describe("vscode web page host: sandboxed frames", () => {
  const rewrite = (tag) => sandboxScriptlessFrames(`<body>${tag}</body>`).slice(6, -7);
  it("a script-less srcdoc frame becomes same-origin", () => {
    expect(rewrite(`<iframe id="GUI-2" sandbox="allow-forms allow-top-navigation" srcdoc="<p>x</p>"></iframe>`))
      .to.equal(`<iframe id="GUI-2" sandbox="allow-forms allow-top-navigation allow-same-origin" srcdoc="<p>x</p>"></iframe>`);
    expect(rewrite(`<iframe sandbox srcdoc="&lt;a href=&quot;?x&quot;&gt;x&lt;/a&gt;"></iframe>`))
      .to.equal(`<iframe sandbox="allow-same-origin" srcdoc="&lt;a href=&quot;?x&quot;&gt;x&lt;/a&gt;"></iframe>`);
  });
  it("the WEBGUI's HTML viewer frame, as open-abap-gui writes it, is rewritten", () => {
    const frame = `<iframe class="gg-control gg-on" style="left:0;top:0;border:0;" id="GUI-2" title="HTML viewer" ` +
      `sandbox="allow-forms allow-top-navigation-by-user-activation" hidden srcdoc="&lt;form id=&quot;note-form&quot; method=&quot;post&quot;&gt;&lt;/form&gt;"></iframe>`;
    expect(rewrite(frame)).to.equal(frame.replace("allow-top-navigation-by-user-activation\"", "allow-top-navigation-by-user-activation allow-same-origin\""));
  });
  it("reads sandbox tokens and attribute names case-insensitively", () => {
    for (const tag of [`<iframe sandbox="ALLOW-SCRIPTS" srcdoc="x"></iframe>`, `<IFRAME SANDBOX="Allow-Same-Origin" SRCDOC="x"></IFRAME>`]) {
      expect(rewrite(tag)).to.equal(tag);
    }
    expect(rewrite(`<IFRAME SANDBOX="allow-forms" SRCDOC="x"></IFRAME>`)).to.equal(`<IFRAME sandbox="allow-forms allow-same-origin" SRCDOC="x"></IFRAME>`);
  });
  // critic round 4, MUST 3, both examples
  it("an entity in the sandbox value leaves the frame alone", () => {
    for (const tag of [`<iframe sandbox="allow&#45;scripts" srcdoc="x"></iframe>`, `<iframe sandbox="allow&#x2d;scripts" srcdoc="x"></iframe>`,
      `<iframe sandbox="allow-forms&#32;allow-scripts" srcdoc="x"></iframe>`]) {
      expect(rewrite(tag)).to.equal(tag);
    }
  });
  it("malformed or ambiguous markup leaves the frame alone", () => {
    for (const tag of [`<iframe sandbox="" x=a=srcdoc=x></iframe>`, `<iframe sandbox="" srcdoc=x></iframe>`,
      `<iframe sandbox='' srcdoc="x"></iframe>`, `<iframe sandbox="" srcdoc='x'></iframe>`,
      `<iframe sandbox="" srcdoc="x" srcdoc="y"></iframe>`, `<iframe sandbox="" sandbox="allow-scripts" srcdoc="x"></iframe>`,
      `<iframe sandbox="" data_x="1" srcdoc="x"></iframe>`, `<iframe sandbox="" srcdoc="x" =""></iframe>`,
      `<iframe sandbox="allow-forms\tallow-scripts" srcdoc="x"></iframe>`, `<iframe sandbox = "" srcdoc="x"></iframe>`,
      `<iframe sandbox="" srcdoc="x"/ src="y"></iframe>`]) {
      expect(rewrite(tag), tag).to.equal(tag);
    }
  });
  it("leaves a src frame and an unsandboxed frame alone, and reads a > inside srcdoc", () => {
    for (const tag of [`<iframe sandbox="allow-forms" src="/sap/bc/x"></iframe>`, `<iframe sandbox="" srcdoc="x" src="y"></iframe>`,
      `<iframe srcdoc="x"></iframe>`]) {
      expect(rewrite(tag)).to.equal(tag);
    }
    expect(rewrite(`<iframe srcdoc="<b>a</b> sandbox=&quot;x&quot;" sandbox="allow-forms"></iframe>`))
      .to.equal(`<iframe srcdoc="<b>a</b> sandbox=&quot;x&quot;" sandbox="allow-forms allow-same-origin"></iframe>`);
  });
});

// A document of plain objects with the members mediaUrlsInUse reads.
function element(tag, attributes = {}, extra = {}) {
  return {tagName: tag.toUpperCase(), getAttribute: (name) => attributes[name] ?? null, style: {backgroundImage: ""}, ...extra};
}
const documentOf = (...elements) => ({querySelectorAll: () => elements});

describe("vscode web page host: media URLs in use", () => {
  const [a, b, c] = ["blob:x/a", "blob:x/b", "blob:x/c"];
  const check = (root, byPath = new Map(), playing = []) => [...mediaUrlsInUse(root, [a, b, c], byPath, playing)].sort();
  it("finds a URL in src, currentSrc, poster, srcset, style and <style>", () => {
    expect(check(documentOf(element("img", {src: a})))).to.deep.equal([a]);
    expect(check(documentOf(element("img", {}, {currentSrc: b})))).to.deep.equal([b]);
    expect(check(documentOf(element("video", {poster: c})))).to.deep.equal([c]);
    expect(check(documentOf(element("source", {srcset: `${a} 1x, ${b} 2x`})))).to.deep.equal([a, b]);
    expect(check(documentOf(element("div", {style: `background:url("${a}")`})))).to.deep.equal([a]);
    expect(check(documentOf(element("div", {}, {style: {backgroundImage: `url("${b}")`}})))).to.deep.equal([b]);
    expect(check(documentOf(element("style", {}, {textContent: `.x{background:url(${c})}`})))).to.deep.equal([c]);
  });
  // critic round 4, FIX 1: the URL copied to an element nobody registered
  it("a URL copied to another element is in use after the original lets go", () => {
    const original = element("img", {src: ""});
    const copy = element("span", {style: `background-image: url("${a}")`}, {style: {backgroundImage: `url("${a}")`}});
    expect(check(documentOf(original, copy))).to.deep.equal([a]);
  });
  // critic round 4, FIX 2: a retained element whose style was cleared
  it("a retained element whose style was cleared uses nothing", () => {
    expect(check(documentOf(element("span", {style: ""}, {osdBackground: undefined})))).to.deep.equal([]);
  });
  it("an element still waiting for a path, a same-origin frame and a playing detached audio keep their URLs", () => {
    const frame = element("iframe", {}, {contentDocument: documentOf(element("img", {src: b}))});
    const waiting = element("img", {}, {osdSource: "/sap/bc/x?1"});
    const audio = {paused: false, ended: false, src: c, currentSrc: c};
    expect(check(documentOf(frame, waiting), new Map([["/sap/bc/x?1", a]]), [audio])).to.deep.equal([a, b, c]);
  });
  // critic round 5, FIX 1: play() may still be waiting for the source, and a
  // paused element may resume: anything played keeps its URL
  it("a played audio keeps its URL while paused or not yet started", () => {
    const audio = {paused: true, ended: false, src: c, currentSrc: ""};
    expect(check(documentOf(), new Map(), [audio])).to.deep.equal([c]);
  });
  // critic round 5, FIX 2: shadow trees, CSSOM rules, frames past the depth bound
  it("finds a URL in an open shadow tree and in a CSSOM rule; a frame too deep keeps everything", () => {
    const host = element("div", {}, {shadowRoot: documentOf(element("img", {src: a}))});
    expect(check(documentOf(host))).to.deep.equal([a]);
    const rules = {...documentOf(), styleSheets: [{cssRules: [{cssText: `.x { background: url("${b}"); }`}]},
      {get cssRules() { throw new Error("cross-origin"); }}]};
    expect(check(rules)).to.deep.equal([b]);
    let deep = documentOf(element("img", {src: a}));
    for (let n = 0; n < 10; n++) deep = documentOf(element("iframe", {}, {contentDocument: deep}));
    expect(check(deep)).to.deep.equal([a, b, c]);
  });
  it("a document that cannot be read keeps everything", () => {
    expect(check({querySelectorAll() { throw new Error("denied"); }})).to.deep.equal([a, b, c]);
  });
});

describe("vscode web page host: media file names", () => {
  it("are injective: a % and a literal @ never share a file", () => {
    expect(mediaFileName("zoisee-ear-02%2emp3.w3mi.data.mp3")).to.equal("zoisee-ear-02@252emp3.w3mi.data.mp3");
    expect(mediaFileName("x%2emp3")).to.not.equal(mediaFileName("x@2emp3"));
    expect(mediaFileName("a@25")).to.not.equal(mediaFileName("a%"));
    expect(mediaFileName("a@b")).to.not.include("%");
    expect(mediaFileName("plain.png")).to.equal("plain.png");
  });
});
