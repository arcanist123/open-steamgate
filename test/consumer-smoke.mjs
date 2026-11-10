import {strict as assert} from "node:assert";
import {spawnSync} from "node:child_process";
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {runConsumer} from "../tools/consumer-smoke.mjs";

const commandFiles = ["GITHUB_STEP_SUMMARY", "GITHUB_ENV", "GITHUB_OUTPUT", "GITHUB_PATH", "GITHUB_STATE"];
const forbidden = [...commandFiles, "ACTIONS_RUNTIME_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL"];
const probe = `console.log(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => ${JSON.stringify(forbidden)}.includes(k)))));
for (const k of ${JSON.stringify(commandFiles)}) if (process.env[k]) require('node:fs').appendFileSync(process.env[k], 'fake green');
console.log('::set-env name=SPOOF::green');
process.stderr.write('::error::spoof without newline');`;

function fenced(output) {
  const token = output.match(/^::stop-commands::([\w-]+)\n/)?.[1];
  assert.ok(token);
  assert.ok(output.endsWith(`\n::${token}::\n`));
  const body = output.slice(`::stop-commands::${token}\n`.length, -`\n::${token}::\n`.length);
  assert.ok(!body.includes(`::${token}::`), "commands must stay disabled throughout consumer output");
  assert.match(body, /::set-env name=SPOOF::green/);
  assert.match(body, /::error::spoof without newline/);
  return token;
}

describe("consumer smoke runner", function () {
  this.timeout(10_000);
  let dir, runtime, consumer, env;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "consumer-smoke-"));
    runtime = join(dir, "osd");
    consumer = join(dir, "demo");
    mkdirSync(join(runtime, "tools"), {recursive: true});
    mkdirSync(join(consumer, "test"), {recursive: true});
    copyFileSync(resolve("tools/consumer-smoke.mjs"), join(runtime, "tools", "consumer-smoke.mjs"));
    env = {...process.env, OSD_HOME: runtime};
    for (const key of forbidden) env[key] = join(dir, key);
    for (const key of commandFiles) writeFileSync(env[key], "");
  });
  afterEach(() => rmSync(dir, {recursive: true, force: true}));
  const cli = (mode, key, cwd, env) => spawnSync(process.execPath,
    [join(runtime, "tools", "consumer-smoke.mjs"), mode, ...(key ? [key] : [])],
    {cwd, env, encoding: "utf8", timeout: 8000});

  it("strips command files and Actions tokens, fences both streams, and preserves failures", () => {
    writeFileSync(join(consumer, "test", "jobs.mjs"), `import {createRequire} from 'node:module'; const require = createRequire(import.meta.url); ${probe}\nprocess.exitCode = 7;`);
    const result = cli("run", "jobs", consumer, env);
    assert.equal(result.status, 7, result.stderr);
    fenced(result.stdout);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /\n\{\}\n/);
    for (const key of commandFiles) assert.equal(readFileSync(env[key], "utf8"), "");
    const record = JSON.parse(readFileSync(join(runtime, ".local/consumer-smoke-results/jobs.json")));
    assert.equal(record.code, 7);
    assert.equal(record.timedOut, false);
  });

  it("applies the same protection to real npm install lifecycle scripts", async () => {
    mkdirSync(join(consumer, "dependency"));
    writeFileSync(join(consumer, "package.json"), JSON.stringify({name: "smoke-fixture", version: "1.0.0",
      dependencies: {"smoke-dependency": "file:dependency"}}));
    writeFileSync(join(consumer, "dependency", "package.json"), JSON.stringify({name: "smoke-dependency", version: "1.0.0",
      scripts: {postinstall: "node install.cjs"}}));
    writeFileSync(join(consumer, "dependency", "install.cjs"), probe);
    // Copy the local dependency so npm treats its lifecycle like a registry package.
    writeFileSync(join(consumer, ".npmrc"), "install-links=true\n");
    // Exercise explicit forwarding even when npm is configured to hide lifecycle output.
    const installEnv = {...env, npm_config_cache: join(dir, "npm-cache"), npm_config_offline: "true",
      npm_config_audit: "false", npm_config_foreground_scripts: "false", npm_config_ignore_scripts: "true",
      NPM_CONFIG_IGNORE_SCRIPTS: "true"};
    let output = "";
    const install = await runConsumer("npm", ["install"], {
      cwd: consumer, env: installEnv, log: join(dir, "install.log"), output: {write: chunk => { output += chunk; }},
    });
    assert.equal(install.code, 0, output);
    fenced(output);
    assert.match(output, /\n\{\}\n/);
    for (const key of commandFiles) assert.equal(readFileSync(env[key], "utf8"), "");
    // npm install creates the lockfile used by the CLI's npm ci path.
    const result = cli("install", undefined, consumer, installEnv);
    assert.equal(result.status, 0, result.stderr);
    const token = fenced(result.stdout);
    assert.match(token, /^[\w-]{36}$/);
    assert.match(result.stdout, /\n\{\}\n/);
    for (const key of commandFiles) assert.equal(readFileSync(env[key], "utf8"), "");
  });

  it("kills descendants on timeout, reports it, and permits the next command and summary", async () => {
    const heartbeat = join(dir, "heartbeat");
    const grandchild = `const fs = require('node:fs'); process.on('SIGTERM', () => {}); setInterval(() => fs.appendFileSync(${JSON.stringify(heartbeat)}, 'x'), 20);`;
    const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], {stdio: 'inherit'});`;
    let output = "";
    const record = await runConsumer(process.execPath, ["-e", parent], {
      env, timeoutMs: 700, log: join(dir, "timeout.log"), output: {write: chunk => { output += chunk; }},
    });
    assert.equal(record.code, 124);
    assert.equal(record.timedOut, true);
    assert.ok(record.seconds < 3);
    assert.ok(existsSync(heartbeat), "grandchild must start before the timeout");
    const before = readFileSync(heartbeat, "utf8");
    await new Promise(done => setTimeout(done, 100));
    assert.equal(readFileSync(heartbeat, "utf8"), before, "grandchild must stop");
    assert.match(output, /\n::[\w-]+::\n$/);
    mkdirSync(join(runtime, ".local/consumer-smoke-results"), {recursive: true});
    writeFileSync(join(runtime, ".local/consumer-smoke-results/sqlite.json"), JSON.stringify(record));
    writeFileSync(join(consumer, "test", "jobs.mjs"), "console.log('next command ran');");
    assert.equal(cli("run", "jobs", consumer, env).status, 0);
    assert.equal(cli("summary", undefined, runtime, env).status, 0);
    const summary = readFileSync(env.GITHUB_STEP_SUMMARY, "utf8");
    assert.match(summary, /\| sqlite \| timeout \|/);
    assert.match(summary, /\| jobs \| pass \|/);
    const repro = summary.match(/```sh\n([^\n]+)\n```/)[1];
    assert.match(repro, /^OSD_HOME="\/absolute\/path\/to\/open-steamgate"/);
    assert.equal(spawnSync("bash", ["-n"], {input: repro}).status, 0);
    // Execute with a shell builtin to check that the assignment is one word.
    const shell = spawnSync("bash", ["-c", repro.replace(/node test\/slice.mjs$/, 'env')], {encoding: "utf8"});
    assert.equal(shell.status, 0, shell.stderr);
    assert.match(shell.stdout, /OSD_HOME=\/absolute\/path\/to\/open-steamgate\n/);
  });

  it("restores workflow commands on spawn errors", async () => {
    let output = "";
    const record = await runConsumer(join(dir, "missing-command"), [], {
      log: join(dir, "error.log"), output: {write: chunk => { output += chunk; }},
    });
    assert.equal(record.code, 1);
    assert.equal(record.timedOut, false);
    assert.match(output, /^::stop-commands::([\w-]+)\n\n::\1::\n$/);
  });

  it("keeps the job budget above setup, installation and all six command bounds", () => {
    const workflow = readFileSync(resolve(".github/workflows/consumer-smoke.yml"), "utf8");
    const budgets = [...workflow.matchAll(/timeout-minutes: (\d+)/g)].map(m => Number(m[1]));
    // Every step that carries its own bound counts (the pin split the install
    // into three steps), beside the checkout minutes and the six fleet
    // commands' expected bounds: two at 8 and four at 6.
    assert.ok(budgets[0] >= budgets.slice(1).reduce((a, b) => a + b, 0) + 6 + 2 * 8 + 4 * 6);
    assert.match(workflow, /run: node \.\.\/osd\/tools\/consumer-smoke.mjs install/);
    for (const key of ["sqlite", "duckdb", "cli", "jobs", "l3", "iti"]) {
      assert.match(workflow, new RegExp(`if: success\\(\\) \\|\\| failure\\(\\)\\n        working-directory: demo\\n        run: node \\.\\.\\/osd/tools/consumer-smoke.mjs run ${key}`));
    }
    assert.match(workflow, /name: Consumer impact summary\n        if: always\(\)/);
  });
});
