#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { resolvePaneSession } from './tmux-host.js';

const ENTRYPOINT = fileURLToPath(import.meta.url);
const VERSION = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const PROTOCOL_VERSION = '2025-06-18';
const exec = promisify(execFile);
const DATA_MARKER = 'VIBENCH_DATA_V1';
const WORKSPACE_STATE_TOOL = {
  name: 'workspace_state',
  title: "See the user's Vibench workspace",
  description: "The current Neovim workbench: focused window and visible lines, open files, cursor, latest visual selection, shared playhead, and Vibench panels. Call it when the user refers to 'this', 'here', 'that file', 'what I selected', 'what is open', or 'where I am'. A selection remains available after Visual mode ends, with active=false.",
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  outputSchema: {
    type: 'object',
    required: ['schema', 'kind', 'session_id'],
    properties: {
      schema: { const: 'vibench.workspace.v1' },
      kind: { const: 'workspace_state' },
      session_id: { type: 'string' },
    },
  },
  annotations: { readOnlyHint: true },
};
const RUN_TABLE_TOOL = {
  name: 'run_table',
  title: 'Run tabular shell command',
  description: 'Run a Bash script and return its strict TSV stdout as a semantic table for Vibench.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['script'],
    properties: {
      script: { type: 'string', description: 'Bash script whose stdout is strict TSV.' },
      cwd: { type: 'string', description: 'Absolute working directory. Defaults to the MCP process working directory.' },
      title: { type: 'string', description: 'Short table title.' },
    },
  },
  outputSchema: {
    type: 'object', additionalProperties: false,
    required: ['schema', 'kind', 'command', 'cwd', 'exitCode', 'stdout', 'stderr', 'data'],
    properties: {
      schema: { const: 'vibench.data.v1' }, kind: { const: 'table' },
      command: { type: 'string' }, cwd: { type: 'string' }, exitCode: { type: 'integer' },
      stdout: { type: 'string' }, stderr: { type: 'string' },
      data: {
        type: 'object', additionalProperties: false, required: ['columns', 'rows'],
        properties: {
          columns: { type: 'array', items: { type: 'string' }, minItems: 2 },
          rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, minItems: 1 },
        },
      },
    },
  },
  annotations: { destructiveHint: true, openWorldHint: true },
};

export function parseTsv(stdout) {
  const lines = String(stdout).replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const [columns, ...rows] = lines.map((line) => line.split('\t'));
  if (!columns || columns.length < 2 || !rows.length || columns.some((cell) => !cell)
      || new Set(columns).size !== columns.length
      || rows.some((row) => row.length !== columns.length)) return null;
  return { columns, rows };
}

export const mcpConfigFile = () => path.join(
  process.env.VIBENCH_DIR || path.join(os.homedir(), '.vibench'),
  'mcp.json',
);

export function writeMcpConfig(file = mcpConfigFile()) {
  const manifest = {
    mcpServers: {
      vibench: { command: process.execPath, args: [ENTRYPOINT] },
    },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  try { if (fs.readFileSync(file, 'utf8') === text) return file; } catch { /* create it */ }
  fs.writeFileSync(file, text, { mode: 0o600 });
  return file;
}

export function harnessArgs(harness, file = mcpConfigFile(), launchArgs = []) {
  const args = [...(Array.isArray(harness.args) ? harness.args : []), ...launchArgs];
  const config = process.platform === 'win32' ? file.replaceAll('\\', '/') : file;
  return harness.name === 'claude' ? [...args, '--mcp-config', config] : args;
}

export function harnessLine(harness, shell, file = mcpConfigFile(), launchArgs = []) {
  const shellName = String(shell).replaceAll('\\', '/').split('/').at(-1).replace(/\.exe$/i, '').toLowerCase();
  const quote = (value) => {
    const text = String(value);
    if (/^[\w./:@=-]+$/.test(text)) return text;
    if (shellName === 'cmd') return `"${text.replaceAll('"', '""')}"`;
    return shellName === 'pwsh' || shellName === 'powershell'
      ? `'${text.replaceAll("'", "''")}'`
      : `'${text.replaceAll("'", `'\\''`)}'`;
  };
  return [harness.cmd, ...harnessArgs(harness, file, launchArgs)].map(quote).join(' ');
}

function serverInfo() {
  const file = process.env.VIBENCH_SERVER_JSON || path.join(
    process.env.VIBENCH_DIR || path.join(os.homedir(), '.vibench'),
    'server.json',
  );
  try {
    const info = JSON.parse(fs.readFileSync(file, 'utf8'));
    const port = Number(info.port);
    if (Number.isInteger(port) && port > 0 && port < 65536 && typeof info.token === 'string') {
      return { base: `http://127.0.0.1:${port}`, token: info.token };
    }
  } catch { /* use the launch-time fallback */ }
  const fallback = process.env.VIBENCH_SERVER;
  const token = process.env.VIBENCH_SERVER_TOKEN;
  return /^http:\/\/127\.0\.0\.1:\d+$/.test(fallback ?? '') && token
    ? { base: fallback, token } : null;
}

async function workspaceState() {
  const id = process.env.VIBENCH_SESSION;
  const server = serverInfo();
  if (!id || !/^\w+$/.test(id)) {
    return { content: [{ type: 'text', text: 'VIBENCH_SESSION is missing or invalid' }], isError: true };
  }
  if (!server) {
    return { content: [{ type: 'text', text: 'Vibench server is unavailable' }], isError: true };
  }
  try {
    const response = await fetch(`${server.base}/sessions/${encodeURIComponent(id)}/workbench`, {
      headers: { authorization: `Bearer ${server.token}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 200);
      return {
        content: [{ type: 'text', text: `Vibench workspace state is unavailable (${response.status}): ${detail}` }],
        isError: true,
      };
    }
    const state = await response.json();
    if (state?.schema !== 'vibench.workspace.v1' || state.kind !== 'workspace_state'
        || state.session_id !== id) {
      return { content: [{ type: 'text', text: 'Vibench returned invalid workspace state' }], isError: true };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(state, null, 2) }],
      structuredContent: state,
    };
  } catch (error) {
    return { content: [{ type: 'text', text: `Vibench workspace state failed: ${error.message}` }], isError: true };
  }
}

function toolError(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function bash() {
  if (process.env.VIBENCH_BASH) return process.env.VIBENCH_BASH;
  if (process.platform !== 'win32') return 'bash';
  try {
    const found = execFileSync('where.exe', ['bash.exe'], { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/).filter(Boolean);
    return found.find((file) => /\\Git\\(?:bin|usr\\bin)\\bash\.exe$/i.test(file))
      ?? found.find((file) => !/\\Windows\\(?:System32|Apps)\\/i.test(file)) ?? 'bash';
  } catch { return 'bash'; }
}

export async function runTable(args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)
      || typeof args.script !== 'string' || !args.script.trim()) {
    return toolError('script is required');
  }
  const extra = Object.keys(args).find((key) => !['script', 'cwd', 'title'].includes(key));
  if (extra) return toolError(`unknown run_table argument: ${extra}`);
  if (args.title !== undefined && typeof args.title !== 'string') {
    return toolError('title must be a string');
  }
  if (args.cwd !== undefined && (typeof args.cwd !== 'string' || !path.isAbsolute(args.cwd))) {
    return toolError('cwd must be an absolute path');
  }
  const cwd = args.cwd ?? process.cwd();
  try {
    if (!fs.statSync(cwd).isDirectory()) throw new Error();
  } catch {
    return toolError(`cwd is not a directory: ${cwd}`);
  }
  let stdout = '', stderr = '';
  try {
    ({ stdout, stderr } = await exec(bash(), ['-lc', args.script], {
      cwd, encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    }));
  } catch (error) {
    stdout = String(error.stdout ?? '');
    stderr = String(error.stderr ?? error.message ?? error);
    const exitCode = Number.isInteger(error.code) ? error.code : 1;
    return toolError([`command exited ${exitCode}`, stdout, stderr].filter(Boolean).join('\n'));
  }
  const data = parseTsv(stdout);
  if (!data) {
    return toolError(['stdout is not valid strict TSV', stdout, stderr].filter(Boolean).join('\n'));
  }
  const result = {
    schema: 'vibench.data.v1', kind: 'table', command: args.script, cwd,
    exitCode: 0, stdout, stderr, data,
  };
  return {
    content: [{ type: 'text', text: `${DATA_MARKER}\n${JSON.stringify(result)}` }],
    structuredContent: result,
  };
}

async function handle(request) {
  if (request.method === 'initialize') {
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'vibench', version: VERSION },
      instructions: "Use run_table for Bash commands whose stdout is tabular data. It must emit strict TSV: a unique non-empty header with at least two columns, at least one data row, and no ragged rows. Use workspace_state whenever the user refers to what is open, focused, visible, or selected in Neovim.",
    };
  }
  if (request.method === 'ping') return {};
  if (request.method === 'tools/list') return { tools: [WORKSPACE_STATE_TOOL, RUN_TABLE_TOOL] };
  if (request.method === 'tools/call') {
    if (request.params?.name === WORKSPACE_STATE_TOOL.name) {
      const args = request.params.arguments;
      if (args !== undefined && (!args || typeof args !== 'object' || Array.isArray(args)
          || Object.keys(args).length > 0)) {
        throw Object.assign(new Error('workspace_state takes no arguments'), { code: -32602 });
      }
      return workspaceState();
    }
    if (request.params?.name === RUN_TABLE_TOOL.name) {
      return runTable(request.params.arguments);
    }
    throw Object.assign(new Error(`unknown tool: ${request.params?.name ?? ''}`), { code: -32602 });
  }
  throw Object.assign(new Error(`method not found: ${request.method}`), { code: -32601 });
}

export async function startMcp() {
  const socket = process.env.VIBENCH_TMUX_SOCKET;
  const id = resolvePaneSession((...args) => execFileSync('tmux', ['-L', socket, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 2000,
  }), process.env);
  if (id) process.env.VIBENCH_SESSION = id;
  else delete process.env.VIBENCH_SESSION;
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const inFlight = new Set();
  for await (const line of lines) {
    let request;
    try { request = JSON.parse(line); } catch {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0', id: null,
        error: { code: -32700, message: 'parse error' },
      })}\n`);
      continue;
    }
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0', id: null,
        error: { code: -32600, message: 'invalid request' },
      })}\n`);
      continue;
    }
    if (request.id === undefined) continue;
    const done = handle(request).then(
      (result) => ({ jsonrpc: '2.0', id: request.id, result }),
      (error) => ({
        jsonrpc: '2.0', id: request.id,
        error: { code: error.code ?? -32603, message: error.message ?? String(error) },
      }),
    ).then((message) => process.stdout.write(`${JSON.stringify(message)}\n`));
    inFlight.add(done);
    done.finally(() => inFlight.delete(done));
  }
  await Promise.allSettled(inFlight);
}

const normalize = (file) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
if (process.argv[1] && normalize(process.argv[1]) === normalize(ENTRYPOINT)) await startMcp();
