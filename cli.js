#!/usr/bin/env node
// vibench: a tmux launcher. One reusable tmux host holds one window per bench.
// Normal benches have Neovim and harness panes; watch-only benches have only
// Neovim. Every pane inherits the same VIBENCH_SESSION identity.
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { loadConfig } from './config.js';
import { harnessLine, writeMcpConfig } from './mcp.js';
import { cleanupOwnedHost, ownedHostTarget, windowOwnerKey, windowWatchKey } from './tmux-host.js';
import { parseProcStat, providerFor, SOURCE_MISS_MS } from './transcript.js';

const TMUX_SOCKET = process.env.VIBENCH_TMUX_SOCKET || 'vibench';
const tmuxArgs = (args) => ['-L', TMUX_SOCKET, ...args];
const tmux = (...args) => execFileSync('tmux', tmuxArgs(args), { encoding: 'utf8', windowsHide: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMUX_SESSION = process.env.VIBENCH_TMUX_SESSION || 'vibench';
const LAUNCH_RESERVATION_MS = 30_000;

// ---- the vibench server, tmux-server style: ping it, hook in if alive,
// start it detached if not ----

const SERVER_FILE = path.join(process.env.VIBENCH_DIR || path.join(os.homedir(), '.vibench'), 'server.json');
const TMUX_LAUNCH_LOCK = path.join(path.dirname(SERVER_FILE), 'tmux-launch.lock');
const SERVER_SOURCE = fileURLToPath(new URL('./server.js', import.meta.url));
const SERVER_VERSION = crypto.createHash('sha256')
  .update(fs.readFileSync(SERVER_SOURCE))
  .update(fs.readFileSync(fileURLToPath(new URL('./transcript.js', import.meta.url))))
  .update(fs.readFileSync(fileURLToPath(new URL('./tmux-host.js', import.meta.url))))
  .update(fs.readdirSync(fileURLToPath(new URL('./providers/', import.meta.url))).filter((file) => !file.endsWith('.test.js')).sort()
    .map((file) => fs.readFileSync(fileURLToPath(new URL(`./providers/${file}`, import.meta.url)))).join(''))
  .digest('hex');
const authorized = (token, headers = {}) => token
  ? { ...headers, authorization: `Bearer ${token}` } : headers;

async function serverInfo() {
  try {
    const { port, version, token } = JSON.parse(fs.readFileSync(SERVER_FILE, 'utf8'));
    const headers = authorized(token);
    const res = await fetch(`http://127.0.0.1:${port}/sessions`, {
      headers, signal: AbortSignal.timeout(500),
    });
    if (res.ok && version === SERVER_VERSION && token) return { port, token };
    if (res.ok) {
      await fetch(`http://127.0.0.1:${port}/kill`, {
        method: 'POST', headers, signal: AbortSignal.timeout(500),
      });
      for (let i = 0; i < 20; i++) {
        await sleep(50);
        try {
          await fetch(`http://127.0.0.1:${port}/sessions`, {
            headers, signal: AbortSignal.timeout(100),
          });
        }
        catch { break; }
      }
    }
  } catch { /* not running */ }
  return null;
}

async function ensureServer() {
  let info = await serverInfo();
  if (info) return info;
  spawn(process.execPath, [fileURLToPath(new URL('./server.js', import.meta.url))], {
    detached: true, stdio: 'ignore', windowsHide: true,
  }).unref();
  for (let i = 0; i < 50; i++) {
    await sleep(150);
    info = await serverInfo();
    if (info) return info;
  }
  throw new Error('vibench server did not start');
}

// ---- the nvim profile: real files live in ~/.vibench/nvim; nvim finds them
// through NVIM_APPNAME=vibench, whose standard config location is a
// junction/symlink onto that directory. Env var over args so a manually
// relaunched nvim in the pane still gets the profile. ----

const NVIM_DIR = path.join(process.env.VIBENCH_DIR || path.join(os.homedir(), '.vibench'), 'nvim');
const NVIM_SRC = fileURLToPath(new URL('./nvim/', import.meta.url));
const NVIM_LAZY_SRC = fileURLToPath(new URL('./nvim-lazy/', import.meta.url));

const configBase = () => (process.platform === 'win32'
  ? (process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'))
  : (process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config')));
const nvimConfigLink = () => path.join(configBase(), 'vibench');
const userNvimConfig = () => path.join(configBase(), 'nvim');
const nvimDataDir = (app) => (process.platform === 'win32'
  ? path.join(configBase(), `${app}-data`)
  : path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), app));

function deployNvim(force, flavor = 'stock') {
  if (force) fs.rmSync(NVIM_DIR, { recursive: true, force: true });
  if (!fs.existsSync(NVIM_DIR)) {
    if (flavor === 'clone') {
      const src = userNvimConfig();
      if (!fs.existsSync(path.join(src, 'init.lua')) && !fs.existsSync(path.join(src, 'init.vim'))) {
        throw new Error(`no nvim config to clone at ${src}`);
      }
      fs.cpSync(src, NVIM_DIR, { recursive: true, filter: (p) => path.basename(p) !== '.git' });
    } else {
      fs.cpSync(flavor === 'lazy' ? NVIM_LAZY_SRC : NVIM_SRC, NVIM_DIR, { recursive: true });
    }
    if (flavor !== 'stock') {
      // seed compiled treesitter parsers from the daily nvim's data dir:
      // nvim-treesitter can't rebuild them in this environment (tree-sitter
      // CLI spawn fails), so without them it retries the whole install,
      // noisily, on every single launch
      const site = path.join(nvimDataDir('nvim'), 'site');
      if (fs.existsSync(site)) fs.cpSync(site, path.join(nvimDataDir('vibench'), 'site'), { recursive: true, force: true });
    }
  }
  // These are vibench-owned even in cloned profiles; refresh them every run.
  for (const relative of ['plugin', path.join('lua', 'vibench')]) {
    const source = path.join(NVIM_SRC, relative);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(NVIM_DIR, relative), { recursive: true, force: true });
  }
  const link = nvimConfigLink();
  try {
    const normalize = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    const same = normalize(fs.realpathSync(link)) === normalize(fs.realpathSync(NVIM_DIR));
    if (!same) throw new Error(`${link} already exists and is not the vibench profile`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(NVIM_DIR, link, 'junction');
  }
}

async function allocateSession(server, session) {
  const res = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
    method: 'POST',
    headers: authorized(server.token, { 'content-type': 'application/json' }),
    body: JSON.stringify(session),
  });
  if (!res.ok) throw new Error(`server refused session: ${(await res.text()).slice(0, 200)}`);
  return { session: await res.json(), created: res.status === 201 };
}

const USAGE = `vibench [options]                       create or focus a bench
  -w, --workspace D                    workspace (default: current directory)
  -m, --model-harness H                configured harness (default: first)
  --name N                             bench name (default: workspace basename)
  -s, --session ID                     resume/watch a harness session
  --watch-only                         Neovim only; requires --session
  --no-watch                           start with Watch off
  --no-attach                          do not attach
vibench ls                             list benches
vibench reset-nvim [--lazy|--clone]   restore ~/.vibench/nvim: stock, LazyVim (-l/--lazy),
                                       or a copy of your own config (--clone)
vibench kill-server                    stop the resident registry server`;

export function parseArgs(argv) {
  const o = { attach: true };
  const value = (flag, i) => {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('-')) throw new Error(`${flag} requires a value`);
    return next;
  };
  const command = (name) => {
    if (o.command && o.command !== name) throw new Error(`commands ${o.command} and ${name} are mutually exclusive`);
    o.command = name;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-w' || a === '--workspace') o.workspace = value(a, i++);
    else if (a === '-m' || a === '--model-harness') o.modelHarness = value(a, i++);
    else if (a === '--name') o.name = value(a, i++);
    else if (a === '-s' || a === '--session') o.session = value(a, i++);
    else if (a === '--watch-only') o.watchOnly = true;
    else if (a === '--no-watch') o.watch = false;
    else if (a === '--no-attach') o.attach = false;
    else if (a === 'ls') command('ls');
    else if (a === 'reset-nvim') command('reset-nvim');
    else if (a === '-l' || a === '--lazy') o.lazy = true;
    else if (a === '--clone') o.clone = true;
    else if (a === 'kill-server') command('kill-server');
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (o.watchOnly && !o.session) throw new Error('--watch-only requires --session');
  if ((o.lazy || o.clone) && o.command !== 'reset-nvim') throw new Error('--lazy and --clone are only valid with reset-nvim');
  if (o.lazy && o.clone) throw new Error('--lazy and --clone are mutually exclusive');
  if (o.command && [o.workspace, o.modelHarness, o.name, o.session, o.watchOnly, o.watch === false, !o.attach]
    .some(Boolean)) throw new Error(`launch options are not valid with ${o.command}`);
  return o;
}

const hasSession = (name) => {
  try { execFileSync('tmux', tmuxArgs(['has-session', '-t', `=${name}`]), { stdio: 'pipe', windowsHide: true }); return true; }
  catch { return false; }
};

const hasHost = () => {
  if (!hasSession(TMUX_SESSION)) return false;
  try {
    return tmux('show-options', '-t', TMUX_SESSION).split(/\r?\n/)
      .some((line) => /^@vibench\s+"?1"?$/.test(line.trim()));
  }
  catch { return false; }
};

const windowNames = (session) => {
  try {
    return new Set(tmux('list-windows', '-t', session, '-F', '#{window_name}').trim().split(/\r?\n/).filter(Boolean));
  } catch { return new Set(); }
};

export function sessionName(base, existing) {
  let candidate = base;
  for (let n = 2; existing(candidate); n++) candidate = `${base}-${n}`;
  return candidate;
}

export function launchOptions(config, args, cwd = process.cwd()) {
  const requested = (args.workspace ?? cwd).replace(/^~(?=$|[\\/])/, os.homedir());
  const dir = path.resolve(requested);
  try {
    if (!fs.statSync(dir).isDirectory()) throw new Error();
  } catch { throw new Error(`workspace is not a directory: ${requested}`); }
  const harnessName = args.modelHarness ?? config.harnesses[0]?.name;
  const harness = config.harnesses.find((candidate) => candidate.name === harnessName);
  if (!harness) {
    throw new Error(`unknown model harness "${harnessName ?? ''}" (configured: ${config.harnesses.map((h) => h.name).join(', ') || 'none'})`);
  }
  if (args.name !== undefined && !args.name.trim()) throw new Error('--name cannot be empty');
  if (args.session !== undefined && !args.session.trim()) throw new Error('--session cannot be empty');
  return {
    dir,
    harness,
    baseName: args.name !== undefined ? args.name : path.basename(dir) || 'vibench',
    harnessSessionId: args.session?.trim() ?? null,
    watchOnly: args.watchOnly === true,
    watch: args.watch !== false,
  };
}

const samePath = (left, right) => {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const normalizePath = (value) => process.platform === 'win32'
    ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalizePath(left) === normalizePath(right);
};

export function existingBench(registry, harnessName, harnessSessionId, watchOnly, workspace, live = () => true) {
  if (!harnessSessionId) return null;
  const matches = Object.values(registry).filter((session) => session.harness === harnessName
    && session.harness_session_id === harnessSessionId
    && (session.watch_only === true) === watchOnly
    && samePath(session.pwd, workspace)
    && live(session));
  if (matches.length > 1) {
    const benches = matches.map((session) => `${session.name} (${session.pwd})`).join(', ');
    throw new Error(`multiple benches match ${harnessName} session ${harnessSessionId}: ${benches}`);
  }
  return matches[0] ?? null;
}

export function activeReservation(session, now = Date.now()) {
  const started = Date.parse(session?.launch_started_at);
  return session?.launching === true && Number.isFinite(started)
    && now - started < LAUNCH_RESERVATION_MS;
}

export function reservedBenchNames(registry, tmuxNames = [], now = Date.now()) {
  return new Set([
    ...Object.values(registry)
      .filter((session) => session.launching !== true || activeReservation(session, now))
      .map((session) => session.name),
    ...tmuxNames,
  ]);
}

export function currentSessionRegistry(registry, catalog, now = Date.now()) {
  const roots = new Map((catalog?.roots ?? []).map((root) => [root.id, root]));
  const ignoredIds = [];
  const sessions = Object.fromEntries(Object.entries(registry).map(([id, session]) => {
    const root = roots.get(id);
    if (activeReservation(session, now) || !root || root.error
        || !Object.hasOwn(root, 'source_session_id')) return [id, session];
    const current = root.source_session_id ?? null;
    if (current === null && root.source_missing_confirmed !== true) return [id, session];
    if (typeof session.harness_session_id === 'string' && session.harness_session_id !== current) {
      ignoredIds.push(id);
    }
    return [id, { ...session, harness_session_id: current }];
  }));
  return { sessions, ignoredIds };
}

export function needsSessionConfirmation(catalog) {
  return catalog?.roots?.some((root) => !root.error && root.source_established === true
    && root.source_session_id === null && root.source_missing_confirmed !== true) === true;
}

export async function preflightWatchSession(provider, session) {
  const located = await provider.locate({ session: { ...session, watch_only: true }, processes: [] });
  if (!located?.file) {
    throw new Error(`cannot watch harness session ${session.harness_session_id}: ${located?.reason || 'transcript not found'}`);
  }
  return located;
}

export function hasProcessIdentitySupport(
  platform = process.platform, readFile = fs.readFileSync, execute = execFileSync,
) {
  if (platform === 'win32') return true;
  if (platform === 'linux') {
    try {
      if (parseProcStat(readFile('/proc/self/stat', 'utf8'), process.pid)) return true;
    } catch { /* fall through to procps */ }
  }
  try {
    const output = execute('ps', ['-A', '-o', 'pid=,ppid=,lstart='], {
      encoding: 'utf8', windowsHide: true,
      env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
    });
    return output.split(/\r?\n/).some((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
      return Number(match?.[1]) === process.pid && Boolean(match?.[3]?.trim());
    });
  } catch { return false; }
}

const paneCount = (target) => {
  try { return tmux('list-panes', '-t', target, '-F', 'x').trim().split(/\r?\n/).filter(Boolean).length; }
  catch { return 0; }
};

async function acquireTmuxLaunchLock() {
  fs.mkdirSync(path.dirname(TMUX_LAUNCH_LOCK), { recursive: true });
  const token = `${process.pid}:${crypto.randomUUID()}`;
  for (let attempt = 0; attempt < 600; attempt++) {
    try {
      fs.writeFileSync(TMUX_LAUNCH_LOCK, token, { flag: 'wx', mode: 0o600 });
      return () => {
        try {
          if (fs.readFileSync(TMUX_LAUNCH_LOCK, 'utf8') === token) fs.unlinkSync(TMUX_LAUNCH_LOCK);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const owner = Number(fs.readFileSync(TMUX_LAUNCH_LOCK, 'utf8').split(':', 1)[0]);
        let alive = Number.isInteger(owner) && owner > 0;
        try { if (alive) process.kill(owner, 0); } catch (probe) { alive = probe.code === 'EPERM'; }
        if (!alive) fs.unlinkSync(TMUX_LAUNCH_LOCK);
      } catch (probe) { if (probe.code !== 'ENOENT') throw probe; }
      await sleep(50);
    }
  }
  throw new Error('timed out waiting to create a tmux window');
}

function readTmuxEnvironment(run, target, keys) {
  const output = run('show-environment', '-t', `=${target}`);
  return new Map(keys.map((key) => {
      const prefix = `${key}=`;
      const line = output.split(/\r?\n/).find((value) => value.startsWith(prefix));
      return [key, line?.slice(prefix.length)];
  }));
}

export function tmuxEnvironmentArgument(value, psmux = false) {
  // psmux rebuilds argv as text and parses it again; JSON quoting survives that second pass.
  return psmux ? JSON.stringify(value) : value;
}

async function applyTmuxEnvironment(run, target, values, psmux = false) {
  let failure;
  for (const [key, value] of values) {
    try {
      if (value === undefined) run('set-environment', '-u', '-t', `=${target}`, key);
      else run('set-environment', '-t', `=${target}`, key, tmuxEnvironmentArgument(value, psmux));
    } catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
  for (let attempt = 0; attempt < 100; attempt++) {
    const current = readTmuxEnvironment(run, target, [...values.keys()]);
    if ([...values].every(([key, value]) => current.get(key) === value)) return;
    await sleep(10);
  }
  throw new Error('tmux environment change was not applied');
}

export async function withTmuxEnvironment(run, target, variables, action, psmux = false) {
  const values = new Map(Object.entries(variables));
  const previous = readTmuxEnvironment(run, target, [...values.keys()]);
  let restored = false;
  const restore = async () => {
    if (restored) return;
    await applyTmuxEnvironment(run, target, previous, psmux);
    restored = true;
  };
  try {
    await applyTmuxEnvironment(run, target, values, psmux);
    return await action();
  } finally { await restore(); }
}

async function create({ dir, harness, name, id, port, token, activate, watchOnly, watch, launchArgs }) {
  const variables = {
    VIBENCH_SESSION: id,
    VIBENCH_SERVER: `http://127.0.0.1:${port}`,
    VIBENCH_SERVER_JSON: SERVER_FILE,
    VIBENCH_SERVER_TOKEN: token,
    VIBENCH_TMUX_SOCKET: TMUX_SOCKET,
    VIBENCH_TMUX_SESSION: TMUX_SESSION,
    VIBENCH_WATCH: watch ? '1' : '0',
    NVIM_APPNAME: 'vibench',
  };
  const psmux = /^psmux\b/im.test(tmux('-V'));
  const env = Object.entries(variables).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  let target;
  let windowTarget;
  let createdHost = false;
  let hostTarget;
  let existed = false;
  // psmux satisfies `-c <dir>` on a warm (pre-spawned) pane by TYPING a
  // PowerShell `cd ...; SetCurrentDirectory(...)` line into it — which errors
  // visibly in a non-PowerShell shell (e.g. git-bash) and lands the pane in
  // the wrong directory. A cold spawn honours `-c` through the ConPTY cwd with
  // no typed line, so disable the warm pool. The session target is required
  // (a bare `-g` set does not reach the server); unknown option on real tmux.
  const prepareHost = (targetSession) => {
    try { tmux('set-option', '-t', targetSession, '-g', 'warm', 'off'); } catch { /* not psmux */ }
    try { tmux('set-option', '-g', 'scroll-enter-copy-mode', 'off'); } catch { /* not psmux */ }
  };
  const releaseLaunchLock = await acquireTmuxLaunchLock();
  try {
    let paneIds;
    try {
      existed = hasSession(TMUX_SESSION);
      if (existed && !hasHost()) {
        // Another launcher can create the shared host just before it marks it.
        // Give that first launch a short chance to finish claiming the host.
        for (let i = 0; i < 20 && hasSession(TMUX_SESSION) && !hasHost(); i++) await sleep(50);
        if (!hasHost()) throw new Error(`tmux session "${TMUX_SESSION}" already exists but is not a vibench host`);
      }
      const spawnPanes = async () => {
        if (existed) prepareHost(TMUX_SESSION);
        if (existed) {
          target = tmux('new-window', '-d', '-P', '-F', '#{window_id}', '-t', TMUX_SESSION, '-n', name, '-c', dir, ...env).trim();
        } else {
          target = tmux('new-session', '-d', '-P', '-F', '#{window_id}', '-s', TMUX_SESSION, '-n', name, '-c', dir, ...env).trim();
          createdHost = true;
          hostTarget = tmux('display-message', '-p', '-t', `=${TMUX_SESSION}`, '#{session_id}').trim() || null;
          tmux('set-option', '-t', TMUX_SESSION, '@vibench', '1');
          prepareHost(TMUX_SESSION);
        }
        if (!target) throw new Error('tmux window creation did not return a stable window id');
        windowTarget = target;
        await applyTmuxEnvironment(tmux, TMUX_SESSION, new Map([
          [windowOwnerKey(target), id],
          [windowWatchKey(target), variables.VIBENCH_WATCH],
        ]), psmux);
        const desiredPanes = watchOnly ? 1 : 2;
        // psmux race: a split fired right after new-session can report success yet
        // leave one pane; verify and re-split, patiently, before giving up
        for (let tries = 0; paneCount(target) < desiredPanes; tries++) {
          if (tries >= 3) throw new Error('tmux never produced a second pane');
          try { tmux('split-window', '-h', '-t', target, '-c', dir, ...env); } catch { /* retry */ }
          for (let i = 0; i < 10 && paneCount(target) < desiredPanes; i++) await sleep(150);
        }
        // bare name: psmux's kill commands reject the '=' prefix
        while (paneCount(target) > desiredPanes) tmux('kill-pane', '-t', `${target}.{last}`);

        paneIds = tmux('list-panes', '-t', target, '-F', '#{pane_index}\t#{pane_id}').trim()
          .split(/\r?\n/).map((row) => row.split('\t')).sort((a, b) => Number(a[0]) - Number(b[0])).map((row) => row[1]);
        if (paneIds.length !== desiredPanes || paneIds.some((pane) => !pane)) throw new Error('tmux pane discovery failed');
      };
      if (existed) await withTmuxEnvironment(tmux, TMUX_SESSION, variables, spawnPanes, psmux);
      else await spawnPanes();
    } finally { releaseLaunchLock(); }

    const [nvimPane, harnessPane] = paneIds;
    tmux('send-keys', '-t', nvimPane, '-l', 'nvim');
    tmux('send-keys', '-t', nvimPane, 'Enter');
    if (harnessPane) {
      const shell = tmux('display-message', '-p', '-t', harnessPane, '#{pane_current_command}').trim();
      tmux('send-keys', '-t', harnessPane, '-l', harnessLine(harness, shell, undefined, launchArgs));
      tmux('send-keys', '-t', harnessPane, 'Enter');
    }
    if (activate) {
      tmux('select-window', '-t', target);
      tmux('select-pane', '-t', nvimPane);
    }
    const pane = (targetPane) => {
      const [session, windowId, windowName, paneId, paneIndex] = tmux(
        'display-message', '-p', '-t', targetPane,
        '#{session_name}\t#{window_id}\t#{window_name}\t#{pane_id}\t#{pane_index}',
      ).trim().split('\t');
      return { session, window_id: windowId, window_name: windowName, pane_id: paneId, pane_index: Number(paneIndex) };
    };
    return {
      harness: harness.name,
      tmux: {
        socket: TMUX_SOCKET,
        ...(harnessPane ? { harness: pane(harnessPane) } : {}),
        nvim: pane(nvimPane),
      },
    };
  } catch (error) {
    if (!existed && !hostTarget) hostTarget = ownedHostTarget(tmux, TMUX_SESSION, id);
    if (!existed && !createdHost && !hostTarget) {
      for (let i = 0; i < 20 && hasSession(TMUX_SESSION); i++) {
        if (hasHost()) return create({ dir, harness, name, id, port, token, activate, watchOnly, watch, launchArgs });
        await sleep(50);
      }
      hostTarget = ownedHostTarget(tmux, TMUX_SESSION, id);
    }
    try {
      if (windowTarget || target) tmux('kill-window', '-t', windowTarget || target);
      else if (hostTarget) cleanupOwnedHost(tmux, hostTarget, id);
    } catch { /* preserve the launch error */ }
    throw error;
  }
}

export function legacyBenchLayout(session, run) {
  const panes = [session.tmux?.nvim, session.tmux?.harness].filter(Boolean);
  if (!panes.length || panes.some((pane) => !pane.pane_id || !pane.window_id
      || !pane.window_name || !pane.session || !Number.isInteger(pane.pane_index))) return false;
  const first = panes[0];
  if (panes.some((pane) => pane.window_id !== first.window_id || pane.session !== first.session
      || pane.window_name !== first.window_name)) return false;
  try {
    const options = run('show-options', '-t', `=${first.session}`);
    if (!options.split(/\r?\n/).some((line) => /^@vibench\s+"?1"?$/.test(line.trim()))) return false;
    const identity = run('display-message', '-p', '-t', first.window_id,
      '#{session_name}\t#{window_id}\t#{window_name}').trim().split('\t');
    if (identity[0] !== first.session || identity[1] !== first.window_id || identity[2] !== first.window_name) return false;
    const actual = run('list-panes', '-t', first.window_id, '-F', '#{pane_id}\t#{pane_index}').trim()
      .split(/\r?\n/).filter(Boolean).sort();
    const expected = panes.map((pane) => `${pane.pane_id}\t${pane.pane_index}`).sort();
    return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
  } catch { return false; }
}

export function ownedBenchPane(session, run) {
  const pane = session.tmux?.nvim ?? session.tmux?.harness;
  if (!session.id || !pane?.pane_id || !pane.window_id || !pane.session) return null;
  try {
    const environment = run('show-environment', '-t', `=${pane.session}`);
    const tagged = new RegExp(`^${windowOwnerKey(pane.window_id)}=(.+)$`, 'm').exec(environment)?.[1]?.trim();
    const owned = tagged ? tagged === session.id : legacyBenchLayout(session, run);
    const actual = run('display-message', '-p', '-t', pane.pane_id,
      '#{session_name}\t#{window_id}\t#{pane_id}').trim().split('\t');
    return owned && actual[0] === pane.session && actual[1] === pane.window_id
      && actual[2] === pane.pane_id ? pane : null;
  } catch { return null; }
}

function focusBench(session, activate) {
  const socket = session.tmux?.socket || TMUX_SOCKET;
  const run = (...args) => execFileSync('tmux', ['-L', socket, ...args], {
    encoding: 'utf8', windowsHide: true,
  });
  const pane = ownedBenchPane(session, run);
  if (!pane) throw new Error(`bench ${session.name} has no live owned tmux window`);
  if (activate) {
    run('select-window', '-t', pane.window_id);
    run('select-pane', '-t', pane.pane_id);
  }
  return { socket, session: pane.session };
}

export function cleanupCreatedWindow(run, launch, id) {
  const pane = ownedBenchPane({ id, tmux: launch?.tmux }, run);
  if (!pane) return false;
  run('kill-window', '-t', pane.window_id);
  return true;
}

function attach(target = { socket: TMUX_SOCKET, session: TMUX_SESSION }) {
  const ownClient = process.env.TMUX && process.env.VIBENCH_TMUX_SOCKET === target.socket;
  const args = ownClient
    ? ['switch-client', '-t', `=${target.session}`]
    : ['attach-session', '-t', `=${target.session}`];
  const env = { ...process.env };
  if (!ownClient) delete env.TMUX;
  const r = spawnSync('tmux', ['-L', target.socket, ...args], { stdio: 'inherit', windowsHide: true, env });
  process.exitCode = r.status ?? 0;
}

export function benchDescription(session) {
  return [session.name, session.pwd, session.harness ? `harness ${session.harness}` : '',
    session.harness_session_id ? `session ${session.harness_session_id}` : ''].filter(Boolean).join('  ');
}

async function ls() {
  const server = await ensureServer();
  const { sessions: registry } = await registryFor(server);
  const rows = Object.values(registry);
  if (!rows.length) { console.log('no sessions'); return; }
  const live = (session) => {
    const socket = session.tmux?.socket || TMUX_SOCKET;
    const run = (...args) => execFileSync('tmux', ['-L', socket, ...args], {
      encoding: 'utf8', windowsHide: true,
    });
    return !!ownedBenchPane(session, run);
  };
  for (const s of rows) {
    console.log([benchDescription(s), live(s) ? '' : '(not running)'].filter(Boolean).join('  '));
  }
}

async function registryFor(server) {
  const headers = authorized(server.token);
  const [response, catalogResponse] = await Promise.all([
    fetch(`http://127.0.0.1:${server.port}/sessions`, { headers }),
    fetch(`http://127.0.0.1:${server.port}/agents`, { headers }),
  ]);
  if (!response.ok) throw new Error(`server refused registry: ${(await response.text()).slice(0, 200)}`);
  if (!catalogResponse.ok) {
    throw new Error(`server refused agent catalog: ${(await catalogResponse.text()).slice(0, 200)}`);
  }
  const registry = await response.json();
  let catalog = await catalogResponse.json();
  if (needsSessionConfirmation(catalog)) {
    await sleep(SOURCE_MISS_MS + 10);
    const retry = await fetch(`http://127.0.0.1:${server.port}/agents`, { headers });
    if (!retry.ok) throw new Error(`server refused agent catalog: ${(await retry.text()).slice(0, 200)}`);
    catalog = await retry.json();
  }
  return currentSessionRegistry(registry, catalog);
}

async function waitForClaimedBench(server, claimed, activate) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const response = await fetch(`http://127.0.0.1:${server.port}/sessions/${claimed.id}`, {
      headers: authorized(server.token),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`server refused claimed bench: ${(await response.text()).slice(0, 200)}`);
    const session = await response.json();
    try { return { session, target: focusBench(session, activate) }; }
    catch { await sleep(100); }
  }
  throw new Error(`bench ${claimed.name} is still starting`);
}

async function resetNvim(args) {
  const flavor = args.clone ? 'clone' : args.lazy ? 'lazy' : 'stock';
  deployNvim(true, flavor);
  if (flavor !== 'stock') {
    try {
      // restore, not sync: install at the lazy-lock.json commits the clone
      // brought along, instead of yanking every plugin to latest
      execFileSync('nvim', ['--headless', '+Lazy! restore', '+qa'], {
        stdio: 'inherit', windowsHide: true, timeout: 120_000,
        env: { ...process.env, NVIM_APPNAME: 'vibench' },
      });
    } catch { console.log('plugin pre-install skipped; profile is ready'); }
  }
  console.log(`nvim profile reset (${flavor})`);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { console.log(USAGE); return; }
  if (args.command === 'ls') { await ls(); return; }
  if (args.command === 'kill-server') {
    const server = await serverInfo();
    if (!server) { console.log('server not running'); return; }
    await fetch(`http://127.0.0.1:${server.port}/kill`, {
      method: 'POST', headers: authorized(server.token),
    });
    console.log('server stopped');
    return;
  }
  if (args.command === 'reset-nvim') { await resetNvim(args); return; }

  const picked = launchOptions(loadConfig(), args);
  let launchArgs = [];
  let provider;
  if (picked.harnessSessionId) {
    provider = await providerFor(picked.harness.name);
    if (!provider) throw new Error(`model harness "${picked.harness.name}" has no session provider`);
    if (typeof provider.validateSessionId === 'function') provider.validateSessionId(picked.harnessSessionId);
    if (picked.watchOnly && typeof provider.locate !== 'function') {
      throw new Error(`model harness "${picked.harness.name}" cannot watch a session directly`);
    }
    if (!picked.watchOnly) {
      if (typeof provider.resumeArgs !== 'function') {
        throw new Error(`model harness "${picked.harness.name}" cannot resume a session`);
      }
      launchArgs = provider.resumeArgs(picked.harnessSessionId);
    }
  }
  if (!picked.watchOnly && picked.harness.name === 'claude' && !hasProcessIdentitySupport()) {
    throw new Error('Claude session tracking requires Linux /proc or a procps-compatible ps');
  }
  if (!picked.watchOnly && picked.harness.name !== 'claude') {
    console.error(`warning: harness "${picked.harness.name}" launches without Vibench MCP tools`);
  }
  try { execFileSync('tmux', tmuxArgs(['-V']), { stdio: 'pipe', windowsHide: true }); }
  catch { throw new Error('vibench needs tmux on PATH (on Windows: winget install marlocarlo.psmux)'); }

  deployNvim(false, 'stock');
  writeMcpConfig();
  const server = await ensureServer();
  const resolved = await registryFor(server);
  const registry = resolved.sessions;
  const staleIds = new Set(resolved.ignoredIds);
  const existing = existingBench(registry, picked.harness.name, picked.harnessSessionId,
    picked.watchOnly, picked.dir, (session) => {
      try { focusBench(session, false); return true; }
      catch {
        if (!activeReservation(session)) staleIds.add(session.id);
        return false;
      }
    });
  if (existing) {
    const target = focusBench(existing, args.attach);
    console.log(`bench ${benchDescription(existing)}`);
    if (args.attach) attach(target);
    return;
  }

  if (picked.watchOnly) {
    await preflightWatchSession(provider, {
      harness: picked.harness.name,
      harness_session_id: picked.harnessSessionId,
      pwd: picked.dir,
    });
  }

  const names = reservedBenchNames(registry, windowNames(TMUX_SESSION));
  picked.name = sessionName(picked.baseName, (name) => names.has(name));
  let allocated;
  for (let attempt = 0; attempt < 3; attempt++) {
    const reservation = await allocateSession(server, {
      name: picked.name,
      pwd: picked.dir,
      harness: picked.harness.name,
      harness_session_id: picked.harnessSessionId,
      watch_only: picked.watchOnly,
      ignore_ids: [...staleIds],
    });
    if (reservation.created) { allocated = reservation.session; break; }
    const claimed = await waitForClaimedBench(server, reservation.session, args.attach);
    if (claimed) {
      console.log(`bench ${benchDescription(claimed.session)}`);
      if (args.attach) attach(claimed.target);
      return;
    }
  }
  if (!allocated) throw new Error('bench reservation repeatedly disappeared');
  picked.name = allocated.name;
  const id = allocated.id;
  let launch;
  try {
    launch = await create({ ...picked, id, ...server, activate: args.attach, launchArgs });
    await allocateSession(server, {
      id,
      ...launch,
      harness_session_id: picked.harnessSessionId,
      watch_only: picked.watchOnly,
      launching: false,
    });
  } catch (error) {
    if (launch) {
      try { cleanupCreatedWindow(tmux, launch, id); }
      catch { /* preserve the launch error */ }
    }
    try {
      await fetch(`http://127.0.0.1:${server.port}/sessions/${id}`, {
        method: 'DELETE', headers: authorized(server.token),
      });
    } catch { /* server failed too */ }
    throw new Error(String(error?.message ?? error).replaceAll(id, '[internal registry id]'));
  }
  console.log(`bench ${benchDescription({
    name: picked.name,
    pwd: picked.dir,
    harness: picked.harness.name,
    harness_session_id: picked.harnessSessionId,
  })}`);
  if (args.attach) attach();
}

const normalize = (file) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
if (process.argv[1] && normalize(process.argv[1]) === normalize(fileURLToPath(import.meta.url))) {
  try { await main(); }
  catch (error) { console.error(`${error.message}\n${USAGE}`); process.exitCode = 1; }
}
