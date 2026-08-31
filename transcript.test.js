import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  forgetAgentSession, paneTarget, parseProcStat, procProcessTable, processTable, projectSteps,
  readySnapshot, terminalFor,
} from './transcript.js';

const replace = (before, after, line = 1) => ({
  oldStart: line, oldLines: 1, newStart: line, newLines: 1,
  lines: [`-${before}`, `+${after}`],
});
const read = (i, content, full = true, file = 'file.txt') => ({
  i, kind: 'read', path: file, content, full,
});
const patch = (i, hunk, file = 'file.txt', extra = {}) => ({
  i, kind: 'patch', path: file, hunks: [hunk], ...extra,
});

test('transcript pane lookup rejects stale registry ids reused by another bench', async () => {
  const session = {
    id: 'bench-a',
    tmux: {
      harness: {
        session: 'vibench', window_id: '@4', window_name: 'demo', pane_id: '%7', pane_index: 1,
      },
    },
  };
  const live = (...args) => args[0] === 'show-environment'
    ? 'VIBENCH_WINDOW__4=bench-a\n'
    : 'vibench:@4.%7\t4321';
  assert.deepEqual(await paneTarget(session, live), { canonical: 'vibench:@4.%7', pid: 4321 });

  const reused = (...args) => args[0] === 'show-environment'
    ? 'VIBENCH_WINDOW__4=bench-b\n'
    : 'vibench:@4.%7\t9876';
  assert.equal(await paneTarget(session, reused), null);

  const moved = (...args) => args[0] === 'show-environment'
    ? 'VIBENCH_WINDOW__4=bench-a\n'
    : 'vibench:@5.%7\t9876';
  assert.equal(await paneTarget(session, moved), null);
});

test('concurrent pane probes yield instead of serializing discovery', async () => {
  const session = {
    id: 'bench-a',
    tmux: { harness: {
      session: 'vibench', window_id: '@4', window_name: 'demo', pane_id: '%7', pane_index: 1,
    } },
  };
  let active = 0;
  let maximum = 0;
  const delayed = async (...args) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    return args[0] === 'show-environment'
      ? 'VIBENCH_WINDOW__4=bench-a\n'
      : 'vibench:@4.%7\t4321';
  };
  const results = await Promise.all([paneTarget(session, delayed), paneTarget(session, delayed)]);
  assert.equal(maximum, 2);
  assert.deepEqual(results, [
    { canonical: 'vibench:@4.%7', pid: 4321 },
    { canonical: 'vibench:@4.%7', pid: 4321 },
  ]);
});

test('process snapshots coalesce and preserve exact start identity', async () => {
  const [first, second] = await Promise.all([processTable(), processTable()]);
  assert.equal(first, second);
  const current = first.get(process.pid);
  assert(current?.starts.length, 'current process is missing from the process snapshot');
  let exact;
  if (process.platform === 'win32') {
    exact = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${process.pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToFileTimeUtc()`],
    { encoding: 'utf8', windowsHide: true }).trim();
  } else if (process.platform === 'linux') {
    exact = parseProcStat(fs.readFileSync('/proc/self/stat', 'utf8'), process.pid).starts[0];
  } else {
    exact = execFileSync('ps', ['-p', String(process.pid), '-o', 'lstart='], {
      encoding: 'utf8', windowsHide: true, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
    }).trim().replace(/\s+/g, ' ');
  }
  assert(current.starts.includes(exact), 'process snapshot rounded the exact start token');
});

test('Linux proc stats preserve process identity without procps', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibench-proc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stat = (pid, parent, start, command = 'worker ) name') =>
    `${pid} (${command}) S ${parent} ${Array(17).fill('0').join(' ')} ${start} 0\n`;
  const write = (directory, content) => {
    const target = path.join(root, String(directory));
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'stat'), content);
  };
  write(123, stat(123, 12, '456'));
  write(124, stat(999, 12, '457'));
  write(125, 'malformed');
  write(126, stat(126, 12, '0'));
  fs.mkdirSync(path.join(root, '127'));
  fs.mkdirSync(path.join(root, 'not-a-pid'));

  assert.deepEqual(parseProcStat(stat(123, 12, '456'), 123), {
    pid: 123, parent: 12, starts: ['456'],
  });
  assert.equal(parseProcStat(stat(999, 12, '457'), 124), null);
  assert.deepEqual([...await procProcessTable(root)], [[123, {
    pid: 123, parent: 12, starts: ['456'],
  }]]);
});

test('pending transcript steps remain visible in the shared timeline', () => {
  const steps = [{ i: 0 }, { i: 1 }, { i: 2 }];
  assert.deepEqual(readySnapshot(steps, undefined, false, new Set([0, 2])), [
    steps[0], { ...steps[1], pending: true }, steps[2],
  ]);
});

test('losing a watched transcript resets the old source before replacement', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibench-source-loss-'));
  const projects = path.join(root, 'projects');
  const project = path.join(projects, 'workspace');
  const id = '77777777-7777-4777-8777-777777777777';
  const file = path.join(project, `${id}.jsonl`);
  const session = {
    id: 'source-loss', name: 'source-loss', pwd: root, harness: 'claude',
    harness_session_id: id, watch_only: true,
  };
  const oldProjects = process.env.VIBENCH_CLAUDE_PROJECTS;
  process.env.VIBENCH_CLAUDE_PROJECTS = projects;
  fs.mkdirSync(project, { recursive: true });
  const transcript = (call, command, output) => [
    { type: 'assistant', timestamp: '2026-08-28T12:00:00.000Z', message: { content: [
      { type: 'tool_use', id: call, name: 'Bash', input: { command } },
    ] } },
    { type: 'user', timestamp: '2026-08-28T12:00:01.000Z', message: { content: [
      { type: 'tool_result', tool_use_id: call, content: output },
    ] }, toolUseResult: { stdout: output, stderr: '', exitCode: 0 } },
  ].map((record) => JSON.stringify(record)).join('\n') + '\n';
  t.after(async () => {
    await forgetAgentSession(session);
    if (oldProjects === undefined) delete process.env.VIBENCH_CLAUDE_PROJECTS;
    else process.env.VIBENCH_CLAUDE_PROJECTS = oldProjects;
    fs.rmSync(root, { recursive: true, force: true });
  });

  fs.writeFileSync(file, transcript('old-call', 'echo old', 'old\n'));
  const first = await terminalFor(session);
  assert.equal(first.steps[0].command, 'echo old');
  assert.equal(first.source.established, true);

  fs.rmSync(file);
  const missing = await terminalFor(session, undefined, first.source.revision);
  assert.equal(missing.reset, true);
  assert.deepEqual(missing.steps, []);
  assert.equal(missing.source.transcript, null);
  assert.equal(missing.source.established, true);
  assert.equal(missing.source.missing_confirmed, false);

  fs.writeFileSync(file, transcript('new-call', 'echo new', 'new\n'));
  const replacement = await terminalFor(session, undefined, missing.source.revision);
  assert.equal(replacement.reset, true);
  assert.deepEqual(replacement.steps.map(({ i, command }) => ({ i, command })), [
    { i: 0, command: 'echo new' },
  ]);
});

test('full reads, writes, and direct original content anchor the forward patch fold', () => {
  const projected = projectSteps([
    read(0, 'one\n'),
    patch(1, replace('one', 'two')),
    { i: 2, kind: 'write', path: 'other.txt', content: 'alpha\n' },
    patch(3, replace('alpha', 'beta'), 'other.txt'),
    patch(4, replace('left', 'right'), 'direct.txt', { _before: 'left\n' }),
    patch(5, replace('two', 'three')),
  ]);

  assert.deepEqual(projected[1], {
    i: 1, kind: 'patch', path: 'file.txt', content: 'two\n',
    region: { start_line: 1, end_line: 1 },
  });
  assert.equal(projected[3].content, 'beta\n');
  assert.equal(projected[4].content, 'right\n');
  assert.equal(Object.hasOwn(projected[4], '_before'), false);
  assert.equal(projected[5].content, 'three\n');
});

test('ambiguous or non-round-tripping patches stay as raw hunks', () => {
  const ambiguous = { ...replace('same', 'changed'), oldStart: 0, newStart: 0 };
  const nonRoundTrip = replace('unique', 'same');
  const malformed = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [null] };
  const projected = projectSteps([
    read(0, 'same\nsame\n', true, 'ambiguous.txt'),
    patch(1, ambiguous, 'ambiguous.txt'),
    read(2, 'same\nunique\n', true, 'roundtrip.txt'),
    patch(3, nonRoundTrip, 'roundtrip.txt'),
    patch(4, malformed, 'malformed.txt'),
    read(5, 'anything\n', true, 'malformed.txt'),
  ]);

  assert.deepEqual(projected[1].hunks, [ambiguous]);
  assert.equal(Object.hasOwn(projected[1], 'content'), false);
  assert.deepEqual(projected[3].hunks, [nonRoundTrip]);
  assert.equal(Object.hasOwn(projected[3], 'content'), false);
  assert.deepEqual(projected[4].hunks, [malformed]);
});

test('declared positions disambiguate duplicate context and pure insertions', () => {
  const duplicate = replace('same', 'changed', 2);
  const insertion = {
    oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+first'],
  };
  const ambiguousInsertion = { ...insertion, oldStart: 0, newStart: 0 };
  const projected = projectSteps([
    read(0, 'same\nsame\n', true, 'duplicate.txt'),
    patch(1, duplicate, 'duplicate.txt'),
    read(2, 'second\n', true, 'insertion.txt'),
    patch(3, insertion, 'insertion.txt'),
    read(4, 'second\n', true, 'ambiguous-insertion.txt'),
    patch(5, ambiguousInsertion, 'ambiguous-insertion.txt'),
    read(6, '', true, 'empty-insertion.txt'),
    patch(7, ambiguousInsertion, 'empty-insertion.txt'),
  ]);
  assert.equal(projected[1].content, 'same\nchanged\n');
  assert.equal(projected[3].content, 'first\nsecond\n');
  assert.deepEqual(projected[5].hunks, [ambiguousInsertion]);
  assert.deepEqual(projected[7].hunks, [ambiguousInsertion]);
});

test('declared positions include the cumulative offset from earlier hunks', () => {
  const hunks = [
    { oldStart: 2, oldLines: 0, newStart: 2, newLines: 1, lines: ['+inserted'] },
    { oldStart: 2, oldLines: 1, newStart: 3, newLines: 1, lines: ['-second', '+changed'] },
  ];
  const projected = projectSteps([
    read(0, 'first\nsecond\n'),
    { i: 1, kind: 'patch', path: 'file.txt', hunks },
  ]);
  assert.equal(projected[1].content, 'first\ninserted\nchanged\n');
  assert.deepEqual(projected[1].region, { start_line: 2, end_line: 3 });
});

test('no-newline markers stay raw rather than guessing EOF semantics', () => {
  const neither = {
    oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
    lines: ['-one', '\\ No newline at end of file', '+two', '\\ No newline at end of file'],
  };
  const addNewline = {
    oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
    lines: ['-one', '\\ No newline at end of file', '+two'],
  };
  const removeNewline = {
    oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
    lines: ['-one', '+two', '\\ No newline at end of file'],
  };
  const projected = projectSteps([
    read(0, 'one', true, 'neither.txt'),
    patch(1, neither, 'neither.txt'),
    read(2, 'one', true, 'added.txt'),
    patch(3, addNewline, 'added.txt'),
    read(4, 'one\n', true, 'removed.txt'),
    patch(5, removeNewline, 'removed.txt'),
  ]);
  assert.deepEqual(projected[1].hunks, [neither]);
  assert.deepEqual(projected[3].hunks, [addNewline]);
  assert.deepEqual(projected[5].hunks, [removeNewline]);
});

test('a future full read backfills earlier patches through an exact reversible chain', () => {
  const projected = projectSteps([
    patch(0, replace('one', 'two')),
    patch(1, replace('two', 'three')),
    read(2, 'three\n'),
  ]);

  assert.equal(projected[0].content, 'two\n');
  assert.deepEqual(projected[0].region, { start_line: 1, end_line: 1 });
  assert.equal(projected[1].content, 'three\n');
});

test('a directly proven later patch can backfill an earlier patch', () => {
  const projected = projectSteps([
    patch(0, replace('one', 'two')),
    patch(1, replace('two', 'three'), 'file.txt', { _before: 'two\n' }),
  ]);
  assert.equal(projected[0].content, 'two\n');
  assert.equal(projected[1].content, 'three\n');

  const supplied = projectSteps([
    patch(0, replace('one', 'two')),
    patch(1, replace('two', 'three'), 'file.txt', {
      content: 'three\n', region: { start_line: 1, end_line: 1 },
    }),
  ]);
  assert.equal(supplied[0].content, 'two\n');
});

test('partial reads, writes, and opaque patches cannot backfill across their boundary', () => {
  const partial = projectSteps([
    patch(0, replace('one', 'two')),
    read(1, 'two\n', false),
  ]);
  assert.equal(Object.hasOwn(partial[0], 'content'), false);

  const writeBarrier = projectSteps([
    patch(0, replace('one', 'two')),
    { i: 1, kind: 'write', path: 'file.txt', content: 'two\n' },
    read(2, 'two\n'),
  ]);
  assert.equal(Object.hasOwn(writeBarrier[0], 'content'), false);

  const opaqueBarrier = projectSteps([
    patch(0, replace('one', 'two')),
    { i: 1, kind: 'patch', path: 'file.txt', hunks: [], opaque: true },
    read(2, 'two\n'),
  ]);
  assert.equal(Object.hasOwn(opaqueBarrier[0], 'content'), false);
});

test('partial reads preserve a matching carried state and discard a contradicted one', () => {
  const matching = projectSteps([
    read(0, 'one\ntwo\n'),
    { i: 1, kind: 'read', path: 'file.txt', content: 'two\n', full: false, start_line: 2, num_lines: 1 },
    patch(2, replace('two', 'changed', 2)),
  ]);
  assert.equal(matching[2].content, 'one\nchanged\n');

  const contradicted = projectSteps([
    read(0, 'one\ntwo\n'),
    { i: 1, kind: 'read', path: 'file.txt', content: 'different\n', full: false, start_line: 2, num_lines: 1 },
    patch(2, replace('two', 'changed', 2)),
  ]);
  assert.equal(Object.hasOwn(contradicted[2], 'content'), false);

  const unpositioned = projectSteps([
    read(0, 'one\ntwo\n'),
    { i: 1, kind: 'read', path: 'file.txt', content: 'two\n', full: false },
    patch(2, replace('two', 'changed', 2)),
  ]);
  assert.equal(Object.hasOwn(unpositioned[2], 'content'), false);
});

test('partial reads must also agree with a future backfill chain', () => {
  const matchingSlice = { i: 1, kind: 'read', path: 'file.txt', content: 'two\n', full: false, start_line: 1, num_lines: 1 };
  const matching = projectSteps([
    patch(0, replace('one', 'two')),
    matchingSlice,
    read(2, 'two\n'),
  ]);
  assert.equal(matching[0].content, 'two\n');

  const contradicted = projectSteps([
    patch(0, replace('one', 'two')),
    { ...matchingSlice, content: 'different\n' },
    read(2, 'two\n'),
  ]);
  assert.equal(Object.hasOwn(contradicted[0], 'content'), false);

  const unpositioned = projectSteps([
    patch(0, replace('one', 'two')),
    { i: 1, kind: 'read', path: 'file.txt', content: 'two\n', full: false },
    read(2, 'two\n'),
  ]);
  assert.equal(Object.hasOwn(unpositioned[0], 'content'), false);
});

test('terminal and unclassified tools break file reconstruction chains', () => {
  const forward = projectSteps([
    read(0, 'one\n'),
    { i: 1, kind: 'terminal', command: 'formatter file.txt', output: '', exit: 0 },
    patch(2, replace('one', 'two')),
  ]);
  assert.equal(Object.hasOwn(forward[2], 'content'), false);

  const backward = projectSteps([
    patch(0, replace('one', 'two')),
    { i: 1, kind: 'other', tool: 'formatter', result: 'done' },
    read(2, 'two\n'),
  ]);
  assert.equal(Object.hasOwn(backward[0], 'content'), false);
});

test('chat steps preserve file reconstruction chains', () => {
  const projected = projectSteps([
    read(0, 'one\n'),
    { i: 1, kind: 'chat', category: 'chat', event: 'message', content: 'keep going' },
    patch(2, replace('one', 'two')),
    patch(3, replace('alpha', 'beta'), 'later.txt'),
    { i: 4, kind: 'chat', category: 'chat', event: 'thinking', content: 'checking' },
    read(5, 'beta\n', true, 'later.txt'),
  ]);

  assert.equal(projected[2].content, 'two\n');
  assert.equal(projected[3].content, 'beta\n');
});

test('step responses are full snapshots only when the client is behind', () => {
  const initial = [patch(0, replace('one', 'two'))];
  assert.equal(Object.hasOwn(readySnapshot(initial)[0], 'content'), false);
  assert.deepEqual(readySnapshot(initial, 0), []);

  const advanced = [...initial, read(1, 'two\n')];
  const snapshot = readySnapshot(advanced, 0);
  assert.deepEqual(snapshot.map(({ i }) => i), [0, 1]);
  assert.equal(snapshot[0].content, 'two\n');
  assert.deepEqual(readySnapshot(advanced, 1), []);
  assert.deepEqual(readySnapshot(advanced, 1, true).map(({ i }) => i), [0, 1]);
});

test('spawned agents appear as children with watchable timelines', async (t) => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'vibench-agents-'));
  process.env.VIBENCH_CLAUDE_PROJECTS = path.join(empty, 'projects');
  t.after(() => {
    delete process.env.VIBENCH_CLAUDE_PROJECTS;
    fs.rmSync(empty, { recursive: true, force: true });
  });
  const { agentCatalog, agentTimelineFor } = await import('./transcript.js');
  const session = {
    id: 'par1', name: 'parent', pwd: empty, harness: 'claude',
    agents: [{
      agent_id: 'aabb', mode: 'subagent', harness: 'claude',
      harness_session_id: '12345678-1234-4123-8123-1234567890ab',
      description: 'do the thing', workspace: empty, status: 'completed',
      spawned_at: '2026-08-31T00:00:00.000Z', ended_at: '2026-08-31T00:01:00.000Z',
    }],
  };
  const catalog = await agentCatalog({ par1: session });
  const child = catalog.roots[0].children.find((candidate) => candidate.id === 'aabb');
  assert.equal(child.subtype, 'subagent');
  assert.equal(child.model, 'claude');
  assert.equal(child.status, 'completed');
  assert.equal(child.live, false);
  const timeline = await agentTimelineFor(session, 'child', 'aabb');
  assert.equal(timeline.agent.id, 'aabb');
  assert.equal(timeline.agent.subtype, 'subagent');
  assert.equal(timeline.session.id, 'par1');
  assert.deepEqual(timeline.steps, []);
  assert.ok(timeline.source.reason);
});
