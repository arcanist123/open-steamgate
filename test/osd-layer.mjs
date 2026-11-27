import {syncBuiltinESMExports} from 'node:module';
import {expect} from "chai";
import childProcess, {execFileSync, spawn, spawnSync} from "node:child_process";
import {copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {load as parseYaml} from "js-yaml";
import {abapgitXml, zipFiles} from "../tools/osd-abapgit-zip.mjs";
import {build, inspect, leakGate, main, pushSystem, readLeakAllow, systemLayers, unresolvedLines} from "../tools/osd-layer.mjs";
import {JSON_LIMIT, assertPrivateTarget, manifest, pull, push, pushBlob, pushManifest, sha256, treeDigest} from "../tools/osd-oci.mjs";
import {archiveFiles} from "../tools/osd-source-zip.mjs";
import {fetchAll} from "../tools/osd-fetch.mjs";
import {fetchSystem} from "../tools/osd-system-fetch.mjs";
import {assertPublicSystem} from "../tools/osd-system.mjs";
import {generationSystem} from "../tools/osd-system.mjs";
import {hashOf, inputsOf} from "../tools/osd-build.mjs";
import {publicProvenance, verifyTreeArtefact} from "../tools/osd-public-tree.mjs";
import {verifyPublicArtefact} from "../tools/osd-provenance.mjs";
import {makeReadRecord, readEntry} from "../tools/osd-read-record.mjs";
import {registry, listening} from "./helpers/oci-registry.mjs";

import {toolCommand, setHostedLeakScanner} from "../tools/osd-host.mjs";
import {installHostedLeakScanner} from "../tools/osd-hosted-leak-scanner.mjs";

const options = {name: "smoke", kind: "input"};
const refusal = async (run, code) => {
  let error;
  try { await run(); } catch (e) { error = e; }
  expect(error?.code).to.equal(code);
};

describe("osd-layer: reproducible publishing", function () {
  this.timeout(30000);
  let root, folder, oldList, oldCwd, oldSelf;
  const write = (path, text) => { mkdirSync(join(path, ".."), {recursive: true}); writeFileSync(path, text); };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "osd-layer-"));
    folder = join(root, "input");
    write(join(folder, "zcl_smoke.clas.abap"), "CLASS zcl_smoke DEFINITION PUBLIC. ENDCLASS.\nCLASS zcl_smoke IMPLEMENTATION. ENDCLASS.\n");
    oldList = process.env.OSD_LEAK_IDENTIFIERS;
    oldSelf = process.env.OSD_SELF;
    oldCwd = process.cwd();
    setHostedLeakScanner((cwd, paths, privateLayer) => {
      const [command, ...args] = toolCommand(join(oldCwd, "tools/osd-leak-scan.mjs"), [...(privateLayer ? ["--private-layer"] : []), "--redact", "--publication-allow", "--paths", ...paths]);
      return spawnSync(command, args, {cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024});
    });
    // No chdir: the gate runs the scanner from its own scan directory, so the
    // test list below wins over a checkout's private one (and the timing
    // reporter, which maps tests to files by the cwd, keeps working).
    write(join(root, "identifiers.json"), JSON.stringify({test: ["forbidden_publish_identifier"], "корпус SAP (A4H, только локально)": ["Z_UNUSED_SYNTHETIC_CORPUS"]}));
    process.env.OSD_LEAK_IDENTIFIERS = join(root, "identifiers.json");
    process.env.OSD_SELF = JSON.stringify([process.execPath, join(oldCwd, "test/helpers/osd-layer-host.mjs")]);
  });
  afterEach(() => {
    setHostedLeakScanner(undefined);
    if (oldSelf === undefined) delete process.env.OSD_SELF;
    else process.env.OSD_SELF = oldSelf;
    if (oldList === undefined) delete process.env.OSD_LEAK_IDENTIFIERS;
    else process.env.OSD_LEAK_IDENTIFIERS = oldList;
    rmSync(root, {recursive: true, force: true});
  });

  it("builds identical bytes and import-shaped trees with generated and existing abapGit metadata", async () => {
    const a = build(folder, options), b = build(folder, options);
    expect(a.zip).to.deep.equal(b.zip);
    expect(a.digest).to.equal(b.digest);
    expect(a.config.treeDigest).to.equal(b.config.treeDigest);
    expect(a.config.treeDigest).to.equal(treeDigest(archiveFiles(a.zip)));
    expect([...archiveFiles(a.zip).keys()]).to.deep.equal([".abapgit.xml", "src/zcl_smoke.clas.abap"]);
    const existing = join(root, "existing");
    for (const [path, bytes] of archiveFiles(a.zip)) write(join(existing, path), bytes);
    const c = build(existing, options);
    expect(c.zip).to.deep.equal(a.zip);
    expect(archiveFiles(c.zip).get(".abapgit.xml").toString()).to.equal(abapgitXml());
    await main(["build", folder, "--name", "smoke", "--kind", "input", "--out", join(root, "out")]);
    expect(readFileSync(join(root, "out/smoke.zip"))).to.deep.equal(a.zip);
    expect(sha256(readFileSync(join(root, "out/manifest.json")))).to.equal(a.digest);
  });

  // P2-5: osd-build's store holds every generation's sources and output,
  // private ones included, with no identity file a layer build could read
  it("requires --private when repackaging a build store folder or a generation", () => {
    const refusedUnlessPrivate = (dir) => {
      expect(() => build(dir, options), dir).to.throw(/requires --private/).with.property("code", "PRIVATE_LAYER");
      expect(() => build(dir, {...options, private: true}), dir).not.to.throw();
    };
    // this checkout's build/
    mkdirSync(join(oldCwd, "build"), {recursive: true});
    const cache = mkdtempSync(join(oldCwd, "build", "osd-layer-cache-"));
    try {
      write(join(cache, "sample.abap"), "synthetic");
      refusedUnlessPrivate(cache);
    } finally { rmSync(cache, {recursive: true, force: true}); }
    // another checkout's store
    const store = join(root, "other-checkout/build"), hash = "0123456789abcdef";
    write(join(store, `by-input/${hash}/manifest.json`), JSON.stringify({hash, systemDigest: null, systemPrivate: true, provenance: []}));
    for (const path of [`by-input/${hash}/source`, `by-input/${hash}/output`, "source-by-digest", "xref"]) {
      write(join(store, path, "zsynthetic.prog.abap"), "REPORT zsynthetic.");
      refusedUnlessPrivate(join(store, path));
    }
    refusedUnlessPrivate(join(root, "other-checkout"));
    // a copied generation, out of any build/: its manifest says what it is
    const copied = join(root, "copied-generation");
    write(join(copied, "manifest.json"), JSON.stringify({hash, gen: "synthetic"}));
    write(join(copied, "output/zsynthetic.prog.mjs"), "synthetic");
    refusedUnlessPrivate(copied);
    refusedUnlessPrivate(join(copied, "output"));
    // an ordinary folder that happens to be called build is not a store
    write(join(root, "plain/build/zplain.prog.abap"), "REPORT zplain.");
    expect(() => build(join(root, "plain"), options)).not.to.throw();
  });

  it("stores private and closure only when requested and preserves the old digest", async () => {
    const old = build(folder, options);
    expect(old.digest).to.equal("sha256:3f810f6ff458d65df7b0ca41c704b6dc1cb410dd55afc7533ca3def06e449864");
    const same = build(folder, {...options, private: false});
    expect(same.digest).to.equal(old.digest);
    expect(same.config).not.to.have.property("private");
    const closure = {unresolved: 3, items: [{kind: "synthetic"}]};
    const marked = build(folder, {...options, private: true, closure});
    expect(marked.config.private).to.equal(true);
    expect(marked.manifest.annotations["org.osd.layer.private"]).to.equal("true");
    expect(marked.config.closure).to.deep.equal(closure);
    const closureFile = join(root, "closure.json");
    write(closureFile, JSON.stringify(closure));
    await main(["build", folder, "--name", "smoke", "--kind", "input", "--private", "--closure", closureFile, "--out", join(root, "closure-build")]);
    expect(JSON.parse(readFileSync(join(root, "closure-build/config.json"))).closure).to.deep.equal(closure);
    expect(() => build(folder, {...options, closure: {unresolved: -1, items: []}})).to.throw(/closure/);
    expect(() => build(folder, {...options, closure: {unresolved: 1, items: ["bad"]}})).to.throw(/closure/);
    expect(() => build(folder, {...options, closure: {unresolved: 1, items: [], extra: true}})).to.throw(/closure/);
    const nearlyFull = {unresolved: 1, items: [{text: "x".repeat(JSON_LIMIT - 105)}]};
    expect(Buffer.byteLength(JSON.stringify(nearlyFull))).to.be.lessThan(JSON_LIMIT);
    expect(() => build(folder, {...options, closure: nearlyFull})).to.throw(/config exceeds 4 MiB/);
  });

  it("keeps OCI source privacy through fetch, generation and a src subdirectory rebuild", async () => {
    const r = registry(), host = await listening(r);
    try {
      const privateLayer = build(folder, {...options, private: true});
      const digest = await push(`${host}/source/private:v1`, privateLayer, {env: {OSD_PRIVATE_REGISTRIES: host}});
      const pack = join(root, "packs/private-pack");
      write(join(pack, "osd-pack.json"), JSON.stringify({name: "private-pack", abap: ["upstream/src"],
        sources: [{folder: "upstream", oci: `${host}/source/private@${digest}`}]}));
      await fetchAll(root, {env: {}});
      const source = join(pack, "upstream");
      expect(JSON.parse(readFileSync(join(source, ".osd-source.json"), "utf8")).private).to.equal(true);
      expect(generationSystem(root).systemPrivate).to.equal(true);
      write(join(source, "src/zcl_smoke.clas.abap"), "CLASS zcl_smoke DEFINITION PUBLIC. ENDCLASS.");
      expect(() => build(join(source, "src"), options)).to.throw().with.property("code", "PRIVATE_LAYER");
      expect(build(join(source, "src"), {...options, private: true}).config.private).to.equal(true);
    } finally { await new Promise(done => r.server.close(done)); }
  });

  it("normalizes an uppercase registry host before checking private publication", () => {
    const layer = build(folder, {...options, private: true});
    expect(() => assertPrivateTarget("LOCALHOST:5000/osd/private:v1", [layer], {OSD_PRIVATE_REGISTRIES: "localhost:5000"})).not.to.throw();
    expect(() => assertPrivateTarget("GHCR.IO/osd/private:v1", [layer], {OSD_PRIVATE_REGISTRIES: "ghcr.io"}))
      .to.throw().with.property("code", "PRIVATE_LAYER");
  });

  it("passes private mode through the hosted scanner used by compiled hosts", () => {
    write(join(root, "identifiers.json"), JSON.stringify({"корпус SAP (A4H, только локально)": ["Z_SYNTHETIC_CORPUS_OBJECT"], host: ["local-test-host"]}));
    write(join(folder, "probe.txt"), "Z_SYNTHETIC_CORPUS_OBJECT");
    installHostedLeakScanner();
    const layer = build(folder, {...options, private: true});
    expect(() => leakGate([layer.files], {}, [], [], ["smoke"], true)).not.to.throw();
    expect(() => leakGate([layer.files], {}, [], [], ["smoke"], false)).to.throw(/publish refused/);
    write(join(folder, "probe.txt"), "local-test-host");
    expect(() => leakGate([build(folder, {...options, private: true}).files], {}, [], [], ["smoke"], true)).to.throw(/publish refused/);
  });

  it("normalizes private registry hosts and ports at both push entry points", async () => {
    const layer = build(folder, {...options, private: true});
    const r = registry(), local = await listening(r);
    try {
      const digest = await push(`${local}/source/layer:v1`, layer, {env: {OSD_PRIVATE_REGISTRIES: local}});
      for (const host of ["ghcr.io:443", "ghcr.io.", "x.github.io:443", "x.github.io.", "github.io"]) {
        const ref = `${host}/test/layer:v1`, env = {OSD_PRIVATE_REGISTRIES: host};
        await refusal(() => push(ref, layer, {env}), "PRIVATE_LAYER");
        await refusal(() => pushSystem(ref, [`${local}/source/layer@${digest}`], {env}), "PRIVATE_LAYER");
        expect(() => assertPrivateTarget(ref, [layer], env)).to.throw().with.property("code", "PRIVATE_LAYER");
      }
    } finally { await new Promise(done => r.server.close(done)); }
    expect(() => assertPrivateTarget("localhost:1234/test/layer:v1", [layer], {OSD_PRIVATE_REGISTRIES: "LOCALHOST"})).to.throw().with.property("code", "PRIVATE_LAYER");
    expect(() => assertPrivateTarget("localhost/test/layer:v1", [layer], {OSD_PRIVATE_REGISTRIES: "LOCALHOST"})).not.to.throw();
    expect(() => assertPrivateTarget("localhost/test/layer:v1", [layer], {OSD_PRIVATE_REGISTRIES: "localhost:1234"})).to.throw().with.property("code", "PRIVATE_LAYER");
    expect(() => assertPrivateTarget("localhost:1234/test/layer:v1", [layer], {OSD_PRIVATE_REGISTRIES: "localhost:5678"})).to.throw().with.property("code", "PRIVATE_LAYER");
  });

  it("refuses private installed systems before release and download archives are made", () => {
    const fixture = join(root, "artifact-root"), identity = {
      order: 0, name: "smoke", kind: "input", private: true,
      digest: `sha256:${"1".repeat(64)}`, treeDigest: `sha256:${"2".repeat(64)}`, path: "inputs/smoke",
    };
    write(join(fixture, ".local/system/.osd-system.json"), JSON.stringify({digest: `sha256:${"3".repeat(64)}`, layers: [identity]}));
    write(join(fixture, ".local/system/inputs/smoke/.osd-layer.json"), JSON.stringify(identity));
    mkdirSync(join(fixture, "scripts"), {recursive: true});
    symlinkSync(join(oldCwd, "tools"), join(fixture, "tools"), "dir");
    for (const script of ["make-release.mjs", "make-download-bundle.mjs"]) {
      copyFileSync(join(oldCwd, "scripts", script), join(fixture, "scripts", script));
      const args = script === "make-release.mjs" ? [join(fixture, ".local/release")] : ["linux-amd64"];
      const result = spawnSync(process.execPath, [join(fixture, "scripts", script), ...args], {cwd: fixture, encoding: "utf8"});
      expect(result.status, result.stderr).not.to.equal(0);
      expect(result.stderr).to.include("private layer smoke");
    }
  });

  it("passes private leak mode only for private layers", () => {
    write(join(root, "identifiers.json"), JSON.stringify({"корпус SAP (A4H, только локально)": ["Z_SYNTHETIC_CORPUS_OBJECT"], host: ["local-test-host"], credential: ["test-token-secret"]}));
    const file = join(folder, "probe.txt");
    write(file, "Z_SYNTHETIC_CORPUS_OBJECT");
    const privateLayer = build(folder, {...options, private: true});
    const publicLayer = build(folder, options);
    leakGate([privateLayer.files], {config: privateLayer.config}, [privateLayer.configBytes], [], ["smoke"], true);
    expect(() => leakGate([publicLayer.files], {}, [], [], ["smoke"])).to.throw(/publish refused/);
    for (const content of ["local-test-host", "test-token-secret", [192, 168, 1, 42].join("."), ["c0", "a8", "01", "2a", "112233445566778899aabbcc"].join("")]) {
      write(file, content);
      const marked = build(folder, {...options, private: true});
      expect(() => leakGate([marked.files], {}, [], [], ["smoke"], true)).to.throw(/publish refused/);
    }
  });

  it("refuses private layer pushes without an exact local registry allow-list, including GHCR", async () => {
    const r = registry(), host = await listening(r), old = process.env.OSD_PRIVATE_REGISTRIES;
    const target = `${host}/osd/private:v1`;
    try {
      delete process.env.OSD_PRIVATE_REGISTRIES;
      await refusal(() => main(["push", target, folder, "--name", "smoke", "--kind", "customer", "--private"]), "PRIVATE_LAYER");
      const cli = spawnSync(process.execPath, [join(oldCwd, "tools/osd-layer.mjs"), "push", target, folder, "--name", "smoke", "--kind", "customer", "--private"],
        {encoding: "utf8", env: {...process.env, OSD_PRIVATE_REGISTRIES: ""}});
      expect(cli.status).to.equal(2);
      expect(cli.stderr).to.include(`PRIVATE_LAYER: private layer smoke cannot be published to ${host}`);
      process.env.OSD_PRIVATE_REGISTRIES = "";
      await refusal(() => main(["push", target, folder, "--name", "smoke", "--kind", "customer", "--private"]), "PRIVATE_LAYER");
      process.env.OSD_PRIVATE_REGISTRIES = `127.0.0.1, ${host}`;
      await main(["push", target, folder, "--name", "smoke", "--kind", "customer", "--private"]);
      expect((await pull(`${host}/osd/private@${build(folder, {name: "smoke", kind: "customer", private: true}).digest}`)).config.private).to.equal(true);
      process.env.OSD_PRIVATE_REGISTRIES = `ghcr.io, ${host}`;
      await refusal(() => main(["push", "ghcr.io/example/private:v1", folder, "--name", "smoke", "--kind", "customer", "--private"]), "PRIVATE_LAYER");
    } finally {
      if (old === undefined) delete process.env.OSD_PRIVATE_REGISTRIES; else process.env.OSD_PRIVATE_REGISTRIES = old;
      await new Promise(done => r.server.close(done));
    }
  });

  it("keeps every existing repository file and its custom starting folder", () => {
    const repo = join(root, "repo");
    const xml = abapgitXml().replace("/src/", "/objects/");
    write(join(repo, ".abapgit.xml"), xml);
    write(join(repo, "objects/deep/zcl_smoke.clas.abap"), "* source\r\n");
    write(join(repo, "README.md"), "repository readme");
    const built = build(repo, {...options, source: "https://github.com/example/repo@abc:objects"});
    expect([...archiveFiles(built.zip).keys()]).to.deep.equal([".abapgit.xml", "README.md", "objects/deep/zcl_smoke.clas.abap"]);
    expect(archiveFiles(built.zip).get(".abapgit.xml").toString()).to.equal(xml);
    expect(built.config.source).to.deep.equal({repo: "https://github.com/example/repo", commit: "abc", path: "objects"});
    expect(built.manifest.annotations["org.opencontainers.image.source"]).to.equal("https://github.com/example/repo");
    expect(built.zip.readUInt16LE(4)).to.equal(20);
    expect(built.zip.readUInt16LE(6)).to.equal(0x800);
    expect(built.zip.readUInt16LE(10)).to.equal(0);
    expect(built.zip.readUInt16LE(12)).to.equal(33);
    expect(built.zip.readUInt16LE(28)).to.equal(0);
  });

  it("refuses symlinks, nonregular entries and reserved fetch metadata", () => {
    symlinkSync(join(folder, "zcl_smoke.clas.abap"), join(folder, "link"));
    expect(() => build(folder, options)).to.throw(/only regular/);
    rmSync(join(folder, "link"));
    write(join(folder, "nested/.osd-source.json"), "{}");
    expect(() => build(folder, options)).to.throw(/cannot be published/);
  });

  it("pushes through the CLI, pulls exact bytes and fetches a real OSD pack with verified treeDigest", async () => {
    const r = registry(), host = await listening(r), target = `${host}/osd/pack:v2`;
    try {
      await main(["push", target, folder, "--name", "smoke", "--kind", "input"]);
      const a = build(folder, options), ref = `${host}/osd/pack@${a.digest}`;
      const result = await pull(ref);
      expect(result.layers[0].bytes).to.deep.equal(a.zip);
      expect(result.config).to.deep.equal(a.config);
      expect(r.scopes).to.include("repository:osd/pack:pull,push");
      const before = r.uploads;
      await push(target, a);
      expect(r.uploads).to.equal(before);
      write(join(root, "packs/smoke/osd-pack.json"), JSON.stringify({name: "smoke", abap: ["upstream"], sources: [{folder: "upstream", oci: ref}]}));
      const [fetched] = await fetchAll(root, {env: {}});
      expect(fetched.treeDigest).to.equal(a.config.treeDigest);
      expect(readFileSync(join(root, "packs/smoke/upstream/zcl_smoke.clas.abap"))).to.deep.equal(readFileSync(join(folder, "zcl_smoke.clas.abap")));
      expect((await inspect(ref)).treeDigest).to.equal(a.config.treeDigest);
    } finally { await new Promise((done) => r.server.close(done)); }
  });

  it("regression 5: runs the workflow publish, inspect and pack fetch-back commands", async () => {
    const r = registry(), host = await listening(r);
    try {
      const workflow = parseYaml(readFileSync(join(oldCwd, ".github/workflows/oci-layers.yml"), "utf8"));
      const step = workflow.jobs.smoke.steps.find(s => s.name === "publish two layers and a system, inspect and fetch");
      // Change only the registry destination. Execute the workflow's exact
      // shell, including its generated pack manifest and final byte comparison.
      const script = step.run.replace(/^registry_repo=.*$/m, `registry_repo="${host}/workflow"`);
      expect(script).not.to.equal(step.run);
      const result = await new Promise((done, reject) => {
        const child = spawn("bash", ["-e", "-c", script], {cwd: oldCwd,
          env: {...process.env, RUN_ID: "test", TMPDIR: root}, stdio: ["ignore", "pipe", "pipe"]});
        let output = "";
        child.stdout.on("data", b => { output += b; });
        child.stderr.on("data", b => { output += b; });
        child.on("error", reject);
        child.on("close", code => done({code, output}));
      });
      expect(result.code, result.output).to.equal(0);
      expect(r.uploads).to.be.greaterThan(0);
    } finally { await new Promise(done => r.server.close(done)); }
  });

  for (const mount of [true, false]) it(`copies two repositories into a system with ${mount ? "mounts" : "upload fallback"}`, async () => {
    const r = registry({mount}), host = await listening(r);
    try {
      const a = build(folder, options), b = build(folder, {...options, name: "upper", kind: "input"});
      const d1 = await push(`${host}/source/one:v1`, a), d2 = await push(`${host}/source/two:v1`, b);
      const uploads = r.uploads;
      const target = `${host}/system/all:v1`;
      const digest = await pushSystem(target, [`${host}/source/one@${d1}`, `${host}/source/two@${d2}`], {root: oldCwd});
      const ref = `${host}/system/all@${digest}`, m = await manifest(ref);
      expect(m.json.manifests.map((d) => d.annotations["org.osd.layer.order"])).to.deep.equal(["0", "1"]);
      expect(m.json.annotations["org.osd.transpiler"]).to.match(/@/);
      expect(r.mounts).to.equal(3); // shared ZIP is mounted only once
      expect(r.uploads - uploads).to.equal(mount ? 0 : 3);
      for (const d of m.json.manifests) expect((await pull(`${host}/system/all@${d.digest}`)).layers[0].bytes).to.deep.equal(a.zip);
      expect((await inspect(ref)).layers.map((l) => l.name)).to.deep.equal(["smoke", "upper"]);
      const reversed = {...m.json, manifests: [...m.json.manifests].reverse()};
      expect(systemLayers(reversed).map((d) => d.annotations["org.osd.layer.order"])).to.deep.equal(["0", "1"]);
      for (const order of ["0", "2", "01", undefined]) {
        const invalid = structuredClone(m.json);
        invalid.manifests[1].annotations["org.osd.layer.order"] = order;
        expect(() => systemLayers(invalid)).to.throw(/contiguous/);
      }
      const same = await pushSystem(`${host}/system/all:v2`, m.json.manifests.map((d) => `${host}/system/all@${d.digest}`), {root: oldCwd});
      expect(same).to.equal(digest);
    } finally { await new Promise((done) => r.server.close(done)); }
  });

  it("refuses folder or metadata identifiers before anything reaches the registry, with CLI exit 2", async () => {
    const r = registry(), host = await listening(r);
    try {
      write(join(folder, "secret.txt"), "forbidden_publish_identifier");
      await refusal(() => main(["push", `${host}/osd/pack:v1`, folder, "--name", "smoke", "--kind", "input"]), "LEAK");
      const result = spawnSync(process.execPath, [join(oldCwd, "tools/osd-layer.mjs"), "push", `${host}/osd/pack:v1`, folder, "--name", "smoke", "--kind", "input"], {encoding: "utf8"});
      expect(result.status).to.equal(2);
      expect(result.stderr).to.include("LEAK");
      expect(r.requests).to.equal(0);
      rmSync(join(folder, "secret.txt"));
      await refusal(() => main(["push", `${host}/osd/pack:v1`, folder, "--name", "smoke", "--kind", "input", "--source", "forbidden_publish_identifier@abc:src"]), "LEAK");
      expect(r.requests).to.equal(0);
    } finally { await new Promise((done) => r.server.close(done)); }
  });

  it("refuses a system containing a leaking layer before destination uploads", async () => {
    const r = registry(), host = await listening(r);
    try {
      const layer = build(folder, {...options, source: "forbidden_publish_identifier@abc:src"});
      const digest = await push(`${host}/source/one:v1`, layer);
      const uploads = r.uploads;
      await refusal(() => pushSystem(`${host}/system/all:v1`, [`${host}/source/one@${digest}`]), "LEAK");
      expect(r.uploads).to.equal(uploads);
      expect(r.mounts).to.equal(0);
    } finally { await new Promise((done) => r.server.close(done)); }
  });

  it("marks private system descriptors, sums closure, and refuses a private config even if its marker is stripped", async () => {
    const r = registry(), host = await listening(r), old = process.env.OSD_PRIVATE_REGISTRIES;
    try {
      process.env.OSD_PRIVATE_REGISTRIES = host;
      const privateLayer = build(folder, {...options, private: true, closure: {unresolved: 2, items: []}});
      const publicLayer = build(folder, {...options, name: "upper", closure: {unresolved: 3, items: [{}]}});
      const one = await push(`${host}/source/one:v1`, privateLayer);
      const two = await push(`${host}/source/two:v1`, publicLayer);
      const refs = [`${host}/source/one@${one}`, `${host}/source/two@${two}`];
      delete process.env.OSD_PRIVATE_REGISTRIES;
      await refusal(() => pushSystem(`${host}/system/all:v1`, refs), "PRIVATE_LAYER");
      process.env.OSD_PRIVATE_REGISTRIES = host;
      const digest = await pushSystem(`${host}/system/all:v1`, refs);
      const index = await manifest(`${host}/system/all@${digest}`);
      expect(index.json.manifests[0].annotations["org.osd.layer.private"]).to.equal("true");
      expect(index.json.annotations["org.osd.system.unresolved"]).to.equal("5");
      const summary = await inspect(`${host}/system/all@${digest}`);
      expect(summary.layers.map(layer => layer.closure.unresolved)).to.deep.equal([2, 3]);
      expect(unresolvedLines(summary)).to.deep.equal(["layer smoke: unresolved 2", "layer upper: unresolved 3", "system: unresolved 5"]);
      const log = [];
      await fetchSystem(root, `${host}/system/all@${digest}`, {log: line => log.push(line)});
      expect(log.filter(line => line.includes("unresolved"))).to.deep.equal(unresolvedLines(summary));
      const wrongCount = structuredClone(index.json);
      wrongCount.annotations["org.osd.system.unresolved"] = "4";
      const wrongCountDigest = await pushManifest(`${host}/system/all:wrong-count`, Buffer.from(JSON.stringify(wrongCount)));
      await refusal(() => inspect(`${host}/system/all@${wrongCountDigest}`), "BAD_SYSTEM");
      await refusal(() => fetchSystem(join(root, "wrong-count"), `${host}/system/all@${wrongCountDigest}`), "BAD_SYSTEM");
      const wrongPrivate = structuredClone(index.json);
      delete wrongPrivate.manifests[0].annotations["org.osd.layer.private"];
      const wrongPrivateDigest = await pushManifest(`${host}/system/all:wrong-private`, Buffer.from(JSON.stringify(wrongPrivate)));
      await refusal(() => inspect(`${host}/system/all@${wrongPrivateDigest}`), "BAD_LAYER");
      await refusal(() => fetchSystem(join(root, "wrong-private"), `${host}/system/all@${wrongPrivateDigest}`), "BAD_LAYER");
      expect(() => assertPublicSystem(root)).to.throw(/private layer smoke/);
      const stripped = structuredClone(privateLayer);
      delete stripped.manifest.annotations["org.osd.layer.private"];
      stripped.manifestBytes = Buffer.from(JSON.stringify(stripped.manifest));
      const strippedDigest = await push(`${host}/source/stripped:v1`, stripped);
      delete process.env.OSD_PRIVATE_REGISTRIES;
      await refusal(() => pushSystem(`${host}/system/all:v2`, [`${host}/source/stripped@${strippedDigest}`]), "PRIVATE_LAYER");
    } finally {
      if (old === undefined) delete process.env.OSD_PRIVATE_REGISTRIES; else process.env.OSD_PRIVATE_REGISTRIES = old;
      await new Promise(done => r.server.close(done));
    }
  });

  it("scans original config and manifest bytes before copying foreign layers", async () => {
    const r = registry(), host = await listening(r);
    try {
      const layer = build(folder, options);
      // A duplicate JSON key disappears from the parsed config, but its bytes travel.
      layer.configBytes = Buffer.from('{"name":"forbidden_publish_identifier",' + layer.configBytes.toString().slice(1));
      Object.assign(layer.manifest.config, {digest: sha256(layer.configBytes), size: layer.configBytes.length});
      layer.manifestBytes = Buffer.from(JSON.stringify(layer.manifest));
      const digest = await push(`${host}/foreign/one:v1`, layer), uploads = r.uploads;
      await refusal(() => pushSystem(`${host}/system/all:v1`, [`${host}/foreign/one@${digest}`]), "LEAK");
      expect(r.uploads).to.equal(uploads);
      expect(r.mounts).to.equal(0);
    } finally { await new Promise((done) => r.server.close(done)); }
  });

  it("fails closed without an identifier list", () => {
    delete process.env.OSD_LEAK_IDENTIFIERS;
    // In a standalone copy the scanner has neither repository nor sibling config.
    const scanner = join(root, "tools/osd-leak-scan.mjs");
    write(scanner, readFileSync(join(oldCwd, "tools/osd-leak-scan.mjs")));
    write(join(root, "tools/osd-env.mjs"), readFileSync(join(oldCwd, "tools/osd-env.mjs")));
    write(join(root, "tools/osd-main.mjs"), readFileSync(join(oldCwd, "tools/osd-main.mjs")));
    process.env.OSD_SELF = JSON.stringify([process.execPath, join(oldCwd, "test/helpers/osd-layer-host.mjs"), root]);
    expect(() => leakGate([build(folder, options).files], {})).to.throw(/SCAN_FAILED/);
  });

  it("uses stored entries and identical Node/Bun child-process digests", () => {
    write(join(folder, "varied.txt"), Array.from({length: 3000}, (_, i) => `line ${i % 71}: ${i * 17}\n`).join(""));
    const script = join(oldCwd, "tools/osd-layer.mjs");
    const run = (command, out) => {
      const result = spawnSync(command, [script, "build", folder, "--name", "smoke", "--kind", "input", "--out", out], {encoding: "utf8"});
      expect(result.status, result.stderr).to.equal(0);
      return [sha256(readFileSync(join(out, "smoke.zip"))), sha256(readFileSync(join(out, "manifest.json")))];
    };
    const node = run("node", join(root, "node"));
    expect(readFileSync(join(root, "node/smoke.zip")).readUInt16LE(8)).to.equal(0);
    if (spawnSync("bun", ["--version"]).error?.code === "ENOENT") {
      console.log("Bun not on PATH: skipping Node/Bun digest comparison");
      return;
    }
    expect(run("bun", join(root, "bun"))).to.deep.equal(node);
  });

  for (const foreign of ["comment", "deflate", "order", "treeDigest"]) it(`refuses foreign layer ${foreign} before destination writes`, async () => {
    const r = registry(), host = await listening(r);
    try {
      const layer = build(folder, options);
      if (foreign === "comment") {
        const zip = Buffer.from(layer.zip);
        const comment = Buffer.from("forbidden_publish_identifier");
        zip.writeUInt16LE(comment.length, zip.length - 2);
        layer.zip = Buffer.concat([zip, comment]);
      } else if (foreign === "deflate") layer.zip = zipFiles(layer.files, {method: 8});
      else if (foreign === "order") layer.zip = zipFiles([...layer.files].reverse(), {method: 0});
      else {
        layer.config.treeDigest = `sha256:${"0".repeat(64)}`;
        layer.configBytes = Buffer.from(JSON.stringify(layer.config));
        Object.assign(layer.manifest.config, {digest: sha256(layer.configBytes), size: layer.configBytes.length});
      }
      Object.assign(layer.manifest.layers[0], {digest: sha256(layer.zip), size: layer.zip.length});
      layer.manifestBytes = Buffer.from(JSON.stringify(layer.manifest));
      const digest = await push(`${host}/foreign/one:v1`, layer), uploads = r.uploads;
      await refusal(() => pushSystem(`${host}/system/all:v1`, [`${host}/foreign/one@${digest}`]), foreign === "treeDigest" ? "TREE_MISMATCH" : "NOT_CANONICAL");
      expect(r.uploads).to.equal(uploads);
      expect(r.mounts).to.equal(0);
    } finally { await new Promise((done) => r.server.close(done)); }
  });

  for (const name of ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "go.sum", "Cargo.lock", ".leak-allow.json", ".git/objects/opaque"]) it(`scans content under neutral names: ${name}`, () => {
    expect(() => leakGate([[{path: name, bytes: Buffer.from("forbidden_publish_identifier")}]], {})).to.throw(/LEAK|publish refused/);
  });

  for (const name of ["trace.pcap", "dump.pcapng", "src/log.JSONL"]) it(`refuses a capture file by its archive name: ${name}`, () => {
    expect(() => leakGate([[{path: name, bytes: Buffer.from("no identifier inside")}]], {})).to.throw(/capture file/);
  });

  it("names a leaking file by its archive path, not its neutral scan name", () => {
    let error;
    try { leakGate([[{path: "safe.txt", bytes: Buffer.from("x")}, {path: "src/zcl_hit.clas.abap", bytes: Buffer.from("forbidden_publish_identifier")}]], {}); } catch (e) { error = e; }
    expect(error?.message).to.include("src/zcl_hit.clas.abap");
    expect(/sha256:[0-9a-f]{8}/.test(error?.message)).to.equal(false);
    expect(error?.message).not.to.match(/content\/\d{6}\.txt/);
  });

  for (const kind of ["lib", "input", "pack", "customer"]) it(`binds category exceptions to reviewed bytes and counts in ${kind}`, () => {
    const bytes = Buffer.from("forbidden_publish_identifier\n* fixture");
    const path = "src/vector.abap", name = `fixture-${kind}`;
    const entry = {layer: name, file: path, fileSha256: sha256(bytes), category: "identifier", count: 1, reason: "Class B: fixture"};
    const files = [{path, bytes}];
    expect(() => leakGate([files], {}, [], [entry], [name])).not.to.throw();
    // Change an unrelated byte, preserving the match itself.
    const changed = Buffer.from(bytes);
    changed[changed.length - 1] ^= 1;
    let error;
    try { leakGate([[{path, bytes: changed}]], {}, [], [entry], [name]); } catch (e) { error = e; }
    expect(error?.code).to.equal("BAD_ALLOW");
    expect(error?.message).to.include(`${name}:${path}`);
    error = undefined;
    try { leakGate([files], {}, [], [{...entry, count: 2}], [name]); } catch (e) { error = e; }
    expect(error?.code).to.equal("BAD_ALLOW");
    expect(error.message).to.include(path);
    expect(error.message).not.to.match(/content\/\d{6}\.txt/);
    expect(() => leakGate([files], {}, [], [{...entry, category: "uuid"}], [name])).to.throw(/match count changed/);
    for (const value of [[192, 168, 247, 231].join("."), "forbidden_publish_identifier"]) {
      expect(() => leakGate([[...files, {path: "src/other.abap", bytes: Buffer.from(value)}]], {}, [], [entry], [name])).to.throw(/publish refused/);
      expect(() => leakGate([[{path, bytes: Buffer.concat([bytes, Buffer.from(value)])}]], {}, [], [entry], [name])).to.throw(/SHA-256 changed/);
    }
    expect(() => leakGate([files, files], {}, [], [entry], [name, "other"])).to.throw(/publish refused/);
    expect(() => leakGate([files], {}, [bytes], [entry], [name])).to.throw(/publish refused/);
  });
  it("stores only file digests, categories and counts in release exceptions", () => {
    const entries = readLeakAllow(join(oldCwd, ".leak-allow.release.json"));
    expect(entries.length > 0).to.equal(true);
    expect(entries.every(e => !('value' in e) && /^sha256:[0-9a-f]{64}$/.test(e.fileSha256) && e.count > 0)).to.equal(true);
  });

  it("refuses an allow entry for a path the layer does not have, or for metadata", () => {
    const safe = [[{path: "src/a.clas.abap", bytes: Buffer.from("safe")}]];
    for (const file of ["src/missing.clas.abap", "OCI metadata", "paths.txt", "meta.json"]) {
      expect(() => leakGate(safe, {}, [Buffer.from("{}")], [{file, value: "x1234", reason: "r"}])).to.throw(/BAD_ALLOW|no such file/);
    }
  });

  it("never lets an archive file's exception reach the metadata documents, whatever it is called", () => {
    const hit = Buffer.from("forbidden_publish_identifier");
    for (const name of ["OCI metadata", "paths.txt", "meta.json"]) {
      const allow = [{layer: "one", file: name, fileSha256: sha256(hit), category: "identifier", count: 1, reason: "r"}];
      expect(() => leakGate([[{path: name, bytes: hit}]], {}, [], allow, ["one"])).not.to.throw();
      // the same value in a raw config document (a duplicate key parsing would drop) stays refused
      expect(() => leakGate([[{path: name, bytes: hit}]], {}, [Buffer.from('{"name":"forbidden_publish_identifier","name":"smoke"}')], allow, ["one"]))
        .to.throw(/publish refused/);
    }
  });

  it("scopes an entry with a layer to that layer of a system", () => {
    const hit = Buffer.from("forbidden_publish_identifier");
    const trees = [[{path: "src/v.clas.abap", bytes: hit}], [{path: "src/v.clas.abap", bytes: hit}]];
    const entry = {file: "src/v.clas.abap", fileSha256: sha256(hit), category: "identifier", count: 1, reason: "r"};
    expect(() => leakGate(trees, {}, [], [{...entry, layer: "one"}], ["one", "two"])).to.throw(/publish refused/);
    expect(() => leakGate(trees, {}, [], [{...entry, layer: "one"}, {...entry, layer: "two"}], ["one", "two"])).not.to.throw();
    expect(() => leakGate(trees, {}, [], [{...entry, layer: "three"}], ["one", "two"])).to.throw(/BAD_ALLOW|no such file/);
    expect(() => leakGate(trees, {}, [], [{...entry, layer: "one"}], ["one", "one"])).to.throw(/more than one layer/);
    // an unscoped entry in a system is refused rather than applied to every layer
    expect(() => leakGate(trees, {}, [], [entry], ["one", "two"])).to.throw(/needs "layer"/);
    expect(() => leakGate([trees[0]], {}, [], [entry], ["one"])).not.to.throw();
  });

  it("reads an allow file only with a reason on every entry", async () => {
    const file = join(root, "allow.json");
    writeFileSync(file, JSON.stringify({allow: [{file: "src/a.clas.abap", layer: "one", fileSha256: sha256(Buffer.from("safe")), category: "uuid", count: 1}]}));
    expect(() => readLeakAllow(file)).to.throw(/reason/);
    writeFileSync(file, JSON.stringify([{file: "a", value: "v", reason: "r"}]));
    expect(() => readLeakAllow(file)).to.throw(/allow/);
    writeFileSync(file, JSON.stringify({allow: [{file: "src/a.clas.abap", fileSha256: sha256(Buffer.from("safe")), layer: "one", category: "uuid", count: 1, reason: "upstream vector"}]}));
    expect(readLeakAllow(file)).to.have.length(1);
    writeFileSync(file, JSON.stringify({allow: [{file: "a", fileSha256: sha256(Buffer.from("safe")), category: "uuid", count: 1, reason: "r", layer: ""}]}));
    expect(() => readLeakAllow(file)).to.throw(/layer/);
    for (const bad of [{allow: [{file: "a", value: "v", reason: "r", Layer: "x"}]}, {allow: [], extra: 1}, {allow: ["x"]}, {allow: [[]]}]) {
      writeFileSync(file, JSON.stringify(bad));
      expect(() => readLeakAllow(file), JSON.stringify(bad)).to.throw(/BAD_ALLOW|unknown key|not an object/);
    }
    let refused;
    try { await main(["build", folder, "--name", "x", "--kind", "input", "--out", join(root, "o"), "--leak-allow", file]); } catch (e) { refused = e; }
    expect(refused?.message).to.match(/no leak gate/);
    writeFileSync(file, " ".repeat(1024 * 1024 + 1));
    expect(() => readLeakAllow(file)).to.throw(/1 MiB/);
    // a pipe stats as size 0; the cap is measured on what was read (a shell
    // pipe, since Node's own child stdin is a socket /dev/stdin cannot open)
    const reader = `import {readLeakAllow} from ${JSON.stringify(new URL("../tools/osd-layer.mjs", import.meta.url).href)}; try { readLeakAllow("/dev/stdin"); } catch (e) { console.log(e.message); }`;
    const piped = spawnSync("sh", ["-c", `"$0" -e 'process.stdout.write(" ".repeat(1024 * 1024 + 1))' | "$0" --input-type=module -e "$1"`, process.execPath, reader], {encoding: "utf8"});
    expect(piped.stdout).to.match(/1 MiB/);
  });

  it("refuses oversized content instead of skipping it", () => {
    expect(() => leakGate([[{path: "large.txt", bytes: Buffer.alloc(8 * 1024 * 1024 + 1, 32)}]], {})).to.throw(/size limit/);
  });

  it("uses a coarse identifier exception across private list categories", () => {
    const list = process.env.OSD_LEAK_IDENTIFIERS;
    const original = readFileSync(list);
    try {
      writeFileSync(list, JSON.stringify({first: ['unmatched_fixture'], second: ['forbidden_publish_identifier']}));
      const bytes = Buffer.from('forbidden_publish_identifier');
      const entry = {layer: 'one', file: 'src/probe.abap', fileSha256: sha256(bytes), category: 'identifier', count: 1, reason: 'fixture'};
      expect(() => leakGate([[{path: entry.file, bytes}]], {}, [], [entry], ['one'])).not.to.throw();
    } finally { writeFileSync(list, original); }
  });

  it("scans archive paths and reports redacted hits", () => {
    expect(() => leakGate([[{path: "forbidden_publish_identifier.txt", bytes: Buffer.from("safe")}]], {})).to.throw(/identifier/);
  });

  it("resolves the scanner from its module when unhosted in another cwd", () => {
    delete process.env.OSD_SELF;
    setHostedLeakScanner(undefined);
    expect(() => leakGate([build(folder, options).files], {})).not.to.throw();
    expect(() => leakGate([[{path: "safe", bytes: Buffer.from("forbidden_publish_identifier")}]], {})).to.throw(/identifier/);
  });

  it("uses the fixed first-party scanner in plain Node despite OSD_SELF", () => {
    setHostedLeakScanner(undefined);
    process.env.OSD_SELF = JSON.stringify([process.execPath, "-e", "process.exit(0)"]);
    expect(() => leakGate([[{path: "safe", bytes: Buffer.from("forbidden_publish_identifier")}]], {})).to.throw(/identifier/);
  });
  it('ignores parent OSD_SELF when selecting the scanner command and passes only PATH HOME and LANG', () => {
    setHostedLeakScanner(undefined);
    const original = childProcess.spawnSync;
    const oldOptions = process.env.NODE_OPTIONS, oldExtra = process.env.UNREVIEWED_SCANNER_ENV;
    process.env.OSD_SELF = JSON.stringify(['/fixture/unreviewed-host', '--parent']);
    process.env.NODE_OPTIONS = '--import=/unreviewed-loader.mjs';
    process.env.UNREVIEWED_SCANNER_ENV = 'fixture';
    let calls = 0;
    childProcess.spawnSync = (command, args, options) => {
      calls++;
      expect(command).to.equal(process.execPath);
      expect(args.slice(0, 3)).to.deep.equal([join(oldCwd, 'tools/osd-leak-scan.mjs'), '--identifiers', process.env.OSD_LEAK_IDENTIFIERS]);
      expect(options.env).to.deep.equal({PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', LANG: 'C.UTF-8'});
      return {status: 0};
    };
    syncBuiltinESMExports();
    try {
      leakGate([[{path: 'safe', bytes: Buffer.from('safe')}]], {});
      expect(calls).to.equal(1);
    } finally {
      childProcess.spawnSync = original;
      if (oldOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = oldOptions;
      if (oldExtra === undefined) delete process.env.UNREVIEWED_SCANNER_ENV; else process.env.UNREVIEWED_SCANNER_ENV = oldExtra;
      syncBuiltinESMExports();
    }
  });

  it("distinguishes scanner spawn failures and exit 2 from leaks", () => {
    process.env.OSD_SELF = JSON.stringify([join(root, "missing-scanner")]);
    expect(() => leakGate([build(folder, options).files], {})).to.throw(/SCAN_FAILED:.*ENOENT/);
    process.env.OSD_SELF = JSON.stringify([process.execPath, "-e", "process.exit(2)"]);
    expect(() => leakGate([build(folder, options).files], {})).to.throw(/SCAN_FAILED:.*2/);
  });

  for (const system of [false, true]) it(`scans ${system ? "system" : "layer"} destination references`, async () => {
    const r = registry(), host = await listening(r);
    try {
      if (system) {
        const digest = await push(`${host}/source/one:v1`, build(folder, options)), uploads = r.uploads;
        await refusal(() => pushSystem(`${host}/system/all:forbidden_publish_identifier`, [`${host}/source/one@${digest}`]), "LEAK");
        expect(r.uploads).to.equal(uploads);
        expect(r.mounts).to.equal(0);
      } else {
        await refusal(() => main(["push", `${host}/forbidden_publish_identifier/pack:v1`, folder, "--name", "smoke", "--kind", "input"]), "LEAK");
        expect(r.requests).to.equal(0);
      }
    } finally { await new Promise((done) => r.server.close(done)); }
  });

  it("excludes .git directories, .git files and node_modules and logs exclusions", async () => {
    const r = registry(), host = await listening(r), logs = [], original = console.error;
    console.error = (...args) => logs.push(args.join(" "));
    try {
      write(join(folder, ".git/config"), "forbidden_publish_identifier");
      write(join(folder, "nested/.git"), "forbidden_publish_identifier");
      write(join(folder, "node_modules/pkg/index.js"), "forbidden_publish_identifier");
      await main(["push", `${host}/osd/pack:v1`, folder, "--name", "smoke", "--kind", "input"]);
      const layer = await pull(`${host}/osd/pack@${build(folder, options).digest}`);
      expect([...archiveFiles(layer.layers[0].bytes).keys()]).to.deep.equal([".abapgit.xml", "src/zcl_smoke.clas.abap"]);
      expect(logs.join("\n")).to.include(".git").and.include("node_modules");
    } finally { console.error = original; await new Promise((done) => r.server.close(done)); }
  });

  it("preserves upload Location query bytes", async () => {
    const requests = [], bytes = Buffer.from("zip");
    await pushBlob("registry.example/osd/pack:v1", bytes, {fetch: async (url) => {
      requests.push(String(url));
      if (requests.length === 1) return new Response(null, {status: 404});
      if (requests.length === 2) return new Response(null, {status: 202, headers: {location: "/upload?token=a%20b&signature=x~y"}});
      return new Response(null, {status: 201});
    }});
    expect(requests[2]).to.equal(`https://registry.example/upload?token=a%20b&signature=x~y&digest=${encodeURIComponent(sha256(bytes))}`);
  });

  it("keeps publication credentials out of install steps", () => {
    const workflow = parseYaml(readFileSync(join(oldCwd, ".github/workflows/oci-layers.yml"), "utf8"));
    const job = workflow.jobs.smoke;
    expect(job.env).not.to.have.property("GITHUB_TOKEN");
    expect(job.env).not.to.have.property("GITHUB_ACTOR");
    expect(job.steps.find((s) => s.uses?.startsWith("actions/checkout")).with["persist-credentials"]).to.equal(false);
    const publish = job.steps.find((s) => s.name?.startsWith("publish two"));
    expect(publish.env).to.have.property("GITHUB_TOKEN");
    expect(publish.env).to.have.property("GITHUB_ACTOR");
  });

  for (const check of ["absent transpiler", "tool checkout commit", "downloads blobs only once"]) it(`handles ${check}`, async () => {
    write(join(root, "libs.lock.json"), JSON.stringify(check === "absent transpiler" ? {} : {transpiler: {repo: "example/transpiler", ref: "test"}}));
    execFileSync("git", ["init", "--quiet"], {cwd: root});
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "fixture"], {cwd: root});
    const r = registry({mount: false}), host = await listening(r), reads = new Map();
    const fetchOnce = async (url, init) => {
      if ((!init?.method || init.method === "GET") && String(url).includes("/blobs/")) {
        reads.set(String(url), (reads.get(String(url)) ?? 0) + 1);
        if (check === "downloads blobs only once") expect(reads.get(String(url)), String(url)).to.equal(1);
      }
      return fetch(url, init);
    };
    try {
      const digest = await push(`${host}/source/one:v1`, build(folder, options));
      const target = `${host}/system/all:v1`;
      const index = await pushSystem(target, [`${host}/source/one@${digest}`], {root, fetch: fetchOnce});
      const result = await manifest(`${host}/system/all@${index}`);
      if (check === "absent transpiler") expect(result.json.annotations).not.to.have.property("org.osd.transpiler");
      if (check === "tool checkout commit") expect(result.json.annotations["org.osd.osg.commit"]).to.equal(execFileSync("git", ["rev-parse", "HEAD"], {cwd: oldCwd, encoding: "utf8"}).trim());
    } finally { await new Promise((done) => r.server.close(done)); }
  });

  it("refuses upload redirects to another origin before forwarding a token", async () => {
    const ref = "registry.example/osd/pack:v1", requests = [];
    await refusal(() => pushBlob(ref, Buffer.from("zip"), {fetch: async (url) => {
      requests.push(url);
      return requests.length === 1 ? new Response(null, {status: 404}) : new Response(null, {status: 202, headers: {location: "https://other.example/upload"}});
    }}), "UNSAFE_LOCATION");
    expect(requests).to.have.length(2);
    await refusal(() => pushManifest(`registry.example/osd/pack@sha256:${"a".repeat(64)}`, Buffer.from("{}")), "DIGEST_MISMATCH");
  });
});

// Every public entry point that copies the checkout, run as CI runs it, from
// a copy beside a synthetic private installed system: each refuses before it
// writes anything (a Pages push, a preview, an image, a seeded binary, a
// release asset, a publishing build).
describe("public entry points refuse a private installed system", function () {
  this.timeout(120000);
  const repo = new URL("..", import.meta.url).pathname;
  let fixture, outside;
  const put = (path, text) => { mkdirSync(join(fixture, path, ".."), {recursive: true}); writeFileSync(join(fixture, path), text); };
  const copy = (...paths) => { for (const path of paths) { mkdirSync(join(fixture, path, ".."), {recursive: true}); copyFileSync(join(repo, path), join(fixture, path)); } };
  const tree = () => readdirSync(fixture, {recursive: true}).map(String).sort();
  const refusedWithoutWrites = (command, args, env = {}) => {
    const before = tree();
    const result = spawnSync(command, args, {cwd: fixture, encoding: "utf8", env: {...process.env, ...env}});
    expect(result.status, result.stdout + result.stderr).not.to.equal(0);
    expect(result.stderr).to.include("private layer smoke");
    expect(tree()).to.deep.equal(before);
    return result;
  };
  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), "osd-public-guard-"));
    outside = mkdtempSync(join(tmpdir(), "osd-public-guard-origin-"));
    const identity = {order: 0, name: "smoke", kind: "input", private: true,
      digest: `sha256:${"1".repeat(64)}`, treeDigest: `sha256:${"2".repeat(64)}`, path: "inputs/smoke"};
    put(".local/system/.osd-system.json", JSON.stringify({digest: `sha256:${"3".repeat(64)}`, layers: [identity]}));
    put(".local/system/inputs/smoke/.osd-layer.json", JSON.stringify(identity));
    symlinkSync(join(repo, "tools"), join(fixture, "tools"), "dir");
  });
  afterEach(() => { rmSync(fixture, {recursive: true, force: true}); rmSync(outside, {recursive: true, force: true}); });

  it("pages-push publish leaves the gh-pages tip and the checkout as they were", () => {
    const origin = join(outside, "origin.git"), seed = join(outside, "seed"), git = (...args) => execFileSync("git", args, {encoding: "utf8"}).trim();
    git("init", "-q", "--bare", origin);
    git("init", "-q", seed);
    writeFileSync(join(seed, "index.html"), "synthetic\n");
    git("-C", seed, "add", "index.html");
    git("-C", seed, "-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-q", "-m", "seed");
    git("-C", seed, "push", "-q", origin, "HEAD:refs/heads/gh-pages");
    const tip = git("--git-dir", origin, "rev-parse", "refs/heads/gh-pages");
    git("init", "-q", fixture);
    git("-C", fixture, "remote", "add", "origin", origin);
    copy("scripts/pages-push.mjs", "scripts/pages-index.mjs");
    put("build/preview/index.html", "synthetic preview\n");
    refusedWithoutWrites(process.execPath, ["scripts/pages-push.mjs", "publish", "main", "build/preview"], {GITHUB_SHA: ""});
    expect(git("--git-dir", origin, "rev-parse", "refs/heads/gh-pages")).to.equal(tip);
  });

  it("build-preview writes no preview", () => {
    symlinkSync(join(repo, "test"), join(fixture, "test"), "dir");
    copy("scripts/build-preview.mjs");
    refusedWithoutWrites(process.execPath, ["scripts/build-preview.mjs"]);
  });

  it("the Docker image build stops before its first step", () => {
    copy("docker/image/build.mjs", "docker/image/packs.mjs");
    refusedWithoutWrites(process.execPath, ["docker/image/build.mjs"]);
  });

  it("osd-build --publish builds nothing", () => {
    refusedWithoutWrites(process.execPath, [join(fixture, "tools/osd-build.mjs"), "--publish"], {OSD_ROOT: fixture});
  });

  it("release-verify binary refuses the asset", () => {
    copy("scripts/release-verify.mjs");
    const elf = Buffer.alloc(64);
    elf.writeUInt32BE(0x7f454c46, 0); elf[4] = 2; elf[5] = 1; elf.writeUInt16LE(0x3e, 18);
    put("osgo-linux-x64", elf);
    put("osgo-linux-x64.sha256", `${sha256(elf).slice(7)}  osgo-linux-x64\n`);
    refusedWithoutWrites(process.execPath, ["scripts/release-verify.mjs", "binary", "osgo-linux-x64", "go-linux-amd64"]);
  });

  it("build-binary --seed stages no seed", function () {
    if (spawnSync("bun", ["--version"]).status !== 0) this.skip();
    symlinkSync(join(repo, "editors"), join(fixture, "editors"), "dir");
    symlinkSync(join(repo, "node_modules"), join(fixture, "node_modules"), "dir");
    copy("scripts/build-binary.mjs", "scripts/build-vsix.mjs", "scripts/third-party-notices.mjs");
    refusedWithoutWrites("bun", ["scripts/build-binary.mjs", "--seed", join(outside, "osd")]);
  });
});

// P1-1, the critic's repro: a public live generation, then a private OCI pack
// declared and fetched AFTER the build (or any other change to the tree).
// Each entry point that copies the tree refuses before it writes; a release
// made before the fetch no longer verifies against the tree.
describe("public entry points refuse a tree that is not the public live generation", function () {
  this.timeout(180000);
  const repo = new URL("..", import.meta.url).pathname;
  let fixture, outside;
  const put = (path, text) => { mkdirSync(join(fixture, path, ".."), {recursive: true}); writeFileSync(join(fixture, path), text); };
  const copy = (...paths) => { for (const path of paths) { mkdirSync(join(fixture, path, ".."), {recursive: true}); copyFileSync(join(repo, path), join(fixture, path)); } };
  const tree = () => readdirSync(fixture, {recursive: true}).map(String).sort();
  const refused = (message, command, args, env = {}) => {
    const before = tree();
    const result = spawnSync(command, args, {cwd: fixture, encoding: "utf8", env: {...process.env, ...env}});
    expect(result.status, result.stdout + result.stderr).not.to.equal(0);
    expect(result.stderr).to.match(message);
    expect(tree()).to.deep.equal(before);
  };
  const live = () => {
    const named = new Map(), source = join(fixture, "src/zpublic.prog.abap");
    const hash = hashOf(fixture, inputsOf(fixture), {digests: named});
    // the input folders as a build records them: a publisher reads them to
    // show the generation carries no gen/hana-src or gen/hana-ddic (#923)
    put(`build/by-input/${hash}/manifest.json`, JSON.stringify({hash, inputs: {folders: ["src"]}, systemDigest: null, systemPrivate: false, provenance: []}));
    // a valid read record: what the build read, inside what the hash named
    put(`build/by-input/${hash}/reads.json`, JSON.stringify(makeReadRecord(fixture, named, [readEntry(fixture, source, readFileSync(source))])));
    put(`build/by-input/${hash}/output/init.mjs`, "public\n");
    symlinkSync(`by-input/${hash}`, join(fixture, "build/live"));
    symlinkSync("build/live/output", join(fixture, "output"));
    return hash;
  };
  const latePrivatePack = () => {
    const oci = `localhost:5000/synthetic/demo@sha256:${"a".repeat(64)}`, identity = {oci, path: "src", exclude: [], files: 1, private: true};
    put("packs/demo/osd-pack.json", JSON.stringify({abap: ["upstream"], sources: [{folder: "upstream", oci}]}));
    put("packs/demo/.osd-fetched.json", JSON.stringify({upstream: identity}));
    put("packs/demo/upstream/.osd-source.json", JSON.stringify(identity));
    put("packs/demo/upstream/zsecret.prog.abap", "REPORT zsecret.\n");
  };
  const lateSource = () => put("src/zlate.prog.abap", "REPORT zlate.\n");
  const PRIVATE = /private input packs\/demo\/upstream/, STALE = /working tree \([0-9a-f]{16}\) is not the live generation/;
  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), "osd-public-tree-entry-"));
    outside = mkdtempSync(join(tmpdir(), "osd-public-tree-entry-out-"));
    symlinkSync(join(repo, "tools"), join(fixture, "tools"), "dir");
    put("abap_transpile.json", JSON.stringify({input_folder: ["src"], libs: []}));
    put("src/zpublic.prog.abap", "REPORT zpublic.\n");
  });
  afterEach(() => { rmSync(fixture, {recursive: true, force: true}); rmSync(outside, {recursive: true, force: true}); });

  it("make-release ships the public live tree with its links, then refuses after a late private fetch", () => {
    copy("scripts/make-release.mjs");
    const hash = live();
    const env = {...process.env, GITHUB_SHA: "0".repeat(40), OSD_NODE_DIR: join(outside, "no-node")};
    const release = join(outside, "release");
    const made = spawnSync(process.execPath, ["scripts/make-release.mjs", release], {cwd: fixture, encoding: "utf8", env});
    expect(made.status, made.stdout + made.stderr).to.equal(0);
    // P2-1: a directory artefact with links records them by target
    const record = verifyTreeArtefact(release, fixture);
    expect(record.files.output).to.deep.include({link: "build/live/output"});
    expect(record.files["build/live"]).to.deep.include({link: `by-input/${hash}`});
    latePrivatePack();
    expect(() => verifyTreeArtefact(release, fixture)).to.throw(PRIVATE);
    const again = join(outside, "release-again");
    const late = spawnSync(process.execPath, ["scripts/make-release.mjs", again], {cwd: fixture, encoding: "utf8", env});
    expect(late.status, late.stdout + late.stderr).not.to.equal(0);
    expect(late.stderr).to.match(PRIVATE);
    expect(readdirSync(outside)).to.deep.equal(["release"]);
    rmSync(join(fixture, "packs"), {recursive: true});
    lateSource();
    refused(STALE, process.execPath, ["scripts/make-release.mjs", again], env);
    // a fetch WHILE it runs: the private Node host make-release copies and
    // asks for its version is the hook; the stamp at the end refuses
    rmSync(join(fixture, "src/zlate.prog.abap"));
    const node = join(outside, "node");
    mkdirSync(join(node, "bin"), {recursive: true});
    const pack = `${fixture}/packs/demo/upstream`;
    writeFileSync(join(node, "bin/node"), `#!/bin/sh\nmkdir -p '${pack}'\nprintf '{"private":true}' > '${pack}/.osd-source.json'\necho v0.0.0\n`, {mode: 0o755});
    const during = spawnSync(process.execPath, ["scripts/make-release.mjs", again], {cwd: fixture, encoding: "utf8", env: {...env, OSD_NODE_DIR: node}});
    expect(during.status, during.stdout + during.stderr).not.to.equal(0);
    expect(during.stderr).to.match(PRIVATE);
    expect(() => verifyPublicArtefact(again)).to.throw().with.property("code", "BAD_PROVENANCE");
  });

  it("build-preview writes no preview", () => {
    symlinkSync(join(repo, "test"), join(fixture, "test"), "dir");
    copy("scripts/build-preview.mjs");
    live();
    expect(() => publicProvenance(fixture)).not.to.throw();
    lateSource();
    refused(STALE, process.execPath, ["scripts/build-preview.mjs"]);
    rmSync(join(fixture, "src/zlate.prog.abap"));
    latePrivatePack();
    refused(PRIVATE, process.execPath, ["scripts/build-preview.mjs"]);
    // $TMP: the preview names the tree as the publishing build did, $TMP off
    rmSync(join(fixture, "packs"), {recursive: true});
    put("local/tmp/ztmp.prog.abap", "REPORT ztmp.\n");
    const old = process.env.OSD_TMP;
    process.env.OSD_TMP = "off";
    try { rmSync(join(fixture, "build/live")); rmSync(join(fixture, "output")); live(); }
    finally { if (old === undefined) delete process.env.OSD_TMP; else process.env.OSD_TMP = old; }
    const result = spawnSync(process.execPath, ["scripts/build-preview.mjs"], {cwd: fixture, encoding: "utf8"});
    expect(result.stderr).not.to.match(STALE);
    expect(result.stderr).not.to.match(PRIVATE);
    expect(result.stderr, "past the public gate, not stopped by it").not.to.match(/read record|READ_RECORD|UNKNOWN_PRIVACY/);
  });

  // P3: the binary is stamped from the tree it was built from (root), not
  // from whatever directory it was started in
  it("build-binary stamps from the tree it builds, not the working directory, and --unstamped is test-only", function () {
    if (spawnSync("bun", ["--version"]).status !== 0) this.skip();
    for (const entry of ["web", "webapp", "editors", "node_modules", "data", "test", "package.json", "libs.lock.json"])
      symlinkSync(join(repo, entry), join(fixture, entry));
    // copied: the entry resolves its relative imports from where it lies
    cpSync(join(repo, "bin"), join(fixture, "bin"), {recursive: true});
    copy("scripts/build-binary.mjs", "scripts/build-vsix.mjs", "scripts/third-party-notices.mjs");
    const hash = live();
    const elsewhere = join(outside, "elsewhere");
    mkdirSync(elsewhere);
    const binary = join(outside, "osd");
    const built = spawnSync("bun", [join(fixture, "scripts/build-binary.mjs"), binary], {cwd: elsewhere, encoding: "utf8"});
    expect(built.status, built.stdout + built.stderr).to.equal(0);
    expect(verifyPublicArtefact(binary).generation).to.equal(hash);
    // --unstamped: test-only, no sidecar (a stale one goes too), so every
    // shipping path's verifyPublicArtefact refuses it; never for what ships
    const bare = spawnSync("bun", [join(fixture, "scripts/build-binary.mjs"), "--unstamped", binary], {cwd: elsewhere, encoding: "utf8"});
    expect(bare.status, bare.stdout + bare.stderr).to.equal(0);
    expect(() => verifyPublicArtefact(binary)).to.throw(/missing or invalid provenance/).with.property("code", "BAD_PROVENANCE");
    for (const args of [["--unstamped", "--seed", join(outside, "seeded")], ["--unstamped", join(outside, "target"), "bun-linux-x64-baseline"]]) {
      const misuse = spawnSync("bun", [join(fixture, "scripts/build-binary.mjs"), ...args], {cwd: elsewhere, encoding: "utf8"});
      expect(misuse.status, args.join(" ")).not.to.equal(0);
      expect(misuse.stderr).to.include("--unstamped is for a test-only checkout binary");
    }
  });

  it("build-binary --seed stages no seed", function () {
    if (spawnSync("bun", ["--version"]).status !== 0) this.skip();
    symlinkSync(join(repo, "editors"), join(fixture, "editors"), "dir");
    symlinkSync(join(repo, "node_modules"), join(fixture, "node_modules"), "dir");
    copy("scripts/build-binary.mjs", "scripts/build-vsix.mjs", "scripts/third-party-notices.mjs");
    // the library preflight runs first: the fixture's config has no libraries, nor does its lock
    put("libs.lock.json", JSON.stringify({...JSON.parse(readFileSync(join(repo, "libs.lock.json"), "utf8")), libraries: []}));
    live();
    // bun names the same generation as node does
    const agrees = spawnSync("bun", ["-e", `import {publicProvenance} from ${JSON.stringify(join(repo, "tools/osd-public-tree.mjs"))}; publicProvenance(${JSON.stringify(fixture)});`], {encoding: "utf8"});
    expect(agrees.status, agrees.stderr).to.equal(0);
    lateSource();
    refused(STALE, "bun", ["scripts/build-binary.mjs", "--seed", join(outside, "osd")]);
    rmSync(join(fixture, "src/zlate.prog.abap"));
    latePrivatePack();
    refused(PRIVATE, "bun", ["scripts/build-binary.mjs", "--seed", join(outside, "osd")]);
  });
});
