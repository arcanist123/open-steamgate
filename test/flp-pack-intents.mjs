import {expect} from "chai";
import {readFileSync} from "node:fs";
import vm from "node:vm";

// The launchpad page and its tiles, run as code rather than read as text:
// webapp/flp.html's inline configuration script (the part that runs before
// the sandbox boots) and launchpad.js's tileTarget(), each in a vm.

function bootConfig(packs, {status = 200} = {}) {
  const html = readFileSync("webapp/flp.html", "utf8");
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
    .find((text) => text.includes('window["sap-ushell-config"] ='));
  const window = {location: {hash: "#Shell-home"}};
  class XMLHttpRequest {
    open(method, url, async) {
      this.url = url;
      this.async = async;
    }
    send() {
      window.requested = {url: this.url, async: this.async};
      this.status = status;
      this.responseText = JSON.stringify(packs);
    }
  }
  vm.runInNewContext(script, {window, XMLHttpRequest});
  return window;
}

const app = (component, url) => ({title: component, additionalInformation: `SAPUI5.Component=${component}`,
  applicationType: "URL", url, navigationMode: "embedded"});

describe("webapp/flp.html boots the sandbox with the packs' intents", () => {
  it("reads packs.json synchronously and adds every inbound of a pack app", () => {
    const window = bootConfig({applications: {
      "Fleet-display": app("osd.fleet", "../sap/bc/ui5_ui5/sap/zosg_demo/"),
      "Fleet-manage": app("osd.fleet", "../sap/bc/ui5_ui5/sap/zosg_demo/"),
    }});
    expect(window.requested).to.deep.equal({url: "./packs.json", async: false});
    const apps = window["sap-ushell-config"].applications;
    expect(apps["Fleet-display"].url).to.equal("../sap/bc/ui5_ui5/sap/zosg_demo/");
    expect(apps["Fleet-manage"], "the same app's second inbound").to.not.equal(undefined);
  });

  it("keeps the built-in intents and components, and one component to one URL", () => {
    const window = bootConfig({applications: {
      "Travel-manage": app("osd.other", "../sap/bc/ui5_ui5/sap/zother/"),
      "Travel-manageRemote": app("stg.travel", "../sap/bc/ui5_ui5/sap/ztravels_a4h/"),
      "Probe-display": app("osd.probe", "../sap/bc/ui5_ui5/sap/zprobe/"),
      "Probe-copy": app("osd.probe", "../sap/bc/ui5_ui5/sap/zprobe_copy/"),
    }});
    const apps = window["sap-ushell-config"].applications;
    expect(apps["Travel-manage"].additionalInformation, "a built-in intent stays").to.equal("SAPUI5.Component=stg.travel");
    expect(apps["Travel-manageRemote"], "a built-in component is not taken over").to.equal(undefined);
    expect(apps["Probe-display"]).to.not.equal(undefined);
    expect(apps["Probe-copy"], "the same component at another URL").to.equal(undefined);
  });

  it("hands the packs' resource roots to the loader after the core, never a built-in one", () => {
    // sap-ui-config set before the bootstrap did not take (the tag's own
    // resourceroots won, measured on 1.120.50); the loader is configured by
    // the script right after the core instead, before any app loads
    const window = bootConfig({applications: {}, resourceRoots: {
      "osd.lib": "../sap/bc/ui5_ui5/sap/zosd_lib/osd/lib",
      "stg": "../somewhere/else",
    }});
    const html = readFileSync("webapp/flp.html", "utf8");
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
      .find((text) => text.includes("sap.ui.loader.config"));
    expect(html.indexOf(script), "after the core script").to.be.greaterThan(html.indexOf("sap-ui-core.js"));
    const configured = [];
    const sap = {ui: {loader: {config: (c) => configured.push(c)}}};
    // the built-in namespaces come from the bootstrap tag itself
    const tagRoots = /data-sap-ui-resourceroots='([^']*)'/.exec(html)[1];
    expect(JSON.parse(tagRoots)).to.have.property("stg");
    const document = {getElementById: (id) => (id === "sap-ui-bootstrap" ? {getAttribute: () => tagRoots} : null)};
    vm.runInNewContext(script, {window, sap, document});
    expect(configured).to.deep.equal([{paths: {"osd/lib": "../sap/bc/ui5_ui5/sap/zosd_lib/osd/lib"}}]);
    configured.length = 0;
    vm.runInNewContext(script, {window: bootConfig({applications: {}}), sap, document});
    expect(configured, "no roots, no call").to.deep.equal([]);
  });

  it("leaves the built-in list alone without packs.json", () => {
    const before = Object.keys(bootConfig({}, {status: 404})["sap-ushell-config"].applications);
    expect(before).to.include("Travel-manage");
    expect(before.some((intent) => intent.startsWith("Probe"))).to.equal(false);
  });
});

describe("webapp/launchpad.js: a pack tile written as this page's intent stays in the shell", () => {
  const source = readFileSync("webapp/launchpad.js", "utf8");
  const fn = (name) => /function name\([^)]*\) \{[\s\S]*?\n  \}/.source.replace("name", name);
  const code = [fn("atMount"), fn("tileTarget")].map((re) => new RegExp(re).exec(source)?.[0]).join("\n");
  const tileTarget = vm.runInNewContext(`${code}; tileTarget`);

  it("turns this page's own URL with an intent into the intent", () => {
    for (const url of ["/app/flp.html#Fleet-display", "flp.html#Fleet-display", "./flp.html#Fleet-display",
      "/app/flp.html?sap-language=EN#Fleet-display"]) {
      expect(tileTarget(url), url).to.equal("#Fleet-display");
    }
  });

  it("and leaves a page URL a page URL, at the mount", () => {
    expect(tileTarget("/app/osg-demo/")).to.equal("../app/osg-demo/");
    expect(tileTarget("#Travel-manage")).to.equal("#Travel-manage");
    expect(tileTarget("/app/other.html#x")).to.equal("../app/other.html#x");
  });
});
