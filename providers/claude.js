import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

export const name = 'claude-code';
export function validateSessionId(sessionId) {
  if (typeof sessionId !== 'string'
      || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)) {
    throw new Error('invalid Claude session id');
  }
  return sessionId;
}
export function resumeArgs(sessionId) {
  return ['--resume', validateSessionId(sessionId)];
}
const sessions = () => process.env.VIBENCH_CLAUDE_SESSIONS || path.join(os.homedir(), '.claude', 'sessions');
const projects = () => process.env.VIBENCH_CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects');
const childScans = new Map();
const slug = (pwd) => pwd.replace(/[:\\/.]/g, '-');
const startToken = (value) => String(value).replace(/\s+/g, ' ').trim();
const flatten = (content) => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((part) => typeof part === 'string' ? part : part?.text ?? '').join('\n')
  : content?.text ?? '';
const responseData = (part, result) => {
  const text = flatten(part.content);
  const empty = Array.isArray(result) ? result.length === 0
    : result && typeof result === 'object' ? Object.keys(result).length === 0 : false;
  return empty && text ? text : result ?? text;
};
const isTableTool = (tool) => /^(?:mcp__)?vibench__run_table$/.test(String(tool));
const tableEnvelope = (value) => {
  if (value?.schema === 'vibench.data.v1' && value.kind === 'table'
      && typeof value.command === 'string' && typeof value.cwd === 'string'
      && value.exitCode === 0 && typeof value.stdout === 'string' && typeof value.stderr === 'string'
      && Array.isArray(value.data?.columns) && value.data.columns.length >= 2
      && value.data.columns.every((cell) => typeof cell === 'string' && cell !== '')
      && new Set(value.data.columns).size === value.data.columns.length
      && Array.isArray(value.data.rows) && value.data.rows.length > 0
      && value.data.rows.every((row) => Array.isArray(row)
        && row.length === value.data.columns.length
        && row.every((cell) => typeof cell === 'string'))) return value;
  if (value && typeof value === 'object') {
    for (const key of ['structuredContent', 'structured_content']) {
      const found = tableEnvelope(value[key]);
      if (found) return found;
    }
    if (Array.isArray(value.content)) {
      for (const item of value.content) {
        const found = tableEnvelope(item?.text ?? item);
        if (found) return found;
      }
    }
  }
  if (typeof value !== 'string') return null;
  const marker = value.indexOf('VIBENCH_DATA_V1');
  const text = marker >= 0 ? value.slice(marker + 'VIBENCH_DATA_V1'.length).trim() : value.trim();
  try { return tableEnvelope(JSON.parse(text)); } catch { return null; }
};
const titleText = (value) => {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
};
const toolTitle = (tool, input) => {
  input = input && typeof input === 'object' ? input : {};
  const file = input.file_path ?? input.notebook_path;
  if (typeof file === 'string') return titleText(file.split(/[\\/]/).at(-1) ?? file);
  const values = tool === 'Bash' || tool === 'PowerShell'
    ? [input.description, input.command]
    : [input.description, input.pattern, input.query, input.prompt, input.url, input.path, input.command];
  return values.map(titleText).find(Boolean) ?? '';
};
const timeline = (state) => state.steps ?? state.blocks;
const validAgentId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
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

function fallbackHunks(tool, input) {
  const edits = tool === 'Edit' ? [input] : tool === 'MultiEdit' && Array.isArray(input?.edits) ? input.edits : [];
  return edits.flatMap((edit) => {
    if (typeof edit?.old_string !== 'string' || typeof edit?.new_string !== 'string') return [];
    const before = diffLines(edit.old_string);
    const after = diffLines(edit.new_string);
    const lines = before.map((line) => `-${line}`);
    lines.push(...after.map((line) => `+${line}`));
    if (edit.old_string.endsWith('\n') !== edit.new_string.endsWith('\n')) {
      lines.push(edit.old_string.endsWith('\n')
        ? '\\ No newline at end of replacement text'
        : '\\ No newline at end of removed text');
    }
    return [{
      oldStart: 0, oldLines: before.length, newStart: 0, newLines: after.length,
      lines,
    }];
  });
}

function cloneHunks(hunks) {
  return hunks.map((hunk) => hunk && typeof hunk === 'object' ? {
    ...hunk,
    ...(Array.isArray(hunk.lines) ? { lines: [...hunk.lines] } : {}),
  } : hunk);
}

function failed(part, result) {
  return part.is_error === true || result?.isError === true || result?.is_error === true;
}

function failStep(step, part) {
  const action = step.kind;
  const error = flatten(part.content);
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

function completeTerminal(step, part, result) {
  const shell = result && typeof result === 'object'
    && (result.stdout !== undefined || result.stderr !== undefined);
  step.output = shell ? `${result.stdout ?? ''}${result.stderr ?? ''}` : flatten(part.content);
  step.exit = result?.exitCode ?? result?.exit_code ?? result?.code ?? null;
  if (failed(part, result) || Number.isFinite(step.exit) && step.exit !== 0) step.failed = true;
}

function completeRead(step, part, result) {
  if (failed(part, result)) return failStep(step, part);
  const file = result?.file && typeof result.file === 'object' ? result.file : null;
  const structured = typeof file?.content === 'string' ? file.content
    : typeof result?.content === 'string' ? result.content : null;
  const hasResponse = typeof part.content === 'string' || Array.isArray(part.content)
    || typeof part.content?.text === 'string';
  const content = structured ?? (hasResponse ? flatten(part.content) : null);
  if (content === null) return failStep(step, { content: 'Read result did not include captured file content' });
  const start = Number.isSafeInteger(file?.startLine) ? file.startLine : step._start_line;
  const captured = lineCount(content);
  const complete = Number.isSafeInteger(file?.numLines) && file.numLines === file.totalLines;
  const normalizeCount = (value) => Number.isSafeInteger(value)
    ? complete && content.endsWith('\n') && value === captured + 1 ? captured : value
    : null;
  const count = normalizeCount(file?.numLines);
  const total = normalizeCount(file?.totalLines);
  step.path = typeof file?.filePath === 'string' ? file.filePath : step.path;
  step.content = content;
  step.start_line = start;
  step.num_lines = count;
  step.total_lines = total;
  step.full = structured !== null && !file?.truncatedByTokenCap
    && start === 1 && count !== null && total !== null
    && count === total && (captured === total || content === '' && total === 1);
  delete step._start_line;
}

function completePatch(step, part, result) {
  if (failed(part, result)) return failStep(step, part);
  step.path = typeof result?.filePath === 'string' ? result.filePath
    : typeof result?.notebookPath === 'string' ? result.notebookPath : step.path;
  const structured = Array.isArray(result?.structuredPatch);
  step.hunks = structured ? cloneHunks(result.structuredPatch) : step._fallback_hunks ?? [];
  delete step._fallback_hunks;
  step.opaque = !step.hunks.length || step.hunks.some((hunk) =>
    hunk.lines?.some((line) => typeof line === 'string' && line.startsWith('\\')));
  if (typeof result?.originalFile === 'string') step._before = result.originalFile;
  if (step.opaque) step.result = flatten(part.content);
}

function completeWrite(step, part, result) {
  if (failed(part, result)) return failStep(step, part);
  step.path = typeof result?.filePath === 'string' ? result.filePath : step.path;
  step.content = typeof result?.content === 'string' ? result.content : step._content;
  step.region = { start_line: 1, end_line: Math.max(1, lineCount(step.content)) };
  delete step._content;
}

function completeData(step, part, result) {
  if (failed(part, result)) return failStep(step, part);
  const envelope = tableEnvelope(result) ?? tableEnvelope(flatten(part.content));
  if (!envelope) return failStep(step, { content: 'run_table result did not include valid captured table data' });
  step.command = envelope.command;
  step.cwd = envelope.cwd;
  step.table = {
    columns: [...envelope.data.columns],
    rows: envelope.data.rows.map((row) => [...row]),
  };
  step.stdout = envelope.stdout;
  step.stderr = envelope.stderr;
  step.exit = envelope.exitCode;
}

function completeOther(step, part, result) {
  if (failed(part, result)) return failStep(step, part);
  step.result = flatten(part.content);
}

function ensureState(state) {
  state.events ??= [];
  state.children ??= new Map();
  state.sidechains ??= new Map();
  state.spawnEvents ??= new Map();
}

function rememberTime(state, record) {
  if (typeof record.timestamp !== 'string' || Number.isNaN(Date.parse(record.timestamp))) return;
  state.started_at ??= record.timestamp;
  state.last_at = record.timestamp;
}

function event(state, record, value) {
  const eventKind = value.event ?? value.kind;
  const details = { ...value };
  delete details.event;
  delete details.kind;
  const step = {
    i: timeline(state).length,
    kind: 'chat',
    category: 'chat',
    event: eventKind,
    ...details,
    at: record.timestamp ?? null,
    cwd: record.cwd ?? null,
    record_id: record.uuid ?? null,
  };
  timeline(state).push(step);
  state.done.add(step.i);
  state.events.push({ ...step, kind: eventKind, position: step.i });
  return state.events.length - 1;
}

function tag(text, name) {
  return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i').exec(text)?.[1]?.trim() ?? null;
}

function notification(text) {
  if (typeof text !== 'string' || !text.includes('<task-notification>')) return null;
  const body = tag(text, 'task-notification') ?? text;
  const id = tag(body, 'task-id');
  if (!validAgentId(id)) return null;
  return {
    task_id: id,
    tool_call_id: tag(body, 'tool-use-id'),
    status: tag(body, 'status'),
    summary: tag(body, 'summary'),
    result: tag(body, 'result'),
  };
}

function rememberNotification(state, record, note) {
  const isAgent = state.children.has(note.task_id) || state.sidechains.has(note.task_id)
    || /^a[0-9a-f]{16,}$/i.test(note.task_id);
  if (isAgent) {
    const previous = state.children.get(note.task_id) ?? { id: note.task_id };
    state.children.set(note.task_id, {
      ...previous,
      status: note.status ?? previous.status ?? null,
      ended_at: record.timestamp ?? previous.ended_at ?? null,
    });
  }
  event(state, record, {
    kind: isAgent ? 'agent_peer' : 'task',
    ...note,
    ...(isAgent ? { agent_id: note.task_id } : {}),
  });
}

function rememberMessage(state, record, role, content) {
  if (typeof content !== 'string' || !content) return;
  if (role === 'user' && record.origin?.kind === 'peer') {
    const origin = record.origin;
    event(state, record, {
      kind: 'agent_peer',
      agent_id: validAgentId(origin.senderTaskId) ? origin.senderTaskId : null,
      name: typeof origin.name === 'string' ? origin.name
        : typeof origin.from === 'string' ? origin.from : null,
      content: typeof origin.body === 'string' ? origin.body : content,
    });
    return;
  }
  const trustedNotification = role === 'user' && record.origin?.kind === 'task-notification';
  const note = trustedNotification ? notification(content) : null;
  if (note) rememberNotification(state, record, note);
  else event(state, record, { kind: 'message', role, content });
}

function rememberChild(state, record, part, step, result) {
  const id = result?.agentId;
  if (step.tool !== 'Agent' || !validAgentId(id)) return;
  const previous = state.children.get(id) ?? {};
  const terminal = /^(completed|failed|stopped|cancelled|killed)$/i.test(result.status ?? '');
  const child = {
    ...previous,
    id,
    parent_agent_id: state.agent_id ?? step.caller?.agent_id ?? null,
    tool_call_id: part.tool_use_id,
    description: result.description ?? step.params?.description ?? previous.description ?? null,
    subtype: step.params?.subagent_type ?? previous.subtype ?? null,
    model: result.resolvedModel ?? previous.model ?? null,
    status: result.status ?? previous.status ?? null,
    spawned_at: step.at ?? record.timestamp ?? previous.spawned_at ?? null,
    spawn_position: step.i + 1,
    ...(terminal ? { ended_at: record.timestamp ?? previous.ended_at ?? null } : {}),
  };
  state.children.set(id, child);
  const index = state.spawnEvents.get(part.tool_use_id);
  if (index !== undefined) {
    const update = { agent_id: id, status: child.status, model: child.model };
    Object.assign(state.events[index], update);
    Object.assign(timeline(state)[state.events[index].position], update);
  }
}

function consumeRecord(record, state) {
  rememberTime(state, record);
  const content = record.message?.content;
  if (record.type === 'assistant') {
    if (typeof content === 'string') rememberMessage(state, record, 'assistant', content);
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === 'text') rememberMessage(state, record, 'assistant', part.text);
        else if (part?.type === 'thinking') {
          event(state, record, {
            kind: 'thinking', content: typeof part.thinking === 'string' ? part.thinking : '',
            redacted: !part.thinking && typeof part.signature === 'string',
          });
        }
        if (part?.type !== 'tool_use' || typeof part.id !== 'string') continue;
        const tool = typeof part.name === 'string' ? part.name : 'unknown';
        const common = {
          i: timeline(state).length, at: record.timestamp ?? null, cwd: record.cwd ?? null,
          tool, title: toolTitle(tool, part.input),
          ...(part.caller && typeof part.caller === 'object' ? { caller: {
            type: part.caller.type ?? null, agent_id: part.caller.agent_id ?? null,
          } } : {}),
        };
        let step;
        if (['Bash', 'PowerShell'].includes(part.name) && typeof part.input?.command === 'string') {
          step = { ...common, kind: 'terminal', command: part.input.command, output: '', exit: null };
        } else if (part.name === 'Read' && typeof part.input?.file_path === 'string') {
          const start = Number.isSafeInteger(part.input.offset) && part.input.offset >= 1 ? part.input.offset : 1;
          step = { ...common, kind: 'read', path: part.input.file_path, _start_line: start };
        } else if (['Edit', 'MultiEdit', 'NotebookEdit'].includes(part.name)) {
          const file = part.input?.file_path ?? part.input?.notebook_path;
          if (typeof file === 'string') {
            step = { ...common, kind: 'patch', path: file };
            const fallback = fallbackHunks(part.name, part.input);
            if (fallback.length) step._fallback_hunks = fallback;
          }
        } else if (part.name === 'Write' && typeof part.input?.file_path === 'string'
            && typeof part.input?.content === 'string') {
          step = { ...common, kind: 'write', path: part.input.file_path, _content: part.input.content };
        } else if (isTableTool(part.name)) {
          step = {
            ...common, kind: 'data', command: typeof part.input?.script === 'string' ? part.input.script : '',
            title: titleText(part.input?.title) || 'table',
          };
        }
        step ??= { ...common, kind: 'other' };
        step.category = step.kind === 'terminal' ? 'terminal'
          : ['read', 'patch', 'write'].includes(step.kind) ? 'file'
            : step.kind === 'data' ? 'data'
            : 'tool_info';
        if (step.kind !== 'terminal') step.params = part.input ?? {};
        state.calls.set(part.id, step.i);
        timeline(state).push(step);
        if (tool === 'Agent') {
          const index = event(state, record, {
            event: 'agent_spawn', tool_call_id: part.id,
            description: part.input?.description ?? null,
            subtype: part.input?.subagent_type ?? null,
          });
          state.spawnEvents.set(part.id, index);
        }
      }
    }
  }
  if (record.type !== 'user') return;
  if (typeof content === 'string') rememberMessage(state, record, 'user', content);
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (typeof part === 'string') rememberMessage(state, record, 'user', part);
    else if (part?.type === 'text') rememberMessage(state, record, 'user', part.text);
  }
  const results = content.filter((part) => part?.type === 'tool_result');
  for (const part of results) {
    const index = state.calls.get(part.tool_use_id);
    const result = results.length === 1 ? record.toolUseResult : null;
    if (index === undefined) continue;
    const step = timeline(state)[index];
    if (!step) continue;
    if (step.kind === 'terminal') completeTerminal(step, part, result);
    else if (step.kind === 'read') completeRead(step, part, result);
    else if (step.kind === 'patch') completePatch(step, part, result);
    else if (step.kind === 'write') completeWrite(step, part, result);
    else if (step.kind === 'data') completeData(step, part, result);
    else if (step.kind === 'other') completeOther(step, part, result);
    if (step.kind !== 'terminal' && step.action !== 'terminal') step.response = responseData(part, result);
    rememberChild(state, record, part, step, result);
    state.done.add(index);
  }
}

async function locateBySessionId(id) {
  if (!validAgentId(id)) return { reason: 'invalid Claude session id' };
  let entries;
  try { entries = await fs.promises.readdir(projects(), { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return { reason: 'no matching Claude session' };
    throw error;
  }
  const matches = (await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory()) return null;
    const file = path.join(projects(), entry.name, `${id}.jsonl`);
    try { return (await fs.promises.stat(file)).isFile() ? file : null; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }))).filter(Boolean);
  if (matches.length !== 1) return {
    reason: matches.length ? `ambiguous Claude session: ${matches.length} matches`
      : 'no matching Claude session',
  };
  return { file: matches[0], id, via: 'session-id' };
}

export async function locate({ session, processes = [] }) {
  if (session?.watch_only === true) return locateBySessionId(session.harness_session_id);
  const live = new Map();
  for (const process of processes) {
    if (!Number.isSafeInteger(process?.pid) || process.pid <= 0 || !Array.isArray(process.starts)) continue;
    const starts = live.get(process.pid) ?? new Set();
    for (const start of process.starts) {
      if ((typeof start === 'string' && start.length) || (typeof start === 'number' && Number.isFinite(start))) starts.add(startToken(start));
    }
    live.set(process.pid, starts);
  }

  let entries;
  try { entries = await fs.promises.readdir(sessions(), { withFileTypes: true }); }
  catch (e) { if (e.code === 'ENOENT') return { reason: 'no matching Claude session' }; throw e; }
  const read = async (entry) => {
    if (!entry.isFile() || !/^\d+\.json$/.test(entry.name)) return null;
    const pid = Number(entry.name.slice(0, -5));
    if (!Number.isSafeInteger(pid) || pid <= 0 || !live.has(pid)) return null;
    try {
      const record = JSON.parse(await fs.promises.readFile(path.join(sessions(), entry.name), 'utf8'));
      if (record?.pid !== pid || typeof record.sessionId !== 'string' || !record.sessionId.trim()
        || typeof record.cwd !== 'string' || !record.cwd.trim()) return null;
      const starts = [record.procStartFt, record.procStart]
        .filter((start) => (typeof start === 'string' && start.length) || (typeof start === 'number' && Number.isFinite(start)))
        .map(startToken);
      return starts.some((start) => live.get(pid).has(start)) ? record : null;
    } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; return null; }
  };
  const matches = (await Promise.all(entries.map(read))).filter(Boolean);
  if (matches.length !== 1) return { reason: matches.length ? `ambiguous Claude session: ${matches.length} matches` : 'no matching Claude session' };
  const [record] = matches;
  const file = path.join(projects(), slug(record.cwd), `${record.sessionId}.jsonl`);
  try {
    if ((await fs.promises.stat(file)).isFile()) {
      return { file, id: record.sessionId, pid: record.pid, via: 'pid-session' };
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { id: record.sessionId, pid: record.pid, via: 'pid-session', reason: 'transcript not yet created' };
}

export function consume(line, state) {
  let record;
  try { record = JSON.parse(line); } catch { return; }
  ensureState(state);
  if (record.isSidechain) {
    if (!validAgentId(record.agentId)) return;
    if (state.agent_id) {
      if (state.agent_id !== record.agentId
          || state.source_session_id && state.source_session_id !== record.sessionId) {
        state.invalid_source = true;
        return;
      }
      consumeRecord(record, state);
      return;
    }
    if (!state.source_session_id || state.source_session_id !== record.sessionId) return;
    let child = state.sidechains.get(record.agentId);
    if (!child) {
      child = {
        agent_id: record.agentId, source_session_id: record.sessionId,
        steps: [], calls: new Map(), done: new Set(), events: [], children: new Map(),
        sidechains: new Map(), spawnEvents: new Map(),
      };
      state.sidechains.set(record.agentId, child);
    }
    if (child.source_session_id !== record.sessionId) return;
    consumeRecord(record, child);
    return;
  }
  if (state.agent_id) { state.invalid_source = true; return; }
  consumeRecord(record, state);
}

const childCachePrefix = (rootFile) => `${path.resolve(rootFile)}\0`;
const childCacheKey = (rootFile, id) => `${childCachePrefix(rootFile)}${id}`;

async function firstTimestamp(file) {
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const timestamp = JSON.parse(line).timestamp;
      if (typeof timestamp === 'string' && !Number.isNaN(Date.parse(timestamp))) return timestamp;
    } catch { /* keep looking for the first complete timestamped record */ }
  }
  return null;
}

async function scanFoundChild(rootFile, files, id, rootSessionId) {
  const found = [];
  for (const file of files) {
    try {
      const stat = await fs.promises.lstat(file);
      if (stat.isFile()) found.push({ file, stat });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const cacheKey = childCacheKey(rootFile, id);
  if (!found.length) { childScans.delete(cacheKey); return null; }
  const rawKey = [...found].sort((left, right) => left.file.localeCompare(right.file))
    .map(({ file, stat }) =>
      `${file}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`).join('\0');
  const cached = childScans.get(cacheKey);
  if (cached?.rawKey === rawKey) return cached.value;
  await Promise.all(found.map(async (entry) => { entry.first = await firstTimestamp(entry.file); }));
  found.sort((left, right) => String(left.first ?? '').localeCompare(String(right.first ?? ''))
    || left.file.localeCompare(right.file));
  const state = {
    agent_id: id, source_session_id: rootSessionId,
    steps: [], calls: new Map(), done: new Set(), events: [], children: new Map(),
  };
  for (const { file } of found) {
    const input = fs.createReadStream(file, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) if (line.trim()) consume(line, state);
  }
  const filesInOrder = found.map(({ file }) => file);
  const value = state.invalid_source || !state.started_at ? null : {
    id,
    file: filesInOrder.at(-1),
    files: filesInOrder,
    started_at: state.started_at,
    last_at: state.last_at ?? state.started_at,
    children: [...state.children.values()],
  };
  childScans.set(cacheKey, { rawKey, value });
  return value;
}

async function childFiles(rootFile) {
  const directory = path.join(path.dirname(rootFile), path.basename(rootFile, '.jsonl'), 'subagents');
  let entries;
  try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return { directory, files: [] }; throw error; }
  const files = entries
    .filter((entry) => entry.isFile() && /^agent-[A-Za-z0-9_-]{1,128}\.jsonl$/.test(entry.name))
    .map((entry) => path.join(directory, entry.name));
  const workflows = path.join(directory, 'workflows');
  let workflowEntries = [];
  try { workflowEntries = await fs.promises.readdir(workflows, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await Promise.all(workflowEntries
    .filter((entry) => entry.isDirectory() && /^wf_[A-Za-z0-9_-]+$/.test(entry.name))
    .map(async (workflow) => {
      const folder = path.join(workflows, workflow.name);
      let children;
      try { children = await fs.promises.readdir(folder, { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      files.push(...children
        .filter((entry) => entry.isFile() && /^agent-[A-Za-z0-9_-]{1,128}\.jsonl$/.test(entry.name))
        .map((entry) => path.join(folder, entry.name)));
    }));
  return { directory, files: files.sort() };
}

export async function discoverChild(rootFile, id) {
  if (!validAgentId(id)) return null;
  const { files } = await childFiles(rootFile);
  const matches = files.filter((candidate) => path.basename(candidate) === `agent-${id}.jsonl`);
  return scanFoundChild(rootFile, matches, id, path.basename(rootFile, '.jsonl'));
}

export async function discoverChildren(rootFile) {
  const rootSessionId = path.basename(rootFile, '.jsonl');
  const found = await childFiles(rootFile);
  const grouped = new Map();
  for (const file of found.files) {
    const id = /^agent-([A-Za-z0-9_-]{1,128})\.jsonl$/.exec(path.basename(file))[1];
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push(file);
  }
  const active = new Set([...grouped.keys()].map((id) => childCacheKey(rootFile, id)));
  const children = await Promise.all([...grouped].map(([id, files]) =>
    scanFoundChild(rootFile, files, id, rootSessionId)));
  for (const key of childScans.keys()) {
    if (key.startsWith(childCachePrefix(rootFile)) && !active.has(key)) childScans.delete(key);
  }
  return children.filter(Boolean);
}

export function forgetChildren(rootFile) {
  for (const key of childScans.keys()) if (key.startsWith(childCachePrefix(rootFile))) childScans.delete(key);
}
