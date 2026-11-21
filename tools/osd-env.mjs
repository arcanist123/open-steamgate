import {dirname, resolve} from 'node:path';

// Read only the named application settings; never hand process.env to a caller.
export function readEnvironment(keys) {
  return Object.fromEntries(keys.map(key => [key, process.env[key]]).filter(([, value]) => value !== undefined));
}

// Publication runs on Linux. No caller or inherited values can widen this env.
export function publishChildEnv(kind) {
  const env = {PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', LANG: 'C.UTF-8'};
  if (kind === 'git') Object.assign(env, {GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0'});
  return env;
}

// Development and shipped tools retain the host's PATH casing, home, proxies,
// SSH settings and normal Git configuration. Only injected runtime/config is cut.
export function devChildEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => {
    const name = key.toUpperCase();
    return name !== 'NODE_OPTIONS' && !name.startsWith('GIT_CONFIG_');
  }));
}

// Keep temporary Git work inside cwd even if init failed to create .git.
// args is the command argv, before any release configuration prefix.
export function isolatedGitEnv(base, cwd, args) {
  return {...base, GIT_CEILING_DIRECTORIES: dirname(resolve(cwd)),
    ...(args[0] === 'init' ? {} : {GIT_DIR: resolve(cwd, '.git'), GIT_WORK_TREE: resolve(cwd)})};
}

// git reads config that can run a program (core.fsmonitor, from the
// repository itself): a git a gate or the read recorder trusts runs with it
// off and with no system, global or environment-injected config
export const GIT_SAFE = ['-c', 'core.fsmonitor=false'];
export function isolatedGit(env) {
  const out = Object.fromEntries(Object.entries(env).filter(([name]) => !/^GIT_CONFIG_(PARAMETERS|COUNT|KEY_|VALUE_)/.test(name)));
  return {...out, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'};
}
