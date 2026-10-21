// Type-form AST rules and the real CLI ratchet in an isolated checkout.
import {expect} from "chai";
import {execFileSync, spawnSync} from "node:child_process";
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {lint, counts, RULES} from "../tools/gogen/abapiti-lint.mjs";

const R8 = RULES[7], R9 = RULES[8];
describe("abapiti type-form guard", function () {
  this.timeout(20000);
  it("finds namespace-member queries in TS and all JSDoc type positions", () => {
    const source = `import * as NS from './n.mjs';
      /** @typedef {ReturnType<typeof NS.member>} Result */
      /** @param {typeof NS.deep.member} x @returns {typeof NS.member} */
      function f(x) { return /** @type {typeof NS.member} */ (x); }
      /** @type {{field: typeof NS.member}} */ let obj;`;
    expect(counts(lint(source, "x.mjs"))[R8]).to.equal(5);
    expect(counts(lint("import * as NS from './n'; type T = typeof NS.member;", "x.ts"))[R8]).to.equal(1);
  });
  it("ignores runtime typeof, other imports, bare namespace queries and comments", () => {
    const source = `import * as NS from './n'; import {named} from './n';
      type T = typeof named.member; type N = typeof NS;
      const s = typeof NS.member; // typeof NS.member
      /** prose typeof NS.member */ let x;`;
    expect(counts(lint(source, "x.ts"))[R8]).to.equal(0);
  });
  it("resolves namespace roots lexically in TS and JSDoc", () => {
    const tsSource = `import * as NS from './n';
      type Imported = typeof NS.member;
      function parameter(NS: any) { type Local = typeof NS.member; }
      function variable() {
        type Before = typeof NS.member;
        const NS = {member: 1};
        type After = typeof NS.member;
      }
      { const NS = {member: 1}; type Local = typeof NS.deep.member; }
      function sibling() { type Imported = typeof NS.member; }
      type Outside = typeof NS.member;`;
    expect(lint(tsSource, "x.ts").filter((h) => h.rule === R8).map((h) => h.line)).to.deep.equal([2, 10, 11]);
    const jsSource = `import * as NS from './n.mjs';
      /** @param {typeof NS.member} x */ function imported(x) {}
      function parameter(NS) { /** @type {typeof NS.member} */ let x; }
      function variable() {
        /** @type {typeof NS.member} */ let before;
        var NS = {member: 1};
        /** @type {typeof NS.member} */ let after;
      }
      { const {NS} = value; /** @type {typeof NS.member} */ let x; }
      /** @type {typeof NS.member} */ let outside;`;
    expect(lint(jsSource, "x.mjs").filter((h) => h.rule === R8).map((h) => h.line)).to.deep.equal([2, 10]);
  });
  it("counts casts once, including nested casts, but excludes declarations and ordinary parentheses", () => {
    expect(counts(lint(`/** @type {string} */ let declared;
      const p = (declared);
      const x = /** @type {string} */ (/** @type {unknown} */ (value));`, "x.mjs"))[R9]).to.equal(2);
    expect(counts(lint("const x = (<string>value) as unknown; const y = value satisfies string;", "x.ts"))[R9]).to.equal(2);
  });

  describe("CLI ratchet", () => {
    let dir;
    const source = "const x = /** @type {string} */ (value);\n";
    const path = "tools/gogen/sample.mjs";
    const git = (...a) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...a], {cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]});
    const run = (...args) => spawnSync(process.execPath, ["tools/gogen/abapiti-lint.mjs", ...args], {cwd: dir, encoding: "utf8"});
    const write = (text) => writeFileSync(join(dir, path), text);
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "abapiti-lint-"));
      mkdirSync(join(dir, "tools/gogen"), {recursive: true});
      copyFileSync(new URL("../tools/gogen/abapiti-lint.mjs", import.meta.url), join(dir, "tools/gogen/abapiti-lint.mjs"));
      symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), join(dir, "node_modules"), "dir");
      write(source);
      writeFileSync(join(dir, "tools/gogen/abapiti-lint.json"), JSON.stringify({files: {[path]: counts(lint(source, path))}}));
      git("init", "-q", "-b", "main");
      git("add", "tools");
      git("-c", "user.name=Test", "-c", "user.email=test@example.org", "commit", "-qm", "baseline");
      git("checkout", "-qb", "topic");
    });
    afterEach(() => rmSync(dir, {recursive: true, force: true}));
    it("passes equal counts", () => {
      const r = run("--check");
      expect(r.status, r.stderr).to.equal(0);
      expect(r.stdout).to.match(/all within/).and.not.match(/--update/);
    });
    it("refuses growth and makes --warn advisory", () => {
      write(source + "const y = /** @type {number} */ (other);\n");
      const r = run("--check", "--changed", "main");
      expect(r.status, r.stderr).to.equal(1);
      expect(r.stderr).to.match(/R9 cast-count: 2 sites, budget 1/);
      const warning = run("--check", "--warn");
      expect(warning.status).to.equal(0);
      expect(warning.stderr).to.match(/breach\(es\) \(advisory\)/);
      expect(run("--update").status).to.equal(0);
      expect(run("--check").status).to.equal(1); // update never legitimizes growth
    });
    it("passes shrinkage with a hint and lowers the baseline", () => {
      write("const x = value;\n");
      const r = run("--check");
      expect(r.status, r.stderr).to.equal(0);
      expect(r.stdout).to.match(/count\(s\) shrank.*--update/);
      expect(run("--update").status).to.equal(0);
      expect(JSON.parse(readFileSync(join(dir, "tools/gogen/abapiti-lint.json"))).files[path][R9]).to.equal(0);
      write(source);
      expect(run("--check").status).to.equal(1);
    });
    it("gives new files and rules budget zero", () => {
      writeFileSync(join(dir, "tools/gogen/new.ts"), "import * as NS from './n'; type T = typeof NS.member;");
      const r = run("--check");
      expect(r.status).to.equal(1);
      expect(r.stderr).to.match(/new.ts: R8 typeof-namespace-member: 1 sites, budget 0/);
    });
    it("blocks untracked source debt with --changed, excluding ignored files from touched paths", () => {
      writeFileSync(join(dir, "tools/gogen/new.ts"), "import * as NS from './n'; type T = typeof NS.member;");
      const r = run("--check", "--changed", "main");
      expect(r.status, r.stderr).to.equal(1);
      expect(r.stderr).to.match(/new.ts: R8 typeof-namespace-member: 1 sites, budget 0/).and.not.match(/does not touch/);
      writeFileSync(join(dir, ".git/info/exclude"), "tools/gogen/new.ts\n");
      const ignored = run("--check", "--changed", "main");
      expect(ignored.status, ignored.stderr).to.equal(0);
      expect(ignored.stderr).to.match(/does not touch/);
    });
    it("checks the whole tree if the comparison ref cannot be resolved", () => {
      write(source + "const y = /** @type {number} */ (other);\n");
      const r = run("--check", "--changed", "missing-ref");
      expect(r.status).to.equal(1);
      expect(r.stderr).to.match(/no merge base/).and.match(/R9 cast-count: 2 sites, budget 1/);
    });
    it("prints inherited breaches without blocking unrelated changes", () => {
      git("checkout", "-q", "main");
      write(source + "const y = /** @type {number} */ (other);\n");
      git("-c", "user.name=Test", "-c", "user.email=test@example.org", "commit", "-qam", "main debt");
      git("checkout", "-q", "topic");
      git("merge", "--ff-only", "main");
      const r = run("--check", "--changed", "main");
      expect(r.status, r.stderr).to.equal(0);
      expect(r.stderr).to.match(/does not touch/);
      write(readFileSync(join(dir, path), "utf8") + "// touched\n");
      expect(run("--check", "--changed", "main").status).to.equal(1);
    });
  });
});
