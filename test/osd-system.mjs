import {spawnSync} from "node:child_process";
import {expect} from "chai";
import {mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {registry, listening} from "./helpers/oci-registry.mjs";
import {build as layerBuild, pushSystem, validateLayer} from "../tools/osd-layer.mjs";
import {push, pushManifest, manifest, pull, sha256, treeDigest} from "../tools/osd-oci.mjs";
import {fetchSystem, main as fetchMain} from "../tools/osd-fetch.mjs";
import {activeSystem, assertPublicSystem, generationSystem, rootWebappOf, LAYER_ID, unrecordedGeneration} from "../tools/osd-system.mjs";
import {publicProvenance, restampTreeArtefact, verifyTreeArtefact, writePublicArtefact} from "../tools/osd-public-tree.mjs";
import {libraryPath} from "../tools/osd-lib-path.mjs";
import {inputFoldersOf, packsOf, dataDirsOf, ddicDirsOf, webappsOf, tilesOf, contentFoldersOf} from "../tools/osd-packs.mjs";
import {layers, libraryFiles, excludePatterns} from "../tools/osd-inputs.mjs";
import {hashOf, inputsOf, prepare} from "../tools/osd-build.mjs";
import {makeReadRecord, readEntry, sha256 as digestRead, verifyReadRecord} from "../tools/osd-read-record.mjs";
import {loadLibs, loadFiles} from "../tools/osd-transpile.mjs";
import fs from "node:fs";
import {syncBuiltinESMExports} from "node:module";
import {unitInputs} from "../tools/gogen/unit-inputs.mjs";
import {ObjectStore, ReadOnly} from "../tools/osd-store.mjs";
import {appsOf} from "../tools/osd-status.mjs";
import {resolveFrame, abapFrames, dumpOf} from "../tools/osd-where.mjs";
import {seedStatements} from "./seed.mjs";
import {abapgitXml, zipFiles} from "../tools/osd-abapgit-zip.mjs";
const write = (file, bytes) => { mkdirSync(join(file, ".."), {recursive: true}); writeFileSync(file, bytes); };
const json = (file, value) => {
  write(file, JSON.stringify(value));
  if (/\/build\/by-input\/[^/]+\/manifest\.json$/.test(file)) write(join(file, "..", "reads.json"), JSON.stringify({schema: 1, root: file.slice(0, file.indexOf("/build/by-input/")), reads: [], uncovered: []}));
};
const rejects = async (fn, code) => { let e; try { await fn(); } catch (error) { e = error; } expect(e?.code, e?.message).to.equal(code); };

describe("osd-system: one digest supplies the system", function () {
  this.timeout(60000);
  it("verifies a public read record after a tree is relocated", () => {
    const from = mkdtempSync(join(tmpdir(), "osd-reads-from-"));
    const to = mkdtempSync(join(tmpdir(), "osd-reads-to-"));
    try {
      const source = "REPORT zsynthetic.\n";
      json(join(from, ".osd-source.json"), {private: false});
      write(join(from, "src/zsynthetic.prog.abap"), source);
      const file = join(from, "src/zsynthetic.prog.abap");
      const record = makeReadRecord(from, new Map([[file, digestRead(Buffer.from(source))]]), [readEntry(from, file, Buffer.from(source))]);
      json(join(to, ".osd-source.json"), {private: false});
      write(join(to, "src/zsynthetic.prog.abap"), source);
      json(join(to, "build/live/reads.json"), record);
      expect(verifyReadRecord(to, join(to, "build/live"), new Map([[join(to, "src/zsynthetic.prog.abap"), digestRead(Buffer.from(source))]])).reads).to.have.length(1);
    } finally { rmSync(from, {recursive: true, force: true}); rmSync(to, {recursive: true, force: true}); }
  });
  it("refuses a stale live generation compiled from a private system", () => {
    const scratch = mkdtempSync(join(tmpdir(), "osd-private-generation-"));
    try {
      json(join(scratch, "abap_transpile.json"), {input_folder: [], libs: []});
      // built while a private system was installed, which has since gone
      json(join(scratch, "build/by-input/fixture/manifest.json"), {systemDigest: "sha256:" + "a".repeat(64), systemPrivate: true});
      symlinkSync("by-input/fixture", join(scratch, "build/live"));
      expect(() => assertPublicSystem(scratch)).to.throw(/private live generation/).with.property("code", "PRIVATE_LAYER");
      json(join(scratch, "build/by-input/fixture/manifest.json"), {systemDigest: null, systemPrivate: true});
      expect(() => assertPublicSystem(scratch)).to.throw().with.property("code", "PRIVATE_LAYER");
      // from another system, or from before the record: not known to be public
      json(join(scratch, "build/by-input/fixture/manifest.json"), {systemDigest: "sha256:" + "a".repeat(64), systemPrivate: false});
      expect(() => assertPublicSystem(scratch)).to.throw(/no matching public system identity/);
      json(join(scratch, "build/by-input/fixture/manifest.json"), {hash: "fixture"});
      expect(() => assertPublicSystem(scratch)).to.throw(/no matching public system identity/);
      json(join(scratch, "build/by-input/fixture/manifest.json"), {hash: hashOf(scratch, inputsOf(scratch)), systemDigest: null, systemPrivate: false, provenance: []});
      expect(() => assertPublicSystem(scratch)).not.to.throw();
      // what osd-build and osd-warm record while a private system is installed
      const identity = {order: 0, name: "synthetic", kind: "lib", private: true,
        digest: `sha256:${"1".repeat(64)}`, treeDigest: `sha256:${"2".repeat(64)}`, path: "libs/synthetic"};
      json(join(scratch, ".local/system/.osd-system.json"), {digest: `sha256:${"3".repeat(64)}`, layers: [identity]});
      json(join(scratch, ".local/system/libs/synthetic", LAYER_ID), identity);
      expect(generationSystem(scratch)).to.deep.equal({systemDigest: `sha256:${"3".repeat(64)}`, systemPrivate: true,
        provenance: [{kind: "lib", path: "libs/synthetic", digest: `sha256:${"1".repeat(64)}`, private: true}]});
    } finally { rmSync(scratch, {recursive: true, force: true}); }
  });

  // P1-1: the provenance an artefact gets is the tree it copies, not only
  // the live record. A public live generation, then a pack fetched after it.
  describe("the public tree (tools/osd-public-tree.mjs)", () => {
    let scratch;
    const oci = `localhost:5000/synthetic/demo@sha256:${"a".repeat(64)}`;
    const live = (provenance = [], reads = []) => {
      const hash = hashOf(scratch, inputsOf(scratch));
      json(join(scratch, `build/by-input/${hash}/manifest.json`), {hash, systemDigest: null, systemPrivate: false, provenance});
      json(join(scratch, `build/by-input/${hash}/reads.json`), {schema: 1, root: scratch, reads, uncovered: []});
      rmSync(join(scratch, "build/live"), {force: true});
      symlinkSync(`by-input/${hash}`, join(scratch, "build/live"));
      return hash;
    };
    const fetched = (dir, identity) => {
      json(join(dir, "osd-pack.json"), {abap: ["upstream"], sources: [{folder: "upstream", oci}]});
      write(join(dir, "upstream/zdemo.prog.abap"), "REPORT zdemo.\n");
      json(join(dir, "upstream/.osd-source.json"), {oci, path: "", exclude: [], files: 1, ...identity});
    };
    beforeEach(() => {
      scratch = mkdtempSync(join(tmpdir(), "osd-public-tree-"));
      json(join(scratch, "abap_transpile.json"), {input_folder: ["src"], libs: []});
      write(join(scratch, "src/zpublic.prog.abap"), "REPORT zpublic.\n");
    });
    afterEach(() => rmSync(scratch, {recursive: true, force: true}));

    it("refuses a private pack fetched after a public generation was built, at write and at verify", () => {
      const hash = live();
      const record = publicProvenance(scratch);
      expect(record).to.include({generation: hash, systemPrivate: false});
      const artefact = join(scratch, "artefact");
      write(join(artefact, "init.mjs"), "public");
      writePublicArtefact(artefact, scratch);
      expect(verifyTreeArtefact(artefact, scratch).generation).to.equal(hash);
      fetched(join(scratch, "packs/demo"), {private: true});
      // the edge every publisher shares, and the full check of the tree
      expect(() => assertPublicSystem(scratch)).to.throw(/private input packs\/demo\/upstream/).with.property("code", "PRIVATE_LAYER");
      for (const step of [() => publicProvenance(scratch), () => writePublicArtefact(artefact, scratch), () => verifyTreeArtefact(artefact, scratch)])
        expect(step).to.throw(/private input packs\/demo\/upstream/).with.property("code", "PRIVATE_LAYER");
    });

    // P1-A: release.yml stamps the OSGo binary through the CLI; it must run,
    // not hang on an import cycle, and refuse what the functions refuse
    it("stamps and verifies through the CLI, and refuses a stale or private tree", () => {
      const cli = (script, ...args) => spawnSync(process.execPath, [new URL(`../tools/${script}`, import.meta.url).pathname, ...args],
        {cwd: scratch, encoding: "utf8", timeout: 60000});
      const hash = live();
      const asset = join(scratch, "osgo-synthetic");
      write(asset, "synthetic binary");
      const wrote = cli("osd-public-tree.mjs", "write", asset);
      expect(wrote.status, wrote.stderr).to.equal(0);
      expect(JSON.parse(readFileSync(`${asset}.osd-provenance.json`, "utf8")).generation).to.equal(hash);
      for (const [script, operation] of [["osd-provenance.mjs", "verify"], ["osd-public-tree.mjs", "verify"]]) {
        const verified = cli(script, operation, asset);
        expect(verified.status, `${script} ${operation}: ${verified.stderr}`).to.equal(0);
      }
      // the byte-only module no longer writes; it says where writing went
      const old = cli("osd-provenance.mjs", "write", asset);
      expect(old.status, old.stderr).to.equal(2);
      expect(old.stderr).to.include("osd-public-tree.mjs write");
      write(join(scratch, "src/zlate.prog.abap"), "REPORT zlate.\n");
      for (const operation of ["write", "verify"]) {
        const stale = cli("osd-public-tree.mjs", operation, asset);
        expect(stale.status, stale.stderr).to.equal(2);
        expect(stale.stderr).to.match(/^BAD_PROVENANCE: the working tree/);
      }
      rmSync(join(scratch, "src/zlate.prog.abap"));
      fetched(join(scratch, "packs/demo"), {private: true});
      for (const operation of ["write", "verify"]) {
        const secret = cli("osd-public-tree.mjs", operation, asset);
        expect(secret.status, secret.stderr).to.equal(2);
        expect(secret.stderr).to.match(/^PRIVATE_LAYER: private input packs\/demo\/upstream/);
      }
    });

    it("recomputes privacy over the current inputs: a private OSD_PACKS folder is refused", () => {
      live();
      const outside = mkdtempSync(join(tmpdir(), "osd-public-tree-packs-"));
      const old = process.env.OSD_PACKS;
      try {
        fetched(join(outside, "extra"), {private: true});
        process.env.OSD_PACKS = outside;
        // not under packs/, so only the recomputed inputs see it
        expect(() => assertPublicSystem(scratch)).not.to.throw();
        expect(() => publicProvenance(scratch)).to.throw(/private input external\/upstream is in the tree/).with.property("code", "PRIVATE_LAYER");
      } finally {
        if (old === undefined) delete process.env.OSD_PACKS; else process.env.OSD_PACKS = old;
        rmSync(outside, {recursive: true, force: true});
      }
    });

    it("requires the working tree to hash to the live generation", () => {
      live();
      expect(() => publicProvenance(scratch)).not.to.throw();
      write(join(scratch, "src/zlate.prog.abap"), "REPORT zlate.\n");
      expect(() => publicProvenance(scratch)).to.throw(/working tree .* is not the live generation/).with.property("code", "BAD_PROVENANCE");
    });

    it("requires a complete read record before public stamping", () => {
      const hash = live();
      const file = join(scratch, `build/by-input/${hash}/reads.json`);
      rmSync(file);
      expect(() => publicProvenance(scratch)).to.throw().with.property("code", "READ_RECORD");
      json(file, {schema: 1, root: scratch, reads: [], uncovered: ["src/unaccounted.txt"]});
      expect(() => publicProvenance(scratch)).to.throw().with.property("code", "UNKNOWN_PRIVACY");
    });

    it("re-stamps an artefact changed in place only while the tree is the generation it was verified as", () => {
      live();
      const artefact = join(scratch, "preview");
      write(join(artefact, "index.html"), "public");
      writePublicArtefact(artefact, scratch);
      const before = verifyTreeArtefact(artefact, scratch);
      write(join(artefact, "screenshots/a.png"), "png");
      expect(restampTreeArtefact(artefact, scratch, before).files).to.have.property("screenshots/a.png");
      write(join(scratch, "src/zlate.prog.abap"), "REPORT zlate.\n");
      live();
      write(join(artefact, "screenshots/b.png"), "png");
      expect(() => restampTreeArtefact(artefact, scratch, before)).to.throw(/live generation changed/).with.property("code", "BAD_PROVENANCE");
    });

    // P2-4: an identity fetched before privacy existed hashes and builds;
    // only publishing refuses it, and says how to fix it
    it("hashes an old fetched identity for development and explains the publish refusal", () => {
      fetched(join(scratch, "packs/demo"), {});
      const inputs = inputsOf(scratch);
      expect(generationSystem(scratch, inputs).provenance.find(input => input.path === "packs/demo/upstream").private).to.equal(null);
      const hash = hashOf(scratch, inputs);
      expect(hash).to.match(/^[0-9a-f]{16}$/);
      // after a build recorded it as unknown
      live(generationSystem(scratch, inputs).provenance);
      expect(() => assertPublicSystem(scratch)).to.throw(/rerun node tools\/osd-fetch.mjs/);
      // a live record from before the pack: the tree check says the same
      live([]);
      expect(() => publicProvenance(scratch)).to.throw(/packs\/demo\/upstream has no recorded privacy; rerun node tools\/osd-fetch.mjs/);
    });

    // an installed layer's identity without the key is the public old format
    it("keeps a layer identity without a private key public", () => {
      const identity = {order: 0, name: "plain", kind: "input", digest: `sha256:${"1".repeat(64)}`, treeDigest: `sha256:${"2".repeat(64)}`, path: "inputs/plain"};
      json(join(scratch, ".local/system/.osd-system.json"), {digest: `sha256:${"3".repeat(64)}`, layers: [identity]});
      json(join(scratch, ".local/system/inputs/plain", LAYER_ID), identity);
      write(join(scratch, ".local/system/inputs/plain/src/zplain.prog.abap"), "REPORT zplain.\n");
      const inputs = {folders: [join(scratch, ".local/system/inputs/plain/src")]};
      expect(generationSystem(scratch, inputs).provenance.every(input => input.private === false)).to.equal(true);
    });

    it("counts private identities reached through directory links, file links and nested source trees", () => {
      const privateTree = join(scratch, "private-tree");
      json(join(privateTree, ".osd-source.json"), {private: true});
      write(join(privateTree, "src/zsynthetic.prog.abap"), "REPORT zsynthetic.\n");
      const cases = [
        () => symlinkSync(join(privateTree, "src"), join(scratch, "src"), "dir"),
        () => { write(join(scratch, "src/.keep"), ""); symlinkSync(join(privateTree, "src/zsynthetic.prog.abap"), join(scratch, "src/zsynthetic.prog.abap")); },
        () => { write(join(scratch, "src/vendor/zsynthetic.prog.abap"), "REPORT zsynthetic.\n"); json(join(scratch, "src/vendor/.osd-source.json"), {private: true}); },
      ];
      for (const setup of cases) {
        rmSync(join(scratch, "src"), {recursive: true, force: true});
        setup();
        const inputs = {folders: [join(scratch, "src")]};
        const source = [join(scratch, "src/zsynthetic.prog.abap"), join(scratch, "src/vendor/zsynthetic.prog.abap")].find(fs.existsSync);
        const reads = [readEntry(scratch, source, readFileSync(source))];
        expect(generationSystem(scratch, inputs, reads).systemPrivate).to.equal(true);
        live([], reads); // simulate the old lexical manifest, with the actual read recorded
        expect(() => publicProvenance(scratch)).to.throw().with.property("code", "PRIVATE_LAYER");
        const packed = spawnSync(process.execPath, [new URL("../tools/osd-ci-artifact.mjs", import.meta.url).pathname, "pack", join(scratch, "synthetic.tar")],
          {cwd: scratch, encoding: "utf8"});
        expect(packed.status).not.to.equal(0);
        expect(packed.stderr, packed.stderr).to.include("PRIVATE_LAYER");
      }
    });

    // P3-5: a record with systemPrivate and no provenance is built again
    it("treats a generation recorded without provenance as unrecorded", () => {
      const dir = join(scratch, "build/by-input/0123456789abcdef");
      json(join(dir, "manifest.json"), {hash: "0123456789abcdef", systemDigest: null, systemPrivate: false});
      expect(unrecordedGeneration(dir)).to.equal(true);
      json(join(dir, "manifest.json"), {hash: "0123456789abcdef", systemDigest: null, systemPrivate: false, provenance: []});
      expect(unrecordedGeneration(dir)).to.equal(false);
    });

    // #908 CI: unknown privacy is recorded, and a warm generation is a serving
    // artefact -- neither is built again on every build
    it("reuses a generation recorded as unknown, and a warm one without a record", () => {
      const dir = join(scratch, "build/by-input/fedcba9876543210");
      json(join(dir, "manifest.json"), {hash: "fedcba9876543210", systemDigest: null, systemPrivate: null, provenance: []});
      writeFileSync(join(dir, "reads.json"), "{}");
      expect(unrecordedGeneration(dir), "null is an answer").to.equal(false);
      rmSync(join(dir, "reads.json"));
      expect(unrecordedGeneration(dir), "no record, not warm").to.equal(true);
      json(`${dir}.warm.json`, {hash: "fedcba9876543210", verified: false});
      expect(unrecordedGeneration(dir), "warm, no record").to.equal(false);
      json(join(dir, "manifest.json"), {hash: "fedcba9876543210", systemDigest: null, systemPrivate: false});
      expect(unrecordedGeneration(dir), "warm still needs its system fields").to.equal(true);
    });
  });
  let root, source, r, host, ref, env, cwd;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "osd-system-"));
    source = join(root, "fixtures");
    cwd = process.cwd(); env = {...process.env};
    process.chdir(root);
    process.env.OSD_LEAK_IDENTIFIERS = join(root, "identifiers.json");
    json(process.env.OSD_LEAK_IDENTIFIERS, {test: ["forbidden_publish_identifier"]});
    delete process.env.OSD_SELF;
    r = registry(); host = await listening(r);
    write(join(source, "lib/.abapgit.xml"), abapgitXml());
    write(join(source, "lib/src/cl_lib.clas.abap"), "* library");
    write(join(source, "lib/src/skip/cl_skip.clas.abap"), "* excluded");
    write(join(source, "input/.abapgit.xml"), abapgitXml());
    write(join(source, "input/src/zcl_same.clas.abap"), "* original");
    write(join(source, "input/src/zfoo.prog.abap"), "REPORT zfoo.\nWRITE 'installed'.\n");
    write(join(source, "input/webapp/flp.html"), "installed launchpad");
    json(join(source, "input/webapp/manifest.json"), {"sap.app": {id: "installed", title: "Installed"}});
    write(join(source, "customer/zcl_same.clas.abap"), "* customer");
    for (const name of ["first", "last"]) {
      json(join(source, name, "osd-pack.json"), {name, order: name === "first" ? 999 : 0, tiles: [{title: name}]});
      write(join(source, name, "src/ddic/zrows.tabl.xml"), '<DD03P><FIELDNAME>text</FIELDNAME><DATATYPE>CHAR</DATATYPE><LENG>8</LENG></DD03P>');
      json(join(source, name, "data/zrows.tabu.json"), [{text: name}]);
      write(join(source, name, "webapp/index.html"), name);
    }
    const refs = [];
    for (const [folder, name, kind] of [["lib", "lib", "lib"], ["input", "src", "input"], ["first", "first", "pack"], ["last", "last", "pack"], ["customer", "customer", "customer"]]) {
      const built = layerBuild(join(source, folder), {name, kind});
      const d = await push(`${host}/system/all:${name}`, built);
      refs.push(`${host}/system/all@${d}`);
    }
    const d = await pushSystem(`${host}/system/all:v1`, refs);
    ref = `${host}/system/all@${d}`;
    json(join(root, "abap_transpile.json"), {input_folder: ["src", "test", "gen"], output_folder: "output", libs: [{folder: "/.local/lars/lib", files: ["/src/**"], exclude_filter: ["/src/skip/"]}]});
  });
  afterEach(async () => {
    await new Promise(done => r.server.close(done));
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    rmSync(root, {recursive: true, force: true});
  });

  it("fetches via CLI and resolves libraries as dependencies, inputs, packs, seed precedence and pages", async () => {
    process.env.OSD_ROOT = root;
    expect(await fetchMain(["--system", ref])).to.equal(0);
    const sys = activeSystem(root);
    expect(sys.digest).to.equal(ref.split("@")[1]);
    expect(sys.layers.map(l => l.kind)).to.deep.equal(["lib", "input", "pack", "pack", "customer"]);
    expect(libraryPath(root, "lib")).to.equal(join(root, ".local/system/libs/lib"));
    const config = JSON.parse(readFileSync(join(root, "abap_transpile.json")));
    const folders = inputFoldersOf(root, config);
    expect(folders).to.deep.equal([".local/system/inputs/src/src", ".local/system/packs/first/src", ".local/system/packs/last/src", ".local/system/inputs/customer/src", "gen"]);
    expect(contentFoldersOf(root)).to.deep.equal(folders.slice(0, -1));
    const stack = layers(root, config);
    expect(stack.owner.get("CLAS ZCL_SAME")).to.equal(folders[3]);
    expect(stack.overridden.find(o => o.object === "CLAS ZCL_SAME").hidden).to.deep.equal([`${folders[0]}/zcl_same.clas.abap`]);
    expect(packsOf(root).map(p => p.name)).to.deep.equal(["first", "last"]);
    expect(dataDirsOf(root)).to.deep.equal(["first", "last"].map(n => join(root, ".local/system/packs", n, "data")));
    expect(ddicDirsOf(root)).to.include(join(root, ".local/system/packs/last/src/ddic"));
    expect(webappsOf(root).map(p => p.dir)).to.deep.equal(["first", "last"].map(n => join(root, ".local/system/packs", n, "webapp")));
    expect(tilesOf(root).map(t => t.title)).to.deep.equal(["first", "last"]);
    expect(seedStatements().join("\n")).to.include("'last    '").and.not.include("first");
    expect(libraryFiles(root, config)[0].files.map(f => f.split("/").at(-1))).to.deep.equal(["cl_lib.clas.abap"]);
    expect((await loadLibs(root, config)).map(f => f.filename)).to.deep.equal(["cl_lib.clas.abap"]);
    // The tree's own inputs and packs are ignored even when present.
    write(join(root, "src/zcl_wrong.clas.abap"), "* ignored");
    json(join(root, "packs/extra/osd-pack.json"), {name: "extra"});
    expect(layers(root, config).owner.has("CLAS ZCL_WRONG")).to.equal(false);
    expect(packsOf(root).length).to.equal(2);
    const compiled = await loadFiles(root, {...config, exclude_filter: excludePatterns(stack.hidden)}, {});
    expect(compiled.files.find(f => f.filename === "zcl_same.clas.abap").contents).to.equal("* customer");
    expect(compiled.files.some(f => f.filename === "zcl_wrong.clas.abap")).to.equal(false);
    expect(() => libraryPath(root, "absent")).to.throw(/does not provide library absent/);
  });

  it("regression 1: builds the installed ObjectStore registry and still refuses user overrides", async () => {
    await fetchSystem(root, ref);
    json(join(root, "abaplint.jsonc"), {syntax: {version: "v702"}});
    const store = new ObjectStore({root});
    expect(store.registry().getObject("PROG", "ZFOO")).not.to.equal(undefined);
    process.env.OSD_PACKS = "";
    expect(() => new ObjectStore({root})).to.throw(/OSD_PACKS is refused/);
  });

  it("regression 1b: unit input discovery keeps the installed closure without injecting overrides", async () => {
    await fetchSystem(root, ref);
    const config = JSON.parse(readFileSync(join(root, "abap_transpile.json")));
    const expected = inputFoldersOf(root, config);
    const plan = unitInputs({home: root, config, extraPacks: false});
    expect(plan.folders).to.include(join(root, expected[0]));
    expect(plan.folders).to.include(join(root, ".local/system/packs/first/src"));
    expect(() => unitInputs({home: root, config, extraPacks: false, env: {OSD_PACKS: ""}})).to.throw(/OSD_PACKS is refused/);
  });

  it("regression 2: discovers root pages only from the installed src layer", async () => {
    await fetchSystem(root, ref);
    json(join(root, "webapp/manifest.json"), {"sap.app": {id: "unrelated"}});
    const webapp = rootWebappOf(root);
    expect(webapp).to.equal(join(root, ".local/system/inputs/src/webapp"));
    expect(readFileSync(join(webapp, "flp.html"), "utf8")).to.equal("installed launchpad");
    const apps = appsOf(root);
    expect(apps.map(a => a.handler)).to.include("installed").and.not.include("unrelated");
    expect(apps.find(a => a.handler === "installed").dir).to.equal(join(root, ".local/system/inputs/src/webapp"));
  });

  it("regression 3: reads logical source maps from installed ABAP rather than checkout bytes", async () => {
    await fetchSystem(root, ref);
    write(join(root, "src/zfoo.prog.abap"), "REPORT zfoo.\nWRITE 'unrelated'.\n");
    for (const [output, prefix] of [["output", "../"], ["build/by-input/fixture/output", "../../../../"]]) {
      const file = join(root, output, "zfoo.prog.mjs");
      if (output.startsWith("build/")) json(join(root, output, "../abap_transpile.json"), {});
      json(file + ".map", {version: 3, sources: [prefix + "src/zfoo.prog.abap"], names: [], mappings: "AACA"});
      expect(resolveFrame(file, 1, 1)).to.include({file: "zfoo.prog.abap", line: 2, text: "WRITE 'installed'."});
    }
  });

  async function appendLayer(folder, name, kind) {
    const l = layerBuild(folder, {name, kind});
    const d = await push(`${host}/system/all:extra`, l);
    const index = (await manifest(ref)).json;
    index.manifests.push({mediaType: l.manifest.mediaType, digest: d, size: l.manifestBytes.length,
      annotations: {"org.osd.layer.name": name, "org.osd.layer.kind": kind, "org.osd.layer.order": String(index.manifests.length)}});
    const id = await pushManifest(`${host}/system/all:extended`, Buffer.from(JSON.stringify(index)));
    return fetchSystem(root, `${host}/system/all@${id}`);
  }

  it("regression 4a: store and transpiler exclude logical test fixture paths alike", async () => {
    const folder = join(source, "test");
    write(join(folder, "fixtures/zexcluded.prog.abap"), "REPORT zexcluded.");
    write(join(folder, "zkept.prog.abap"), "REPORT zkept.");
    await appendLayer(folder, "test", "input");
    const config = JSON.parse(readFileSync(join(root, "abap_transpile.json")));
    config.not_in_system = config.exclude_filter = ["/test/fixtures/"];
    json(join(root, "abap_transpile.json"), config);
    json(join(root, "abaplint.jsonc"), {syntax: {version: "v702"}});
    const loaded = await loadFiles(root, config, {});
    expect(loaded.files.map(f => f.filename)).not.to.include("zexcluded.prog.abap");
    const reg = new ObjectStore({root}).registry();
    expect(reg.getObject("PROG", "ZKEPT")).not.to.equal(undefined);
    expect(reg.getObject("PROG", "ZEXCLUDED")).to.equal(undefined);
  });

  it("round 2 item 2: unit discovery excludes installed fixtures by logical path", async () => {
    const folder = join(source, "test");
    write(join(folder, "fixtures/adt-editor/zcl_editor.clas.testclasses.abap"), "* excluded");
    write(join(folder, "unit/zcl_kept.clas.testclasses.abap"), "* kept");
    await appendLayer(folder, "test", "input");
    const config = {...JSON.parse(readFileSync(join(root, "abap_transpile.json"))), exclude_filter: ["/test/fixtures/"]};
    const file = join(root, ".local/system/inputs/test/src/fixtures/adt-editor/zcl_editor.clas.testclasses.abap");
    const plan = unitInputs({home: root, config});
    expect(plan.skip(file)).to.equal(true);
    const kept = [join(root, ".local/system/inputs/test/src/unit/zcl_kept.clas.testclasses.abap")];
    expect(plan.sources).to.deep.equal(kept);
    expect(unitInputs({home: root, config: {...config, exclude_filter: []}}).sources).to.deep.equal(kept);
    expect((await loadFiles(root, config, {})).files.map(f => f.filename)).not.to.include("zcl_editor.clas.testclasses.abap");
  });

  it("round 2 item 4: installed store roots refuse writes and TMP without changing source or inactive state", async () => {
    await fetchSystem(root, ref);
    const store = new ObjectStore({root});
    const snapshot = dir => !fs.existsSync(dir) ? [] : fs.readdirSync(dir, {recursive: true}).sort()
      .filter(f => fs.statSync(join(dir, f)).isFile()).map(f => [f, readFileSync(join(dir, f)).toString("base64")]);
    const before = snapshot(join(root, ".local/system")), inactive = snapshot(join(root, "build/inactive"));
    expect(() => store.write("PROG", "ZFOO", "REPORT zfoo. WRITE 'changed'.")).to.throw(ReadOnly);
    expect(() => store.write("PROG", "ZNEW", "REPORT znew.")).to.throw(ReadOnly);
    expect(() => store.create("PROG", "ZNEW", {package: "$TMP"})).to.throw(ReadOnly);
    expect(store.roots.every(r => r.writable === false)).to.equal(true);
    expect(store.roots.some(r => r.path === "local/tmp")).to.equal(false);
    store.reroot();
    expect(store.roots.every(r => r.writable === false)).to.equal(true);
    expect(snapshot(join(root, ".local/system"))).to.deep.equal(before);
    expect(snapshot(join(root, "build/inactive"))).to.deep.equal(inactive);
    expect(fs.existsSync(join(root, "local/tmp"))).to.equal(false);
    expect(() => prepare(root)).not.to.throw();
  });

  it("round 2 item 5: a symlink frame with a source above the installed root still yields a dump", async () => {
    await fetchSystem(root, ref);
    const generated = join(root, "build/by-input/g1/output/zfoo.prog.mjs");
    write(generated, "throw new Error('boom');");
    json(generated + ".map", {version: 3, sources: ["../../../../src/zfoo.prog.abap"], names: [], mappings: "AACA"});
    symlinkSync(join(root, "build/by-input/g1/output"), join(root, "output"), "dir");
    const file = join(root, "output/zfoo.prog.mjs"), error = new Error("boom");
    error.stack = `Error: boom\n    at foo (${file}:1:1)`;
    expect(resolveFrame(file, 1, 1)).to.include({file: "zfoo.prog.abap", text: undefined});
    expect(() => abapFrames(error)).not.to.throw();
    expect(dumpOf(error)).to.include({message: "boom"});
  });

  it("regression 4b: library discovery uses the transpiler's logical exclusion paths", async () => {
    await fetchSystem(root, ref);
    const config = JSON.parse(readFileSync(join(root, "abap_transpile.json")));
    config.libs[0].exclude_filter = ["/\\.local/lars/lib/src/skip/"];
    const discovered = libraryFiles(root, config)[0].files.map(f => f.split("/").at(-1));
    const loaded = (await loadLibs(root, config)).map(f => f.filename);
    expect(loaded).to.deep.equal(["cl_lib.clas.abap"]);
    expect(discovered).to.deep.equal(loaded);
  });

  it("regression 6: rejects mixed-case pack names during build", () => {
    json(join(source, "first/osd-pack.json"), {name: "Demo"});
    expect(() => layerBuild(join(source, "first"), {name: "Demo", kind: "pack"})).to.throw(/lowercase/);
  });

  it("regression 6b: rejects mixed-case names in a received pack layer", () => {
    const l = layerBuild(join(source, "last"), {name: "last", kind: "pack"});
    l.config.name = l.manifest.annotations["org.osd.layer.name"] = "Demo";
    l.manifest.layers[0].annotations["org.opencontainers.image.title"] = "Demo.zip";
    l.files.find(f => f.path === "osd-pack.json").bytes = Buffer.from('{"name":"Demo"}');
    l.config.treeDigest = treeDigest(l.files.map(f => [f.path, f.bytes]));
    l.zip = zipFiles(l.files, {method: 0});
    expect(() => validateLayer({manifest: {json: l.manifest}, config: l.config, layers: [{bytes: l.zip}]})).to.throw(/lowercase/);
  });

  for (const kind of ["lib", "input", "pack", "customer"]) it(`regression 7: prepare refuses modified installed ${kind} contents`, async () => {
    await fetchSystem(root, ref);
    const layer = activeSystem(root).layers.find(l => l.kind === kind);
    write(join(root, ".local/system", layer.path, "modified.txt"), "tampered");
    expect(() => prepare(root)).to.throw(new RegExp(`${layer.name}.*run osd-fetch --system again`));
  });

  it("regression 7b: rechecks an edited library after a successful prepare", async () => {
    await fetchSystem(root, ref);
    expect(() => prepare(root)).not.to.throw();
    write(join(root, ".local/system/libs/lib/src/cl_lib.clas.abap"), "* changed");
    expect(() => prepare(root)).to.throw(/lib.*run osd-fetch --system again/);
  });

  it("regression 8: checkout selection resolves system absence once per read phase", async () => {
    for (let i = 0; i < 40; i++) write(join(root, `src/z${i}.prog.abap`), `REPORT z${i}.`);
    const original = fs.existsSync;
    let probes = 0;
    fs.existsSync = path => { if (String(path).endsWith("/.local/system/.osd-system.json")) probes++; return original(path); };
    syncBuiltinESMExports();
    try {
      const {files} = await loadFiles(root, {input_folder: ["src"], output_folder: "output", input_filter: ["."], exclude_filter: ["not_selected"]}, {});
      expect(files).to.have.length(40);
      expect(probes).to.be.at.most(2);
    } finally { fs.existsSync = original; syncBuiltinESMExports(); }
  });

  it("refuses overrides and TMP, and checks installed layer identities", async () => {
    await fetchSystem(root, ref);
    for (const key of ["OSD_PACKS", "OSD_WEB_PACKS", "OSD_LAYERS", "OSD_LIB_LIB"]) {
      expect(() => activeSystem(root, {[key]: ""})).to.throw(key);
      expect(() => inputFoldersOf(root, {}, {[key]: "value"})).to.throw(key);
    }
    mkdirSync(join(root, "local/tmp"), {recursive: true});
    expect(() => activeSystem(root, {OSD_TMP: "off"})).to.throw(/\$TMP/);
    rmSync(join(root, "local"), {recursive: true});
    json(join(root, ".local/system/libs/lib", LAYER_ID), {});
    expect(() => libraryPath(root, "lib")).to.throw(/identity differs/);
  });

  it("adds the index digest to content hashing", async () => {
    await fetchSystem(root, ref);
    const inputs = inputsOf(root), a = hashOf(root, inputs, {transpiler: "fixture"});
    expect(inputs.libs).to.deep.equal([join(root, ".local/system/libs/lib")]);
    const file = join(root, ".local/system/.osd-system.json"), system = activeSystem(root);
    system.digest = `sha256:${"a".repeat(64)}`; json(file, system);
    expect(hashOf(root, inputs, {transpiler: "fixture"})).not.to.equal(a);
  });

  for (const fault of ["gap", "tree", "canonical", "identity", "digest", "duplicate"]) it(`refuses ${fault} tampering without replacing the previous system`, async () => {
    await fetchSystem(root, ref);
    const previous = readFileSync(join(root, ".local/system/.osd-system.json"));
    const index = (await manifest(ref)).json;
    let code;
    if (fault === "gap") { index.manifests[1].annotations["org.osd.layer.order"] = "9"; code = "BAD_ORDER"; }
    else if (fault === "duplicate") { index.manifests[1] = {...index.manifests[0], annotations: {...index.manifests[0].annotations, "org.osd.layer.order": "1"}}; code = "BAD_SYSTEM"; }
    else if (fault === "digest") { r.tamperManifest = index.manifests[0].digest; code = "DIGEST_MISMATCH"; }
    else {
      const l = layerBuild(join(source, "lib"), {name: "lib", kind: "lib"});
      if (fault === "tree") { l.config.treeDigest = `sha256:${"0".repeat(64)}`; l.configBytes = Buffer.from(JSON.stringify(l.config)); l.manifest.config = {...l.manifest.config, digest: sha256(l.configBytes), size: l.configBytes.length}; code = "TREE_MISMATCH"; }
      if (fault === "canonical") { l.zip = zipFiles(l.files, {method: 8}); l.manifest.layers[0] = {...l.manifest.layers[0], digest: sha256(l.zip), size: l.zip.length}; code = "NOT_CANONICAL"; }
      l.manifestBytes = Buffer.from(JSON.stringify(l.manifest));
      const d = await push(`${host}/system/all:bad`, l);
      index.manifests[0] = {...index.manifests[0], digest: d, size: l.manifestBytes.length};
      if (fault === "identity") { index.manifests[0].annotations["org.osd.layer.name"] = "other"; code = "BAD_LAYER"; }
    }
    const d = await pushManifest(`${host}/system/all:bad-index`, Buffer.from(JSON.stringify(index)));
    await rejects(() => fetchSystem(root, `${host}/system/all@${d}`), code);
    expect(readFileSync(join(root, ".local/system/.osd-system.json"))).to.deep.equal(previous);
    expect(activeSystem(root).digest).to.equal(ref.split("@")[1]);
  });

  it("installs a local OCI layout by verified descriptors and refuses mutable tags", async () => {
    const index = await manifest(ref), base = join(root, "layout");
    write(join(base, "index.json"), index.bytes);
    for (const d of index.json.manifests) {
      const l = await pull(`${host}/system/all@${d.digest}`);
      for (const bytes of [l.manifest.bytes, l.configBytes, ...l.layers.map(l => l.bytes)]) write(join(base, "blobs/sha256", sha256(bytes).slice(7)), bytes);
    }
    expect((await fetchSystem(root, join(base, "index.json"))).digest).to.equal(index.digest);
    write(join(base, "blobs/sha256", index.digest.slice(7)), index.bytes);
    json(join(base, "index.json"), {schemaVersion: 2, mediaType: index.json.mediaType,
      manifests: [{mediaType: index.json.mediaType, digest: index.digest, size: index.bytes.length}]});
    expect((await fetchSystem(root, join(base, "index.json"))).digest).to.equal(index.digest);
    await rejects(() => fetchSystem(root, `${host}/system/all:v1`), "TAG_ONLY");
  });

  it("warns when the recorded OSG commit differs, while installing successfully", async () => {
    const index = (await manifest(ref)).json;
    index.annotations["org.osd.osg.commit"] = "0".repeat(40);
    const d = await pushManifest(`${host}/system/all:other-toolchain`, Buffer.from(JSON.stringify(index)));
    const logs = [];
    await fetchSystem(root, `${host}/system/all@${d}`, {log: line => logs.push(line)});
    expect(logs.some(line => /warning:.*records OSG.*running OSG/.test(line))).to.equal(true);
    expect(activeSystem(root).digest).to.equal(d);
  });

  it("preserves a library root even without abapGit metadata", () => {
    const l = layerBuild(join(source, "customer"), {name: "lib", kind: "lib"});
    expect(l.files.map(f => f.path)).to.include("zcl_same.clas.abap").and.not.include("src/zcl_same.clas.abap");
  });

  it("keeps pack paths at the ZIP root and refuses unresolved sources and fetched identities", () => {
    const l = layerBuild(join(source, "first"), {name: "first", kind: "pack"});
    const files = validateLayer({manifest: {json: l.manifest}, config: l.config, layers: [{bytes: l.zip}]});
    expect(files.map(f => f.path)).to.include("osd-pack.json").and.include("data/zrows.tabu.json").and.include("webapp/index.html");
    json(join(source, "first/osd-pack.json"), {name: "first", abap: ["../../outside"]});
    expect(() => layerBuild(join(source, "first"), {name: "first", kind: "pack"})).to.throw(/escapes its layer/);
    json(join(source, "first/osd-pack.json"), {name: "first", sources: [{folder: "upstream"}]});
    expect(() => layerBuild(join(source, "first"), {name: "first", kind: "pack"})).to.throw(/resolved and stripped/);
    json(join(source, "first/upstream/.osd-source.json"), {});
    expect(() => layerBuild(join(source, "first"), {name: "first", kind: "pack"})).to.throw(/cannot be published/);
  });
});
