import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { harnessArgs, harnessLine, parseTsv, runTable, writeMcpConfig } from './mcp.js';
import { resolvePaneSession } from './tmux-host.js';

test('resolves managed pane identity from the live window map and fails closed', () => {
  const env = {
    VIBENCH_SESSION: 'wrong-bench',
    VIBENCH_TMUX_SOCKET: 'vibench-socket',
    VIBENCH_TMUX_SESSION: 'vibench',
    TMUX_PANE: '%7',
  };
  const calls = [];
  const mapped = (...args) => {
    calls.push(args);
    if (args[0] === 'display-message') return 'vibench\t@4\t%7\n';
    if (args[0] === 'show-environment') return 'VIBENCH_WINDOW__4=right-bench\n';
    return '';
  };
  assert.equal(resolvePaneSession(mapped, env), 'right-bench');
  assert.deepEqual(calls, [
    ['display-message', '-p', '-t', '%7', '#{session_name}\t#{window_id}\t#{pane_id}'],
    ['show-environment', '-t', '=vibench', 'VIBENCH_WINDOW__4'],
  ]);
  assert.equal(resolvePaneSession(() => '', { ...env, VIBENCH_TMUX_SESSION: '' }), null);
  assert.equal(resolvePaneSession(() => '', { ...env, TMUX_PANE: '' }), null);
  assert.equal(resolvePaneSession((...args) => args[0] === 'display-message'
    ? 'vibench\t@4\t%3\n' : 'VIBENCH_WINDOW__4=right-bench\n', env), null);
  assert.equal(resolvePaneSession((...args) => args[0] === 'display-message'
    ? 'vibench\t@4\t%7\n' : '', env), null);
  assert.equal(resolvePaneSession(() => { throw new Error('must not run'); }, {
    VIBENCH_SESSION: 'headless-bench',
  }), 'headless-bench');
});

test('writes and injects the Vibench MCP without replacing other Claude config', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibench-mcp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = writeMcpConfig(path.join(dir, 'mcp.json'));
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(manifest.mcpServers.vibench.command, process.execPath);
  const launchFile = process.platform === 'win32' ? file.replaceAll('\\', '/') : file;
  assert.deepEqual(harnessArgs({ name: 'claude', args: ['--model', 'sonnet'] }, file),
    ['--model', 'sonnet', '--mcp-config', launchFile]);
  assert.deepEqual(harnessArgs({ name: 'other', args: ['--flag'] }, file), ['--flag']);
  assert.deepEqual(harnessArgs({ name: 'claude', args: ['--model', 'sonnet'] }, file, ['--resume', 'session-1']),
    ['--model', 'sonnet', '--resume', 'session-1', '--mcp-config', launchFile]);
  const unusual = "C:/Users/O'Brien/MCP Config/mcp.json";
  assert.equal(harnessLine({ name: 'claude', cmd: 'claude' }, 'bash', unusual),
    "claude --mcp-config 'C:/Users/O'\\''Brien/MCP Config/mcp.json'");
  assert.equal(harnessLine({ name: 'claude', cmd: 'claude' }, 'pwsh.exe', unusual),
    "claude --mcp-config 'C:/Users/O''Brien/MCP Config/mcp.json'");
  assert.equal(harnessLine({ name: 'claude', cmd: 'claude' }, 'cmd.exe', unusual),
    `claude --mcp-config "${unusual}"`);
});

test('run_table accepts only strict TSV and returns captured structured data', async (t) => {
  assert.deepEqual(parseTsv('name\tcount\nalpha\t2\n'), {
    columns: ['name', 'count'], rows: [['alpha', '2']],
  });
  for (const invalid of [
    'only-one-column\nvalue\n',
    'name\tname\nalpha\t2\n',
    'name\tcount\n',
    'name\tcount\nalpha\n',
  ]) assert.equal(parseTsv(invalid), null);

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'vibench-table-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const success = await runTable({
    script: "printf 'name\\tcount\\nalpha\\t2\\n'", cwd, title: 'counts',
  });
  assert.equal(success.isError, undefined);
  assert.deepEqual(success.structuredContent, {
    schema: 'vibench.data.v1', kind: 'table',
    command: "printf 'name\\tcount\\nalpha\\t2\\n'", cwd, exitCode: 0,
    stdout: 'name\tcount\nalpha\t2\n', stderr: '',
    data: { columns: ['name', 'count'], rows: [['alpha', '2']] },
  });
  assert.match(success.content[0].text, /^VIBENCH_DATA_V1\n/);
  assert.equal((await runTable({ script: "printf 'not-a-table\\n'", cwd })).isError, true);
  assert.match((await runTable({ script: 'exit 7', cwd })).content[0].text, /command exited 7/);
  assert.equal((await runTable({ script: 'true', cwd: 'relative' })).isError, true);
  assert.match((await runTable({ script: 'true', cwd, format: 'csv' })).content[0].text,
    /unknown run_table argument: format/);
});

test('serves workspace_state for the inherited Vibench session', async (t) => {
  const state = {
    schema: 'vibench.workspace.v1',
    kind: 'workspace_state',
    session_id: 'bench123',
    current: { path: 'example.lua' },
    selection: { active: true, text: 'picked' },
    stale: false,
  };
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/sessions/bench123/workbench'
        || req.headers.authorization !== 'Bearer test-server-token') {
      res.writeHead(404).end();
      return;
    }
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(state));
    }, 25);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibench-mcp-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const port = server.address().port;
  const child = spawn(process.execPath, ['mcp.js'], {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    env: {
      ...process.env,
      VIBENCH_DIR: dir,
      VIBENCH_SERVER_JSON: path.join(dir, 'missing-server.json'),
      VIBENCH_SERVER: `http://127.0.0.1:${port}`,
      VIBENCH_SERVER_TOKEN: 'test-server-token',
      VIBENCH_SESSION: 'bench123',
      VIBENCH_TMUX_SOCKET: '',
      VIBENCH_TMUX_SESSION: '',
      TMUX_PANE: '',
    },
    stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true,
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stdin.end([
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2099-01-01' } }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'workspace_state', arguments: {} } }),
    JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'workspace_state', arguments: null } }),
    'null',
    '{',
    '',
  ].join('\n'));
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  const responses = output.trim().split('\n').map(JSON.parse);
  const byId = new Map(responses.filter(({ id }) => id !== null).map((response) => [response.id, response]));
  assert.equal(byId.get(1).result.serverInfo.name, 'vibench');
  assert.equal(byId.get(1).result.protocolVersion, '2025-06-18');
  assert.deepEqual(byId.get(1).result.capabilities, { tools: {} });
  assert.deepEqual(byId.get(2).result.tools.map(({ name }) => name), ['workspace_state', 'run_table']);
  assert.deepEqual(byId.get(2).result.tools[1].inputSchema.required, ['script']);
  assert.equal(byId.get(2).result.tools[1].inputSchema.properties.format, undefined);
  assert.equal(byId.get(3).result.structuredContent.selection.text, 'picked');
  assert.equal(JSON.parse(byId.get(3).result.content[0].text).session_id, 'bench123');
  assert.equal(byId.get(4).error.code, -32602);
  assert.ok(responses.findIndex(({ id }) => id === 4) < responses.findIndex(({ id }) => id === 3),
    'a slow tool request blocked later MCP requests');
  assert.deepEqual(responses.filter(({ id }) => id === null).map(({ error }) => error.code).sort((a, b) => a - b),
    [-32700, -32600]);
});
