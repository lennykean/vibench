import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { cleanup, testEnv, tmux } from './isolation.js';

test.after(cleanup);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isolated = (tag) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `vibench-${tag}-`));
  const registry = path.join(root, 'registry');
  return { root, registry, env: { ...testEnv, VIBENCH_DIR: registry } };
};
const serverAt = (registry) => JSON.parse(fs.readFileSync(path.join(registry, 'server.json'), 'utf8'));
const serverHeaders = (server) => ({ authorization: `Bearer ${server.token}` });
const stopServer = (env) => spawnSync(process.execPath, ['cli.js', 'kill-server'], { encoding: 'utf8', windowsHide: true, timeout: 5000, env });
const windowExists = (session, index) => tmux('list-windows', '-t', session, '-F', '#{window_index}').trim().split(/\r?\n/).includes(String(index));

test('vibench creates a 2-pane window in the reusable host with the id in both panes', async () => {
  const isolatedState = isolated('session');
  const cfg = path.join(os.tmpdir(), `vibench-test-cfg-${process.pid}.json`);
  const harnessScript = path.join(os.tmpdir(), `vibench-test-harness-${process.pid}.js`);
  fs.writeFileSync(harnessScript, 'console.log("SID:" + process.env.VIBENCH_SESSION + ":END CC:" + process.argv.slice(2).join(":")); setInterval(() => {}, 1000);');
  fs.writeFileSync(cfg, JSON.stringify({
    harnesses: [{
      name: 'claude', cmd: 'node', args: [harnessScript.replaceAll('\\', '/')],
    }],
  }));
  const name = `vibtest-${process.pid}`;
  const host = testEnv.VIBENCH_TMUX_SESSION;
  const r = spawnSync(process.execPath, ['cli.js', '--workspace', process.cwd(), '--model-harness', 'claude', '--name', name, '--no-attach'], {
    encoding: 'utf8', windowsHide: true, timeout: 15000, env: { ...isolatedState.env, VIBENCH_CONFIG: cfg },
  });
  try {
    assert.equal(r.status, 0, r.stderr);
    const server = serverAt(isolatedState.registry);
    const registry = await (await fetch(`http://127.0.0.1:${server.port}/sessions`, {
      headers: serverHeaders(server),
    })).json();
    const id = Object.values(registry).find((session) => session.name === name)?.id;
    assert.ok(id, `bench registered (stdout: ${r.stdout})`);
    assert.doesNotMatch(r.stdout, new RegExp(id), 'internal registry id is not printed');

    const panes = tmux('list-panes', '-t', `${host}:${name}`, '-F', '#{pane_index}').trim().split(/\r?\n/);
    assert.equal(panes.length, 2);

    // harness pane: the typed launch line runs with VIBENCH_SESSION set
    let right = '';
    for (let i = 0; i < 40 && !right.includes(`SID:${id}:END`); i++) {
      await sleep(500);
      right = tmux('capture-pane', '-p', '-t', `${host}:${name}.1`);
    }
    assert.ok(right.includes(`SID:${id}:END`), `harness pane sees the id (saw: ${right.slice(-300)})`);

    // nvim pane: nvim is running (command name or its UI on screen)
    let ok = false;
    let left = '';
    for (let i = 0; i < 40 && !ok; i++) {
      await sleep(500);
      let cmd = '';
      try { cmd = tmux('display-message', '-p', '-t', `${host}:${name}.0`, '#{pane_current_command}').trim(); } catch { /* retry */ }
      left = tmux('capture-pane', '-p', '-t', `${host}:${name}.0`);
      ok = /nvim/i.test(cmd) || /NVIM|Neovim|Lazy/.test(left);
    }
    assert.ok(ok, `nvim pane shows nvim (saw: ${left.slice(-300)})`);

    // the server registry resolves the id to name and pwd
    const reg = await (await fetch(`http://127.0.0.1:${server.port}/sessions/${id}`, {
      headers: serverHeaders(server),
    })).json();
    assert.equal(reg.name, name);
    assert.equal(reg.pwd, process.cwd());
    assert.equal(reg.harness, 'claude');
    assert.equal(reg.tmux.harness.session, host);
    assert.equal(reg.tmux.harness.window_name, name);
    assert.equal(reg.tmux.harness.pane_index, 1);
    assert.equal(reg.tmux.nvim.pane_index, 0);
    assert.match(reg.tmux.harness.window_id, /^@/);
    assert.match(reg.tmux.harness.pane_id, /^%/);
    assert.equal(reg.claude_session_id, undefined);
    assert.doesNotMatch(right, /--session-id/, `Claude launch is not pinned (saw: ${right.slice(-300)})`);
    await fetch(`http://127.0.0.1:${server.port}/sessions/${id}`, {
      method: 'DELETE', headers: serverHeaders(server),
    });

    // the isolated nvim profile is deployed
    assert.ok(fs.existsSync(path.join(isolatedState.registry, 'nvim', 'init.lua')), 'profile deployed');
  } finally {
    // psmux quirk: kill-session rejects the '=' exact-match prefix that every
    // other command accepts; use the bare name here
    try { tmux('kill-session', '-t', host); } catch { /* already gone */ }
    stopServer(isolatedState.env);
    fs.unlinkSync(cfg);
    fs.unlinkSync(harnessScript);
    fs.rmSync(isolatedState.root, { recursive: true, force: true });
  }
});

test('vibench gives a second window its own identity when invoked from another tmux session', async () => {
  const isolatedState = isolated('window');
  const tag = `vibwtest-${process.pid}-${Date.now()}`;
  const cfg = path.join(os.tmpdir(), `${tag}.json`);
  const parent = `${tag}-parent`;
  const host = testEnv.VIBENCH_TMUX_SESSION;
  const seed = `${tag}-seed`;
  const requested = `${tag}-bench`;
  let id;
  fs.writeFileSync(cfg, JSON.stringify({
    harnesses: [{
      name: 'fake', cmd: 'node',
      args: ['-e', 'console.log("SID:" + process.env.VIBENCH_SESSION + ":END NA:" + process.env.NVIM_APPNAME)'],
    }],
  }));
  tmux('new-session', '-d', '-s', parent, '-c', process.cwd(), '-e', `VIBENCH_CONFIG=${cfg}`, '-e', `VIBENCH_DIR=${isolatedState.registry}`);
  const cli = path.join(process.cwd(), 'cli.js');
  const q = (value) => `"${value.replace(/"/g, '\\"')}"`;
  const command = (name) => `${q(process.execPath)} ${q(cli)} --workspace ${q(process.cwd())} --model-harness fake --name ${name} --no-attach`;
  const launch = (name) => {
    tmux('send-keys', '-t', `${parent}:0.0`, '-l', command(name));
    tmux('send-keys', '-t', `${parent}:0.0`, 'Enter');
  };
  const findWindow = () => tmux('list-windows', '-t', host, '-F', '#{window_index}\t#{window_name}');
  try {
    launch(seed);
    let seeded = false;
    for (let i = 0; i < 40 && !seeded; i++) {
      await sleep(250);
      try { seeded = findWindow().split(/\r?\n/).some((line) => line.endsWith(`\t${seed}`)); }
      catch { /* host starting */ }
    }
    assert.ok(seeded, 'first vibench window created the shared host');

    launch(requested);

    let target;
    for (let i = 0; i < 40 && !target; i++) {
      await sleep(250);
      let windows = '';
      try { windows = findWindow(); } catch { /* host starting */ }
      target = windows.split(/\r?\n/).find((line) => line.endsWith(`\t${requested}`))?.split('\t')[0];
    }
    assert.ok(target, 'vibench window created in the current session');
    const panes = tmux('list-panes', '-t', `${host}:${target}`, '-F', '#{pane_index}').trim().split(/\r?\n/);
    assert.equal(panes.length, 2);

    let right = '';
    for (let i = 0; i < 40 && !/SID:[0-9a-f]{8}:END/.test(right); i++) {
      await sleep(250);
      assert.ok(windowExists(host, target), 'target window still exists before capture');
      right = tmux('capture-pane', '-p', '-t', `${host}:${target}.1`);
    }
    id = /SID:([0-9a-f]{8}):END/.exec(right)?.[1];
    assert.ok(id, `window harness pane sees the id (saw: ${right.slice(-300)})`);
    assert.match(right, /NA:vibench/, `harness pane sees NVIM_APPNAME (saw: ${right.slice(-300)})`);
    assert.doesNotMatch(right, /(?:export\s+|set(?:\s+-gx)?\s+["']?|\$env:)VIBENCH_SESSION/i,
      'harness launch does not print environment setup');
    const server = serverAt(isolatedState.registry);
    const reg = await (await fetch(`http://127.0.0.1:${server.port}/sessions/${id}`, {
      headers: serverHeaders(server),
    })).json();
    assert.equal(reg.harness, 'fake');
    assert.equal(reg.tmux.harness.session, host);
    assert.equal(reg.tmux.harness.window_name, requested);
    assert.equal(reg.tmux.harness.pane_index, 1);

    // Quit back to the shell and confirm both inherited vars survived.
    // pane_current_command is unreliable right after a Windows conpty exit
    // (a known vibench trap), so give nvim a beat to actually quit instead
    // of polling it.
    tmux('send-keys', '-t', `${host}:${target}.0`, 'Escape');
    await sleep(300);
    tmux('send-keys', '-t', `${host}:${target}.0`, '-l', ':q!');
    tmux('send-keys', '-t', `${host}:${target}.0`, 'Enter');
    await sleep(1500);
    tmux('send-keys', '-t', `${host}:${target}.0`, '-l', 'echo VS=$VIBENCH_SESSION NA=$NVIM_APPNAME');
    tmux('send-keys', '-t', `${host}:${target}.0`, 'Enter');
    tmux('send-keys', '-t', `${host}:${target}.1`, '-l', 'echo VS=$VIBENCH_SESSION NA=$NVIM_APPNAME && node -e "console.log(\'CHILD:\'+process.env.VIBENCH_SESSION+\':\'+process.env.NVIM_APPNAME)"');
    tmux('send-keys', '-t', `${host}:${target}.1`, 'Enter');
    let left = '';
    for (let i = 0; i < 20 && !/VS=[0-9a-f]{8}/.test(left); i++) {
      await sleep(250);
      assert.ok(windowExists(host, target), 'target window still exists before capture');
      left = tmux('capture-pane', '-p', '-t', `${host}:${target}.0`);
    }
    assert.match(left, new RegExp(`VS=${id} NA=vibench`), `nvim pane's shell kept both vars after quitting nvim (saw: ${left.slice(-300)})`);
    assert.doesNotMatch(left, /(?:export\s+|set(?:\s+-gx)?\s+["']?|\$env:)VIBENCH_SESSION/i,
      'nvim launch does not print environment setup');
    for (let i = 0; i < 20 && !right.includes(`CHILD:${id}:vibench`); i++) {
      await sleep(250);
      assert.ok(windowExists(host, target), 'target window still exists before capture');
      right = tmux('capture-pane', '-p', '-t', `${host}:${target}.1`);
    }
    assert.match(right, new RegExp(`VS=${id} NA=vibench`), `harness shell kept both vars after the tool exited (saw: ${right.slice(-300)})`);
    assert.match(right, new RegExp(`CHILD:${id}:vibench`), `child process inherited both vars (saw: ${right.slice(-300)})`);

    const listed = spawnSync(process.execPath, ['cli.js', 'ls'], { encoding: 'utf8', windowsHide: true, timeout: 5000, env: isolatedState.env });
    const row = listed.stdout.split(/\r?\n/).find((line) => line.includes(requested));
    assert.ok(row && !row.includes('(not running)'), `window-backed registry row is live (saw: ${row})`);
    assert.doesNotMatch(row, new RegExp(id), 'ls hides the internal registry id');

  } finally {
    if (id) {
      try {
        const server = serverAt(isolatedState.registry);
        await fetch(`http://127.0.0.1:${server.port}/sessions/${id}`, {
          method: 'DELETE', headers: serverHeaders(server), signal: AbortSignal.timeout(500),
        });
      } catch { /* server already gone */ }
    }
    try { tmux('kill-session', '-t', parent); } catch { /* already gone */ }
    try { tmux('kill-session', '-t', host); } catch { /* already gone */ }
    stopServer(isolatedState.env);
    try { fs.unlinkSync(cfg); } catch { /* already gone */ }
    fs.rmSync(isolatedState.root, { recursive: true, force: true });
  }
});

test('ls starts the registry without exposing internal ids', () => {
  const state = isolated('ls');
  try {
    const out = spawnSync(process.execPath, ['cli.js', 'ls'], { encoding: 'utf8', windowsHide: true, timeout: 5000, env: state.env });
    assert.equal(out.status, 0, out.stderr);
  } finally {
    stopServer(state.env);
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});

test('kill-server stops the resident server', async () => {
  const state = isolated('kill');
  try {
    const started = spawnSync(process.execPath, ['cli.js', 'ls'], { encoding: 'utf8', windowsHide: true, timeout: 5000, env: state.env });
    assert.equal(started.status, 0, started.stderr);
    const { port } = serverAt(state.registry);
    const out = spawnSync(process.execPath, ['cli.js', 'kill-server'], { encoding: 'utf8', windowsHide: true, timeout: 5000, env: state.env });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /server stopped/);
    await sleep(300);
    let alive = null;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/sessions`, { signal: AbortSignal.timeout(500) });
      alive = `${res.status} ${(await res.text()).slice(0, 200)}`;
    } catch { /* dead, as expected */ }
    assert.equal(alive, null, `port ${port} still answers: ${alive}`);
  } finally {
    stopServer(state.env);
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});
