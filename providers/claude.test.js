import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { consume, discoverChild, discoverChildren, locate, resumeArgs } from './claude.js';
import { projectSteps } from '../transcript.js';

test('Claude owns its resume arguments', () => {
  const id = '12345678-1234-1234-1234-123456789abc';
  assert.deepEqual(resumeArgs(id), ['--resume', id]);
  assert.throws(() => resumeArgs('session-1'), /invalid Claude session id/);
  assert.throws(() => resumeArgs('bad\nsession'), /invalid Claude session id/);
  assert.throws(() => resumeArgs('bad session'), /invalid Claude session id/);
});

test('consume completes a real Claude Bash result without an exit code', () => {
  const state = { steps: [], calls: new Map(), done: new Set() };
  const records = [
    { type: 'assistant', timestamp: '2026-08-27T00:59:51.709Z', cwd: 'C:\\repo', message: { content: [
      { type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'npm test' } },
    ] } },
    { type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'call-1', content: 'ok', is_error: false },
    ] }, toolUseResult: { stdout: 'ok', stderr: '', interrupted: false } },
  ];
  for (const record of records) consume(JSON.stringify(record), state);
  assert.deepEqual(state.steps, [{
    i: 0, kind: 'terminal', category: 'terminal', command: 'npm test', output: 'ok',
    at: '2026-08-27T00:59:51.709Z', exit: null, cwd: 'C:\\repo',
    tool: 'Bash', title: 'npm test',
  }]);
  assert.deepEqual([...state.done], [0]);
});

test('failed terminal calls retain terminal replay data', () => {
  const state = { steps: [], calls: new Map(), done: new Set() };
  const call = (id, command) => consume(JSON.stringify({
    type: 'assistant', message: { content: [
      { type: 'tool_use', id, name: 'Bash', input: { command } },
    ] },
  }), state);
  const result = (id, content, isError, toolUseResult) => consume(JSON.stringify({
    type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: id, content, is_error: isError },
    ] }, toolUseResult,
  }), state);

  call('flagged', 'missing-command');
  result('flagged', 'fallback error', true, { stdout: '', stderr: 'not found\n' });
  call('nonzero', 'exit 7');
  result('nonzero', 'fallback exit', false, { stdout: 'partial\n', stderr: 'failed\n', exitCode: 7 });

  assert.deepEqual(state.steps.map(({ kind, category, output, exit, failed: didFail }) => ({
    kind, category, output, exit, failed: didFail,
  })), [
    { kind: 'terminal', category: 'terminal', output: 'not found\n', exit: null, failed: true },
    { kind: 'terminal', category: 'terminal', output: 'partial\nfailed\n', exit: 7, failed: true },
  ]);
  assert.deepEqual([...state.done], [0, 1]);
});

test('consume classifies selected actions into one contiguous completed timeline', () => {
  const state = { steps: [], calls: new Map(), done: new Set() };
  consume(JSON.stringify({
    type: 'assistant', timestamp: 'now', cwd: 'C:\\repo', message: { content: [
      { type: 'tool_use', id: 'ignored', name: 'Glob', input: { pattern: '*' } },
      { type: 'tool_use', id: 'shell', name: 'PowerShell', input: { command: 'Get-Date' } },
      { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'C:\\repo\\a.txt' } },
      { type: 'tool_use', id: 'edit', name: 'Edit', input: { file_path: 'C:\\repo\\a.txt' } },
      { type: 'tool_use', id: 'write', name: 'Write', input: { file_path: 'C:\\repo\\b.txt', content: 'new\n' } },
    ] },
  }), state);
  consume(JSON.stringify({
    type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'ignored', content: 'matched files', is_error: false },
    ] }, toolUseResult: {},
  }), state);
  consume(JSON.stringify({
    type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'shell', content: 'fallback', is_error: false },
    ] }, toolUseResult: { stdout: 'shell output', stderr: '' },
  }), state);
  consume(JSON.stringify({
    type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'read', content: 'rendered output', is_error: false },
    ] }, toolUseResult: { file: {
      filePath: 'C:\\repo\\a.txt', content: 'captured\ntext\n', numLines: 2, totalLines: 2,
    } },
  }), state);
  const hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-captured', '+changed'] };
  consume(JSON.stringify({
    type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'edit', content: 'updated', is_error: false },
    ] }, toolUseResult: {
      filePath: 'C:\\repo\\a.txt', originalFile: 'captured\ntext\n', structuredPatch: [hunk],
    },
  }), state);
  consume(JSON.stringify({
    type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'write', content: 'created', is_error: false },
    ] }, toolUseResult: { filePath: 'C:\\repo\\b.txt', content: 'new\n' },
  }), state);

  assert.deepEqual(state.steps.map(({ i, kind }) => ({ i, kind })), [
    { i: 0, kind: 'other' },
    { i: 1, kind: 'terminal' },
    { i: 2, kind: 'read' },
    { i: 3, kind: 'patch' },
    { i: 4, kind: 'write' },
  ]);
  assert.equal(state.steps[0].tool, 'Glob');
  assert.equal(state.steps[0].title, '*');
  assert.deepEqual(state.steps[0].params, { pattern: '*' });
  assert.equal(state.steps[0].response, 'matched files');
  assert.equal(state.steps[0].result, 'matched files');
  assert.equal(state.steps[1].tool, 'PowerShell');
  assert.equal(state.steps[1].title, 'Get-Date');
  assert.equal(state.steps[1].output, 'shell output');
  assert.deepEqual(state.steps[2], {
    i: 2, kind: 'read', category: 'file', path: 'C:\\repo\\a.txt', at: 'now', cwd: 'C:\\repo',
    tool: 'Read', title: 'a.txt',
    params: { file_path: 'C:\\repo\\a.txt' },
    content: 'captured\ntext\n', start_line: 1, num_lines: 2, total_lines: 2, full: true,
    response: { file: {
      filePath: 'C:\\repo\\a.txt', content: 'captured\ntext\n', numLines: 2, totalLines: 2,
    } },
  });
  assert.deepEqual(state.steps.slice(3).map(({ tool, title }) => ({ tool, title })), [
    { tool: 'Edit', title: 'a.txt' },
    { tool: 'Write', title: 'b.txt' },
  ]);
  assert.deepEqual(state.steps[3].hunks, [hunk]);
  assert.deepEqual(state.steps[3].params, { file_path: 'C:\\repo\\a.txt' });
  assert.equal(state.steps[3].response.originalFile, 'captured\ntext\n');
  assert.equal(state.steps[3]._before, 'captured\ntext\n');
  assert.equal(state.steps[4].content, 'new\n');
  assert.deepEqual(state.steps[4].params, { file_path: 'C:\\repo\\b.txt', content: 'new\n' });
  assert.equal(state.steps[4].response.content, 'new\n');
  assert.deepEqual(state.steps[4].region, { start_line: 1, end_line: 1 });
  assert.deepEqual([...state.done], [0, 1, 2, 3, 4]);
});

test('normalizes the Vibench run_table MCP call and its captured structured result', () => {
  const state = { steps: [], calls: new Map(), done: new Set() };
  consume(JSON.stringify({
    type: 'assistant', timestamp: '2026-08-28T12:00:00.000Z', cwd: 'C:\\repo',
    message: { content: [{
      type: 'tool_use', id: 'table', name: 'mcp__vibench__run_table',
      input: {
        script: "printf 'name\\tcount\\nalpha\\t2\\n'", cwd: 'C:\\table-work', title: 'counts',
      },
    }] },
  }), state);
  assert.deepEqual(state.steps[0], {
    i: 0, kind: 'data', category: 'data', at: '2026-08-28T12:00:00.000Z', cwd: 'C:\\repo',
    tool: 'mcp__vibench__run_table', title: 'counts',
    command: "printf 'name\\tcount\\nalpha\\t2\\n'",
    params: {
      script: "printf 'name\\tcount\\nalpha\\t2\\n'", cwd: 'C:\\table-work', title: 'counts',
    },
  });
  assert.deepEqual([...state.done], []);

  const envelope = {
    schema: 'vibench.data.v1', kind: 'table',
    command: "printf 'name\\tcount\\nalpha\\t2\\n'", cwd: 'C:\\table-work', exitCode: 0,
    stdout: 'name\tcount\nalpha\t2\n', stderr: '',
    data: { columns: ['name', 'count'], rows: [['alpha', '2']] },
  };
  const captured = {
    content: [{ type: 'text', text: `VIBENCH_DATA_V1\n${JSON.stringify(envelope)}` }],
    structuredContent: envelope,
  };
  consume(JSON.stringify({
    type: 'user', message: { content: [{
      type: 'tool_result', tool_use_id: 'table', content: captured.content, is_error: false,
    }] }, toolUseResult: captured,
  }), state);

  assert.deepEqual(state.steps[0].table, envelope.data);
  assert.equal(state.steps[0].stdout, envelope.stdout);
  assert.equal(state.steps[0].stderr, '');
  assert.equal(state.steps[0].exit, 0);
  assert.equal(state.steps[0].cwd, 'C:\\table-work');
  assert.equal(state.steps[0].response.structuredContent.schema, 'vibench.data.v1');

  consume(JSON.stringify({ type: 'assistant', message: { content: [{
    type: 'tool_use', id: 'blocks', name: 'mcp__vibench__run_table', input: { script: 'second' },
  }] } }), state);
  const second = {
    ...envelope, command: 'second', stdout: 'name\tcount\nbeta\t3\n',
    data: { columns: ['name', 'count'], rows: [['beta', '3']] },
  };
  consume(JSON.stringify({ type: 'user', message: { content: [{
    type: 'tool_result', tool_use_id: 'blocks', is_error: false,
    content: [{ type: 'text', text: `VIBENCH_DATA_V1\n${JSON.stringify(second)}` }],
  }] } }), state);
  assert.deepEqual(state.steps[1].table, second.data,
    'array-of-text-blocks tool_result content was not captured');
  assert.deepEqual([...state.done], [0, 1]);
});

test('run_table classification is Vibench-only and invalid results use the existing error step', () => {
  const state = { steps: [], calls: new Map(), done: new Set() };
  consume(JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'foreign', name: 'mcp__mcfly__run_table', input: { script: 'x' } },
    { type: 'tool_use', id: 'invalid', name: 'vibench__run_table', input: { script: 'y' } },
  ] } }), state);
  assert.equal(state.steps[0].kind, 'other');
  assert.equal(state.steps[0].category, 'tool_info');
  assert.equal(state.steps[1].kind, 'data');
  assert.equal(state.steps[1].category, 'data');

  consume(JSON.stringify({
    type: 'user', message: { content: [{
      type: 'tool_result', tool_use_id: 'invalid', content: '{}', is_error: false,
    }] }, toolUseResult: {},
  }), state);
  assert.equal(state.steps[1].kind, 'error');
  assert.equal(state.steps[1].action, 'data');
  assert.equal(state.steps[1].category, 'data');
  assert.match(state.steps[1].error, /valid captured table data/);
  assert.deepEqual([...state.done], [1]);
});

test('normalizes Claude newline-terminated full-read counts', () => {
  const state = { steps: [], calls: new Map(), done: new Set() };
  consume(JSON.stringify({
    type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'a.txt' } },
    ] },
  }), state);
  consume(JSON.stringify({
    type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'read', content: 'rendered', is_error: false },
    ] }, toolUseResult: { file: {
      filePath: 'a.txt', content: 'one\ntwo\n', startLine: 1, numLines: 3, totalLines: 3,
    } },
  }), state);

  assert.equal(state.steps[0].full, true);
  assert.equal(state.steps[0].num_lines, 2);
  assert.equal(state.steps[0].total_lines, 2);
});

test('newline-normalized reads reconstruct edits without originalFile', () => {
  const state = { steps: [], calls: new Map(), done: new Set() };
  const call = (id, name, input) => consume(JSON.stringify({
    type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] },
  }), state);
  const result = (id, toolUseResult) => consume(JSON.stringify({
    type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: id, content: 'captured', is_error: false },
    ] }, toolUseResult,
  }), state);
  const hunk = {
    oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'],
  };

  call('read-before', 'Read', { file_path: 'forward.txt' });
  result('read-before', { file: {
    filePath: 'forward.txt', content: 'old\nrest\n', startLine: 1, numLines: 3, totalLines: 3,
  } });
  call('edit-after', 'Edit', { file_path: 'forward.txt' });
  result('edit-after', { filePath: 'forward.txt', originalFile: null, structuredPatch: [hunk] });

  call('edit-before', 'Edit', { file_path: 'backward.txt' });
  result('edit-before', { filePath: 'backward.txt', originalFile: null, structuredPatch: [hunk] });
  call('read-after', 'Read', { file_path: 'backward.txt' });
  result('read-after', { file: {
    filePath: 'backward.txt', content: 'new\nrest\n', startLine: 1, numLines: 3, totalLines: 3,
  } });

  assert.deepEqual(state.steps.filter(({ kind }) => kind === 'read')
    .map(({ full, num_lines, total_lines }) => ({ full, num_lines, total_lines })), [
    { full: true, num_lines: 2, total_lines: 2 },
    { full: true, num_lines: 2, total_lines: 2 },
  ]);
  assert.equal(state.steps.filter(({ kind }) => kind === 'patch')
    .some((step) => Object.hasOwn(step, '_before')), false);
  const projected = projectSteps(state.steps);
  assert.equal(projected[1].content, 'new\nrest\n');
  assert.equal(projected[2].content, 'new\nrest\n');
});

test('treats Claude empty-file read metadata as a complete anchor', () => {
  const state = { steps: [], calls: new Map(), done: new Set() };
  consume(JSON.stringify({
    type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'empty.txt' } },
    ] },
  }), state);
  consume(JSON.stringify({
    type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'read', content: '', is_error: false },
    ] }, toolUseResult: { file: {
      filePath: 'empty.txt', content: '', startLine: 1, numLines: 1, totalLines: 1,
    } },
  }), state);

  assert.equal(state.steps[0].content, '');
  assert.equal(state.steps[0].full, true);
});

test('MultiEdit and NotebookEdit are provider-neutral patch steps', () => {
  const state = { steps: [], calls: new Map(), done: new Set() };
  consume(JSON.stringify({
    type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'multi', name: 'MultiEdit', input: { file_path: 'a.txt', edits: [] } },
      { type: 'tool_use', id: 'notebook', name: 'NotebookEdit', input: { notebook_path: 'book.ipynb' } },
    ] },
  }), state);
  const hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] };
  for (const [id, filePath] of [['multi', 'a.txt'], ['notebook', 'book.ipynb']]) consume(JSON.stringify({
    type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: id, content: 'updated', is_error: false },
    ] }, toolUseResult: { filePath, originalFile: 'old', structuredPatch: [hunk] },
  }), state);
  assert.deepEqual(state.steps.map(({ i, kind, path: file }) => ({ i, kind, path: file })), [
    { i: 0, kind: 'patch', path: 'a.txt' },
    { i: 1, kind: 'patch', path: 'book.ipynb' },
  ]);
  assert.deepEqual([...state.done], [0, 1]);
});

test('Edit input is reconstructed only when its fallback patch is exact', () => {
  const state = { steps: [], calls: new Map(), done: new Set() };
  consume(JSON.stringify({
    type: 'assistant', message: { content: [{
      type: 'tool_use', id: 'edit', name: 'Edit',
      input: { file_path: 'a.txt', old_string: 'old\n', new_string: 'new\n' },
    }] },
  }), state);
  consume(JSON.stringify({
    type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'edit', content: 'updated', is_error: false },
    ] }, toolUseResult: { filePath: 'a.txt' },
  }), state);
  assert.deepEqual(state.steps[0].hunks, [{
    oldStart: 0, oldLines: 1, newStart: 0, newLines: 1, lines: ['-old', '+new'],
  }]);
  assert.equal(state.steps[0].opaque, false);
  const applied = projectSteps([
    { i: 0, kind: 'read', path: 'a.txt', content: 'old\nnext\n', full: true },
    { ...state.steps[0], i: 1 },
  ]);
  assert.equal(applied[1].content, 'new\nnext\n');
  const ambiguous = projectSteps([
    { i: 0, kind: 'read', path: 'a.txt', content: 'old\nold\n', full: true },
    { ...state.steps[0], i: 1 },
  ]);
  assert.equal(Object.hasOwn(ambiguous[1], 'content'), false);

  const newlineState = { steps: [], calls: new Map(), done: new Set() };
  consume(JSON.stringify({
    type: 'assistant', message: { content: [{
      type: 'tool_use', id: 'edit', name: 'Edit',
      input: { file_path: 'a.txt', old_string: 'foo\n', new_string: 'baz' },
    }] },
  }), newlineState);
  consume(JSON.stringify({
    type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'edit', content: 'updated', is_error: false },
    ] }, toolUseResult: { filePath: 'a.txt' },
  }), newlineState);
  const projected = projectSteps([
    { i: 0, kind: 'read', path: 'a.txt', content: 'foo\nbar\n', full: true },
    { ...newlineState.steps[0], i: 1 },
  ]);
  assert.equal(Object.hasOwn(projected[1], 'content'), false);
  assert.equal(projected[1].hunks[0].lines.at(-1), '\\ No newline at end of replacement text');
});

test('failed file calls are explicit errors, not successful read, patch, or write steps', () => {
  const state = { steps: [], calls: new Map(), done: new Set() };
  for (const [id, name, input] of [
    ['read', 'Read', { file_path: 'a.txt' }],
    ['edit', 'Edit', { file_path: 'a.txt' }],
    ['write', 'Write', { file_path: 'a.txt', content: 'tempting' }],
  ]) consume(JSON.stringify({
    type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] },
  }), state);

  for (const [id, toolUseResult] of [
    ['read', { file: { content: 'not a successful read', startLine: 1, numLines: 1, totalLines: 1 } }],
    ['edit', { originalFile: 'old', structuredPatch: [{ oldLines: 1, newLines: 1, lines: ['-old', '+new'] }] }],
    ['write', { content: 'not a successful write' }],
  ]) consume(JSON.stringify({
    type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: id, content: `${id} failed`, is_error: true },
    ] }, toolUseResult,
  }), state);

  assert.deepEqual(state.steps.map((step) => ({
    i: step.i, kind: step.kind, action: step.action, tool: step.tool, title: step.title,
    error: step.error,
    hasContent: Object.hasOwn(step, 'content'), hasHunks: Object.hasOwn(step, 'hunks'),
  })), [
    { i: 0, kind: 'error', action: 'read', tool: 'Read', title: 'a.txt', error: 'read failed', hasContent: false, hasHunks: false },
    { i: 1, kind: 'error', action: 'patch', tool: 'Edit', title: 'a.txt', error: 'edit failed', hasContent: false, hasHunks: false },
    { i: 2, kind: 'error', action: 'write', tool: 'Write', title: 'a.txt', error: 'write failed', hasContent: false, hasHunks: false },
  ]);
  assert.deepEqual([...state.done], [0, 1, 2]);
  assert.deepEqual(state.steps.map((step) => step.params.file_path), ['a.txt', 'a.txt', 'a.txt']);
  assert.equal(state.steps[0].response.file.content, 'not a successful read');
});

test('a captured partial Read result is retained but never marked full', () => {
  const state = { steps: [], calls: new Map(), done: new Set() };
  consume(JSON.stringify({
    type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'a.txt', offset: 2, limit: 1 } },
    ] },
  }), state);
  consume(JSON.stringify({
    type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'read', content: 'displayed', is_error: false },
    ] }, toolUseResult: { file: {
      filePath: 'a.txt', content: 'second\n', startLine: 2, numLines: 1, totalLines: 2,
    } },
  }), state);
  assert.equal(state.steps[0].content, 'second\n');
  assert.equal(state.steps[0].full, false);
});

test('a newline-terminated prefix read cannot anchor a null-originalFile edit', () => {
  const state = { steps: [], calls: new Map(), done: new Set() };
  const call = (id, name, input) => consume(JSON.stringify({
    type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] },
  }), state);
  const result = (id, toolUseResult) => consume(JSON.stringify({
    type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: id, content: 'captured', is_error: false },
    ] }, toolUseResult,
  }), state);

  call('read', 'Read', { file_path: 'a.txt', limit: 1 });
  result('read', { file: {
    filePath: 'a.txt', content: 'old\n', startLine: 1, numLines: 1, totalLines: 2,
  } });
  call('edit', 'Edit', { file_path: 'a.txt' });
  result('edit', { filePath: 'a.txt', originalFile: null, structuredPatch: [
    { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+changed'] },
  ] });

  assert.deepEqual({ full: state.steps[0].full, num: state.steps[0].num_lines, total: state.steps[0].total_lines },
    { full: false, num: 1, total: 2 });
  assert.equal(Object.hasOwn(projectSteps(state.steps)[1], 'content'), false);
});

test('a token-truncated Read is never authoritative even when its line counts match', () => {
  const state = { steps: [], calls: new Map(), done: new Set() };
  consume(JSON.stringify({
    type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'long.txt' } },
    ] },
  }), state);
  consume(JSON.stringify({
    type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'read', content: 'displayed', is_error: false },
    ] }, toolUseResult: { file: {
      filePath: 'long.txt', content: 'truncated', startLine: 1, numLines: 1, totalLines: 1,
      truncatedByTokenCap: true,
    } },
  }), state);
  assert.equal(state.steps[0].content, 'truncated');
  assert.equal(state.steps[0].full, false);
});

test('a Read falls back to captured tool-result text only as a non-authoritative slice', () => {
  const state = { steps: [], calls: new Map(), done: new Set() };
  consume(JSON.stringify({
    type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'a.txt' } },
    ] },
  }), state);
  consume(JSON.stringify({
    type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'read', content: 'rendered, not captured', is_error: false },
    ] }, toolUseResult: {},
  }), state);
  assert.equal(state.steps[0].kind, 'read');
  assert.equal(state.steps[0].content, 'rendered, not captured');
  assert.equal(state.steps[0].full, false);
});

test('a Read with no captured response becomes an error step', () => {
  const state = { steps: [], calls: new Map(), done: new Set() };
  consume(JSON.stringify({
    type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'a.txt' } },
    ] },
  }), state);
  consume(JSON.stringify({
    type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'read', is_error: false },
    ] }, toolUseResult: {},
  }), state);
  assert.equal(state.steps[0].kind, 'error');
  assert.equal(state.steps[0].action, 'read');
  assert.equal(Object.hasOwn(state.steps[0], 'content'), false);
});

test('one structured result is never guessed across parallel tool-result parts', () => {
  const state = { steps: [], calls: new Map(), done: new Set() };
  consume(JSON.stringify({
    type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'a.txt' } },
      { type: 'tool_use', id: 'edit', name: 'Edit', input: { file_path: 'b.txt' } },
    ] },
  }), state);
  consume(JSON.stringify({
    type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'read', content: 'captured read response', is_error: false },
      { type: 'tool_result', tool_use_id: 'edit', content: 'captured edit response', is_error: false },
    ] }, toolUseResult: {
      filePath: 'wrong.txt', originalFile: 'old',
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }],
    },
  }), state);
  assert.equal(state.steps[0].content, 'captured read response');
  assert.equal(state.steps[0].full, false);
  assert.equal(state.steps[1].path, 'b.txt');
  assert.equal(state.steps[1].opaque, true);
});

test('root and sidechain records keep separate normalized state and child lifetime', () => {
  const state = {
    source_session_id: 'root-session', steps: [], calls: new Map(), done: new Set(),
  };
  const root = [
    { type: 'user', timestamp: '2026-08-28T10:00:00.000Z', message: { content: 'root message' } },
    { type: 'assistant', timestamp: '2026-08-28T10:00:01.000Z', message: { content: [
      { type: 'thinking', thinking: 'considering' },
      { type: 'tool_use', id: 'spawn-1', name: 'Agent', input: {
        description: 'Check work', subagent_type: 'reviewer', prompt: 'review it',
      } },
    ] } },
    { type: 'user', timestamp: '2026-08-28T10:00:02.000Z', message: { content: [
      { type: 'tool_result', tool_use_id: 'spawn-1', content: 'started' },
    ] }, toolUseResult: {
      agentId: 'a1234567890abcdef', description: 'Check work', status: 'async_launched',
      resolvedModel: 'sonnet',
    } },
    { type: 'user', isMeta: true, timestamp: '2026-08-28T10:00:02.500Z', message: { content:
      '<task-notification><task-id>a1234567890abcdef</task-id><status>completed</status></task-notification>' } },
    { isSidechain: true, agentId: 'a1234567890abcdef', sessionId: 'different-root',
      type: 'assistant', timestamp: '2026-08-28T10:00:02.750Z', message: { content: [
        { type: 'tool_use', id: 'first-intruder', name: 'Bash', input: { command: 'echo wrong first' } },
      ] } },
    { isSidechain: true, agentId: 'a1234567890abcdef', sessionId: 'root-session',
      type: 'assistant', timestamp: '2026-08-28T10:00:03.000Z', message: { content: [
        { type: 'tool_use', id: 'child-call', name: 'Bash', input: { command: 'echo child' } },
      ] } },
    { isSidechain: true, agentId: 'a1234567890abcdef', sessionId: 'root-session',
      type: 'user', timestamp: '2026-08-28T10:00:04.000Z', message: { content: [
        { type: 'tool_result', tool_use_id: 'child-call', content: 'child output' },
      ] }, toolUseResult: { stdout: 'child output', stderr: '', exitCode: 0 } },
    { isSidechain: true, agentId: 'a1234567890abcdef', sessionId: 'different-root',
      type: 'assistant', timestamp: '2026-08-28T10:00:04.500Z', message: { content: [
        { type: 'tool_use', id: 'intruder', name: 'Bash', input: { command: 'echo wrong root' } },
      ] } },
    { type: 'user', isMeta: true, timestamp: '2026-08-28T10:00:04.750Z', origin: {
      kind: 'peer', from: 'reviewer', name: 'reviewer',
      senderTaskId: 'a1234567890abcdef', body: 'peer result',
    }, message: { content: 'Another Claude session sent a message: <agent-message>peer result</agent-message>' } },
    { type: 'user', timestamp: '2026-08-28T10:00:05.000Z',
      origin: { kind: 'task-notification' }, message: { content:
      '<task-notification><task-id>a1234567890abcdef</task-id><status>completed</status><summary>done</summary></task-notification>' } },
  ];
  for (const record of root) consume(JSON.stringify(record), state);

  const rootAgent = state.steps.find(({ tool }) => tool === 'Agent');
  assert.equal(state.steps.some(({ tool }) => tool === 'Bash'), false,
    'child tool leaked into the root timeline');
  assert.equal(rootAgent.category, 'tool_info');
  assert.deepEqual(rootAgent.response.agentId, 'a1234567890abcdef');
  const child = state.sidechains.get('a1234567890abcdef');
  assert.equal(child.steps.length, 1);
  assert.equal(child.steps[0].command, 'echo child');
  assert.equal(child.steps[0].output, 'child output');
  assert.deepEqual(state.events.map(({ kind }) => kind),
    ['message', 'thinking', 'agent_spawn', 'message', 'agent_peer', 'agent_peer']);
  assert.match(state.events[3].content, /task-notification/,
    'unrelated isMeta text was treated as trusted task-notification provenance');
  assert.deepEqual({
    kind: state.events[4].kind, agent_id: state.events[4].agent_id,
    name: state.events[4].name, content: state.events[4].content,
  }, {
    kind: 'agent_peer', agent_id: 'a1234567890abcdef',
    name: 'reviewer', content: 'peer result',
  });
  assert.deepEqual(child.events, []);
  assert.deepEqual(state.children.get('a1234567890abcdef'), {
    id: 'a1234567890abcdef',
    parent_agent_id: null,
    tool_call_id: 'spawn-1',
    description: 'Check work',
    subtype: 'reviewer',
    model: 'sonnet',
    status: 'completed',
    spawned_at: '2026-08-28T10:00:01.000Z',
    spawn_position: 3,
    ended_at: '2026-08-28T10:00:05.000Z',
  });
  assert.deepEqual(state.steps.map(({ category }) => category),
    ['chat', 'chat', 'tool_info', 'chat', 'chat', 'chat', 'chat']);
});

test('synchronous Agent completion records its result timestamp', () => {
  const state = { steps: [], calls: new Map(), done: new Set() };
  consume(JSON.stringify({
    type: 'assistant', timestamp: '2026-08-28T10:00:00.000Z', message: { content: [
      { type: 'tool_use', id: 'spawn', name: 'Agent', input: { description: 'Do it' } },
    ] },
  }), state);
  consume(JSON.stringify({
    type: 'user', timestamp: '2026-08-28T10:00:05.000Z', message: { content: [
      { type: 'tool_result', tool_use_id: 'spawn', content: 'done' },
    ] }, toolUseResult: { agentId: 'a1234567890abcdef', status: 'completed' },
  }), state);

  assert.equal(state.children.get('a1234567890abcdef').ended_at,
    '2026-08-28T10:00:05.000Z');
});

test('discovers retained child transcripts with validated identity and lifetime', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibench-claude-children-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'root-session.jsonl');
  const directory = path.join(tmp, 'root-session', 'subagents');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(root, '');
  const line = (value) => `${JSON.stringify(value)}\n`;
  const childFile = path.join(directory, 'agent-a1234567890abcdef.jsonl');
  assert.equal(await discoverChild(root, 'a1234567890abcdef'), null);
  fs.writeFileSync(childFile, '');
  assert.equal(await discoverChild(root, 'a1234567890abcdef'), null);
  fs.writeFileSync(childFile, [
    { isSidechain: true, agentId: 'a1234567890abcdef', sessionId: 'root-session',
      type: 'user', timestamp: '2026-08-28T10:00:03.000Z', message: { content: 'child prompt' } },
    { isSidechain: true, agentId: 'a1234567890abcdef', sessionId: 'root-session',
      type: 'assistant', timestamp: '2026-08-28T10:00:04.000Z', message: { content: [{ type: 'text', text: 'done' }] } },
  ].map(line).join(''));
  assert.equal((await discoverChild(root, 'a1234567890abcdef')).id, 'a1234567890abcdef');
  fs.writeFileSync(path.join(directory, 'agent-wrong.jsonl'), line({
    isSidechain: true, agentId: 'different', sessionId: 'root-session',
    type: 'user', timestamp: '2026-08-28T10:00:00.000Z', message: { content: 'wrong' },
  }));
  const workflowDirectory = path.join(directory, 'workflows', 'wf_team');
  fs.mkdirSync(workflowDirectory, { recursive: true });
  fs.writeFileSync(path.join(workflowDirectory, 'agent-workflow-child.jsonl'), line({
    isSidechain: true, agentId: 'workflow-child', sessionId: 'root-session',
    type: 'user', timestamp: '2026-08-28T10:00:05.000Z', message: { content: 'workflow prompt' },
  }));
  const splitDirectory = path.join(directory, 'workflows', 'wf_split');
  fs.mkdirSync(splitDirectory, { recursive: true });
  const splitFile = path.join(splitDirectory, 'agent-a1234567890abcdef.jsonl');
  fs.writeFileSync(splitFile, line({
    isSidechain: true, agentId: 'a1234567890abcdef', sessionId: 'root-session',
    type: 'user', timestamp: '2026-08-28T09:00:00.000Z', message: { content: 'earlier segment' },
  }));

  const children = await discoverChildren(root);
  assert.deepEqual(children.map(({ id }) => id), ['a1234567890abcdef', 'workflow-child']);
  const direct = children.find(({ id }) => id === 'a1234567890abcdef');
  assert.equal(direct.started_at, '2026-08-28T09:00:00.000Z');
  assert.equal(direct.last_at, '2026-08-28T10:00:04.000Z');
  assert.equal(direct.children.length, 0);
  assert.deepEqual(direct.files, [splitFile, childFile]);
  assert.deepEqual((await discoverChild(root, 'a1234567890abcdef')).files,
    [splitFile, childFile]);
  assert.equal((await discoverChild(root, 'workflow-child')).started_at,
    '2026-08-28T10:00:05.000Z');

  fs.rmSync(childFile);
  assert.deepEqual((await discoverChild(root, 'a1234567890abcdef')).files, [splitFile]);
  fs.rmSync(splitFile);
  assert.equal(await discoverChild(root, 'a1234567890abcdef'), null);
  fs.writeFileSync(childFile, [
    { isSidechain: true, agentId: 'a1234567890abcdef', sessionId: 'root-session',
      type: 'user', timestamp: '2026-08-28T11:00:03.000Z', message: { content: 'replacement' } },
  ].map(line).join(''));
  assert.equal((await discoverChild(root, 'a1234567890abcdef')).started_at,
    '2026-08-28T11:00:03.000Z');
});

test('locate requires one live PID/start match and rescans for a replacement', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibench-claude-locate-'));
  const sessions = path.join(tmp, 'sessions');
  const projects = path.join(tmp, 'projects');
  fs.mkdirSync(sessions);
  fs.mkdirSync(projects);
  const oldSessions = process.env.VIBENCH_CLAUDE_SESSIONS;
  const oldProjects = process.env.VIBENCH_CLAUDE_PROJECTS;
  process.env.VIBENCH_CLAUDE_SESSIONS = sessions;
  process.env.VIBENCH_CLAUDE_PROJECTS = projects;
  t.after(() => {
    if (oldSessions === undefined) delete process.env.VIBENCH_CLAUDE_SESSIONS;
    else process.env.VIBENCH_CLAUDE_SESSIONS = oldSessions;
    if (oldProjects === undefined) delete process.env.VIBENCH_CLAUDE_PROJECTS;
    else process.env.VIBENCH_CLAUDE_PROJECTS = oldProjects;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const write = (file, record) => fs.writeFileSync(path.join(sessions, file), JSON.stringify(record));
  write('not-a-pid.json', { pid: 99, sessionId: 'wrong-file', cwd: 'C:\\wrong', procStart: 's99' });
  write('100.json', { pid: 999, sessionId: 'wrong-pid', cwd: 'C:\\wrong', procStart: 's100' });
  write('101.json', { pid: 101, sessionId: ' ', cwd: 'C:\\wrong', procStart: 's101' });
  write('102.json', { pid: 102, sessionId: 'blank-cwd', cwd: ' ', procStart: 's102' });
  write('103.json', { pid: 103, sessionId: 'wrong-start', cwd: 'C:\\wrong', procStart: 'stale' });
  write('104.json', { pid: 104, sessionId: 'first', cwd: 'C:\\authoritative\\next.js\\.config', procStartFt: '  s104   token ' });
  fs.writeFileSync(path.join(sessions, '105.json'), '{');
  const firstTranscript = path.join(projects, 'C--authoritative-next-js--config', 'first.jsonl');
  fs.mkdirSync(path.dirname(firstTranscript), { recursive: true });
  fs.writeFileSync(firstTranscript, '');
  const processes = [99, 100, 101, 102, 103, 104, 105].map((pid) => ({
    pid, starts: [pid === 104 ? 's104 token' : `s${pid}`],
  }));

  assert.deepEqual(await locate({ session: { pwd: 'C:\\not-authoritative' }, pane: {}, processes }), {
    file: firstTranscript, id: 'first', pid: 104, via: 'pid-session',
  });
  assert.deepEqual(await locate({ session: {
    id: 'internal-bench', watch_only: true, harness_session_id: 'first',
  } }), {
    file: firstTranscript, id: 'first', via: 'session-id',
  });
  assert.match((await locate({ session: {
    id: 'first', watch_only: true, harness_session_id: 'missing',
  } })).reason, /no matching/i);

  write('106.json', { pid: 106, sessionId: 'second', cwd: 'D:\\new\\repo', procStart: 's106' });
  const ambiguous = await locate({ processes: [...processes, { pid: 106, starts: ['s106'] }] });
  assert.match(ambiguous.reason, /ambiguous/i);
  assert.equal(ambiguous.id, undefined);

  const secondTranscript = path.join(projects, 'D--new-repo', 'second.jsonl');
  fs.mkdirSync(path.dirname(secondTranscript), { recursive: true });
  fs.writeFileSync(secondTranscript, '');
  assert.deepEqual(await locate({ processes: [{ pid: 106, starts: ['s106'] }] }), {
    file: secondTranscript, id: 'second', pid: 106, via: 'pid-session',
  });
  write('107.json', { pid: 107, sessionId: 'not-created', cwd: 'D:\\new\\repo', procStart: 's107' });
  assert.deepEqual(await locate({ processes: [{ pid: 107, starts: ['s107'] }] }), {
    id: 'not-created', pid: 107, via: 'pid-session', reason: 'transcript not yet created',
  });
  assert.match((await locate({ processes: [{ pid: 106, starts: ['different'] }] })).reason, /no matching/i);
});
