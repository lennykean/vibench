import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  databasePath, locate, parseReadOutput, parseUnifiedDiff, resumeArgs, sqliteSupported, sync,
  validateSessionId,
} from './opencode.js';
import { terminalFor } from '../transcript.js';

const available = sqliteSupported();
const SESSION_ID = 'ses_test0000abc';

function freshState() {
  return {
    steps: [], calls: new Map(), done: new Set(), events: [],
    children: new Map(), sidechains: new Map(), spawnEvents: new Map(),
  };
}

async function makeDb(file) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    create table session (id text primary key, directory text,
      time_created integer, time_updated integer);
    create table message (id text primary key, session_id text,
      time_created integer, time_updated integer, data text);
    create table part (id text primary key, message_id text, session_id text,
      time_created integer, time_updated integer, data text);
  `);
  db.prepare('insert into session values (?, ?, ?, ?)')
    .run(SESSION_ID, '/work/demo', 1000, 2000);
  const message = db.prepare('insert into message values (?, ?, ?, ?, ?)');
  const part = db.prepare('insert into part values (?, ?, ?, ?, ?, ?)');
  message.run('m1', SESSION_ID, 1000, 1000, JSON.stringify({ role: 'user', time: { created: 1000 } }));
  part.run('p1', 'm1', SESSION_ID, 1000, 1000,
    JSON.stringify({ type: 'text', text: 'please fix it' }));
  message.run('m2', SESSION_ID, 1100, 2000, JSON.stringify({ role: 'assistant' }));
  part.run('p2', 'm2', SESSION_ID, 1101, 1101,
    JSON.stringify({ type: 'reasoning', text: 'thinking hard' }));
  part.run('p3', 'm2', SESSION_ID, 1102, 1102, JSON.stringify({
    type: 'tool', tool: 'bash', callID: 'call-bash',
    state: {
      status: 'completed', input: { command: 'echo hi', description: 'greet' },
      output: 'hi\n', metadata: { output: 'hi\n', exit: 0, truncated: false },
    },
  }));
  part.run('p4', 'm2', SESSION_ID, 1103, 1103, JSON.stringify({
    type: 'tool', tool: 'read', callID: 'call-read',
    state: {
      status: 'completed', input: { filePath: '/work/demo/file.txt' },
      output: '<path>/work/demo/file.txt</path>\n<type>file</type>\n<content>\n1: alpha\n2: beta\n3: gamma\n</content>',
      metadata: { truncated: false },
    },
  }));
  part.run('p5', 'm2', SESSION_ID, 1104, 1104, JSON.stringify({
    type: 'tool', tool: 'edit', callID: 'call-edit',
    state: {
      status: 'completed',
      input: { filePath: '/work/demo/file.txt', oldString: 'beta', newString: 'delta' },
      output: 'Edit applied successfully.',
      metadata: {
        diff: [
          'Index: /work/demo/file.txt',
          '===================================================================',
          '--- /work/demo/file.txt',
          '+++ /work/demo/file.txt',
          '@@ -1,3 +1,3 @@',
          ' alpha',
          '-beta',
          '+delta',
          ' gamma',
          '',
        ].join('\n'),
      },
    },
  }));
  part.run('p6', 'm2', SESSION_ID, 1105, 1105, JSON.stringify({
    type: 'tool', tool: 'write', callID: 'call-write',
    state: {
      status: 'completed', input: { filePath: '/work/demo/new.txt', content: 'one\ntwo\n' },
      output: 'Wrote file successfully.', metadata: {},
    },
  }));
  part.run('p7', 'm2', SESSION_ID, 1106, 1106, JSON.stringify({
    type: 'tool', tool: 'glob', callID: 'call-glob',
    state: { status: 'completed', input: { pattern: '*.txt' }, output: 'file.txt', metadata: {} },
  }));
  part.run('p8', 'm2', SESSION_ID, 1107, 1107, JSON.stringify({
    type: 'tool', tool: 'bash', callID: 'call-running',
    state: { status: 'running', input: { command: 'sleep 5' } },
  }));
  part.run('p9', 'm2', SESSION_ID, 1108, 1108, JSON.stringify({
    type: 'tool', tool: 'edit', callID: 'call-broken',
    state: { status: 'error', input: { filePath: '/x' }, error: 'edit failed' },
  }));
  db.close();
}

test('session id validation and resume arguments', () => {
  assert.equal(validateSessionId(SESSION_ID), SESSION_ID);
  assert.deepEqual(resumeArgs(SESSION_ID), ['--session', SESSION_ID]);
  assert.throws(() => validateSessionId('nope'), /invalid OpenCode session id/);
  assert.throws(() => validateSessionId('ses_a'), /invalid OpenCode session id/);
});

test('database path prefers the override, then XDG data', () => {
  assert.equal(databasePath({ VIBENCH_OPENCODE_DB: '/tmp/x.db' }), '/tmp/x.db');
  assert.equal(databasePath({ XDG_DATA_HOME: '/data' }, '/home/u'),
    path.join('/data', 'opencode', 'opencode.db'));
  assert.equal(databasePath({}, '/home/u'),
    path.join('/home/u', '.local', 'share', 'opencode', 'opencode.db'));
});

test('parseUnifiedDiff reads positions and rejects bad counts', () => {
  const hunks = parseUnifiedDiff('@@ -3,2 +3,3 @@\n alpha\n-beta\n+delta\n+extra\n');
  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0], {
    oldStart: 3, oldLines: 2, newStart: 3, newLines: 3,
    lines: [' alpha', '-beta', '+delta', '+extra'],
  });
  assert.equal(parseUnifiedDiff('@@ -1,2 +1,1 @@\n alpha\n'), null);
  assert.equal(parseUnifiedDiff('no hunks here'), null);
  const marked = parseUnifiedDiff('@@ -1,1 +1,1 @@\n-old\n+new\n\\ No newline at end of file\n');
  assert.equal(marked[0].lines.at(-1), '\\ No newline at end of file');
});

test('parseReadOutput strips line numbers and validates continuity', () => {
  const parsed = parseReadOutput(
    '<path>/f</path>\n<type>file</type>\n<content>\n5: alpha\n6: \n7: beta\n</content>');
  assert.deepEqual(parsed, { content: 'alpha\n\nbeta', start: 5, count: 3 });
  assert.equal(parseReadOutput('plain text'), null);
  assert.equal(parseReadOutput('<content>\nnot numbered\n</content>'), null);
  assert.equal(parseReadOutput('<content>\n1: a\n3: b\n</content>'), null);
});

test('locate needs a known id and an existing session row', { skip: !available }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibench-oc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'opencode.db');
  await makeDb(file);
  process.env.VIBENCH_OPENCODE_DB = file;
  t.after(() => { delete process.env.VIBENCH_OPENCODE_DB; });

  const missingId = await locate({ session: {} });
  assert.match(missingId.reason, /known session id/);
  const wrongId = await locate({ session: { harness_session_id: 'ses_doesnotexist' } });
  assert.match(wrongId.reason, /no matching OpenCode session/);
  const found = await locate({ session: { harness_session_id: SESSION_ID } });
  assert.deepEqual(found, {
    store: { key: file, id: SESSION_ID }, id: SESSION_ID, via: 'session-id',
  });

  process.env.VIBENCH_OPENCODE_DB = path.join(dir, 'absent.db');
  const noDb = await locate({ session: { harness_session_id: SESSION_ID } });
  assert.match(noDb.reason, /no OpenCode database/);
  process.env.VIBENCH_OPENCODE_DB = file;
});

test('sync classifies OpenCode parts into the shared step model', { skip: !available }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibench-oc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'opencode.db');
  await makeDb(file);
  const state = freshState();
  await sync({ store: { key: file, id: SESSION_ID } }, state);

  assert.deepEqual(state.steps.map((step) => step.kind),
    ['chat', 'chat', 'terminal', 'read', 'patch', 'write', 'other', 'terminal', 'error']);
  const [userChat, thinking, bash, read, patch, write, other, running, broken] = state.steps;
  assert.equal(userChat.event, 'message');
  assert.equal(userChat.role, 'user');
  assert.equal(userChat.content, 'please fix it');
  assert.equal(thinking.event, 'thinking');
  assert.equal(bash.command, 'echo hi');
  assert.equal(bash.output, 'hi\n');
  assert.equal(bash.exit, 0);
  assert.equal(bash.category, 'terminal');
  assert.equal(bash.title, 'greet');
  assert.equal(read.content, 'alpha\nbeta\ngamma');
  assert.equal(read.start_line, 1);
  assert.equal(read.full, true);
  assert.equal(read.total_lines, 3);
  assert.equal(read.category, 'file');
  assert.equal(patch.opaque, false);
  assert.equal(patch.hunks.length, 1);
  assert.equal(patch.hunks[0].oldStart, 1);
  assert.equal(write.content, 'one\ntwo\n');
  assert.deepEqual(write.region, { start_line: 1, end_line: 2 });
  assert.equal(other.result, 'file.txt');
  assert.equal(other.category, 'tool_info');
  assert.equal(running.command, 'sleep 5');
  assert.equal(state.done.has(running.i), false);
  assert.equal(broken.kind, 'error');
  assert.equal(broken.action, 'patch');
  assert.equal(broken.category, 'file');
  assert.equal(broken.error, 'edit failed');
  assert.equal(state.done.has(broken.i), true);
  assert.equal(state.done.has(bash.i), true);
  assert.equal(state.events.filter((event) => event.kind === 'message').length, 1);
  assert.equal(state.events.filter((event) => event.kind === 'thinking').length, 1);

  const before = state.steps;
  await sync({ store: { key: file, id: SESSION_ID } }, state);
  assert.equal(state.steps, before);
});

test('sync completes mutated parts in place and rebuilds on shrink', { skip: !available }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibench-oc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'opencode.db');
  await makeDb(file);
  const state = freshState();
  const found = { store: { key: file, id: SESSION_ID } };
  await sync(found, state);
  const runningIndex = state.steps.findIndex((step) => step.command === 'sleep 5');
  assert.equal(state.done.has(runningIndex), false);
  assert.equal(state.inPlaceCompletion, false);

  const { DatabaseSync } = await import('node:sqlite');
  let db = new DatabaseSync(file);
  db.prepare('update part set time_updated = 5000, data = ? where id = ?').run(JSON.stringify({
    type: 'tool', tool: 'bash', callID: 'call-running',
    state: {
      status: 'completed', input: { command: 'sleep 5' },
      output: 'done\n', metadata: { output: 'done\n', exit: 0 },
    },
  }), 'p8');
  db.close();
  await sync(found, state);
  assert.equal(state.done.has(runningIndex), true);
  assert.equal(state.steps[runningIndex].output, 'done\n');
  assert.equal(state.inPlaceCompletion, true);

  db = new DatabaseSync(file);
  db.prepare('delete from part where id = ?').run('p9');
  db.close();
  const outcome = await sync(found, state);
  assert.deepEqual(outcome, { rebuild: true });
});

test('terminalFor serves an OpenCode session end to end', { skip: !available }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibench-oc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'opencode.db');
  await makeDb(file);
  process.env.VIBENCH_OPENCODE_DB = file;
  t.after(() => { delete process.env.VIBENCH_OPENCODE_DB; });

  const session = {
    id: 'oc1', name: 'demo', pwd: '/work/demo',
    harness: 'opencode', watch_only: true, harness_session_id: SESSION_ID,
  };
  const body = await terminalFor(session);
  assert.equal(body.source.provider, 'opencode');
  assert.equal(body.source.transcript, file);
  assert.equal(body.source.session_id, SESSION_ID);
  assert.equal(body.source.via, 'session-id');
  assert.equal(body.source.established, true);
  assert.ok(body.steps.length > 0);
  assert.ok(body.steps.every((step) => step.kind !== 'chat'));
  const running = body.steps.find((step) => step.command === 'sleep 5');
  assert.equal(running.pending, true);
  const patch = body.steps.find((step) => step.kind === 'patch');
  assert.equal(patch.content, 'alpha\ndelta\ngamma');
  assert.deepEqual(patch.region, { start_line: 2, end_line: 2 });
});
