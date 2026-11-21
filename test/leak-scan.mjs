import assert from "node:assert/strict";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";

import {publicationFindings, homePaths} from '../tools/osd-leak-scan.mjs';

describe("leak scanner", () => {
  it("private-layer mode drops only the two SAP corpus categories", () => {
    const root = mkdtempSync(join(tmpdir(), "leak-private-"));
    try {
      const list = join(root, "identifiers.json"), file = join(root, "content.txt");
      writeFileSync(list, JSON.stringify({
        "корпус SAP (A4H, только локально)": ["Z_SYNTHETIC_CORPUS_OBJECT"],
        "SEGW-образцы SAP (только локально)": ["Z_SYNTHETIC_SEGW_OBJECT"],
        "тема скрининга (политика 2026-10-01, только приватно)": ["synthetic-topic-value-one"],
        "закрытый корпус и смежное (политика 2026-10-01, заполнено osg-research по поручению Alice)": ["synthetic-closed-project"],
        host: ["local-test-host"], user: ["synthetic-logon-user"], credential: ["test-token-secret"],
      }));
      const run = content => {
        writeFileSync(file, content);
        return spawnSync(process.execPath, ["tools/osd-leak-scan.mjs", root, "--identifiers", list, "--private-layer", "--redact", "--paths", file], {encoding: "utf8"});
      };
      assert.equal(run("Z_SYNTHETIC_CORPUS_OBJECT").status, 0);
      assert.equal(run("Z_SYNTHETIC_SEGW_OBJECT").status, 0);
      for (const content of ["synthetic-topic-value-one", "synthetic-closed-project", "local-test-host", "synthetic-logon-user", "test-token-secret", [192, 168, 1, 42].join("."), ["c0", "a8", "01", "2a", "112233445566778899aabbcc"].join("")]) {
        assert.equal(run(content).status, 1, content);
      }
      writeFileSync(list, JSON.stringify({host: ["local-test-host"]}));
      const missing = run("clean");
      assert.equal(missing.status, 2);
      assert.match(missing.stderr, /requires a SAP corpus category/);
      assert.throws(() => publicationFindings(root, [file], list, true), /requires a SAP corpus category/);
    } finally { rmSync(root, {recursive: true, force: true}); }
  });
  it('supports publicationFindings as a library with explicit or discovered identifiers', () => {
    const root = mkdtempSync(join(tmpdir(), 'leak-library-'));
    try {
      mkdirSync(join(root, '.local'));
      const list = join(root, '.local/leak-identifiers.json');
      writeFileSync(list, JSON.stringify({fixture: ['library_fixture_identifier']}));
      const sources = [{file: 'content.txt', text: 'library_fixture_identifier'}];
      for (const explicit of [undefined, list]) {
        assert.deepEqual(publicationFindings(root, sources, explicit), [{file: 'content.txt', category: 'identifier'}]);
        assert.deepEqual(publicationFindings(root, [{file: 'clean.txt', text: 'clean'}], explicit), []);
      }
    } finally { rmSync(root, {recursive: true, force: true}); }
  });
  const folder = mkdtempSync(join(tmpdir(), "osd-leak-vector-"));
  const packedPrivateAddress = [
    "00112233445566778899aabb", "c0", "a8", "01", "2a", "ffeeddbbccaa9988",
  ].join("");
  const privateAddress = [192, 168, 1, 42].join(".");
  const scan = (file) => spawnSync(process.execPath,
    ["tools/osd-leak-scan.mjs", ".", "--paths", file], {encoding: "utf8"});

  after(() => rmSync(folder, {recursive: true, force: true}));

  it('accepts an explicit identifier list with a minimal environment and refuses invalid paths', () => {
    const list = join(folder, 'explicit-list.json'), file = join(folder, 'explicit-content.txt');
    writeFileSync(list, JSON.stringify({fixture: ['explicit_fixture_identifier']}));
    writeFileSync(file, 'explicit_fixture_identifier');
    const run = args => spawnSync(process.execPath, ['tools/osd-leak-scan.mjs', '--redact', ...args, '--paths', file],
      {env: {PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG}, encoding: 'utf8'});
    const found = run(['--identifiers', list]);
    assert.equal(found.status, 1);
    assert.match(found.stderr, /identifier/);
    assert.ok(!(found.stdout + found.stderr).includes('explicit_fixture_identifier'));
    const missing = run(['--identifiers', join(folder, 'missing-list.json')]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /not valid JSON/);
    for (const args of [['--identifiers'], ['--identifiers', list, '--identifiers', list]]) {
      const invalid = run(args);
      assert.equal(invalid.status, 2);
      assert.match(invalid.stderr, /needs one list path/);
    }
  });

  // A real-looking user path is assembled at run time, so this file does not
  // itself carry one for the tree-wide scan to find.
  const realHome = (lead, sep) => lead + ["jdoe", "dev", "repo", "x.mjs"].join(sep);
  it("flags a home directory whose owner is not a generic name", () => {
    assert.deepEqual(homePaths("at f (" + realHome("/home/", "/") + ":1:1)"), ["/home/jdoe"]);
    assert.deepEqual(homePaths(realHome("/Users/", "/")), ["/Users/jdoe"]);
    assert.deepEqual(homePaths(realHome("C:\\Users\\", "\\")), ["C:\\Users\\jdoe"]);
    // escaped, as inside a JS or JSON string literal
    assert.deepEqual(homePaths(realHome("C:\\\\Users\\\\", "\\\\")), ["C:\\\\Users\\\\jdoe"]);
  });
  it("lets generic and placeholder home directories through", () => {
    for (const text of [
      "/home/coder/project", "/home/runner/work/a", "/home/x/y", "/home/example/a",
      "/home/someone/a", "/home/node/app", "/Users/example/Library", "C:\\Users\\example\\AppData",
      "/home/<user>/dev", "/home/$USER/dev", "/home/some user/a tree", "~/dev/repo",
    ]) assert.deepEqual(homePaths(text), [], text);
  });
  it("reports a home path through the command line, also in UTF-16LE", () => {
    const plain = join(folder, "home-plain.txt"), wide = join(folder, "home-wide.bin");
    writeFileSync(plain, "see " + realHome("/home/", "/") + "\n");
    writeFileSync(wide, Buffer.from(realHome("/Users/", "/"), "utf16le"));
    for (const file of [plain, wide]) {
      const result = scan(file);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /домашний каталог/);
    }
    const generic = join(folder, "home-generic.txt");
    writeFileSync(generic, "/home/coder/project and /home/runner/work\n");
    assert.ok([0, 2].includes(scan(generic).status));
  });

  it("treats only declared embedding vector fields as opaque bytes", () => {
    const fixture = join(folder, "packs", "zvdb", "fixtures");
    mkdirSync(fixture, {recursive: true});
    const file = join(fixture, "corpus.test.json");
    writeFileSync(file, JSON.stringify({vectorHex: packedPrivateAddress, qbits: packedPrivateAddress}));
    const result = scan(file);
    assert.ok([0, 2].includes(result.status), result.stderr);
  });

  it("still decodes the same bytes in an ordinary field", () => {
    const file = join(folder, "ordinary.json");
    writeFileSync(file, JSON.stringify({payloadHex: packedPrivateAddress}));
    const result = scan(file);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /192\.168\.1\.42/);
  });

  it("still scans ordinary text beside an opaque vector", () => {
    const fixture = join(folder, "packs", "zvdb", "fixtures");
    mkdirSync(fixture, {recursive: true});
    const file = join(fixture, "corpus.mixed.json");
    writeFileSync(file, JSON.stringify({qbits: packedPrivateAddress, host: privateAddress}));
    const result = scan(file);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /частный адрес \(текст\): 192\.168\.1\.42/);
  });

  it("does not trust JSON-looking vector fields in an ordinary text file", () => {
    const file = join(folder, "vector-looking.txt");
    writeFileSync(file, JSON.stringify({qbits: packedPrivateAddress}));
    const result = scan(file);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /192\.168\.1\.42/);
  });

  // A SHA-256 digest packing a private prefix by chance, padded to 64 hex
  // (its halves do not read as UUIDs: no version nibble at 12, no variant at 16).
  const digest = "aaaaaaaaaaaa0aaa0a" + "c0a8012a" + "aaaaaa" + "bbbbbbbbbbbb0bbb0bbbbbbbbbbbbbbb";
  // Two session GUIDs back to back, privateAddress packed in both node fields.
  const guid = (n) => `00112233445546778899c0a8012a000${n}`;
  const guids = guid(1) + guid(2);
  // A 32-byte IPv4/UDP packet whose source address is privateAddress.
  const packet = "4500002000004000401100" + "00" + "c0a8012a" + "c0a80101" + "1f9000350008" + "0000" + "deadbeef";
  const digestFile = (name, body) => { const file = join(folder, name); writeFileSync(file, body); return file; };

  it("does not decode a 64-hex SHA-256 digest in its canonical spellings as packed addresses", () => {
    assert.equal(digest.length, 64);
    for (const [name, body] of [["sha.txt", `sha256:${digest}\n`], ["sri.txt", `integrity sha256-${digest}\n`],
      ["shape.abap", `* TS: shape.${digest}\n`], ["oci.json", JSON.stringify({digest: `sha256:${digest}`})]]) {
      const result = scan(digestFile(name, body));
      assert.ok([0, 2].includes(result.status), `${name}: ${result.stderr}`);
    }
  });

  it("still decodes generic labels, other lengths, GUIDs and captures as packed addresses", () => {
    assert.equal(guid(1).length, 32);
    assert.equal(packet.length, 64);
    for (const [name, body] of [["bare.txt", `value ${digest}\n`], ["hash.txt", `hash:${digest}\n`],
      ["digest-key.json", JSON.stringify({digest})], ["rehash.txt", `rehash:${digest}\n`],
      ["long.txt", `sha256:${digest}a\n`], ["short.txt", `sha256:${digest.slice(0, 63)}\n`],
      ["guid.txt", `session ${guid(1)}\n`], ["guid-after-marker.txt", `sha256:${guid(1)}\n`],
      ["guids-after-hash.txt", `hash:${guids}\n`], ["guids-after-sha.txt", `sha256:${guids}\n`],
      ["packet-digest.json", JSON.stringify({digest: packet})]]) {
      const result = scan(digestFile(name, body));
      assert.equal(result.status, 1, `${name}: ${result.stderr}`);
      assert.match(result.stderr, /192\.168\.1\.42/, name);
    }
  });

  it("exempts a digest with a UUID-looking half and decodes only that half's node field", () => {
    // version nibble 4 and variant 8 in the first half, the packed prefix outside its node field
    const uuidish = "c0a8012a" + "aaaa" + "4aaa" + "8aaa" + "aaaaaaaaaaaa" + "bbbbbbbbbbbb0bbb0bbbbbbbbbbbbbbb";
    assert.equal(uuidish.length, 64);
    let result = scan(digestFile("uuidish.abap", `* TS: shape.${uuidish}\n`));
    assert.ok([0, 2].includes(result.status), result.stderr);
    // the same prefix in that half's node field is still a GUID-carried address
    const node = "aaaaaaaa" + "aaaa" + "4aaa" + "8aaa" + "c0a8012aaaaa" + "bbbbbbbbbbbb0bbb0bbbbbbbbbbbbbbb";
    result = scan(digestFile("uuid-node.abap", `* TS: shape.${node}\n`));
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /192\.168\.1\.42/);
    // and in the second half's node field
    const second = "bbbbbbbbbbbb0bbb0bbbbbbbbbbbbbbb" + "aaaaaaaa" + "aaaa" + "1aaa" + "9aaa" + "c0a8012aaaaa";
    result = scan(digestFile("uuid-node-2.abap", `sha256:${second}\n`));
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /192\.168\.1\.42/);
  });

  it("treats a bare 64-hex value as a digest only when the same scan saw it after a marker", () => {
    const marked = digestFile("shape-class.abap", `* TS: shape.${digest}\n`);
    const bare = digestFile("descriptor.abap", `CREATE OBJECT x EXPORTING name = \`${digest.toUpperCase()}\`.\n`);
    let result = spawnSync(process.execPath, ["tools/osd-leak-scan.mjs", ".", "--paths", marked, bare], {encoding: "utf8"});
    assert.ok([0, 2].includes(result.status), result.stderr);
    // the order of the files does not matter: the marked one may come last
    result = spawnSync(process.execPath, ["tools/osd-leak-scan.mjs", ".", "--paths", bare, marked], {encoding: "utf8"});
    assert.ok([0, 2].includes(result.status), result.stderr);
    result = scan(bare);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /192\.168\.1\.42/);
    // a different bare value beside a marked digest is still decoded
    const other = digest.replace(/^a/, "b");
    const otherFile = digestFile("other.abap", `name = \`${other}\`\n`);
    result = spawnSync(process.execPath, ["tools/osd-leak-scan.mjs", ".", "--paths", marked, otherFile], {encoding: "utf8"});
    assert.equal(result.status, 1, result.stderr);
  });

  it("still finds a dotted address and decoded text beside an exempt digest", () => {
    let result = scan(digestFile("mixed-digest.txt", `sha256:${digest} host ${privateAddress}\n`));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /частный адрес \(текст\): 192\.168\.1\.42/);
    // the hex→ascii text view of the run itself is still matched for dotted addresses
    const dotted = Buffer.from(` ${privateAddress} `.padEnd(32, " ")).toString("hex");
    result = scan(digestFile("dotted-in-digest.txt", `sha256:${dotted}\n`));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /hex→ascii\): 192\.168\.1\.42/);
  });

  describe("redacted output for a public log", () => {
    const root = mkdtempSync(join(tmpdir(), "osd-leak-redact-"));
    const category = "zz secret category";
    const name = "zzleakprobename";
    mkdirSync(join(root, ".local"), {recursive: true});
    writeFileSync(join(root, ".local", "leak-identifiers.json"), JSON.stringify({preceding: ["unused_fixture_identifier"], [category]: [name]}));
    const file = join(root, "draft.txt");
    writeFileSync(file, `text mentioning ${name.toUpperCase()} here\n`);
    const run = (...extra) => spawnSync(process.execPath,
      ["tools/osd-leak-scan.mjs", root, ...extra], {encoding: "utf8"});
    after(() => rmSync(root, {recursive: true, force: true}));

    it("prints the name without --redact", () => {
      const result = run("--paths", file);
      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(name));
    });

    it("prints neither the name nor its category with --redact, but still fails", () => {
      const result = run("--paths", file, "--redact");
      assert.equal(result.status, 1);
      assert.doesNotMatch(result.stderr, new RegExp(name, "i"));
      assert.doesNotMatch(result.stderr, new RegExp(category));
      assert.match(result.stderr, /identifier/);
      assert.doesNotMatch(result.stderr, /категория|identifier-\d|category #/);
      assert.doesNotMatch(result.stderr, /sha256:|[0-9a-f]{8}/);
    });

    it("keeps CI-mode output free of value fingerprints", () => {
      const result = spawnSync(process.execPath, ["tools/osd-leak-scan.mjs", root, "--paths", file],
        {encoding: "utf8", env: {...process.env, OSD_LEAK_REDACT: "1"}});
      assert.equal(result.status, 1);
      assert.equal(!result.stderr.toLowerCase().includes(name.toLowerCase()), true);
      assert.equal(!result.stderr.includes(category), true);
      assert.equal(!/sha256:|[0-9a-f]{8}/.test(result.stderr), true);
    });

    it("rejects value fingerprints in the repository allow file as BAD_ALLOW", () => {
      writeFileSync(join(root, '.leak-allow.json'), JSON.stringify({allow: [{file: 'draft.txt', value: `sha256:${'a'.repeat(64)}`, reason: 'fixture'}]}));
      try {
        const result = run('--paths', file, '--redact');
        assert.equal(result.status, 3);
        assert.match(result.stderr, /BAD_ALLOW/);
        assert.doesNotMatch(result.stderr, /a{64}/);
      } finally { rmSync(join(root, '.leak-allow.json')); }
    });

    it("does not quote a malformed list", () => {
      const broken = mkdtempSync(join(tmpdir(), "osd-leak-broken-"));
      try {
        mkdirSync(join(broken, ".local"), {recursive: true});
        writeFileSync(join(broken, ".local", "leak-identifiers.json"), `{"k": [${name}]}`);
        const result = spawnSync(process.execPath, ["tools/osd-leak-scan.mjs", broken, "--print-masks"], {encoding: "utf8"});
        assert.equal(result.status, 1);
        assert.doesNotMatch(result.stdout + result.stderr, new RegExp(name));
      } finally {
        rmSync(broken, {recursive: true, force: true});
      }
    });

    for (const [label, list] of [
      ["a line break in a name", {k: [`${name}\nmore`]}],
      ["a line break in a category", {[`k\n${name}`]: ["abcdef"]}],
      ["a string where an array belongs", {k: name}],
      ["a name that is not a string", {k: [42]}],
      ["a name too short to scan", {k: ["ab"]}],
      ["a category without names", {k: []}],
      ["no categories at all", {}],
    ]) {
      it(`refuses a list with ${label}, without printing it`, () => {
        const broken = mkdtempSync(join(tmpdir(), "osd-leak-shape-"));
        try {
          mkdirSync(join(broken, ".local"), {recursive: true});
          writeFileSync(join(broken, ".local", "leak-identifiers.json"), JSON.stringify(list));
          const result = spawnSync(process.execPath, ["tools/osd-leak-scan.mjs", broken, "--print-masks"], {encoding: "utf8"});
          assert.equal(result.status, 1);
          assert.doesNotMatch(result.stdout + result.stderr, new RegExp(name));
          assert.doesNotMatch(result.stdout, /add-mask/);
        } finally {
          rmSync(broken, {recursive: true, force: true});
        }
      });
    }

    it("emits a mask for every name and category", () => {
      const result = run("--print-masks");
      assert.equal(result.status, 0);
      assert.deepEqual(result.stdout.trim().split("\n").sort(),
        ["::add-mask::preceding", "::add-mask::unused_fixture_identifier", `::add-mask::${category}`, `::add-mask::${name}`].sort());
    });
  });
});
