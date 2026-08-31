import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { consume } from './providers/claude.js';
import { cleanup, testEnv, tmux } from './isolation.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibench-terminal-'));
test.after(() => { cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); });
const claudeSessions = path.join(tmp, 'claude-sessions');
const projects = path.join(tmp, 'projects');
const pwd = 'C:\\work\\vibench';
const project = path.join(projects, 'C--work-vibench');
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(claudeSessions, { recursive: true });
const serverTokens = new Map();
const serverHeaders = (port) => ({ authorization: `Bearer ${serverTokens.get(port)}` });

const line = (value) => `${JSON.stringify(value)}\n`;
const call = (id, name, command, timestamp, cwd = pwd) => ({
  type: 'assistant', timestamp, cwd,
  message: { content: [{ type: 'tool_use', id, name, input: command ? { command } : { file_path: 'x' } }] },
});
const result = (id, stdout, stderr = '', exitCode = 0) => ({
  type: 'user', timestamp: '2026-08-26T20:00:01.000Z',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: `fallback:${stdout}` }] },
  toolUseResult: { stdout, stderr, exitCode },
});
const processStart = (pid) => {
  if (process.platform === 'win32') return execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToFileTimeUtc()`,
  ], { encoding: 'utf8', windowsHide: true }).trim();
  return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim().replace(/\s+/g, ' ');
};

test('real Claude result shape without an exit code completes its command', () => {
  // Trimmed from a real ~/.claude/projects transcript; paths and ids are
  // synthetic, the record shape is verbatim.
  const records = [
    { isSidechain: false, type: 'assistant', timestamp: '2026-08-27T00:59:51.709Z', cwd: 'C:\\Users\\User\\git\\project', message: { content: [{ type: 'tool_use', id: 'toolu_01AAAAAAAAAAAAAAAAAAAAAA', name: 'Bash', input: { command: 'wc -l *.js providers/*.js' }, caller: { type: 'direct' } }] } },
    { isSidechain: false, type: 'user', message: { content: [{ tool_use_id: 'toolu_01AAAAAAAAAAAAAAAAAAAAAA', type: 'tool_result', content: '1032 total', is_error: false }] }, toolUseResult: { stdout: '1032 total', stderr: '', interrupted: false, isImage: false, noOutputExpected: false } },
  ];
  const state = { steps: [], calls: new Map(), done: new Set() };
  for (const record of records) consume(JSON.stringify(record), state);
  assert.equal(state.steps.length, 1);
  assert.deepEqual([...state.done], [0]);
  assert.equal(state.steps[0].output, '1032 total');
});

async function waitFor(file) {
  for (let i = 0; i < 100; i++) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  throw new Error(`timed out waiting for ${file}`);
}

async function harnessPane(t, tag) {
  const name = `vibtrans-${tag}-${process.pid}-${Date.now()}`;
  tmux('new-session', '-d', '-s', name, '-c', process.cwd());
  t.after(() => {
    try { tmux('kill-session', '-t', name); } catch { /* gone */ }
  });
  tmux('send-keys', '-t', `${name}:0.0`, '-l', 'node -e "console.log(\'HARNESS_PID:\'+process.pid); setInterval(() => {}, 1000)"');
  tmux('send-keys', '-t', `${name}:0.0`, 'Enter');
  const fields = tmux('display-message', '-p', '-t', `${name}:0.0`,
    '#{session_name}\t#{window_id}\t#{window_name}\t#{pane_id}\t#{pane_index}\t#{pane_pid}').trim().split('\t');
  const [tmuxSession, windowId, windowName, paneId, paneIndex, panePid] = fields;
  let pid;
  for (let i = 0; i < 50 && !pid; i++) {
    const capture = tmux('capture-pane', '-p', '-t', `${name}:0.0`);
    pid = Number(/HARNESS_PID:(\d+)/.exec(capture)?.[1]) || undefined;
    if (!pid) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(pid, 'harness child pid found');
  return { pid, tmux: { harness: { session: tmuxSession, window_id: windowId, window_name: windowName, pane_id: paneId, pane_index: Number(paneIndex) } } };
}

async function startServer(t, registry, sessions, watch = true) {
  fs.mkdirSync(registry, { recursive: true });
  fs.writeFileSync(path.join(registry, 'sessions.json'), JSON.stringify(sessions));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(), env: { ...testEnv, VIBENCH_DIR: registry, VIBENCH_CLAUDE_PROJECTS: projects, VIBENCH_CLAUDE_SESSIONS: claudeSessions,
      ...(watch ? {} : { VIBENCH_DISABLE_WATCH: '1' }) },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  t.after(() => child.kill());
  const info = await waitFor(path.join(registry, 'server.json'));
  serverTokens.set(info.port, info.token);
  return info.port;
}

test('terminal endpoint serves action snapshots, filters since, tails, and degrades for unsupported harnesses', async (t) => {
  const pane = await harnessPane(t, 'endpoint');
  const id = '11111111-1111-4111-8111-111111111111';
  const transcript = path.join(project, `${id}.jsonl`);
  const target = `${pane.tmux.harness.session}:${pane.tmux.harness.window_id}.${pane.tmux.harness.pane_id}`;
  fs.writeFileSync(path.join(claudeSessions, `${pane.pid}.json`), JSON.stringify({
    pid: pane.pid, sessionId: id, cwd: pwd, procStart: processStart(pane.pid), tmux: target,
  }));
  fs.writeFileSync(transcript,
    line(call('one', 'Bash', 'npm test', '2026-08-26T20:00:00.000Z')) + line(result('one', 'ok\n'))
    + line(call('two', 'PowerShell', 'Get-Date', '2026-08-26T20:00:03.000Z')) + line(result('two', 'out', 'err', 7)));
  const port = await startServer(t, path.join(tmp, 'registry-endpoint'), {
    abc12345: { id: 'abc12345', name: 'vibench', pwd, harness: 'claude', ...pane },
    empty123: { id: 'empty123', name: 'empty', pwd, harness: 'codex', ...pane },
  });
  const get = async (url) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, { headers: serverHeaders(port) });
    return { status: response.status, body: await response.json() };
  };
  const cold = await get('/sessions/abc12345/terminal');
  assert.deepEqual(cold.body.steps.map(({ command, output }) => ({ command, output })), [
    { command: 'npm test', output: 'ok\n' }, { command: 'Get-Date', output: 'outerr' },
  ], JSON.stringify(cold.body.source));
  assert.equal(cold.body.source.transcript, transcript);
  assert.equal(cold.body.source.via, 'pid-session');
  assert.equal(cold.body.source.session_id, id);
  assert.equal((await get('/sessions/abc12345/terminal?since=0')).body.steps.length, 2);
  assert.deepEqual(await get('/sessions/nope/terminal'), { status: 404, body: { error: 'unknown session' } });
  const unsupported = await get('/sessions/empty123/terminal');
  assert.deepEqual(unsupported.body.steps, []);
  assert.equal(unsupported.body.source.provider, 'codex');
  assert.match(unsupported.body.source.reason, /unsupported harness/);
  fs.appendFileSync(transcript, line(call('three', 'Bash', 'echo tail', '2026-08-26T20:00:04.000Z')) + line(result('three', 'tail\n')));
  assert.equal((await get('/sessions/abc12345/terminal')).body.steps.length, 3);
});

test('pid-session lookup handles first-turn delay and resets indices when the pane harness changes', async (t) => {
  const pane = await harnessPane(t, 'switch');
  const firstId = '22222222-2222-4222-8222-222222222222';
  const secondId = '33333333-3333-4333-8333-333333333333';
  const record = { pid: pane.pid, cwd: pwd, procStart: processStart(pane.pid) };
  fs.writeFileSync(path.join(claudeSessions, `${pane.pid}.json`), JSON.stringify({ ...record, sessionId: firstId }));
  const port = await startServer(t, path.join(tmp, 'registry-switch'), {
    pane1234: { id: 'pane1234', name: 'switch', pwd, harness: 'claude', ...pane },
  });
  const get = async (suffix = '') => (await fetch(`http://127.0.0.1:${port}/sessions/pane1234/terminal${suffix}`, {
    headers: serverHeaders(port),
  })).json();
  const transient = await get();
  assert.equal(transient.source.session_id, firstId);
  assert.equal(transient.source.transcript, null);
  fs.writeFileSync(path.join(project, `${firstId}.jsonl`), line(call('old', 'Bash', 'old', '2026-08-26T20:00:00.000Z')) + line(result('old', 'old\n')));
  assert.equal((await get()).steps[0].i, 0);
  fs.writeFileSync(path.join(project, `${secondId}.jsonl`), line(call('new', 'Bash', 'new', '2026-08-26T20:01:00.000Z')) + line(result('new', 'new\n')));
  fs.writeFileSync(path.join(claudeSessions, `${pane.pid}.json`), JSON.stringify({ ...record, sessionId: secondId }));
  const restarted = await get('?since=9');
  assert.equal(restarted.source.session_id, secondId);
  assert.deepEqual(restarted.steps.map(({ i, command }) => ({ i, command })), [{ i: 0, command: 'new' }]);
});

test('same pid with a changed session id resets with watching disabled', async (t) => {
  const pane = await harnessPane(t, 'same-pid');
  const firstId = '55555555-5555-4555-8555-555555555555';
  const secondId = '66666666-6666-4666-8666-666666666666';
  const pidFile = path.join(claudeSessions, `${pane.pid}.json`);
  const record = { pid: pane.pid, cwd: pwd, procStart: processStart(pane.pid) };
  fs.writeFileSync(pidFile, JSON.stringify({ ...record, sessionId: firstId }));
  fs.writeFileSync(path.join(project, `${firstId}.jsonl`), line(call('old2', 'Bash', 'old', '2026-08-26T20:00:00.000Z')) + line(result('old2', 'old\n')));
  fs.writeFileSync(path.join(project, `${secondId}.jsonl`), line(call('new2', 'Bash', 'new', '2026-08-26T20:01:00.000Z')) + line(result('new2', 'new\n')));
  const port = await startServer(t, path.join(tmp, 'registry-same-pid'), {
    samepid1: { id: 'samepid1', name: 'same-pid', pwd, harness: 'claude', ...pane },
  }, false);
  const get = async (suffix = '') => (await fetch(`http://127.0.0.1:${port}/sessions/samepid1/terminal${suffix}`, {
    headers: serverHeaders(port),
  })).json();
  assert.deepEqual((await get()).steps.map((step) => [step.i, step.command]), [[0, 'old']]);
  fs.writeFileSync(pidFile, JSON.stringify({ ...record, sessionId: secondId }));
  const changed = await get('?since=9');
  assert.equal(changed.source.session_id, secondId);
  assert.deepEqual(changed.steps.map((step) => [step.i, step.command]), [[0, 'new']]);
});

test('a command output is served on the next poll, not one command behind', async (t) => {
  const pane = await harnessPane(t, 'lag');
  const id = '44444444-4444-4444-8444-444444444444';
  const transcript = path.join(project, `${id}.jsonl`);
  fs.writeFileSync(path.join(claudeSessions, `${pane.pid}.json`), JSON.stringify({
    pid: pane.pid, sessionId: id, cwd: pwd, procStart: processStart(pane.pid),
  }));
  const port = await startServer(t, path.join(tmp, 'registry-lag'), {
    lag12345: { id: 'lag12345', name: 'lag', pwd, harness: 'claude', ...pane },
  });
  const get = async (suffix = '') => (await fetch(`http://127.0.0.1:${port}/sessions/lag12345/terminal${suffix}`, {
    headers: serverHeaders(port),
  })).json();
  fs.writeFileSync(transcript, line(call('c1', 'Bash', 'echo one', '2026-08-26T20:00:00.000Z')));
  const cursor = (await get()).steps.reduce((max, step) => Math.max(max, step.i), -1);
  fs.appendFileSync(transcript, line(result('c1', 'one\n')));
  const got = (await get(`?since=${cursor}`)).steps.find((step) => step.command === 'echo one');
  assert.ok(got);
  assert.equal(got.output, 'one\n');
  fs.appendFileSync(transcript, line(call('c2', 'Bash', 'echo two', '2026-08-26T20:01:00.000Z')) + line(result('c2', 'two\n')));
  assert.deepEqual((await get()).steps.map((step) => [step.i, step.command, step.output]), [[0, 'echo one', 'one\n'], [1, 'echo two', 'two\n']]);
});
