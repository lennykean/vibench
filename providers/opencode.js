// OpenCode stores sessions in one SQLite database (session, message, and part
// rows with JSON payloads). Message parts mutate in place while a tool runs,
// so this provider rebuilds the step timeline whenever the store changes and
// reports in-place updates through the shared pending-step path.
//
// Phase 1 covers sessions with a known id only (spawned agents, peers,
// --watch-only, --session resume). OpenCode publishes no pid record, so
// interactive pane matching waits for an OpenCode plugin.
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

export const name = 'opencode';

const require = createRequire(import.meta.url);
let sqliteModule;
function sqlite() {
  if (sqliteModule === undefined) {
    try {
      const mod = require('node:sqlite');
      sqliteModule = typeof mod?.DatabaseSync === 'function' ? mod : null;
    } catch { sqliteModule = null; }
  }
  return sqliteModule;
}
export function sqliteSupported() {
  return !!sqlite();
}

export function validateSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !/^ses_[A-Za-z0-9]{8,128}$/.test(sessionId)) {
    throw new Error('invalid OpenCode session id');
  }
  return sessionId;
}

export function resumeArgs(sessionId) {
  return ['--session', validateSessionId(sessionId)];
}

// OpenCode cannot pre-create a session, so spawned agents report their id
// after launch: headless children print it in the --format json event stream,
// and peers are found in the store by workspace and spawn time.
export function spawnPlan(mode, prompt) {
  return mode === 'subagent'
    ? { args: ['run', '--format', 'json', prompt], discover: 'output' }
    : { args: ['--prompt', prompt], discover: 'store' };
}

const sameDirectory = (left, right) => {
  const normalizeDir = (value) => {
    const text = String(value ?? '').replaceAll('\\', '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? text.toLowerCase() : text;
  };
  return normalizeDir(left) === normalizeDir(right);
};

export async function discoverSessionId({ output, workspace, after } = {}) {
  const fromOutput = /\bses_[A-Za-z0-9]{8,128}\b/.exec(output ?? '')?.[0];
  if (fromOutput) return fromOutput;
  if (!sqlite() || typeof workspace !== 'string' || !workspace) return null;
  const since = Date.parse(after ?? '') || 0;
  let db;
  try { db = openDatabase(databasePath()); } catch { return null; }
  try {
    const rows = db.prepare(
      'select id, directory from session where time_created >= ? order by time_created limit 50',
    ).all(since);
    return rows.find((row) => sameDirectory(row.directory, workspace))?.id ?? null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export function databasePath(env = process.env, home = os.homedir()) {
  if (env.VIBENCH_OPENCODE_DB) return env.VIBENCH_OPENCODE_DB;
  const data = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(data, 'opencode', 'opencode.db');
}

function openDatabase(file) {
  return new (sqlite().DatabaseSync)(file, { readOnly: true });
}

export async function locate({ session }) {
  const id = session?.harness_session_id;
  try { validateSessionId(id); }
  catch {
    return { reason: 'OpenCode needs a known session id (--session, --watch-only, or a spawned agent)' };
  }
  if (!sqlite()) {
    return { id, reason: 'reading OpenCode sessions needs node:sqlite in this Node runtime' };
  }
  const file = databasePath();
  let db;
  try { db = openDatabase(file); }
  catch { return { id, reason: `no OpenCode database at ${file}` }; }
  try {
    const row = db.prepare('select id from session where id = ?').get(id);
    if (!row) return { id, reason: 'no matching OpenCode session' };
    return { store: { key: file, id }, id, via: 'session-id' };
  } catch {
    return { id, reason: 'unsupported OpenCode database schema' };
  } finally {
    db.close();
  }
}

const lineCount = (content) => {
  if (!content) return 0;
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines.length;
};

const diffLines = (content) => {
  if (!content) return [];
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
};

const titleText = (value) => {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
};

function toolTitle(tool, input, state) {
  if (typeof input.filePath === 'string') {
    return titleText(input.filePath.split(/[\\/]/).at(-1) ?? input.filePath);
  }
  const values = tool === 'bash'
    ? [input.description, input.command]
    : [state.title, input.description, input.pattern, input.query, input.prompt,
      input.url, input.path, input.command];
  return values.map(titleText).find(Boolean) ?? '';
}

const isoTime = (value) => Number.isFinite(Number(value)) && Number(value) > 0
  ? new Date(Number(value)).toISOString() : null;

function rememberTime(state, at) {
  if (!at) return;
  state.started_at ??= at;
  state.last_at = at;
}

function chatEvent(state, at, cwd, value) {
  const eventKind = value.kind;
  const details = { ...value };
  delete details.kind;
  const step = {
    i: state.steps.length, kind: 'chat', category: 'chat', event: eventKind,
    ...details, at, cwd, record_id: null,
  };
  state.steps.push(step);
  state.done.add(step.i);
  state.events.push({ ...step, kind: eventKind, position: step.i });
  return state.events.length - 1;
}

function fail(step, error) {
  const action = step.kind;
  const { i, category, at, cwd, path: file, command, tool, title, params } = step;
  for (const key of Object.keys(step)) delete step[key];
  Object.assign(step, {
    i, kind: 'error', category, action, at, cwd,
    ...(file !== undefined ? { path: file } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(params !== undefined ? { params } : {}),
    tool, title,
    error,
  });
}

// OpenCode read output wraps the file in <content> tags with "N: " line
// numbers. Reconstruct the raw lines so shared anchoring can use them.
export function parseReadOutput(output) {
  const open = output.indexOf('<content>');
  const close = output.lastIndexOf('</content>');
  if (open < 0 || close <= open) return null;
  let body = output.slice(open + '<content>'.length, close);
  if (body.startsWith('\n')) body = body.slice(1);
  if (body.endsWith('\n')) body = body.slice(0, -1);
  const rawLines = body === '' ? [] : body.split('\n');
  const lines = [];
  let start = null;
  let expected = null;
  for (const raw of rawLines) {
    const match = /^(\d+): ?(.*)$/.exec(raw);
    if (!match) return null;
    const number = Number(match[1]);
    if (expected !== null && number !== expected) return null;
    start ??= number;
    expected = number + 1;
    lines.push(match[2]);
  }
  if (start === null) start = 1;
  return { content: lines.join('\n'), start, count: lines.length };
}

// Parse the unified diff text OpenCode records for an edit into the shared
// hunk format. Returns null when the text does not validate.
export function parseUnifiedDiff(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const hunks = [];
  let current = null;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of lines) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      hunks.push(current);
      oldLeft = current.oldLines;
      newLeft = current.newLines;
      continue;
    }
    if (!current) continue;
    if (line.startsWith('\\')) { current.lines.push(line); continue; }
    if (oldLeft <= 0 && newLeft <= 0) { current = null; continue; }
    const operation = line === '' ? ' ' : line[0];
    if (operation === ' ') {
      if (oldLeft <= 0 || newLeft <= 0) return null;
      oldLeft -= 1;
      newLeft -= 1;
      current.lines.push(line === '' ? ' ' : line);
    } else if (operation === '-') {
      if (oldLeft <= 0) return null;
      oldLeft -= 1;
      current.lines.push(line);
    } else if (operation === '+') {
      if (newLeft <= 0) return null;
      newLeft -= 1;
      current.lines.push(line);
    } else return null;
  }
  for (const hunk of hunks) {
    const before = hunk.lines.filter((line) => line[0] === ' ' || line[0] === '-').length;
    const after = hunk.lines.filter((line) => line[0] === ' ' || line[0] === '+').length;
    if (before !== hunk.oldLines || after !== hunk.newLines) return null;
  }
  return hunks.length ? hunks : null;
}

function fallbackHunks(input) {
  if (typeof input.oldString !== 'string' || typeof input.newString !== 'string') return [];
  const before = diffLines(input.oldString);
  const after = diffLines(input.newString);
  const lines = before.map((line) => `-${line}`);
  lines.push(...after.map((line) => `+${line}`));
  if (input.oldString.endsWith('\n') !== input.newString.endsWith('\n')) {
    lines.push(input.oldString.endsWith('\n')
      ? '\\ No newline at end of replacement text'
      : '\\ No newline at end of removed text');
  }
  return [{ oldStart: 0, oldLines: before.length, newStart: 0, newLines: after.length, lines }];
}

function completeRead(step, input, state, metadata) {
  const output = typeof state.output === 'string' ? state.output : '';
  const parsed = parseReadOutput(output);
  if (!parsed) {
    step.content = output;
    step.start_line = 1;
    step.num_lines = null;
    step.total_lines = null;
    step.full = false;
    return;
  }
  step.content = parsed.content;
  step.start_line = parsed.start;
  step.num_lines = parsed.count;
  const explicitRange = Number(input.offset) > 0 || input.limit != null;
  step.full = !explicitRange && parsed.start === 1 && metadata.truncated !== true;
  step.total_lines = step.full ? parsed.count : null;
}

function completeEdit(step, input, state, metadata) {
  const diffText = typeof metadata.diff === 'string' ? metadata.diff
    : typeof metadata.filediff?.patch === 'string' ? metadata.filediff.patch : null;
  let hunks = diffText ? parseUnifiedDiff(diffText) : null;
  if (!hunks?.length) hunks = fallbackHunks(input);
  step.hunks = hunks;
  step.opaque = !hunks.length || hunks.some((hunk) =>
    hunk.lines?.some((line) => typeof line === 'string' && line.startsWith('\\')));
  if (step.opaque) step.result = typeof state.output === 'string' ? state.output : '';
}

function toolStep(state, at, cwd, part, partRowId) {
  const toolState = part.state && typeof part.state === 'object' ? part.state : {};
  const input = toolState.input && typeof toolState.input === 'object' ? toolState.input : {};
  const metadata = toolState.metadata && typeof toolState.metadata === 'object'
    ? toolState.metadata : {};
  const status = typeof toolState.status === 'string' ? toolState.status : 'pending';
  const settled = status === 'completed' || status === 'error';
  const tool = typeof part.tool === 'string' ? part.tool : 'unknown';
  const common = { i: state.steps.length, at, cwd, tool, title: toolTitle(tool, input, toolState) };
  let step;
  if (tool === 'bash' && typeof input.command === 'string') {
    step = { ...common, kind: 'terminal', command: input.command, output: '', exit: null };
  } else if (tool === 'read' && typeof input.filePath === 'string') {
    step = { ...common, kind: 'read', path: input.filePath };
  } else if (tool === 'edit' && typeof input.filePath === 'string') {
    step = { ...common, kind: 'patch', path: input.filePath };
  } else if (tool === 'write' && typeof input.filePath === 'string') {
    step = { ...common, kind: 'write', path: input.filePath };
  }
  step ??= { ...common, kind: 'other' };
  step.category = step.kind === 'terminal' ? 'terminal'
    : ['read', 'patch', 'write'].includes(step.kind) ? 'file'
      : 'tool_info';
  if (step.kind !== 'terminal') step.params = input;

  if (step.kind === 'terminal' && settled) {
    step.output = typeof metadata.output === 'string' ? metadata.output
      : typeof toolState.output === 'string' ? toolState.output : '';
    step.exit = Number.isSafeInteger(metadata.exit) ? metadata.exit : null;
    if (status === 'error' || Number.isFinite(step.exit) && step.exit !== 0) step.failed = true;
    if (status === 'error' && !step.output) {
      step.output = typeof toolState.error === 'string' ? toolState.error : '';
    }
  } else if (status === 'error') {
    fail(step, typeof toolState.error === 'string' ? toolState.error
      : typeof toolState.output === 'string' ? toolState.output : 'tool call failed');
  } else if (status === 'completed') {
    if (step.kind === 'read') completeRead(step, input, toolState, metadata);
    else if (step.kind === 'patch') completeEdit(step, input, toolState, metadata);
    else if (step.kind === 'write') {
      step.content = typeof input.content === 'string' ? input.content : '';
      step.region = { start_line: 1, end_line: Math.max(1, lineCount(step.content)) };
    } else if (step.kind === 'other') {
      step.result = typeof toolState.output === 'string' ? toolState.output : '';
    }
    if (step.kind !== 'terminal') {
      step.response = typeof toolState.output === 'string' ? toolState.output : null;
    }
  }

  const callId = typeof part.callID === 'string' && part.callID ? part.callID : `part:${partRowId}`;
  state.calls.set(callId, step.i);
  state.steps.push(step);
  if (settled) state.done.add(step.i);
}

function build(db, id, sessionRow, state) {
  state.steps = [];
  state.calls = new Map();
  state.done = new Set();
  state.events = [];
  state.children ??= new Map();
  state.sidechains ??= new Map();
  state.spawnEvents ??= new Map();
  state.started_at = undefined;
  state.last_at = undefined;
  const messages = db.prepare(
    'select id, time_created, data from message where session_id = ? order by time_created, id',
  ).all(id);
  const parts = db.prepare(
    'select message_id, id, time_created, data from part where session_id = ? order by time_created, id',
  ).all(id);
  const byMessage = new Map();
  for (const part of parts) {
    if (!byMessage.has(part.message_id)) byMessage.set(part.message_id, []);
    byMessage.get(part.message_id).push(part);
  }
  const cwd = typeof sessionRow.directory === 'string' ? sessionRow.directory : null;
  for (const row of messages) {
    let message;
    try { message = JSON.parse(row.data); } catch { continue; }
    const role = message?.role === 'user' ? 'user' : 'assistant';
    for (const partRow of byMessage.get(row.id) ?? []) {
      let part;
      try { part = JSON.parse(partRow.data); } catch { continue; }
      const at = isoTime(partRow.time_created ?? row.time_created);
      rememberTime(state, at);
      if (part?.type === 'text') {
        if (typeof part.text === 'string' && part.text) {
          chatEvent(state, at, cwd, { kind: 'message', role, content: part.text });
        }
      } else if (part?.type === 'reasoning') {
        chatEvent(state, at, cwd, {
          kind: 'thinking', content: typeof part.text === 'string' ? part.text : '',
        });
      } else if (part?.type === 'tool') {
        toolStep(state, at, cwd, part, partRow.id);
      }
      // step-start, step-finish, and compaction parts carry no timeline value
    }
  }
}

export async function sync(found, state) {
  const db = openDatabase(found.store.key);
  try {
    let sessionRow;
    let messageStats;
    let partStats;
    try {
      sessionRow = db.prepare(
        'select id, directory, time_created, time_updated from session where id = ?',
      ).get(found.store.id);
      messageStats = db.prepare(
        'select count(*) as n, coalesce(max(time_updated), 0) as m from message where session_id = ?',
      ).get(found.store.id);
      partStats = db.prepare(
        'select count(*) as n, coalesce(max(time_updated), 0) as m from part where session_id = ?',
      ).get(found.store.id);
    } catch (error) {
      throw Object.assign(new Error('unsupported OpenCode database schema'), { cause: error });
    }
    if (!sessionRow) throw Object.assign(new Error('OpenCode session no longer exists'), { code: 'ENOENT' });
    const signature = [sessionRow.time_created, sessionRow.time_updated,
      messageStats.n, messageStats.m, partStats.n, partStats.m].join(':');
    const previous = state.opencode;
    if (previous?.signature === signature) return {};
    if (previous && (previous.created !== sessionRow.time_created
        || messageStats.n < previous.messages || partStats.n < previous.parts)) {
      return { rebuild: true };
    }
    const previousSteps = state.steps.length;
    const previousDone = new Set(state.done);
    build(db, found.store.id, sessionRow, state);
    const completed = [...state.done]
      .some((index) => index < previousSteps && !previousDone.has(index));
    const appended = state.steps.slice(previousSteps).some((step) => step.kind !== 'chat');
    state.inPlaceCompletion = previous ? completed || !appended : false;
    state.opencode = {
      signature, created: sessionRow.time_created,
      messages: messageStats.n, parts: partStats.n,
    };
    state.sourceMtime = Math.max(Number(sessionRow.time_updated) || 0,
      Number(messageStats.m) || 0, Number(partStats.m) || 0) || null;
    return {};
  } finally {
    db.close();
  }
}
