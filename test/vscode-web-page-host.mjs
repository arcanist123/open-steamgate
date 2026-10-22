// The web extension's page host without VS Code (editors/vscode/web/page-host.mjs):
// a panel's push channels against the document's lifetime, the sandbox
// rewrite of a gateway page's frames, and the media file names.
import {expect} from "chai";
import {mediaFileName, pageChannels, sandboxScriptlessFrames} from "../editors/vscode/web/page-host.mjs";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return {promise, resolve};
};
const tick = () => new Promise((done) => setImmediate(done));

function harness() {
  const opened = new Set();
  const log = [];
  const toPage = [];
  const services = deferred();
  const gateway = {
    async openChannel(key) { opened.add(key); log.push(`open ${key}`); },
    async channelMessage(key, text) { log.push(`message ${key} ${text}`); },
    async closeChannel(key) { opened.delete(key); log.push(`close ${key}`); },
  };
  const host = pageChannels({backend: async () => gateway, services: () => services.promise,
    describe: async (error) => String(error?.message ?? error), toPage: async (message) => { toPage.push(message); }});
  const release = () => services.resolve({channels: [{path: "/sap/bc/apc/sap/zapc_demo"}]});
  return {host, opened, log, toPage, release};
}

describe("vscode web page host: push channels follow the page's document", () => {
  it("an open still loading the channel list does not survive the document's end", async () => {
    const {host, opened, release} = harness();
    const open = host.receive("p:apc-1", {type: "apc-open", id: "apc-1", path: "/sap/bc/apc/sap/zapc_demo"});
    await tick();
    await host.closeAll();
    release();
    await open;
    expect([...opened]).to.deep.equal([]);
    expect(host.channels.size).to.equal(0);
  });

  it("closing a CONNECTING socket cancels its pending open", async () => {
    const {host, opened, toPage, release} = harness();
    const open = host.receive("p:apc-1", {type: "apc-open", id: "apc-1", path: "/sap/bc/apc/sap/zapc_demo"});
    await tick();
    await host.receive("p:apc-1", {type: "apc-close", id: "apc-1", code: 1000});
    release();
    await open;
    expect([...opened]).to.deep.equal([]);
    expect(toPage.map((one) => one.apc)).to.deep.equal(["close"]);
  });

  it("an open that finished is closed with the document, and the old document's sends are dropped", async () => {
    const {host, opened, toPage, release, log} = harness();
    release();
    await host.receive("p:apc-1", {type: "apc-open", id: "apc-1", path: "/sap/bc/apc/sap/zapc_demo"});
    expect([...opened]).to.deep.equal(["p:apc-1"]);
    const late = host.receive("p:apc-1", {type: "apc-close", id: "apc-1"});
    await host.closeAll();
    await late;
    expect([...opened]).to.deep.equal([]);
    expect(log.filter((one) => one.startsWith("close"))).to.have.length.greaterThan(0);
    expect(toPage).to.deep.equal([]);
  });

  it("an unknown path is refused with 1008", async () => {
    const {host, toPage, release} = harness();
    release();
    await host.receive("p:apc-1", {type: "apc-open", id: "apc-1", path: "/sap/bc/apc/sap/nothing"});
    expect(toPage).to.deep.equal([{type: "apc", id: "apc-1", apc: "close", code: 1008, reason: "no channel on /sap/bc/apc/sap/nothing"}]);
    expect(host.channels.size).to.equal(0);
  });
});

describe("vscode web page host: sandboxed frames", () => {
  const rewrite = (tag) => sandboxScriptlessFrames(`<body>${tag}</body>`).slice(6, -7);
  it("a script-less srcdoc frame becomes same-origin", () => {
    expect(rewrite(`<iframe id="GUI-2" sandbox="allow-forms allow-top-navigation" srcdoc="<p>x</p>"></iframe>`))
      .to.equal(`<iframe id="GUI-2" sandbox="allow-forms allow-top-navigation allow-same-origin" srcdoc="<p>x</p>"></iframe>`);
    expect(rewrite(`<iframe sandbox srcdoc='<a href="?x">x</a>'></iframe>`))
      .to.equal(`<iframe sandbox="allow-same-origin" srcdoc='<a href="?x">x</a>'></iframe>`);
  });
  it("reads sandbox tokens and attribute names case-insensitively", () => {
    for (const tag of [`<iframe sandbox="ALLOW-SCRIPTS" srcdoc="x"></iframe>`, `<IFRAME SANDBOX="Allow-Same-Origin" SRCDOC="x"></IFRAME>`,
      `<iframe sandbox="allow-forms\tallow-Scripts" srcdoc="x"></iframe>`]) {
      expect(rewrite(tag)).to.equal(tag);
    }
    expect(rewrite(`<IFRAME SANDBOX="allow-forms" SRCDOC="x"></IFRAME>`)).to.equal(`<IFRAME sandbox="allow-forms allow-same-origin" SRCDOC="x"></IFRAME>`);
  });
  it("leaves a src frame, an unsandboxed frame and a > inside srcdoc alone", () => {
    for (const tag of [`<iframe sandbox="allow-forms" src="/sap/bc/x"></iframe>`, `<iframe sandbox="" srcdoc="x" src="y"></iframe>`,
      `<iframe srcdoc="x"></iframe>`]) {
      expect(rewrite(tag)).to.equal(tag);
    }
    expect(rewrite(`<iframe srcdoc="<b>a</b> sandbox=&quot;x&quot;" sandbox="allow-forms"></iframe>`))
      .to.equal(`<iframe srcdoc="<b>a</b> sandbox=&quot;x&quot;" sandbox="allow-forms allow-same-origin"></iframe>`);
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
