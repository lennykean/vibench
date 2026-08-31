import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  activeReservation, benchDescription, cleanupCreatedWindow, currentSessionRegistry, existingBench, launchOptions,
  legacyBenchLayout,
  hasProcessIdentitySupport, needsSessionConfirmation, ownedBenchPane, parseArgs, preflightWatchSession,
  reservedBenchNames, sessionName, tmuxEnvironmentArgument, withTmuxEnvironment,
} from './cli.js';
import { cleanupOwnedHost, ownedHostTarget, windowWatchKey } from './tmux-host.js';

test('flags-only launch parsing rejects ambiguous and incomplete flags', () => {
  assert.deepEqual(parseArgs([]), { attach: true });
  assert.deepEqual(parseArgs([
    '-w', '.', '-m', 'claude', '--name', 'demo', '-s', 'session-1', '--watch-only', '--no-watch', '--no-attach',
  ]), {
    attach: false, workspace: '.', modelHarness: 'claude', name: 'demo', session: 'session-1',
    watchOnly: true, watch: false,
  });
  assert.throws(() => parseArgs(['--watch']), /unknown argument/);
  assert.throws(() => parseArgs(['--watch-only']), /requires --session/);
  assert.throws(() => parseArgs(['--workspace', '--name', 'x']), /requires a value/);
  assert.throws(() => parseArgs(['--dir', '.']), /unknown argument/);
});

test('process identity support uses Linux proc before procps', () => {
  const stat = `${process.pid} (node worker) S 1 ${Array(17).fill('0').join(' ')} 456 0\n`;
  assert.equal(hasProcessIdentitySupport('linux', () => stat, () => {
    throw new Error('ps should not run');
  }), true);
  assert.equal(hasProcessIdentitySupport('linux', () => 'bad', () => `${process.pid} 1 Fri Aug 28 12:00:00 2026\n`), true);
  assert.equal(hasProcessIdentitySupport('linux', () => 'bad', () => `${process.pid}\n`), false);
  assert.equal(hasProcessIdentitySupport('linux', () => 'bad', () => { throw new Error('missing'); }), false);
  assert.equal(hasProcessIdentitySupport('win32', () => { throw new Error('unused'); }), true);
});

test('psmux environment transport preserves spaces, slashes, and quotes', () => {
  const value = 'C:\\Users\\With Space\\a"b\\server.json';
  assert.equal(tmuxEnvironmentArgument(value), value);
  assert.equal(JSON.parse(tmuxEnvironmentArgument(value, true)), value);
});

test('pane creation temporarily swaps and restores its complete tmux environment', async () => {
  const environment = new Map([
    ['VIBENCH_SESSION', 'host'], ['VIBENCH_SERVER_JSON', 'C:\\Users\\With Space\\server.json'],
  ]);
  const pending = [];
  let reads = 0;
  const run = (command, ...args) => {
    if (command === 'show-environment') {
      reads++;
      if (reads % 2 === 0) pending.splice(0).forEach((change) => change());
      return [...environment].map(([key, value]) => `${key}=${value}`).join('\n');
    }
    const key = args.at(-2);
    if (args.includes('-u')) pending.push(() => environment.delete(args.at(-1)));
    else pending.push(() => environment.set(key, JSON.parse(args.at(-1))));
    return '';
  };
  await withTmuxEnvironment(run, 'vibench', {
    VIBENCH_SESSION: 'bench_1',
    VIBENCH_SERVER_JSON: 'C:\\Users\\Different Place\\server.json',
    NVIM_APPNAME: 'vibench',
  }, () => {
    assert.equal(environment.get('VIBENCH_SESSION'), 'bench_1');
    assert.equal(environment.get('VIBENCH_SERVER_JSON'), 'C:\\Users\\Different Place\\server.json');
    assert.equal(environment.get('NVIM_APPNAME'), 'vibench');
  }, true);
  assert.equal(environment.get('VIBENCH_SESSION'), 'host');
  assert.equal(environment.has('NVIM_APPNAME'), false);
  assert.equal(environment.get('VIBENCH_SERVER_JSON'), 'C:\\Users\\With Space\\server.json');
  assert.ok(reads >= 4, 'waited for both asynchronous environment changes');
});

test('bench names preserve spaces, dots, and colons until an exact collision', (t) => {
  const config = { harnesses: [{ name: 'first', cmd: 'first' }] };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibench workspace.v2-'));
  t.after(() => fs.rmdirSync(dir));

  const defaultName = path.basename(dir);
  assert.equal(launchOptions(config, parseArgs([]), dir).baseName, defaultName);
  assert.equal(sessionName(defaultName, () => false), defaultName);

  const exactName = 'review bench.v2:api';
  assert.equal(launchOptions(config, parseArgs(['--name', exactName]), dir).baseName, exactName);
  assert.equal(sessionName(exactName, () => false), exactName);
  const used = new Set([exactName, `${exactName}-2`]);
  assert.equal(sessionName(exactName, (name) => used.has(name)), `${exactName}-3`);
  assert.throws(() => launchOptions(config, parseArgs(['--name', ' \t ']), dir), /name cannot be empty/);
});

test('launch defaults, suffixes, and durable bench matching stay unambiguous', () => {
  const cwd = process.cwd();
  const config = { harnesses: [
    { name: 'first', cmd: 'first' },
    { name: 'second', cmd: 'second' },
  ] };
  const defaults = launchOptions(config, parseArgs([]), cwd);
  assert.equal(defaults.dir, path.resolve(cwd));
  assert.equal(defaults.harness.name, 'first');
  assert.equal(defaults.baseName, path.basename(cwd));
  assert.equal(defaults.watchOnly, false);
  assert.equal(defaults.watch, true);
  assert.equal(launchOptions(config, parseArgs(['--no-watch']), cwd).watch, false);
  assert.equal(windowWatchKey('@4'), 'VIBENCH_WATCH__4');
  assert.throws(() => launchOptions(config, parseArgs(['-m', 'missing']), cwd), /unknown model harness/);

  const used = new Set(['demo', 'demo-2']);
  assert.equal(sessionName('demo', (name) => used.has(name)), 'demo-3');
  const registry = {
    internal1: {
      id: 'internal1', name: 'demo', pwd: cwd, harness: 'first',
      harness_session_id: 'provider-session',
    },
    internal2: {
      id: 'internal2', name: 'viewer', pwd: cwd, harness: 'first',
      harness_session_id: 'provider-session', watch_only: true,
    },
  };
  assert.equal(existingBench(registry, 'first', 'provider-session', false, cwd).name, 'demo');
  assert.equal(existingBench(registry, 'first', 'provider-session', true, cwd).name, 'viewer');
  assert.equal(existingBench(registry, 'first', 'provider-session', false, path.dirname(cwd)), null);
  assert.doesNotMatch(benchDescription(registry.internal1), /internal1/);

  registry.internal3 = { ...registry.internal1, id: 'internal3', name: 'demo-2' };
  assert.throws(() => existingBench(registry, 'first', 'provider-session', false, cwd), /multiple benches/);
  assert.equal(existingBench(registry, 'first', 'provider-session', false, cwd,
    (session) => session.id === 'internal3').id, 'internal3');
  const now = Date.now();
  assert.equal(activeReservation({ launching: true, launch_started_at: new Date(now - 1000).toISOString() }, now), true);
  assert.equal(activeReservation({ launching: true, launch_started_at: new Date(now - 31_000).toISOString() }, now), false);
  const reserved = reservedBenchNames({
    expired: { name: 'expired', launching: true, launch_started_at: new Date(now - 31_000).toISOString() },
    active: { name: 'active', launching: true, launch_started_at: new Date(now - 1000).toISOString() },
    ready: { name: 'ready', launching: false },
  }, ['tmux-window'], now);
  assert.deepEqual([...reserved], ['active', 'ready', 'tmux-window']);
  assert.equal(sessionName('expired', (name) => reserved.has(name)), 'expired');

  const { sessions: current, ignoredIds } = currentSessionRegistry(registry, { roots: [
    { id: 'internal1', source_session_id: 'current-session' },
    { id: 'internal2', source_session_id: null, source_established: true, source_missing_confirmed: true },
  ] });
  assert.equal(current.internal1.harness_session_id, 'current-session');
  assert.equal(current.internal2.harness_session_id, null);
  assert.equal(existingBench(current, 'first', 'current-session', false, cwd).id, 'internal1');
  assert.equal(existingBench(current, 'first', 'provider-session', true, cwd), null);
  assert.match(benchDescription(current.internal1), /session current-session/);
  assert.deepEqual(ignoredIds.sort(), ['internal1', 'internal2']);
  const errored = currentSessionRegistry(registry, { roots: [
    { id: 'internal1', source_session_id: null, error: 'discovery failed' },
  ] });
  assert.equal(errored.sessions.internal1.harness_session_id, 'provider-session');
  assert.deepEqual(errored.ignoredIds, []);
  const unresolved = currentSessionRegistry({ internal1: registry.internal1 }, { roots: [
    { id: 'internal1', source_session_id: null, source_established: true, source_missing_confirmed: false },
  ] });
  assert.equal(unresolved.sessions.internal1.harness_session_id, 'provider-session');
  assert.deepEqual(unresolved.ignoredIds, []);
  assert.equal(needsSessionConfirmation({ roots: [
    { source_established: true, source_session_id: null, source_missing_confirmed: false },
  ] }), true);
  assert.equal(needsSessionConfirmation({ roots: [
    { source_established: true, source_session_id: null, source_missing_confirmed: true },
  ] }), false);
  const launching = currentSessionRegistry({
    launch: {
      id: 'launch', name: 'launching', pwd: cwd, harness: 'first', harness_session_id: 'provider-session',
      launching: true, launch_started_at: new Date(now - 1000).toISOString(),
    },
  }, { roots: [{ id: 'launch', source_session_id: null }] }, now);
  assert.equal(launching.sessions.launch.harness_session_id, 'provider-session');
  assert.deepEqual(launching.ignoredIds, []);
});

test('tmux ownership rejects reused panes and cleanup kills only the created window', () => {
  const session = {
    id: 'internal1',
    tmux: {
      nvim: {
        session: 'vibench', window_id: '@4', window_name: 'demo', pane_id: '%7', pane_index: 0,
      },
      harness: {
        session: 'vibench', window_id: '@4', window_name: 'demo', pane_id: '%8', pane_index: 1,
      },
    },
  };
  const calls = [];
  const tagged = (...args) => {
    calls.push(args);
    if (args[0] === 'show-environment') return 'VIBENCH_WINDOW__4=internal1\n';
    if (args[0] === 'display-message') return 'vibench\t@4\t%7\n';
    return '';
  };
  assert.equal(ownedBenchPane(session, tagged).window_id, '@4');
  assert.deepEqual(calls[0].slice(0, 4), ['show-environment', '-t', '=vibench']);
  assert.equal(cleanupCreatedWindow(tagged, session, 'internal1'), true);
  assert.deepEqual(calls.at(-1), ['kill-window', '-t', '@4']);

  const legacyLayout = (...args) => {
    if (args[0] === 'show-environment') return '';
    if (args[0] === 'show-options') return '@vibench 1\n';
    if (args[0] === 'list-panes') return '%7\t0\n%8\t1\n';
    if (args[0] === 'display-message' && args[3] === '@4') return 'vibench\t@4\tdemo\n';
    if (args[0] === 'display-message' && args[3] === '%7') return 'vibench\t@4\t%7\n';
    return '';
  };
  assert.equal(legacyBenchLayout(session, legacyLayout), true);
  assert.equal(ownedBenchPane(session, legacyLayout).pane_id, '%7');
  assert.equal(legacyBenchLayout({
    ...session,
    tmux: { ...session.tmux, harness: { ...session.tmux.harness, pane_index: 0 } },
  }, legacyLayout), false);
  assert.equal(legacyBenchLayout(session, (...args) => {
    if (args[0] === 'show-options') return '@vibench 1\n';
    if (args[0] === 'display-message') return 'vibench\t@99\tdemo\n';
    return '';
  }), false);
  let killed = false;
  const reused = (...args) => {
    if (args[0] === 'show-environment') return 'VIBENCH_WINDOW__4=somebody-else\n';
    if (args[0] === 'kill-window') killed = true;
    return '%7\n';
  };
  assert.equal(ownedBenchPane(session, reused), null);
  assert.equal(cleanupCreatedWindow(reused, session, 'internal1'), false);
  assert.equal(killed, false);

  const moved = (...args) => {
    if (args[0] === 'show-environment') return 'VIBENCH_WINDOW__4=internal1\n';
    if (args[0] === 'display-message') return 'vibench\t@5\t%7\n';
    if (args[0] === 'kill-window') killed = true;
    return '';
  };
  assert.equal(cleanupCreatedWindow(moved, session, 'internal1'), false);
  assert.equal(killed, false);
});

test('watch-only preflight requires a provider-resolved transcript', async () => {
  const session = { harness: 'claude', harness_session_id: 'session-1', pwd: process.cwd() };
  const found = await preflightWatchSession({ locate: async () => ({ file: 'session-1.jsonl' }) }, session);
  assert.equal(found.file, 'session-1.jsonl');
  await assert.rejects(preflightWatchSession({ locate: async () => ({ reason: 'no matching session' }) }, session),
    /no matching session/);
});

test('partial host cleanup kills only the matching stable session id', () => {
  const calls = [];
  const matching = (...args) => {
    calls.push(args);
    if (args[0] === 'display-message') return '$7\n';
    if (args[0] === 'show-environment') return 'VIBENCH_SESSION=ours\n';
    return '';
  };
  const target = ownedHostTarget(matching, 'vibench', 'ours');
  assert.equal(target, '$7');
  assert.equal(cleanupOwnedHost(matching, target, 'ours'), true);
  assert.deepEqual(calls.at(-1), ['kill-session', '-t', '$7']);

  let killed = false;
  const different = (...args) => {
    if (args[0] === 'display-message') return '$8\n';
    if (args[0] === 'show-environment') return 'VIBENCH_SESSION=theirs\n';
    if (args[0] === 'kill-session') killed = true;
    return '';
  };
  assert.equal(cleanupOwnedHost(different, ownedHostTarget(different, 'vibench', 'ours'), 'ours'), false);
  assert.equal(killed, false);

  const concurrent = (...args) => {
    if (args[0] === 'display-message') return '$9\n';
    if (args[0] === 'show-environment') return 'VIBENCH_SESSION=ours\n';
    if (args[0] === 'list-windows') return '@1\n@2\n';
    if (args[0] === 'kill-session') killed = true;
    return '';
  };
  assert.equal(cleanupOwnedHost(concurrent, ownedHostTarget(concurrent, 'vibench', 'ours'), 'ours'), false);
  assert.equal(killed, false);
});
