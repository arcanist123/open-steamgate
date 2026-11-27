import {expect} from 'chai';
import {readFileSync, realpathSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname, resolve, relative, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {publishChildEnv, devChildEnv, isolatedGitEnv} from '../tools/osd-env.mjs';
import {releaseGitConfig, releaseGitSource} from '../tools/osd-release-git.mjs';
import {runInNewContext} from 'node:vm';
import {load} from 'js-yaml';

const root = fileURLToPath(new URL('../', import.meta.url));
const subprocesses = JSON.parse(readFileSync(resolve(root, 'test/fixtures/oci-publish-subprocesses.json'), 'utf8'));
const trackedFiles = new Set(execFileSync('git', ['ls-files', '-z'], {cwd: root, encoding: 'utf8'}).split('\0').filter(Boolean).map(path => resolve(root, path)));
function walkImports(entries, read = path => readFileSync(path, 'utf8'),
  {canonical = realpathSync, tracked = trackedFiles, virtual = new Set(), base = root} = {}) {
  const seen = new Set();
  function visit(file) {
    if (!virtual.has(file)) {
      try { file = canonical(file); } catch { throw new Error('missing module dependency'); }
      const path = relative(base, file);
      if (!tracked.has(file) || !['tools', 'scripts', 'bin'].includes(path.split('/')[0])
        || path.split('/').some(part => ['.local', 'upstream', 'node_modules'].includes(part))) {
        throw new Error('untracked or fetched module dependency');
      }
    }
    if (seen.has(file)) return;
    seen.add(file);
    const ast = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (ast.parseDiagnostics.length) throw new Error(`invalid module dependency syntax in ${file}`);
    const allowed = subprocesses.filter(entry => entry.file === relative(root, file));
    const remaining = [...allowed];
    const subprocessNames = new Map();
    const approvedCalls = new Set();
    const declarations = [];
    function collectDeclarations(node) {
      if (ts.isVariableStatement(node) && node.declarationList.flags & ts.NodeFlags.Const) declarations.push(node);
      ts.forEachChild(node, collectDeclarations);
    }
    collectDeclarations(ast);
    const declaredOnce = source => declarations.filter(node => node.getText(ast) === source).length === 1;
    // Lint only: this cannot prove arbitrary JavaScript safe. The workflow
    // allowlist, tested tag, absent dependencies and minimal child env are boundaries.
    const forbiddenNames = new Set(['require', 'createRequire', 'register', 'eval', 'Function', 'getBuiltinModule', 'binding', 'dlopen', 'constructor', 'execve', 'loadEnvFile']);
    const gitCalls = allowed.flatMap(entry => entry.gitCalls ?? []);
    const wrappers = new Set(gitCalls.map(call => call.name));
    function approveGitCall(node) {
      if (!ts.isIdentifier(node.expression) || !wrappers.has(node.expression.text)) return;
      const index = gitCalls.findIndex(call => call.name === node.expression.text && call.source === node.getText(ast));
      if (index < 0) throw new Error('unreviewed git argv module dependency');
      gitCalls.splice(index, 1);
    }
    function isProcessEnv(node) {
      return ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
        && node.expression.text === 'process' && node.name.text === 'env';
    }
    function forbiddenAccess(node) {
      if (isProcessEnv(node)) {
        const parent = node.parent;
        // The inherited-env helper is the sole place allowed to read the whole
        // environment, as its default argument (callers cannot widen release env).
        const devDefault = file === resolve(root, 'tools/osd-env.mjs') && ts.isParameter(parent)
          && parent.initializer === node && ts.isFunctionDeclaration(parent.parent)
          && parent.parent.name?.text === 'devChildEnv';
        // Only the existing host API may forward the whole parent environment,
        // through this exact declaration; publication calls toolCommandIn itself.
        const hostForward = file === resolve(root, 'tools/osd-host.mjs') && ts.isCallExpression(parent)
          && ts.isReturnStatement(parent.parent) && ts.isBlock(parent.parent.parent)
          && ts.isFunctionDeclaration(parent.parent.parent.parent)
          && parent.parent.parent.parent.getText(ast) === 'export function toolCommand(script, args = []) {\n  return toolCommandIn(process.env, script, args);\n}';
        if (!devDefault && !hostForward && !((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent))
          && parent.expression === node && !parent.questionDotToken)) return true;
        // A method call on the environment is not a plain property read.
        if (ts.isCallExpression(parent.parent) && parent.parent.expression === parent) return true;
      }
      // process may only be the receiver of a direct property access, never a
      // value that could be aliased and used to recover a loader indirectly.
      const processValue = ts.isIdentifier(node) && node.text === 'process'
        && !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node)
        && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node);
      const globalValue = ts.isIdentifier(node) && node.text === 'globalThis'
        && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node);
      if (processValue || globalValue) return true;
      if (ts.isIdentifier(node) && forbiddenNames.has(node.text)) return true;
      if (ts.isPropertyAccessExpression(node)) {
        if (forbiddenNames.has(node.name.text)) return true;
      }
      if (ts.isElementAccessExpression(node)) {
        const key = node.argumentExpression;
        // Nonliteral computed accesses can assemble loader names at runtime.
        if (!ts.isStringLiteral(key) && !ts.isNumericLiteral(key) && !isProcessEnv(node.expression)) return true;
        if (forbiddenNames.has(key.text)) return true;
      }
      return false;
    }
    function writesEnvironment(node) {
      function envReference(target) {
        if (ts.isPropertyAccessExpression(target) && target.name.text === 'env'
          || ts.isElementAccessExpression(target) && ts.isStringLiteral(target.argumentExpression) && target.argumentExpression.text === 'env') {
          if (ts.isIdentifier(target.expression) && target.expression.text === 'process') return true;
        }
        return ts.forEachChild(target, envReference) === true;
      }
      const assigned = ts.isBinaryExpression(node)
        && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
      const updated = (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
        && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator);
      if (assigned) return envReference(node.left);
      if (updated) return envReference(node.operand);
      if (ts.isDeleteExpression(node)) return envReference(node.expression);
      if (ts.isForOfStatement(node) || ts.isForInStatement(node)) return envReference(node.initializer);
      return false;
    }
    const envHelpers = new Map(ast.statements.flatMap(statement => {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
        || resolve(dirname(file), statement.moduleSpecifier.text) !== resolve(root, 'tools/osd-env.mjs')) return [];
      const bindings = statement.importClause?.namedBindings;
      return bindings && ts.isNamedImports(bindings) ? bindings.elements
        .filter(binding => ['publishChildEnv', 'devChildEnv', 'isolatedGitEnv'].includes((binding.propertyName ?? binding.name).text))
        .map(binding => [binding.name.text, (binding.propertyName ?? binding.name).text]) : [];
    }));
    const explicitHost = ast.statements.some(statement => ts.isImportDeclaration(statement)
      && ts.isStringLiteral(statement.moduleSpecifier)
      && resolve(dirname(file), statement.moduleSpecifier.text) === resolve(root, 'tools/osd-host.mjs')
      && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)
      && statement.importClause.namedBindings.elements.some(binding => binding.name.text === 'toolCommandIn'
        && (binding.propertyName ?? binding.name).text === 'toolCommandIn'));
    function approveSubprocess(node) {
      const fn = subprocessNames.get(node.expression?.text);
      if (!fn) return;
      const options = node.arguments[2];
      const env = options && ts.isObjectLiteralExpression(options) && options.properties.find(property => property.name?.getText(ast) === 'env');
      const call = env && ts.isPropertyAssignment(env) && env.initializer;
      const helper = (node, name) => node && ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && envHelpers.get(node.expression.text) === name;
      const reviewedEnv = allowed.some(entry => {
        if (entry.envDeclaration) return call?.getText(ast) === 'scannerEnv'
          && envHelpers.get('publishChildEnv') === 'publishChildEnv' && declaredOnce(entry.envDeclaration);
        let base = call;
        if (entry.envHelper === 'isolatedGitEnv') {
          if (!helper(call, 'isolatedGitEnv') || call.arguments.length !== 3
            || call.arguments[1].getText(ast) !== 'cwd' || call.arguments[2].getText(ast) !== 'args') return false;
          base = call.arguments[0];
        }
        const minimal = node => helper(node, 'publishChildEnv') && (entry.executable === 'git'
          ? node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'git'
          : node.arguments.length === 0);
        const inherited = node => helper(node, 'devChildEnv') && node.arguments.length === 0;
        if (entry.envMode) return base && ts.isConditionalExpression(base) && entry.envMode === base.condition.getText(ast)
          && minimal(base.whenTrue) && inherited(base.whenFalse);
        return entry.envHelper === 'devChildEnv' ? inherited(base) : minimal(base);
      });
      if (!reviewedEnv || options.properties.some(property => ts.isSpreadAssignment(property))) {
        throw new Error('minimal child env module dependency required');
      }
      const index = remaining.findIndex(entry => entry.module === 'node:child_process'
        && entry.function === fn && entry.source === node.getText(ast));
      if (index < 0) throw new Error('unreviewed subprocess module dependency');
      const entry = remaining.splice(index, 1)[0];
      const executable = node.arguments[0];
      if (entry.executable === 'git') {
        if (!ts.isStringLiteral(executable) || executable.text !== 'git') throw new Error('unsafe executable module dependency');
      } else {
        if (entry.executable !== 'scannerCommand' || executable.getText(ast) !== 'scannerCommand'
          || node.arguments[1].getText(ast) !== 'scannerArgs' || !explicitHost || !declaredOnce(entry.commandDeclaration)
          || entry.script !== 'tools/osd-leak-scan.mjs') throw new Error('unsafe script module dependency');
      }
      approvedCalls.add(node);
    }
    function dependency(specifier) {
      if (!specifier || !ts.isStringLiteral(specifier)) throw new Error('nonliteral module dependency');
      const name = specifier.text;
      if (name.startsWith('node:')) {
        if (!new Set(['node:fs', 'node:path', 'node:url', 'node:crypto', 'node:os', 'node:zlib']).has(name)) {
          throw new Error('unsafe builtin module dependency');
        }
        return;
      }
      if (!name.startsWith('./') && !name.startsWith('../')) throw new Error(`bare module dependency in ${file}`);
      visit(resolve(dirname(file), name));
    }
    function scan(node) {
      if (ts.isImportDeclaration(node)) {
        const name = node.moduleSpecifier;
        if (ts.isStringLiteral(name) && name.text === 'node:child_process') {
          const clause = node.importClause;
          if (!allowed.length || clause?.name || !clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) throw new Error('unsafe builtin module dependency');
          for (const binding of clause.namedBindings.elements) {
            const fn = (binding.propertyName ?? binding.name).text;
            if (!allowed.some(entry => entry.function === fn)) throw new Error('unsafe subprocess module dependency');
            subprocessNames.set(binding.name.text, fn);
          }
          return;
        }
        dependency(name);
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier) dependency(node.moduleSpecifier);
      if (ts.isCallExpression(node)) { approveSubprocess(node); approveGitCall(node); }
      if (ts.isIdentifier(node) && wrappers.has(node.text)) {
        const parent = node.parent;
        if (!(ts.isCallExpression(parent) && parent.expression === node)
          && !(ts.isFunctionDeclaration(parent) && parent.name === node)
          && !(ts.isVariableDeclaration(parent) && parent.name === node)) throw new Error('aliased git module dependency');
      }
      if (ts.isIdentifier(node) && subprocessNames.has(node.text)
        && !(ts.isCallExpression(node.parent) && node.parent.expression === node && approvedCalls.has(node.parent))) {
        throw new Error('aliased subprocess module dependency');
      }
      if (forbiddenAccess(node) || writesEnvironment(node)) throw new Error('unsafe execution module dependency');
      if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) dependency(node.arguments[0]);
      }
      ts.forEachChild(node, scan);
    }
    for (const node of ast.statements) {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
        && node.moduleSpecifier.text === 'node:child_process') scan(node);
    }
    scan(ast);
  }
  entries.forEach(visit);
  return seen;
}
// Execute the real declarations with a child-process probe in place of Git.
// Check origin/main's inherited-environment contract without requiring a remote
// ref in shallow CI checkouts. Local verification also probes origin/main itself.
function declarationOf(source, name) {
  const ast = ts.createSourceFile('probe.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let declaration, variable = false;
  for (const statement of ast.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
      declaration = ts.createPrinter().printNode(ts.EmitHint.Unspecified,
        ts.factory.updateFunctionDeclaration(statement, undefined, statement.asteriskToken, statement.name,
          statement.typeParameters, statement.parameters, statement.type, statement.body), ast);
    }
    if (ts.isVariableStatement(statement)) {
      for (const node of statement.declarationList.declarations) {
        if (node.name.getText(ast) === name) { declaration = `const ${name} = ${node.initializer.getText(ast)};`; variable = true; }
      }
    }
  }
  expect(declaration, name + ' declaration').to.be.a('string');
  return {declaration, variable};
}
function probeGitEnvironment(source, name, release = false) {
  const {declaration, variable} = declarationOf(source, name);
  const observed = [];
  const ref = '1'.repeat(40), lib = join('/fixture', '.local/lars/example');
  const context = {
    process, publishChildEnv, devChildEnv, isolatedGitEnv, releaseMode: release, releaseGitConfig, join,
    activeSystem: () => null, layerEnvironment: () => ({}), readLock: () => ({libraries: [{folder: 'example', ref}]}),
    envKey: () => 'OSD_LIB_EXAMPLE', isCheckout: () => true, realpathSync: value => value,
    warned: new Set(), toolRoot: '/fixture', console: {error() {}},
    execFileSync(command, args, options) {
      expect(command).to.equal('git');
      const child = JSON.parse(execFileSync(process.execPath, [resolve(root, 'test/helpers/oci-publish-env-probe.mjs')],
        {env: options.env, encoding: 'utf8'}));
      observed.push(child);
      return args.includes('--show-toplevel') ? lib : args.includes('status') ? '' : ref;
    },
  };
  const invoke = name === 'libraryPath' ? `libraryPath('/fixture', 'example', undefined, ${release})`
    : name === 'warnSystemToolchain' ? `warnSystemToolchain('/fixture', {digest: 'fixture', annotations: {'org.osd.osg.commit': 'other'}}, () => {})`
    : variable ? "git('/fixture', 'init', '-q'); git('/fixture', 'status')"
      : `git(['init', '-q'], '/fixture', ${release}); git(['status'], '/fixture', ${release})`;
  runInNewContext(declaration + '\n' + invoke, context);
  expect(observed.length).to.be.greaterThan(0);
  return observed;
}
describe('secret-holding OCI publisher imports', () => {
  it('lints all publish job entry points and spawned tools', () => {
    const workflow = load(readFileSync(resolve(root, '.github/workflows/oci-release.yml'), 'utf8'));
    const entries = ['tools/osd-license-assumptions.mjs', 'scripts/system-stage.mjs', 'tools/osd-layer.mjs', 'tools/osd-oci.mjs', 'tools/osd-leak-scan.mjs'];
    const inline = new Map();
    for (const [index, step] of workflow.jobs.publish.steps.entries()) {
      const lines = (step.run ?? '').split('\n');
      for (let line = 0; line < lines.length; line++) {
        const command = lines[line];
        if (command.startsWith('node tools/') || command.startsWith('node scripts/')) entries.push(command.split(' ')[1]);
        if (command === "node --input-type=module <<'JS'") {
          const body = [];
          while (++line < lines.length && lines[line] !== 'JS') body.push(lines[line]);
          if (line === lines.length) throw new Error('unterminated inline module');
          const file = resolve(root, `.publish-inline-${index}.mjs`);
          entries.push(file);
          inline.set(file, body.join('\n'));
        }
      }
    }
    expect(entries).to.include.members(['scripts/system-publish.mjs', 'tools/osd-libs.mjs', 'tools/osd-fetch.mjs']);
    expect(walkImports(entries.map(path => resolve(root, path)), path => inline.get(path) ?? readFileSync(path, 'utf8'), {virtual: new Set(inline.keys())}).size).to.be.greaterThan(entries.length);
  });
  it('accepts literal relative and node imports while ignoring comments and strings', () => {
    const files = {'/entry.mjs': `import 'node:fs'; export * from './leaf.mjs';
      import('./leaf.mjs'); import('node:path');
      // require('third-party');
      const text = "createRequire(import.meta.url)";`, '/leaf.mjs': 'export const x = 1;'};
    expect(walkImports(['/entry.mjs'], path => files[path], {canonical: path => path, tracked: new Set(), virtual: new Set(Object.keys(files))}).size).to.equal(2);
  });
  it('rejects transitive bare imports, re-exports, dynamic imports and require', () => {
    for (const statement of [
      "import 'third-party';", "export {x} from 'third-party';", "import('third-party');",
      "require('third-party');", "require('node:fs');", "require('./local.mjs');",
      "import {createRequire} from 'node:module'; const req = createRequire(import.meta.url); req('third-party');",
      "import {createRequire} from 'node:module'; createRequire(import.meta.url)('x');",
      "import * as m from 'node:module'; m.createRequire(import.meta.url)('third-party');",
      "import {createRequire as cr} from 'node:module'; cr(import.meta.url)('third-party');",
      "module.require('third-party');", "module['require']('node:fs');",
      "eval(\"import('third-party')\");", "(0, eval)(source);", 'const e = eval; e(source);',
      'Function(source)();', 'new Function(source)();', 'const F = Function; new F(source);',
      "globalThis['eval'](source);", "globalThis.Function(source)();",
      "import * as m from 'node:module'; const cr = m.createRequire; cr(import.meta.url);",
      "import * as m from 'node:module'; m['createRequire'](import.meta.url);",
      "import * as m from 'node:module'; m['create' + 'Require'](import.meta.url);",
      "import {register as r} from 'node:module'; r('./loader.mjs', import.meta.url);",
      "import * as m from 'node:module'; m['register']('./loader.mjs', import.meta.url);",
      "import('node:module').then(m => m.register('./loader.mjs', import.meta.url));",
      "process.binding('spawn_sync');", "process['binding']('spawn_sync');", 'const b = process.binding;',
      "process.dlopen({}, './addon.node');", "process['dlopen']({}, './addon.node');",
      'const p = process;', 'const p = globalThis.process;', 'const p = globalThis . process;', "const p = globalThis['process'];",
      "globalThis.process.getBuiltinModule('child_process');", "globalThis.process['binding']('spawn_sync');",
      "const g = globalThis; g.process.dlopen({}, './addon.node');",
      "const g = globalThis; g.process['getBuiltinModule']('child_process');",
      "other.binding('spawn_sync');", "other['dlopen']({}, './addon.node');",
      "process.getBuiltinModule('child_process');",
      "import {Worker as W} from 'node:worker_threads'; new W(source, {eval: true});",
      "import('node:worker_threads');", "export * from 'node:child_process';",
      "import {exec as e} from 'child_process'; e(command);", "import('node:child_process');",
      "import vm from 'node:vm'; vm.runInThisContext(source);", "import('vm');",
      'import(variable);', "import('./' + variable);", 'import(`./leaf.mjs`);',
      "import('/absolute.mjs');", "import('https://example.invalid/module.mjs');",
    ]) {
      const files = {'/entry.mjs': "import './leaf.mjs';", '/leaf.mjs': statement};
      expect(() => walkImports(['/entry.mjs'], path => files[path], {canonical: path => path, tracked: new Set(), virtual: new Set(Object.keys(files))})).to.throw(/module dependency/);
    }
  });
  it('rejects every builtin outside the reviewed allowlist', () => {
    for (const name of ['inspector', 'test', 'vm', 'worker_threads', 'module', 'repl', 'http', 'net', 'stream', 'util']) {
      for (const statement of [`import 'node:${name}';`, `export * from 'node:${name}';`, `import('node:${name}');`]) {
        expect(() => walkImports(['/entry.mjs'], () => statement, {virtual: new Set(['/entry.mjs'])}), statement).to.throw('module dependency');
      }
    }
  });
  it('rejects nonliteral element accesses on every receiver', () => {
    for (const statement of ["const k = 'ev' + 'al'; other[k](source);", "other['con' + 'sole'];", 'array[index];', 'other[`key`];']) {
      expect(() => walkImports(['/entry.mjs'], () => statement, {virtual: new Set(['/entry.mjs'])}), statement).to.throw('unsafe execution');
    }
  });
  it('rejects globalThis as a value without relying on a forbidden property name', () => {
    for (const statement of ['const g = globalThis; g.console.log(source);', 'consume(globalThis);', 'const g = globalThis;']) {
      expect(() => walkImports(['/entry.mjs'], () => statement, {virtual: new Set(['/entry.mjs'])}), statement).to.throw('unsafe execution');
    }
  });
  it('rejects assignments to process.env and its members', () => {
    for (const statement of [
      'process.env = {};', "process.env.NODE_OPTIONS = '--import=/x.mjs';", "process['env']['NODE_OPTIONS'] = source;",
      'process.env.NODE_OPTIONS += source;', 'process.env.COUNT++;', '++process.env.COUNT;',
      'delete process.env.NODE_OPTIONS;', '({value: process.env.NODE_OPTIONS} = other);',
      'for (process.env.KEY of values) {}',
    ]) {
      expect(() => walkImports(['/entry.mjs'], () => statement, {virtual: new Set(['/entry.mjs'])}), statement).to.throw('unsafe execution');
    }
  });
  it('rejects constructor, execve and loadEnvFile member access', () => {
    for (const name of ['constructor', 'execve', 'loadEnvFile']) {
      for (const statement of [`other.${name}(source);`, `other['${name}'](source);`, `const alias = other.${name};`]) {
        expect(() => walkImports(['/entry.mjs'], () => statement, {virtual: new Set(['/entry.mjs'])}), statement).to.throw('unsafe execution');
      }
    }
  });
  it('permits process.env only as the object of a plain property read', () => {
    for (const statement of [
      'const alias = process.env;', 'Object.assign(process.env, values);',
      "Reflect.set(process.env, 'NODE_OPTIONS', source);", "Object.defineProperty(process.env, 'NODE_OPTIONS', {value: source});",
      'const {NODE_OPTIONS} = process.env;', 'consume({...process.env});', 'Object.keys(process.env);',
      'process.env.hasOwnProperty(key);',
    ]) expect(() => walkImports(['/entry.mjs'], () => statement, {virtual: new Set(['/entry.mjs'])}), statement).to.throw('unsafe execution');
    for (const statement of ['const value = process.env.HOME;', "const value = process.env['HOME'];", 'const value = process.env[key];']) {
      expect(() => walkImports(['/entry.mjs'], () => statement, {virtual: new Set(['/entry.mjs'])}), statement).not.to.throw();
    }
  });
  it('requires the reviewed env helper at every spawn/execFile site and minimal release branch', function () {
    this.timeout(20000); // many whole-tree scans; over mocha's default on a slower box
    for (const entry of subprocesses) {
      const file = resolve(root, entry.file), source = readFileSync(file, 'utf8');
      const minimal = entry.executable === 'git' ? "publishChildEnv('git')" : 'publishChildEnv()';
      const base = entry.envMode ? `${entry.envMode} ? ${minimal} : devChildEnv()` : entry.envHelper === 'devChildEnv' ? 'devChildEnv()' : minimal;
      const call = entry.envDeclaration ? 'scannerEnv' : entry.envHelper === 'isolatedGitEnv' ? `isolatedGitEnv(${base}, cwd, args)` : base;
      const invalid = ['process.env', '{...process.env}', '{}', 'otherEnv()'];
      if (entry.envMode) invalid.push('devChildEnv()', `${entry.envMode} ? devChildEnv() : ${minimal}`,
        `${entry.envMode} ? devChildEnv() : devChildEnv()`, `${entry.envMode} ? ${minimal} : process.env`);
      if (entry.envHelper === 'isolatedGitEnv') invalid.push(base, `otherEnv(${base}, cwd, args)`,
        `isolatedGitEnv(${base}, cwd, [...releaseGitConfig, ...args])`, `isolatedGitEnv(${base}, otherCwd, args)`,
        `isolatedGitEnv(${base}, cwd, args, process.env)`, `isolatedGitEnv(process.env, cwd, args)`,
        `isolatedGitEnv({...process.env}, cwd, args)`, `isolatedGitEnv({}, cwd, args)`,
        `isolatedGitEnv(otherEnv(), cwd, args)`, `isolatedGitEnv(${entry.envMode} ? devChildEnv() : ${minimal}, cwd, args)`,
        `isolatedGitEnv(${entry.envMode} ? ${minimal} : devChildEnv(process.env), cwd, args)`);
      for (const env of invalid) {
        const changed = source.replace(entry.source, entry.source.replace(call, env));
        expect(changed).not.to.equal(source);
        expect(() => walkImports([file], path => path === file ? changed : readFileSync(path, 'utf8'))).to.throw('minimal child env');
      }
    }
  });
  it('binds the scanner host command and child to the same minimal environment', () => {
    const entry = subprocesses.find(entry => entry.commandDeclaration);
    const file = resolve(root, entry.file), source = readFileSync(file, 'utf8');
    for (const replacement of ['process.env', 'devChildEnv()', '{}', 'otherEnv()']) {
      const changed = source.replace(entry.envDeclaration, entry.envDeclaration.replace('publishChildEnv()', replacement));
      expect(changed).not.to.equal(source);
      expect(() => walkImports([file], path => path === file ? changed : readFileSync(path, 'utf8'))).to.throw(/module dependency/);
    }
    for (const replacement of [
      entry.commandDeclaration.replace('toolCommandIn(scannerEnv,', 'toolCommandIn(process.env,'),
      entry.commandDeclaration.replace('toolCommandIn(scannerEnv,', 'toolCommandIn(devChildEnv(),'),
      entry.commandDeclaration.replace('toolCommandIn(scannerEnv,', 'toolCommand('),
      entry.commandDeclaration.replace('tools/osd-leak-scan.mjs', 'tools/extra.mjs'),
    ]) {
      const changed = source.replace(entry.commandDeclaration, replacement);
      expect(changed).not.to.equal(source);
      expect(() => walkImports([file], path => path === file ? changed : readFileSync(path, 'utf8'))).to.throw(/module dependency/);
    }
    const host = resolve(root, 'tools/osd-host.mjs'), hostSource = readFileSync(host, 'utf8');
    expect(() => walkImports([host])).not.to.throw();
    for (const changed of [hostSource + '\nconst leakedEnv = process.env;',
      hostSource.replace('return toolCommandIn(process.env, script, args);', 'return otherCommand(process.env, script, args);')]) {
      expect(() => walkImports([host], path => path === host ? changed : readFileSync(path, 'utf8'))).to.throw('unsafe execution');
    }
  });
  it('keeps inherited config, Node options and credentials out of a first-party child', () => {
    const probe = resolve(root, 'test/helpers/oci-publish-env-probe.mjs');
    const keys = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'NODE_OPTIONS', 'GITHUB_TOKEN', 'OSD_OCI_TOKEN'];
    const saved = keys.map(key => [key, process.env[key]]);
    try {
      Object.assign(process.env, {GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'alias.fixture', GIT_CONFIG_VALUE_0: '!false',
        NODE_OPTIONS: '--require=/does-not-exist/fixture.cjs', GITHUB_TOKEN: 'fixture-token', OSD_OCI_TOKEN: 'fixture-token'});
      for (const git of [false, true]) {
        const child = JSON.parse(execFileSync(process.execPath, [probe], {env: publishChildEnv(git ? 'git' : undefined), encoding: 'utf8'}));
        const expected = {PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', LANG: 'C.UTF-8'};
        if (git) Object.assign(expected, {GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0'});
        expect(child).to.deep.equal(expected);
        expect(keys.every(key => !Object.hasOwn(child, key))).to.equal(true);
      }
    } finally {
      for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });
  it('preserves inherited development settings and win32 Path casing, stripping only injected options', () => {
    const parent = {Path: 'C:\\fixture\\bin', HOME: 'fixture-home', HTTPS_PROXY: 'fixture-proxy',
      NODE_OPTIONS: 'fixture-option', GIT_CONFIG_COUNT: '1', Git_Config_Global: 'fixture-config', SSH_AUTH_SOCK: 'fixture-agent'};
    expect(devChildEnv(parent)).to.deep.equal({Path: parent.Path, HOME: parent.HOME, HTTPS_PROXY: parent.HTTPS_PROXY, SSH_AUTH_SOCK: parent.SSH_AUTH_SOCK});
    expect(Object.hasOwn(devChildEnv(parent), 'PATH')).to.equal(false);
    expect(parent.NODE_OPTIONS).to.equal('fixture-option');
  });
  it('isolates relative Git directories without changing the selected base environment or argv', () => {
    const base = {PATH: 'fixture-path', HOME: 'fixture-home', HTTPS_PROXY: 'fixture-proxy'};
    const cwd = join('fixture', 'scratch', 'target');
    for (const args of [['init', '-q'], ['remote', 'add', '--', 'origin', 'https://example.invalid/repo.git']]) {
      const before = [...args];
      const env = isolatedGitEnv(Object.freeze(base), cwd, Object.freeze(args));
      expect(env).to.deep.equal({...base, GIT_CEILING_DIRECTORIES: dirname(resolve(cwd)),
        ...(args[0] === 'init' ? {} : {GIT_DIR: resolve(cwd, '.git'), GIT_WORK_TREE: resolve(cwd)})});
      expect(env).not.to.equal(base);
      expect(args).to.deep.equal(before);
    }
  });
  for (const [file, name] of [['osd-libs', 'git'], ['osd-fetch', 'git'], ['osd-lib-path', 'libraryPath'], ['osd-system-toolchain', 'warnSystemToolchain']]) {
    it(`${file} development Git children inherit PATH, HOME and proxy exactly as origin/main`, () => {
      const path = `tools/${file}.mjs`;
      const current = readFileSync(resolve(root, path), 'utf8');
      const fixtures = {PATH: '/fixture/custom/bin', HOME: '/fixture/custom/home', HTTPS_PROXY: 'https://proxy.example.invalid'};
      const saved = Object.keys(fixtures).map(key => [key, process.env[key]]);
      try {
        Object.assign(process.env, fixtures);
        const children = probeGitEnvironment(current, name);
        expect(children.every(env => Object.keys(fixtures).every(key => env[key] === fixtures[key]))).to.equal(true);
        if (name !== 'warnSystemToolchain') {
          const children = probeGitEnvironment(current, name, true);
          for (const [index, env] of children.entries()) {
            const expected = {PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', LANG: 'C.UTF-8',
              GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0'};
            if (name === 'git') Object.assign(expected, {GIT_CEILING_DIRECTORIES: '/'}, index === 0 ? {}
              : {GIT_DIR: '/fixture/.git', GIT_WORK_TREE: '/fixture'});
            expect(env).to.deep.equal(expected);
          }
        }
      } finally {
        for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      }
    });
  }
  for (const file of ['osd-fetch', 'osd-libs']) {
    for (const release of [false, true]) {
      for (const mode of ['init fails', 'init leaves no repository']) {
        it(`${file} ${release ? 'release' : 'development'}: ${mode} cannot reach an enclosing repository`, () => {
          const temp = mkdtempSync(join(tmpdir(), 'oci-git-isolation-'));
          try {
            const git = (...args) => execFileSync('git', args, {cwd: temp, encoding: 'utf8', stdio: 'pipe'}).trim();
            git('init', '-q');
            git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture');
            const config = readFileSync(join(temp, '.git/config'), 'utf8'), head = git('rev-parse', 'HEAD');
            const cwd = join(temp, 'scratch', 'target');
            mkdirSync(cwd, {recursive: true});
            const source = readFileSync(resolve(root, `tools/${file}.mjs`), 'utf8');
            const operation = file === 'osd-fetch' ? 'checkout' : 'cloneInto';
            const failed = new Error('injected init failure');
            let init = 0, later = 0;
            const context = {
              publishChildEnv, devChildEnv, isolatedGitEnv, releaseGitConfig, releaseGitSource, releaseMode: release,
              mkdtempSync: () => cwd, tmpdir: () => join(temp, 'scratch'), join, rmSync,
              execFileSync(command, args, options) {
                expect(command).to.equal('git');
                if (args.includes('init')) {
                  init++;
                  // init's env must prevent discovery before .git exists.
                  expect(() => execFileSync('git', ['rev-parse', '--show-toplevel'], {...options, stdio: 'pipe'})).to.throw();
                  expect(options.env.GIT_CEILING_DIRECTORIES).to.equal(dirname(cwd));
                  expect(Object.hasOwn(options.env, 'GIT_DIR')).to.equal(false);
                  expect(Object.hasOwn(options.env, 'GIT_WORK_TREE')).to.equal(false);
                  if (mode === 'init fails') throw failed;
                  return '';
                }
                later++;
                expect(args.slice(release ? releaseGitConfig.length : 0, release ? releaseGitConfig.length + 2 : 2)).to.deep.equal(['remote', 'add']);
                expect(options.env.GIT_DIR).to.equal(join(cwd, '.git'));
                expect(options.env.GIT_WORK_TREE).to.equal(cwd);
                // Without explicit GIT_DIR this real write would alter temp/.git/config.
                return execFileSync(command, args, options);
              },
            };
            const invoke = operation === 'checkout'
              ? `checkout('https://example.invalid/repo.git', '${'1'.repeat(40)}', ${release})`
              : `cloneInto(${JSON.stringify(cwd)}, {url: 'https://example.invalid/repo.git', ref: '${'1'.repeat(40)}'})`;
            let error;
            try { runInNewContext(declarationOf(source, 'git').declaration + '\n' + declarationOf(source, operation).declaration + '\n' + invoke, context); }
            catch (caught) { error = caught; }
            expect(init).to.equal(1);
            expect(error).to.be.instanceOf(Error);
            if (mode === 'init fails') { expect(error).to.equal(failed); expect(later).to.equal(0); }
            else { expect(later).to.equal(1); expect(error.status).to.be.a('number').and.not.equal(0); }
            expect(readFileSync(join(temp, '.git/config'), 'utf8')).to.equal(config);
            expect(git('rev-parse', 'HEAD')).to.equal(head);
            expect(existsSync(join(temp, '.git/shallow'))).to.equal(false);
          } finally { rmSync(temp, {recursive: true, force: true}); }
        });
      }
    }
  }
  it('accepts each reviewed subprocess source once and rejects new calls in the same file', () => {
    for (const entry of subprocesses) {
      const file = resolve(root, entry.file);
      const prefix = entry.file.startsWith('scripts/') ? '../tools/' : './';
      const source = `import {publishChildEnv, devChildEnv, isolatedGitEnv} from '${prefix}osd-env.mjs';\nimport {toolCommandIn} from '${prefix}osd-host.mjs';\nimport {${entry.function}} from '${entry.module}';\n${entry.envDeclaration ?? ''}\n${entry.commandDeclaration ?? ''}\n${entry.source};`;
      expect(() => walkImports([file], path => path === file ? source : readFileSync(path, 'utf8'), {virtual: new Set([file])})).not.to.throw();
      for (const extra of [entry.source, `${entry.function}('git', ['status'])`,
        `${entry.function}('sh', ['-c', 'command'])`, `${entry.function}(process.execPath, ['tools/extra.mjs'])`,
        `const alias = ${entry.function}; alias('git', []);`]) {
        expect(() => walkImports([file], path => path === file ? source + '\n' + extra + ';' : readFileSync(path, 'utf8'), {virtual: new Set([file])})).to.throw(/module dependency/);
      }
      expect(() => walkImports([resolve(root, 'tools/unreviewed.mjs')], () => source, {virtual: new Set([resolve(root, 'tools/unreviewed.mjs')])})).to.throw(/module dependency/);
      const changed = entry.commandDeclaration
        ? source.replace(entry.commandDeclaration, entry.commandDeclaration.replace('tools/osd-leak-scan.mjs', 'tools/extra.mjs'))
        : source.replace(entry.source, entry.source.replace("'git'", "'sh'").replace('"git"', '"sh"'));
      expect(() => walkImports([file], path => path === file ? changed : readFileSync(path, 'utf8'), {virtual: new Set([file])})).to.throw(/module dependency/);
    }
  });
  it('rejects imports of fetched files, including tracked symlinks to them', () => {
    const temp = mkdtempSync(resolve(tmpdir(), 'oci-import-fixture-'));
    const entry = resolve(temp, 'tools/entry.mjs'), fetched = resolve(temp, '.local/lars/dependency.mjs'), link = resolve(temp, 'tools/link.mjs');
    try {
      mkdirSync(dirname(entry), {recursive: true});
      mkdirSync(dirname(fetched), {recursive: true});
      writeFileSync(fetched, 'export const x = 1;');
      symlinkSync(fetched, link);
      for (const specifier of ['../.local/lars/dependency.mjs', './link.mjs']) {
        writeFileSync(entry, `import '${specifier}';`);
        expect(() => walkImports([entry], undefined, {tracked: new Set([entry, link, fetched]), base: temp})).to.throw('fetched module dependency');
      }
      writeFileSync(entry, "import './leaf.mjs';");
      writeFileSync(resolve(temp, 'tools/leaf.mjs'), 'export const x = 1;');
      expect(() => walkImports([entry], undefined, {tracked: new Set([entry]), base: temp})).to.throw('untracked');
    } finally { rmSync(temp, {recursive: true, force: true}); }
  });
  it('binds calls through existing git wrappers to their exact reviewed argv', () => {
    for (const entry of subprocesses.filter(entry => entry.gitCalls?.length)) {
      const file = resolve(root, entry.file), source = readFileSync(file, 'utf8');
      const reviewed = entry.gitCalls[0];
      const changed = source.replace(reviewed.source, `${reviewed.name}(['-c', 'alias.x=!sh', 'x'])`);
      expect(changed).not.to.equal(source);
      expect(() => walkImports([file], path => path === file ? changed : readFileSync(path, 'utf8'))).to.throw('unreviewed git argv module dependency');
      expect(() => walkImports([file], path => path === file ? source + `\n${entry.gitCalls[0].name}(['-c', 'alias.x=!sh', 'x']);` : readFileSync(path, 'utf8'))).to.throw(/git.*module dependency/);
    }
  });
});
