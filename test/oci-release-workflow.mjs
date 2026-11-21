import {expect} from 'chai';
import {readFileSync, readdirSync, mkdtempSync, mkdirSync, rmSync, symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {load} from 'js-yaml';
const workflow = load(readFileSync(new URL('../.github/workflows/oci-release.yml', import.meta.url), 'utf8'));
const steps = workflow.jobs.publish.steps;
// Deliberately independent expected value: changes require reviewing the full
// secret-holding job, including action SHAs, env, conditions and every run line.
const expectedPublish = {
  "if": "${{ github.event_name == 'push' && startsWith(github.ref, 'refs/tags/') }}",
  "environment": "release",
  "needs": "wait-for-tests",
  "permissions": {
    "contents": "read",
    "packages": "write"
  },
  "outputs": {
    "report": "${{ steps.publish.outputs.report }}"
  },
  "runs-on": "ubuntu-latest",
  "timeout-minutes": 120,
  "env": {
    "OSD_LEAK_REDACT": "1",
    "TESTED_SHA": "${{ needs.wait-for-tests.outputs.sha }}",
    "RELEASE_TAG": "${{ github.ref_name }}"
  },
  "steps": [
    {
      "uses": "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
      "with": {
        "ref": "${{ needs.wait-for-tests.outputs.sha }}",
        "fetch-depth": 0,
        "persist-credentials": false
      }
    },
    {
      "name": "Assert workspace has no dependencies",
      "run": "dependency_entry=\"$(find -L \"$GITHUB_WORKSPACE\" -name node_modules -print -quit)\"\ntest -z \"$dependency_entry\" || { echo '::error::node_modules is forbidden in the publish workspace'; exit 1; }\n"
    },
    {
      "uses": "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
      "with": {
        "node-version": 24
      }
    },
    {
      "name": "Validate existing release tag and clean checkout",
      "run": "node --input-type=module <<'JS'\nimport {assertTestedRelease} from './scripts/system-publish.mjs';\nassertTestedRelease(process.cwd(), process.env.RELEASE_TAG, process.env.TESTED_SHA);\nJS\n"
    },
    {
      "name": "Resolve locked libraries and every pack, and stage the release",
      "run": "node tools/osd-libs.mjs --sync --release\nnode tools/osd-fetch.mjs --release\nnode scripts/system-publish.mjs --prepare \"$RELEASE_TAG\" \"${OWNER,,}\" \"$RUNNER_TEMP/oci-plan.json\"\n",
      "env": {
        "OWNER": "${{ github.repository_owner }}"
      }
    },
    {
      "name": "install the identifier list",
      "env": {
        "LEAK_IDENTIFIERS": "${{ secrets.OSD_RELEASE_LEAK_IDENTIFIERS }}"
      },
      "run": "test -n \"$LEAK_IDENTIFIERS\" || { echo '::error::OSD_RELEASE_LEAK_IDENTIFIERS is required for publishing'; exit 1; }\numask 077\nmkdir -p .local\nprintf '%s' \"$LEAK_IDENTIFIERS\" > .local/leak-identifiers.json\n"
    },
    {
      "id": "publish",
      "name": "Publish layers and system through the leak gate",
      "env": {
        "GITHUB_TOKEN": "${{ secrets.GITHUB_TOKEN }}",
        "GITHUB_ACTOR": "${{ github.actor }}",
        "OWNER": "${{ github.repository_owner }}"
      },
      "run": "dependency_entry=\"$(find -L \"$GITHUB_WORKSPACE\" -name node_modules -print -quit)\"\ntest -z \"$dependency_entry\" || { echo '::error::node_modules is forbidden in the publish workspace'; exit 1; }\nnode scripts/system-publish.mjs \"$RELEASE_TAG\" \"${OWNER,,}\" \"$RUNNER_TEMP/oci-release.json\" --leak-allow .leak-allow.release.json --plan \"$RUNNER_TEMP/oci-plan.json\"\nnode --input-type=module <<'JS'\nimport {readFileSync, appendFileSync} from 'node:fs';\nconst report = JSON.parse(readFileSync(`${process.env.RUNNER_TEMP}/oci-release.json`));\nappendFileSync(process.env.GITHUB_OUTPUT, `report=${JSON.stringify(report)}\\n`);\nJS\n"
    },
    {
      "name": "remove the identifier list after its last consumer",
      "run": "rm -f .local/leak-identifiers.json"
    },
    {
      "name": "remove the identifier list",
      "if": "always()",
      "run": "rm -f .local/leak-identifiers.json"
    }
  ]
};
const expectedWait = {
  outputs: {sha: '${{ steps.tested.outputs.sha }}'},
  'runs-on': 'ubuntu-latest',
  permissions: {actions: 'read'},
  env: {RELEASE_TAG: '${{ github.ref_name }}'},
  steps: [
    {uses: 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262', with: {
      ref: "${{ format('refs/tags/{0}', github.ref_name) }}", 'fetch-depth': 0, 'persist-credentials': false,
    }},
    {uses: 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020', with: {'node-version': 24, cache: 'npm'}},
    {run: 'npm ci --ignore-scripts'},
    {name: 'Validate existing release tag and clean checkout', run: "node --input-type=module <<'JS'\nimport {assertRelease} from './scripts/system-publish.mjs';\nassertRelease(process.cwd(), process.env.RELEASE_TAG);\nJS\n"},
    {id: 'tested', name: 'Require successful tests for the exact tag commit', env: {GITHUB_TOKEN: '${{ github.token }}'},
      run: 'tag_sha="$(git rev-parse "refs/tags/$RELEASE_TAG^{commit}")"\nnode tools/osd-ci-wait-tests.mjs "$RELEASE_TAG" "$tag_sha"\necho "sha=$tag_sha" >> "$GITHUB_OUTPUT"\n'},
  ],
};
function assertWait(candidate) {
  expect(candidate).to.deep.equal(expectedWait);
}
function strings(value) {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}
// GitHub expressions quote strings with single quotes and escape one as ''.
// Tokenize only expression bodies, so prose and string literals are harmless.
function referencesSecrets(value) {
  const start = c => c !== undefined && 'abcdefghijklmnopqrstuvwxyz_'.includes(c.toLowerCase());
  const part = c => start(c) || c !== undefined && '0123456789-'.includes(c);
  let offset = 0;
  while ((offset = value.indexOf('${{', offset)) !== -1) {
    offset += 3;
    while (offset < value.length && !value.startsWith('}}', offset)) {
      if (value[offset] === "'") {
        offset++;
        while (offset < value.length) {
          if (value[offset++] !== "'") continue;
          if (value[offset] !== "'") break;
          offset++;
        }
      } else if (start(value[offset])) {
        const begin = offset++;
        while (part(value[offset])) offset++;
        if (value.slice(begin, offset).toLowerCase() === 'secrets') return true;
      } else offset++;
    }
    offset += 2;
  }
  return false;
}
function assertSecretTiming(candidate) {
  const installed = candidate.steps.findIndex(step => step.name === 'install the identifier list');
  expect(installed).to.be.greaterThan(0);
  for (const step of candidate.steps.slice(0, installed)) {
    expect(strings(step).some(referencesSecrets)).to.equal(false);
  }
  expect(candidate.steps.slice(installed)).to.deep.equal(expectedPublish.steps.slice(installed));
}
function assertWorkflow(candidate) {
  expect(Object.keys(candidate.jobs)).to.deep.equal(['wait-for-tests', 'publish', 'public-check']);
  expect(candidate.permissions).to.deep.equal({});
  expect(candidate.concurrency).to.deep.equal({group: 'oci-release-${{ github.ref_name }}', 'cancel-in-progress': false});
  expect(candidate.on).to.deep.equal({push: {tags: ['vscode-stable-v*', 'vscode-v*']}});
}
function assertPublish(candidate) {
  expect(candidate).to.deep.equal(expectedPublish);
}
describe('OCI release workflow gates', () => {
  it('pins the complete job set, top-level permissions, concurrency and triggers', () => {
    assertWorkflow(workflow);
    for (const change of [
      copy => { copy.jobs.extra = {}; }, copy => { delete copy.jobs['public-check']; },
      copy => { copy.permissions = {contents: 'write'}; }, copy => { copy.concurrency['cancel-in-progress'] = true; },
      copy => { copy.concurrency.group = 'other'; }, copy => { copy.on.workflow_dispatch = {}; },
      copy => { copy.on.push.branches = ['main']; }, copy => { copy.on.push.tags.push('*'); },
    ]) {
      const changed = structuredClone(workflow); change(changed);
      expect(() => assertWorkflow(changed)).to.throw();
    }
  });
  it('exposes no secrets before installation and pins every subsequent step', () => {
    assertSecretTiming(workflow.jobs.publish);
    const installed = steps.findIndex(step => step.name === 'install the identifier list');
    for (const expression of ['secrets.FIXTURE', "secrets['FIXTURE']", 'toJSON(secrets)']) {
      for (const field of ['run', 'env', 'with', 'if', 'name']) {
        const value = '${{ ' + expression + ' }}';
        const changed = structuredClone(workflow.jobs.publish);
        changed.steps[0][field] = field === 'env' || field === 'with' ? {nested: [value]} : value;
        expect(() => assertSecretTiming(changed), expression + ' in ' + field).to.throw();
      }
    }
    const changed = structuredClone(workflow.jobs.publish); changed.steps.push({run: 'echo extra'});
    expect(() => assertSecretTiming(changed)).to.throw();
    expect(steps[installed].env.LEAK_IDENTIFIERS).to.equal('${{ secrets.OSD_RELEASE_LEAK_IDENTIFIERS }}');
    expect(steps[installed].run).to.include('test -n');
    const references = Object.entries(workflow.jobs).filter(([, job]) => strings(job).some(value => value.includes('secrets.OSD_RELEASE_LEAK_IDENTIFIERS'))).map(([name]) => name);
    expect(references).to.deep.equal(['publish']);
  });
  it('tokenizes secrets references without matching prose or expression string literals', () => {
    for (const value of ["secrets.FIXTURE", "${{ 'secrets.FIXTURE' }}", "${{ 'escaped '' secrets }}' }}",
      '${{ github.secrets_fixture }}', '${{ mysecrets.FIXTURE }}']) expect(referencesSecrets(value), value).to.equal(false);
    for (const value of ["${{ '}}' }} ${{ secrets['FIXTURE'] }}", '${{ toJSON(SeCrEtS) }}']) {
      expect(referencesSecrets(value), value).to.equal(true);
    }
  });
  it('allows only the reviewed publish job and shell defaults', () => {
    assertPublish(workflow.jobs.publish);
    expect(workflow.defaults).to.deep.equal({run: {shell: 'bash'}});
    expect(workflow.env).to.equal(undefined);
  });
  it('rejects added or changed commands, actions and dependency installation', () => {
    for (const run of [
      'node --eval "import(\"third-party\")"', 'node --import third-party script.mjs',
      'npx third-party', 'npm\tci', 'node extra.mjs',
    ]) {
      const added = structuredClone(workflow.jobs.publish);
      added.steps.splice(1, 0, {run});
      expect(() => assertPublish(added)).to.throw();
      const changed = structuredClone(workflow.jobs.publish);
      changed.steps[1].run += run + '\n';
      expect(() => assertPublish(changed)).to.throw();
    }
    const changed = structuredClone(workflow.jobs.publish);
    changed.steps.find(step => step.uses?.startsWith('actions/checkout@')).uses = 'actions/checkout@v4';
    expect(() => assertPublish(changed)).to.throw();
  });
  it('pins tag/environment gates and completes all fetching and staging before the secret', () => {
    const installed = steps.findIndex(step => step.name === 'install the identifier list');
    expect(steps[installed - 1].run).to.include('--prepare');
    expect(steps[installed - 1].run).to.include('osd-fetch.mjs --release');
    expect(steps.slice(installed + 1).some(step => step.run?.includes('--prepare') || step.run?.includes('osd-fetch.mjs'))).to.equal(false);
    for (const field of ['if', 'environment']) {
      const changed = structuredClone(workflow.jobs.publish);
      delete changed[field];
      expect(() => assertPublish(changed)).to.throw();
    }
    const reordered = structuredClone(workflow.jobs.publish);
    [reordered.steps[installed - 1], reordered.steps[installed]] = [reordered.steps[installed], reordered.steps[installed - 1]];
    expect(() => assertPublish(reordered)).to.throw();
  });
  it('refuses dependencies anywhere after checkout and immediately before publication', () => {
    const assertion = steps.find(step => step.name === 'Assert workspace has no dependencies').run;
    const publish = steps.find(s => s.id === 'publish').run;
    expect(publish.startsWith(assertion)).to.equal(true);
    expect(publish.slice(assertion.length).startsWith('node scripts/system-publish.mjs ')).to.equal(true);
    const dir = mkdtempSync(join(tmpdir(), 'oci-empty-workspace-'));
    const external = mkdtempSync(join(tmpdir(), 'oci-external-deps-'));
    const check = () => spawnSync('bash', ['-e', '-o', 'pipefail', '-c', assertion],
      {env: {...process.env, GITHUB_WORKSPACE: dir}, stdio: 'pipe'}).status;
    try {
      expect(check()).to.equal(0);
      mkdirSync(join(dir, '.hidden', 'nested', 'node_modules'), {recursive: true});
      expect(check()).to.equal(1);
      rmSync(join(dir, '.hidden'), {recursive: true});
      mkdirSync(join(external, 'node_modules'));
      symlinkSync(external, join(dir, 'linked'));
      expect(check()).to.equal(1);
    } finally {
      rmSync(dir, {recursive: true, force: true});
      rmSync(external, {recursive: true, force: true});
    }
  });
  it('pins every action to a full commit with a version comment', () => {
    const source = readFileSync(new URL('../.github/workflows/oci-release.yml', import.meta.url), 'utf8');
    for (const line of source.split('\n').filter(l => l.includes('uses:'))) {
      const [action, comment] = line.slice(line.indexOf('uses:') + 5).trim().split(' # ');
      const pin = action.split('@')[1];
      expect(pin?.length === 40 && [...pin].every(c => '0123456789abcdef'.includes(c))).to.equal(true);
      expect(comment?.startsWith('v') && '0123456789'.includes(comment[1])).to.equal(true);
    }
  });
  it('requires exact tag tests before the first publication', () => {
    const wait = workflow.jobs['wait-for-tests'];
    assertWait(wait);
    expect(wait.permissions).to.deep.equal({actions: 'read'});
    expect(JSON.stringify(wait).includes('secrets.')).to.equal(false);
    expect(workflow.jobs.publish.needs).to.equal('wait-for-tests');
  });
  it('rejects a masked test failure and any other change to the test gate', () => {
    const changed = structuredClone(workflow.jobs['wait-for-tests']);
    const tested = changed.steps.find(step => step.id === 'tested');
    tested.run = tested.run.replace('node tools/osd-ci-wait-tests.mjs "$RELEASE_TAG" "$tag_sha"', 'node tools/osd-ci-wait-tests.mjs "$RELEASE_TAG" "$tag_sha" || true');
    expect(() => assertWait(changed)).to.throw();
  });
  it('triggers only on release tags and checks the secret at installation', () => {
    expect(workflow.on).to.deep.equal({push: {tags: ['vscode-stable-v*', 'vscode-v*']}});
    const guard = steps.find(step => step.name === 'install the identifier list');
    expect(guard.env).to.deep.equal({LEAK_IDENTIFIERS: '${{ secrets.OSD_RELEASE_LEAK_IDENTIFIERS }}'});
    for (const value of ['', 'synthetic-fixture']) {
      const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', guard.run.split('\n')[0]], {env: {...process.env, LEAK_IDENTIFIERS: value}, stdio: 'pipe'});
      expect(result.status).to.equal(value ? 0 : 1);
      expect(result.stdout.toString() + result.stderr.toString()).not.to.include('synthetic-fixture');
    }
    const docs = readFileSync(new URL('../docs/oci-layers.md', import.meta.url), 'utf8');
    expect(docs).to.include('must be an environment secret of `release`, never a repository secret');
    expect(docs).to.include('missing environment yields an empty secret');
    expect(docs).to.include('only for a release tag push');
    expect(docs).not.to.include('manual dispatch from');
  });
  it('exports the tested SHA and pins both later jobs to it with a fresh tag check', () => {
    const wait = workflow.jobs['wait-for-tests'];
    expect(wait.outputs.sha).to.equal('${{ steps.tested.outputs.sha }}');
    expect(wait.steps.find(s => s.id === 'tested').run).to.include('echo "sha=$tag_sha" >> "$GITHUB_OUTPUT"');
    for (const name of ['publish', 'public-check']) {
      const job = workflow.jobs[name];
      expect(job.steps.find(step => step.uses?.startsWith('actions/checkout@')).with.ref).to.equal('${{ needs.wait-for-tests.outputs.sha }}');
      expect(job.env.TESTED_SHA).to.equal('${{ needs.wait-for-tests.outputs.sha }}');
      expect(job.steps.find(s => s.name === 'Validate existing release tag and clean checkout').run).to.include('assertTestedRelease(process.cwd(), process.env.RELEASE_TAG, process.env.TESTED_SHA)');
    }
  });
  it('isolates public boot verification from secrets and package permission', () => {
    const publicJob = workflow.jobs['public-check'];
    expect(publicJob.needs).to.deep.equal(['wait-for-tests', 'publish']);
    expect(publicJob.permissions).to.deep.equal({contents: 'read'});
    expect(JSON.stringify(publicJob).includes('secrets.')).to.equal(false);
    expect(JSON.stringify(publicJob).includes('needs.publish.outputs.report')).to.equal(true);
    expect(publicJob.steps.some(s => s.run?.includes('system-public-check.mjs'))).to.equal(true);
    expect(workflow.jobs.publish.outputs.report).to.equal('${{ steps.publish.outputs.report }}');
    expect(workflow.jobs.publish.permissions).to.deep.equal({contents: 'read', packages: 'write'});
    expect(publicJob.steps.some(s => s.run?.includes('osd-ci-transpiler-build.sh build'))).to.equal(true);
  });
  it('keeps repository leak scanning separate from the publication environment secret', () => {
    const docs = readFileSync(new URL('../docs/oci-layers.md', import.meta.url), 'utf8');
    expect(docs).to.include('OSD_RELEASE_LEAK_IDENTIFIERS');
    expect(docs).to.include('Keep the repository-level\n`OSD_LEAK_IDENTIFIERS`');
    expect(docs).not.to.include('Remove any repository-level copy');
    for (const name of ['leak-scan', 'release', 'oci-layers']) {
      const other = load(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
      expect(strings(other).some(value => value.includes('secrets.OSD_LEAK_IDENTIFIERS'))).to.equal(true);
      expect(strings(other).some(value => value.includes('secrets.OSD_RELEASE_LEAK_IDENTIFIERS'))).to.equal(false);
    }
  });
  it('removes the list immediately after its last consumer and before any action', () => {
    const installed = steps.findIndex(s => s.run?.includes('> .local/leak-identifiers.json'));
    const last = steps.findIndex(s => s.id === 'publish');
    expect(steps[last + 1]?.run).to.equal('rm -f .local/leak-identifiers.json');
    expect(steps.slice(installed + 1).some(s => s.uses)).to.equal(false);
    expect(steps.some(s => s.if === 'always()' && s.run === 'rm -f .local/leak-identifiers.json')).to.equal(true);
  });
  it('documents first-release absent-package status verification and fails closed otherwise', () => {
    const docs = readFileSync(new URL('../docs/oci-layers.md', import.meta.url), 'utf8');
    expect(docs).to.include('first release must confirm GHCR');
    expect(docs).to.include('not-yet-existing package');
    expect(docs).to.include('404');
    expect(docs).to.include('401/403');
    expect(docs).to.include('Only 404 is treated as absent');
    expect(docs).to.include('401/403 and every other lookup error fail closed before any upload');
  });
  it('documents first-release visibility and every expected package name', () => {
    const docs = readFileSync(new URL('../docs/oci-layers.md', import.meta.url), 'utf8');
    expect(docs.includes('package settings')).to.equal(true);
    const lock = JSON.parse(readFileSync(new URL('../libs.lock.json', import.meta.url)));
    const expected = [...lock.libraries.map(l => `lib-${l.folder}`), 'input-src', 'input-test', 'pack-o4d', 'pack-zork', 'pack-gui-examples', 'pack-travels-a4h', 'osd-system'];
    expect(expected.every(name => docs.includes('`' + name + '`'))).to.equal(true);
  });
});

// Every workflow step that stamps or verifies an artefact against the tree
// (tools/osd-public-tree.mjs) needs a live generation built earlier in the
// same job, or builds one itself. A test-only binary may skip the stamp
// with --unstamped, never on a seeded or release-target build, and only in
// the test workflow: every shipping path verifies the sidecar it lacks.
const STAMPS = [
  /\bbuild-binary\.mjs\b|\bnpm run binary(?![:\w])/, /\bbuild-sea\.mjs\b|\bnpm run binary:(?:sea|bundle)\b/,
  /\bbuild-vsix\.mjs\b|\bnpm run vsix\b/, /\bbuild-preview\.mjs\b/, /\bmake-release\.mjs\b/,
  /\bmake-download-bundle\.mjs\b/, /\bosd-ci-artifact\.mjs pack\b/, /\bosd-public-tree\.mjs (?:write|verify)\b/,
  /\bcapture-screenshots\.mjs\b/, /\bassemble\.mjs\b/,
];
// what leaves a live generation behind in the job's tree (web:vscode and the
// image build make their own before they stamp)
const BUILDS = /\bnpm run (?:transpile|bootstrap|web:preview(?::duckdb)?|web:vscode)\b|\btools\/osd-build\.mjs\b|\bbuild-vscode-web\.mjs\b|\bosd-ci-artifact\.mjs verify\b|\bdocker (?:buildx )?build\b/;
// A shell command continued with a trailing backslash is one command: every
// rule below reads commands, not physical lines.
export const commandsOf = (run) => String(run ?? '').replace(/\\\r?\n[ \t]*/g, ' ').split('\n')
  .map(text => text.trim()).filter(text => text && !text.startsWith('#'));
export function stampsWithoutGeneration(name, workflow) {
  const problems = [];
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    let built = false;
    for (const [index, step] of (job.steps ?? []).entries()) {
      for (const line of commandsOf(step.run)) {
        const where = `${name} ${jobName} step ${index + 1} (${step.name ?? line})`;
        const unstamped = /\s--unstamped\b/.test(line);
        if (unstamped && (!/\bbuild-binary\.mjs\b|\bnpm run binary(?![:\w])/.test(line) || /\s--seed\b/.test(line) || /\sbun-[a-z0-9-]+/.test(line) || name !== 'tests.yml'))
          problems.push(`${where}: --unstamped outside a test-only checkout binary`);
        if (!built && !unstamped && STAMPS.some(stamp => stamp.test(line)) && !BUILDS.test(line))
          problems.push(`${where}: stamps with no live generation built before it in this job`);
        // writing moved to osd-public-tree.mjs; osd-provenance.mjs only verifies bytes
        if (/\bosd-provenance\.mjs\s+write\b/.test(line)) problems.push(`${where}: osd-provenance.mjs write is gone; use osd-public-tree.mjs write`);
        if (BUILDS.test(line)) built = true;
      }
    }
  }
  return problems;
}

describe('workflows: a stamping step runs after a live generation exists', () => {
  const dir = new URL('../.github/workflows/', import.meta.url);
  const workflows = readdirSync(dir).filter(file => file.endsWith('.yml')).map(file => [file, load(readFileSync(new URL(file, dir), 'utf8'))]);

  it('holds for every job of every workflow', () => {
    expect(workflows.flatMap(([file, workflow]) => stampsWithoutGeneration(file, workflow))).to.deep.equal([]);
  });

  it('builds the pre-transpile test binary unstamped, and every release binary is verified after it is built', () => {
    const build = load(readFileSync(new URL('tests.yml', dir), 'utf8')).jobs.build.steps;
    const first = build.findIndex(step => commandsOf(step.run).some(line => /build-binary\.mjs/.test(line)));
    expect(commandsOf(build[first].run).join('\n')).to.match(/build-binary\.mjs --unstamped /);
    expect(build.findIndex(step => commandsOf(step.run).some(line => /npm run transpile/.test(line)))).to.be.greaterThan(first);
    const release = load(readFileSync(new URL('release.yml', dir), 'utf8'));
    for (const [jobName, job] of Object.entries(release.jobs)) {
      const runs = (job.steps ?? []).flatMap(step => commandsOf(step.run)).join('\n');
      if (/npm run binary\b/.test(runs)) expect(runs.indexOf('release-verify.mjs binary'), jobName).to.be.greaterThan(runs.indexOf('npm run binary'));
    }
  });

  it('catches a stamping step before the generation, and a misused --unstamped', () => {
    const job = (...runs) => ({jobs: {build: {steps: runs.map(run => ({run}))}}});
    expect(stampsWithoutGeneration('tests.yml', job('bun scripts/build-binary.mjs "$RUNNER_TEMP/osd"', 'npm run transpile'))).to.have.length(1);
    expect(stampsWithoutGeneration('tests.yml', job('npm run transpile', 'bun scripts/build-binary.mjs "$RUNNER_TEMP/osd"'))).to.deep.equal([]);
    expect(stampsWithoutGeneration('tests.yml', job('bun scripts/build-binary.mjs --unstamped "$RUNNER_TEMP/osd"'))).to.deep.equal([]);
    expect(stampsWithoutGeneration('preview.yml', job('node scripts/build-preview.mjs', 'npm run web:preview'))).to.have.length(1);
    expect(stampsWithoutGeneration('preview.yml', job('npm run web:preview', 'node scripts/capture-screenshots.mjs'))).to.deep.equal([]);
    expect(stampsWithoutGeneration('release.yml', job('node tools/osd-public-tree.mjs write build/release/x', 'npm run transpile'))).to.have.length(1);
    expect(stampsWithoutGeneration('release.yml', job('npm run transpile', 'node tools/osd-provenance.mjs write build/release/x'))).to.have.length(1);
    // a continued command is one command, for every rule
    expect(stampsWithoutGeneration('release.yml', job('npm run transpile', 'npm run binary -- \\\n  --unstamped build/release/x'))).to.have.length(1);
    expect(stampsWithoutGeneration('tests.yml', job('bun scripts/build-binary.mjs \\\n  --unstamped "$RUNNER_TEMP/osd"'))).to.deep.equal([]);
    expect(stampsWithoutGeneration('tests.yml', job('bun scripts/build-binary.mjs --unstamped \\\n  x bun-linux-x64-baseline'))).to.have.length(1);
    expect(stampsWithoutGeneration('tests.yml', job('node \\\n  scripts/build-preview.mjs', 'npm run transpile'))).to.have.length(1);
    expect(stampsWithoutGeneration('tests.yml', job('node tools/osd-build.mjs \\\n  --publish', 'node scripts/build-preview.mjs'))).to.deep.equal([]);
    for (const [file, run] of [['release.yml', 'npm run binary -- --unstamped build/release/x'], ['tests.yml', 'npm run binary -- --seed --unstamped x'],
      ['tests.yml', 'bun scripts/build-binary.mjs --unstamped x bun-linux-x64-baseline'], ['tests.yml', 'node scripts/build-vsix.mjs --unstamped']])
      expect(stampsWithoutGeneration(file, job('npm run transpile', run)), run).to.have.length(1);
  });
});
