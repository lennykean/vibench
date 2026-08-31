import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { windowOwnerKey } from './tmux-host.js';

const cache = new Map();
const sources = new Map();
const agentTargets = new Map();
let nextRevision = 0;
const revisionPrefix = crypto.randomBytes(8).toString('hex');
const MAX_READ = 2 * 1024 * 1024;
export const SOURCE_MISS_MS = 1000;
let processSnapshot = { at: 0, table: new Map() };
let processSnapshotPending = null;
const execFileAsync = promisify(execFile);

async function runAsync(command, args, timeout = 5000, env,
  socket = process.env.VIBENCH_TMUX_SOCKET) {
  if (command === 'tmux' && socket) args = ['-L', socket, ...args];
  const { stdout } = await execFileAsync(command, args, {
    encoding: 'utf8', windowsHide: true, timeout, env,
  });
  return stdout.trim();
}

export async function paneTarget(session, tmux = (...args) => runAsync(
  'tmux', args, 5000, undefined, session.tmux?.socket,
)) {
  const pane = session.tmux?.harness;
  if (!session.id || !pane?.session || !pane.window_id || !pane.pane_id) return null;
  try {
    const key = windowOwnerKey(pane.window_id);
    const line = (await tmux('show-environment', '-t', `=${pane.session}`, key)).split(/\r?\n/)
      .find((value) => value.startsWith(`${key}=`));
    if (line?.slice(key.length + 1).trim() !== session.id) return null;
  } catch { return null; }
  const expected = `${pane.session}:${pane.window_id}.${pane.pane_id}`;
  const targets = [
    pane.pane_id,
    pane.session && pane.window_name && `${pane.session}:${pane.window_name}.${pane.pane_index ?? 1}`,
  ].filter(Boolean);
  for (const target of targets) {
    try {
      const [canonical, pid] = (await tmux(
        'display-message', '-p', '-t', target,
        '#{session_name}:#{window_id}.#{pane_id}\t#{pane_pid}',
      )).split('\t');
      if (canonical === expected && Number.isSafeInteger(Number(pid))) return { canonical, pid: Number(pid) };
    } catch { /* pane ids can disappear; try the recorded window/index */ }
  }
  return null;
}

export function parseProcStat(text, expectedPid) {
  const source = String(text);
  const open = source.indexOf('(');
  const close = source.lastIndexOf(')');
  if (open < 1 || close <= open) return null;
  const pid = Number(source.slice(0, open).trim());
  const fields = source.slice(close + 1).trim().split(/\s+/);
  const parent = Number(fields[1]);
  const start = fields[19];
  if (!Number.isSafeInteger(pid) || pid < 1
      || (expectedPid !== undefined && pid !== Number(expectedPid))
      || !Number.isSafeInteger(parent) || parent < 0
      || !/^[1-9]\d*$/.test(start ?? '')) return null;
  return { pid, parent, starts: [start] };
}

export async function procProcessTable(root = '/proc') {
  const table = new Map();
  let entries;
  try { entries = await fs.promises.readdir(root, { withFileTypes: true }); }
  catch { return table; }
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory() || !/^[1-9]\d*$/.test(entry.name)) return;
    const expectedPid = Number(entry.name);
    if (!Number.isSafeInteger(expectedPid)) return;
    try {
      const row = parseProcStat(
        await fs.promises.readFile(path.join(root, entry.name, 'stat'), 'utf8'), expectedPid,
      );
      if (row) table.set(row.pid, row);
    } catch { /* process exited while /proc was being read */ }
  }));
  return table;
}

export async function processTable() {
  if (Date.now() - processSnapshot.at < 750) return processSnapshot.table;
  if (processSnapshotPending) return processSnapshotPending;
  processSnapshotPending = (async () => {
    const table = new Map();
    try {
      if (process.platform === 'win32') {
        const script = '$rows=@(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{Pid=$_.ProcessId;Parent=$_.ParentProcessId} }); $starts=@{}; Get-Process -ErrorAction SilentlyContinue | ForEach-Object { try { $d=$_.StartTime; $u=$d.ToUniversalTime(); $starts[[int]$_.Id]=@($u.ToFileTimeUtc(),$d.Ticks,$u.Ticks,([DateTimeOffset]$d).ToUnixTimeMilliseconds()) } catch {} }; $rows | ForEach-Object { $values=@($_.Pid,$_.Parent); if ($starts.ContainsKey([int]$_.Pid)) { $values += $starts[[int]$_.Pid] }; $values -join [char]9 }';
        const output = await runAsync('powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', script], 10000);
        for (const line of output.split(/\r?\n/)) {
          const [rawPid, rawParent, ...starts] = line.trim().split('\t');
          const pid = Number(rawPid);
          const parent = Number(rawParent);
          if (Number.isSafeInteger(pid) && Number.isSafeInteger(parent)) {
            table.set(pid, { pid, parent, starts: starts.filter(Boolean) });
          }
        }
      } else {
        if (process.platform === 'linux') {
          const proc = await procProcessTable();
          if (proc.has(process.pid)) for (const [pid, row] of proc) table.set(pid, row);
        }
        if (!table.size) {
          const output = await runAsync('ps', ['-A', '-o', 'pid=,ppid=,lstart='], 10000,
            { ...process.env, TZ: 'UTC', LC_ALL: 'C' });
          for (const line of output.split(/\r?\n/)) {
            const match = line.match(/^\s*(\d+)\s+(\d+)(?:\s+(.+?))?\s*$/);
            if (!match) continue;
            const start = match[3]?.replace(/\s+/g, ' ').trim();
            const millis = start ? Date.parse(`${start} UTC`) : NaN;
            table.set(Number(match[1]), {
              pid: Number(match[1]), parent: Number(match[2]),
              starts: start ? [start, ...(Number.isNaN(millis) ? [] : [String(millis)])] : [],
            });
          }
        }
      }
    } catch { /* an unavailable process table means no authoritative match */ }
    processSnapshot = { at: Date.now(), table };
    return table;
  })().finally(() => { processSnapshotPending = null; });
  return processSnapshotPending;
}

async function descendantProcesses(root) {
  if (!Number.isSafeInteger(root)) return [];
  const table = await processTable();
  const children = new Map();
  for (const process of table.values()) {
    if (!children.has(process.parent)) children.set(process.parent, []);
    children.get(process.parent).push(process.pid);
  }
  const ids = [];
  const visit = (pid) => {
    for (const child of children.get(pid) ?? []) {
      if (ids.includes(child)) continue;
      ids.push(child);
      visit(child);
    }
  };
  visit(root);

  if (process.platform === 'linux') {
    for (const pid of ids) {
      try {
        const proc = parseProcStat(await fs.promises.readFile(`/proc/${pid}/stat`, 'utf8'), pid);
        const row = table.get(pid);
        if (proc && row && proc.parent === row.parent && !row.starts.includes(proc.starts[0])) {
          row.starts.push(proc.starts[0]);
        }
      } catch { /* process exited */ }
    }
  }
  return ids.map((pid) => table.get(pid)).filter((process) => process?.starts.length);
}

export async function providerFor(name) {
  if (typeof name !== 'string' || !/^[a-z0-9-]+$/.test(name.toLowerCase())) return null;
  try { return await import(`./providers/${name.toLowerCase()}.js`); }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw error;
  }
}

export async function locateTranscript(session) {
  const provider = await providerFor(session.harness);
  if (!provider) return { provider: session.harness ?? null, reason: `unsupported harness: ${session.harness ?? 'unknown'}` };
  if (session.watch_only === true) {
    return { provider: provider.name, ...await provider.locate({ session, processes: [] }) };
  }
  const pane = await paneTarget(session);
  if (!pane) return { provider: provider.name, reason: 'harness pane no longer exists' };
  const processes = await descendantProcesses(pane.pid);
  if (!processes.length) return { provider: provider.name, reason: 'no live harness process in the pane' };
  return { provider: provider.name, ...await provider.locate({ session, pane, processes }) };
}

function freshState(agentId, sourceSessionId) {
  return {
    revision: `${revisionPrefix}-${++nextRevision}`, steps: [], calls: new Map(), done: new Set(),
    events: [], children: new Map(), sidechains: new Map(), spawnEvents: new Map(),
    agent_id: agentId, source_session_id: sourceSessionId,
    offset: 0, partial: '', mtime: 0, ctime: 0, size: 0, dev: null, ino: null, pending: null,
    inPlaceCompletion: false,
  };
}

function textLines(content) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const trailing = content.endsWith('\n');
  const lines = content ? content.split(/\r?\n/) : [];
  if (trailing) lines.pop();
  return { lines, eol, trailing };
}

function joinLines({ lines, eol, trailing }) {
  return `${lines.join(eol)}${trailing ? eol : ''}`;
}

function capturedSliceMatches(content, step) {
  if (typeof content !== 'string' || typeof step.content !== 'string'
      || !Number.isSafeInteger(step.start_line) || step.start_line < 1) return null;
  const known = textLines(content).lines;
  const captured = textLines(step.content).lines;
  if (Number.isSafeInteger(step.num_lines) && step.num_lines !== captured.length) return false;
  const start = step.start_line - 1;
  if (start + captured.length > known.length) return false;
  return captured.every((line, index) => known[start + index] === line);
}

function parsedHunk(hunk) {
  if (!hunk || !Number.isSafeInteger(hunk.oldLines) || hunk.oldLines < 0
      || !Number.isSafeInteger(hunk.newLines) || hunk.newLines < 0
      || !Array.isArray(hunk.lines)) return null;
  const entries = [];
  for (const line of hunk.lines) {
    if (line === '\\ No newline at end of file') return null;
    if (typeof line !== 'string' || ![' ', '-', '+'].includes(line[0])) return null;
    entries.push({ operation: line[0], text: line.slice(1) });
  }
  const before = entries.filter(({ operation }) => operation !== '+').map(({ text }) => text);
  const after = entries.filter(({ operation }) => operation !== '-').map(({ text }) => text);
  return before.length === hunk.oldLines && after.length === hunk.newLines
    ? { entries, before, after }
    : null;
}

function invertHunks(hunks) {
  return hunks.map((hunk) => hunk && typeof hunk === 'object' ? {
    ...hunk,
    oldStart: hunk.newStart,
    oldLines: hunk.newLines,
    newStart: hunk.oldStart,
    newLines: hunk.oldLines,
    lines: Array.isArray(hunk.lines) ? hunk.lines.map((line) => {
      if (typeof line !== 'string') return line;
      if (line[0] === '+') return `-${line.slice(1)}`;
      if (line[0] === '-') return `+${line.slice(1)}`;
      return line;
    }) : hunk.lines,
  } : hunk);
}

function exactMatches(lines, wanted) {
  if (!wanted.length) return Array.from({ length: lines.length + 1 }, (_, index) => index);
  const matches = [];
  for (let start = 0; start + wanted.length <= lines.length; start += 1) {
    if (wanted.every((line, offset) => lines[start + offset] === line)) matches.push(start);
  }
  return matches;
}

function applyHunks(content, hunks) {
  if (typeof content !== 'string' || !Array.isArray(hunks) || !hunks.length) return null;
  const document = textLines(content);
  let cursor = 0;
  let lineOffset = 0;
  let first = Infinity;
  let last = -Infinity;
  for (const hunk of hunks) {
    const parsed = parsedHunk(hunk);
    if (!parsed) return null;
    const matches = exactMatches(document.lines, parsed.before);
    const positioned = Number.isSafeInteger(hunk.oldStart) && hunk.oldStart >= 1
      ? hunk.oldStart - 1 + lineOffset
      : null;
    const start = parsed.before.length === 0
      ? positioned !== null && matches.includes(positioned) ? positioned : null
      : matches.length === 1 ? matches[0]
      : positioned !== null && matches.includes(positioned) ? positioned
        : null;
    if (start === null || start < cursor) return null;
    let output = start;
    for (const { operation } of parsed.entries) {
      if (operation === ' ') output += 1;
      else if (operation === '+') {
        first = Math.min(first, output + 1);
        last = Math.max(last, output + 1);
        output += 1;
      } else {
        first = Math.min(first, output + 1);
        last = Math.max(last, output + 1);
      }
    }
    document.lines.splice(start, parsed.before.length, ...parsed.after);
    cursor = start + parsed.after.length;
    lineOffset += parsed.after.length - parsed.before.length;
  }
  if (!Number.isFinite(first)) return null;
  const maximum = Math.max(1, document.lines.length);
  return {
    content: joinLines(document),
    region: {
      start_line: Math.min(first, maximum),
      end_line: Math.min(Math.max(first, last), maximum),
    },
  };
}

function strictPatch(content, hunks) {
  const applied = applyHunks(content, hunks);
  if (!applied) return null;
  const reverted = applyHunks(applied.content, invertHunks(hunks));
  return reverted?.content === content ? applied : null;
}

function cloneStep(step) {
  return {
    ...step,
    ...(Array.isArray(step.hunks) ? {
      hunks: step.hunks.map((hunk) => hunk && typeof hunk === 'object' ? {
        ...hunk,
        ...(Array.isArray(hunk.lines) ? { lines: [...hunk.lines] } : {}),
      } : hunk),
    } : {}),
  };
}

export function projectSteps(steps) {
  const projected = steps.map(cloneStep);
  const direct = new Set();
  const hunks = projected.map((step) => step.hunks);

  for (let index = 0; index < projected.length; index += 1) {
    const step = projected[index];
    if (step.kind !== 'patch' || step.opaque) continue;
    if (typeof step.content === 'string' && step.region && Array.isArray(step.hunks) && step.hunks.length) {
      direct.add(index);
      continue;
    }
    if (typeof step._before !== 'string') continue;
    const applied = strictPatch(step._before, step.hunks);
    if (!applied) continue;
    Object.assign(step, applied);
    direct.add(index);
  }

  const known = new Map();
  for (let index = 0; index < projected.length; index += 1) {
    const step = projected[index];
    if (step.kind === 'chat') continue;
    if (!['read', 'patch', 'write'].includes(step.kind)) {
      known.clear();
      continue;
    }
    if (typeof step.path !== 'string') continue;
    if (step.kind === 'read') {
      if (step.full && typeof step.content === 'string') known.set(step.path, step.content);
      else if (capturedSliceMatches(known.get(step.path), step) !== true) known.delete(step.path);
      continue;
    }
    if (step.kind === 'write') {
      if (typeof step.content === 'string') known.set(step.path, step.content);
      else known.delete(step.path);
      continue;
    }
    if (step.kind !== 'patch') continue;
    if (typeof step.content === 'string') {
      known.set(step.path, step.content);
      continue;
    }
    const before = known.get(step.path);
    const applied = step.opaque || before === undefined ? null : strictPatch(before, step.hunks);
    if (applied) {
      Object.assign(step, applied);
      known.set(step.path, step.content);
    } else known.delete(step.path);
  }

  for (let target = 0; target < projected.length; target += 1) {
    const step = projected[target];
    if (step.kind !== 'patch' || step.opaque || typeof step.content === 'string') continue;
    let anchor = null;
    const chain = [];
    for (let index = target + 1; index < projected.length; index += 1) {
      const later = projected[index];
      if (later.kind === 'chat') continue;
      if (!['read', 'patch', 'write'].includes(later.kind)) break;
      if (later.path !== step.path) continue;
      if (later.kind === 'write') break;
      if (later.kind === 'read') {
        if (later.full && typeof later.content === 'string') anchor = later.content;
        if (anchor !== null) break;
        chain.push(index);
        continue;
      }
      if (later.kind !== 'patch') continue;
      if (later.opaque || !Array.isArray(hunks[index]) || !hunks[index].length) break;
      chain.push(index);
      if (direct.has(index)) {
        anchor = later.content;
        break;
      }
    }
    if (anchor === null) continue;
    let after = anchor;
    let valid = true;
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const chained = projected[chain[index]];
      if (chained.kind === 'read') {
        if (capturedSliceMatches(after, chained) !== true) { valid = false; break; }
      } else {
        const undone = strictPatch(after, invertHunks(hunks[chain[index]]));
        if (!undone) { valid = false; break; }
        after = undone.content;
      }
    }
    if (!valid) continue;
    const before = strictPatch(after, invertHunks(hunks[target]));
    const reapplied = before && strictPatch(before.content, hunks[target]);
    if (!reapplied || reapplied.content !== after) continue;
    step.content = after;
    step.region = reapplied.region;
  }

  for (const step of projected) {
    delete step._before;
    delete step._content;
    delete step._start_line;
    delete step._fallback_hunks;
    if (step.kind === 'patch' && typeof step.content === 'string') {
      delete step.hunks;
      delete step.opaque;
      delete step.result;
    }
  }
  return projected;
}

export function readySnapshot(steps, since, reset = false, done, force = false) {
  if (!steps.length) return [];
  const head = steps.at(-1).i;
  if (Number.isInteger(since) && !reset && !force && head <= since) return [];
  const projected = projectSteps(steps);
  if (done) for (const step of projected) if (!done.has(step.i)) step.pending = true;
  return projected;
}

async function append(file, stat, state, consume, cursor = state) {
  const before = new Map();
  const remember = (current) => {
    before.set(current, { steps: current.steps.length, done: new Set(current.done) });
    for (const child of current.sidechains?.values() ?? []) remember(child);
  };
  remember(state);
  const handle = await fs.promises.open(file, 'r');
  const end = Math.min(stat.size, cursor.offset + MAX_READ);
  try {
    while (cursor.offset < end) {
      const size = Math.min(1024 * 1024, end - cursor.offset);
      const buffer = Buffer.allocUnsafe(size);
      const { bytesRead } = await handle.read(buffer, 0, size, cursor.offset);
      if (!bytesRead) break;
      cursor.offset += bytesRead;
      const lines = (cursor.partial + buffer.toString('utf8', 0, bytesRead)).split('\n');
      cursor.partial = lines.pop();
      for (const line of lines) if (line.trim()) consume(line, state);
      await new Promise(setImmediate);
    }
  } finally { await handle.close(); }
  for (const [current, previous] of before) {
    const completed = [...current.done]
      .some((index) => index < previous.steps && !previous.done.has(index));
    const appended = current.steps.slice(previous.steps).some((step) => step.kind !== 'chat');
    current.inPlaceCompletion = completed || current.inPlaceCompletion && !appended;
  }
  cursor.mtime = stat.mtimeMs;
  cursor.ctime = stat.ctimeMs;
  cursor.size = stat.size;
  cursor.dev = stat.dev;
  cursor.ino = stat.ino;
}

function missingSource(sessionId, identity, sourceSessionId, previouslyEstablished, now = Date.now()) {
  let source = sources.get(sessionId);
  const established = source?.established === true || previouslyEstablished === true
    || typeof sourceSessionId === 'string';
  if (!source || source.identity !== identity) {
    source = { identity, revision: `${revisionPrefix}-${++nextRevision}`, established, missingAt: now };
    sources.set(sessionId, source);
  } else if (established) {
    source.established = true;
  }
  return source;
}

function dropSource(key) {
  const source = sources.get(key);
  sources.delete(key);
  if (source && ![...sources.values()].some((other) => other.identity === source.identity)) {
    cache.delete(source.identity);
  }
}

async function timelineFileFor(session, found, sourceKey, identity, since, requestedRevision,
  agentId, sourceSessionId, includeChat = false, includeEvents = false) {
  const previousSource = sources.get(sourceKey);
  if (previousSource && previousSource.identity !== identity
      && ![...sources].some(([id, source]) => id !== sourceKey && source.identity === previousSource.identity)) {
    cache.delete(previousSource.identity);
  }
  const provider = await providerFor(session.harness);
  const files = Array.isArray(found.files) && found.files.length ? found.files : null;
  const stats = files
    ? await Promise.all(files.map(async (file) => ({ file, stat: await fs.promises.stat(file) })))
    : [{ file: found.file, stat: await fs.promises.stat(found.file) }];
  const stat = stats.at(-1).stat;
  let state = cache.get(identity);
  let rebuild = !state;
  if (files && state) {
    const order = state.fileOrder ?? [];
    rebuild = !(state.fileStates instanceof Map)
      || order.length > files.length || order.some((file, index) => file !== files[index]);
    if (!rebuild) for (let index = 0; index < stats.length; index += 1) {
      const { file, stat: current } = stats[index];
      const cursor = state.fileStates.get(file);
      if (!cursor) continue;
      const replaced = current.size < cursor.offset || current.mtimeMs < cursor.mtime
        || cursor.dev !== null && (current.dev !== cursor.dev || current.ino !== cursor.ino)
        || current.size === cursor.size
          && (current.mtimeMs !== cursor.mtime || current.ctimeMs !== cursor.ctime);
      const earlierSegmentChanged = index < order.length - 1
        && (current.size !== cursor.size || current.mtimeMs !== cursor.mtime
          || current.ctimeMs !== cursor.ctime);
      if (replaced || earlierSegmentChanged) { rebuild = true; break; }
    }
  } else if (state) {
    rebuild = stat.size < state.offset || stat.mtimeMs < state.mtime
      || state.dev !== null && (stat.dev !== state.dev || stat.ino !== state.ino)
      || stat.size === state.size
        && (stat.mtimeMs !== state.mtime || stat.ctimeMs !== state.ctime);
  }
  if (rebuild) {
    state = freshState(agentId, sourceSessionId);
    if (files) {
      state.fileOrder = [...files];
      state.fileStates = new Map();
    }
    cache.set(identity, state);
  }
  if (files) {
    state.fileOrder = [...files];
    const changed = stats.some(({ file, stat: current }) => {
      const cursor = state.fileStates.get(file);
      return !cursor || cursor.offset < current.size || cursor.size !== current.size
        || cursor.mtime !== current.mtimeMs;
    });
    if (changed) state.pending ??= (async () => {
      for (const { file, stat: current } of stats) {
        let cursor = state.fileStates.get(file);
        if (!cursor) {
          cursor = {
            offset: 0, partial: '', mtime: 0, ctime: 0, size: 0, dev: null, ino: null,
          };
          state.fileStates.set(file, cursor);
        }
        while (cursor.offset < current.size || cursor.size !== current.size
            || cursor.mtime !== current.mtimeMs) {
          const offset = cursor.offset;
          await append(file, current, state, provider.consume, cursor);
          if (cursor.offset === offset) break;
        }
      }
    })().finally(() => { state.pending = null; });
  } else if (state.offset < stat.size || stat.size !== state.size || stat.mtimeMs !== state.mtime) {
    state.pending ??= append(found.file, stat, state, provider.consume)
      .finally(() => { state.pending = null; });
  }
  if (state.pending) {
    await state.pending;
  }
  sources.set(sourceKey, { identity, revision: state.revision, established: true });

  const reset = requestedRevision
    ? requestedRevision !== state.revision
    : Number.isInteger(since) && !!previousSource
      && (previousSource.identity !== identity || previousSource.revision !== state.revision);
  let timelineSteps = state.steps;
  let done = state.done;
  if (!includeChat) {
    timelineSteps = state.steps.filter((step) => step.kind !== 'chat').map((step, i) => ({
      ...step, i, _source_i: step.i,
    }));
    done = new Set(timelineSteps
      .filter((step) => state.done.has(step._source_i))
      .map((step) => step.i));
  }
  const steps = readySnapshot(timelineSteps, since, reset, done, state.inPlaceCompletion);
  for (const step of steps) delete step._source_i;
  return {
    session: { id: session.id, name: session.name, pwd: session.pwd },
    reset,
    source: {
      provider: found.provider, transcript: stats.at(-1).file,
      ...(files ? { transcripts: [...files] } : {}),
      mtime: Math.max(...stats.map(({ stat: current }) => current.mtimeMs)),
      session_id: sourceSessionId ?? found.id, via: found.via, revision: state.revision,
      established: true,
      ...(agentId ? { agent_id: agentId } : {}),
      ...(found.reason ? { reason: found.reason } : {}),
    },
    steps,
    ...(includeEvents ? { events: state.events ?? [] } : {}),
  };
}

async function sessionTimelineFor(session, since, requestedRevision, includeChat = false) {
  const found = await locateTranscript(session);
  const base = { session: { id: session.id, name: session.name, pwd: session.pwd } };
  const identity = JSON.stringify([found.provider, found.pid ?? null, found.id ?? null, found.file ?? null]);
  const previousSource = sources.get(session.id);
  if (!found.file) {
    if (previousSource && previousSource.identity !== identity
        && ![...sources].some(([id, source]) => id !== session.id
          && source.identity === previousSource.identity)) cache.delete(previousSource.identity);
    const source = missingSource(
      session.id, identity, found.id, session.source_established === true,
    );
    const revision = source.revision;
    const reset = requestedRevision
      ? requestedRevision !== revision
      : Number.isInteger(since) && !!previousSource && previousSource.identity !== identity;
    return {
      ...base,
      reset,
      source: {
        provider: found.provider, transcript: null, mtime: null, session_id: found.id ?? null,
        via: found.via ?? null, reason: found.reason, revision,
        established: source.established === true,
        missing_confirmed: source.established === true && Date.now() - source.missingAt >= SOURCE_MISS_MS,
      },
      steps: [],
    };
  }
  return timelineFileFor(session, found, session.id, identity, since, requestedRevision,
    undefined, found.id, includeChat);
}

export function terminalFor(session, since, requestedRevision) {
  return sessionTimelineFor(session, since, requestedRevision);
}

const validAgentId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const defined = (value) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));

function mergeChild(children, value, parentAgentId) {
  if (!validAgentId(value?.id)) return;
  const previous = children.get(value.id) ?? {};
  children.set(value.id, {
    ...previous,
    ...defined(value),
    id: value.id,
    parent_agent_id: parentAgentId !== undefined
      ? parentAgentId
      : value.parent_agent_id ?? previous.parent_agent_id ?? null,
  });
}

function publicChild(rootId, child) {
  const terminal = /^(completed|failed|stopped|cancelled|killed)$/i.test(child.status ?? '');
  const timeline = `/agents/child/${encodeURIComponent(rootId)}/${encodeURIComponent(child.id)}/timeline`;
  return {
    kind: 'child', id: child.id, root_id: rootId,
    parent_agent_id: child.parent_agent_id ?? null,
    name: child.description || child.id,
    description: child.description ?? null,
    subtype: child.subtype ?? null,
    model: child.model ?? null,
    status: child.status ?? null,
    live: !terminal && !child.ended_at,
    spawned_at: child.spawned_at ?? null,
    spawn_position: child.spawn_position ?? null,
    started_at: child.started_at ?? child.spawned_at ?? null,
    last_at: child.last_at ?? child.ended_at ?? null,
    ended_at: child.ended_at ?? (terminal ? child.last_at ?? null : null),
    timeline_url: timeline,
    events_url: `${timeline}/events`,
  };
}

function inferredSpawnPosition(steps, child) {
  const started = Date.parse(child.started_at ?? '');
  if (!Number.isFinite(started)) return null;
  for (const step of steps ?? []) {
    const at = Date.parse(step.at ?? '');
    if (Number.isFinite(at) && at >= started) return step.i + 1;
  }
  return (steps?.length ?? 0) + 1;
}

async function catalogSession(session, body = null) {
  body ??= await terminalFor(session);
  const source = sources.get(session.id);
  const state = source && cache.get(source.identity);
  const children = new Map();
  const provider = await providerFor(session.harness);
  const discovered = body.source.transcript && provider?.discoverChildren
    ? await provider.discoverChildren(body.source.transcript)
    : [];

  for (const child of discovered) mergeChild(children, child);
  for (const child of state?.children?.values() ?? []) mergeChild(children, child);
  for (const [id, childState] of state?.sidechains ?? []) {
    mergeChild(children, {
      id, started_at: childState.started_at, last_at: childState.last_at, _state: childState,
    });
    for (const nested of childState.children?.values() ?? []) {
      if (nested.spawned_at) mergeChild(children, nested, id);
    }
  }
  for (const child of discovered) {
    for (const nested of child.children ?? []) {
      if (nested.spawned_at) mergeChild(children, nested, child.id);
    }
  }
  for (const child of discovered) {
    const stored = children.get(child.id);
    if (stored) {
      stored._file = child.file;
      stored._files = child.files ?? [child.file];
    }
  }
  for (const child of children.values()) {
    if (child.spawn_position == null && child.parent_agent_id == null) {
      child.spawn_position = inferredSpawnPosition(state?.steps, child);
    }
  }

  const previousTargets = agentTargets.get(session.id);
  const identity = sources.get(session.id)?.identity;
  for (const id of previousTargets?.children.keys() ?? []) {
    if (previousTargets.identity !== identity || !children.has(id)) {
      dropSource(`${session.id}:child:${id}`);
    }
  }
  if (previousTargets?.transcript && previousTargets.transcript !== body.source.transcript) {
    provider?.forgetChildren?.(previousTargets.transcript);
  }
  agentTargets.set(session.id, {
    identity, transcript: body.source.transcript, harness: session.harness, children,
  });

  const rootTimeline = `/agents/root/${encodeURIComponent(session.id)}/timeline`;
  const root = {
    kind: 'root', id: session.id, root_id: session.id,
    name: session.name, pwd: session.pwd, created: session.created ?? null,
    harness: session.harness ?? null, tmux: session.tmux ?? null,
    live: body.source.via === 'pid-session' && !!body.source.session_id
      && (!body.source.reason || body.source.reason === 'transcript not yet created'),
    source_session_id: body.source.session_id ?? null,
    source_established: body.source.established === true || session.source_established === true,
    source_missing_confirmed: body.source.missing_confirmed === true,
    timeline_url: rootTimeline, events_url: `${rootTimeline}/events`,
    children: [...children.values()]
      .map((child) => publicChild(session.id, child))
      .sort((left, right) => String(left.spawned_at ?? left.started_at ?? '')
        .localeCompare(String(right.spawned_at ?? right.started_at ?? ''))),
  };
  return { root, body, children };
}

export async function agentCatalog(registry) {
  const roots = await Promise.all(Object.values(registry).map(async (session) => {
    try { return (await catalogSession(session)).root; }
    catch (error) {
      const timeline = `/agents/root/${encodeURIComponent(session.id)}/timeline`;
      return {
        kind: 'root', id: session.id, root_id: session.id, name: session.name,
        pwd: session.pwd, created: session.created ?? null, harness: session.harness ?? null,
        tmux: session.tmux ?? null, live: false, source_session_id: null,
        source_established: false,
        source_missing_confirmed: false,
        timeline_url: timeline, events_url: `${timeline}/events`, children: [],
        error: error.message,
      };
    }
  }));
  return { roots };
}

export async function forgetAgentSession(session) {
  const targets = agentTargets.get(session.id);
  agentTargets.delete(session.id);
  for (const key of [...sources.keys()]) {
    if (key === session.id || key.startsWith(`${session.id}:child:`)) dropSource(key);
  }
  if (!targets?.transcript) return;
  try {
    const provider = await providerFor(targets.harness ?? session.harness);
    provider?.forgetChildren?.(targets.transcript);
  } catch { /* session deletion must not be held hostage by cache cleanup */ }
}

function embeddedTimeline(session, rootBody, child, state, since, requestedRevision) {
  const revision = `${rootBody.source.revision}:${child.id}`;
  const reset = !!requestedRevision && requestedRevision !== revision;
  return {
    session: rootBody.session,
    agent: publicChild(session.id, child),
    reset,
    source: {
      ...rootBody.source, agent_id: child.id, via: 'claude-sidechain', revision,
      ...(!state ? { reason: 'child transcript not yet created' } : {}),
    },
    steps: readySnapshot(state?.steps ?? [], since, reset, state?.done,
      state?.inPlaceCompletion === true),
    events: state?.events ?? [],
  };
}

export async function agentTimelineFor(session, kind, childId, since, requestedRevision) {
  if (kind === 'root') {
    const body = await sessionTimelineFor(session, since, requestedRevision, true);
    const source = sources.get(session.id);
    return { ...body, events: cache.get(source?.identity)?.events ?? [], agent: {
      kind: 'root', id: session.id, root_id: session.id, name: session.name,
    } };
  }
  if (kind !== 'child' || !validAgentId(childId)) return null;
  const rootBody = await terminalFor(session, Number.MAX_SAFE_INTEGER);
  const identity = sources.get(session.id)?.identity;
  let targets = agentTargets.get(session.id);
  if (!targets || targets.identity !== identity || !targets.children.has(childId)) {
    const refreshed = await catalogSession(session, rootBody);
    targets = agentTargets.get(session.id);
    if (!refreshed.children.has(childId)) return null;
  }
  const rootState = cache.get(identity);
  const current = rootState?.children?.get(childId);
  if (current) mergeChild(targets.children, current);
  const embedded = rootState?.sidechains?.get(childId);
  if (embedded) mergeChild(targets.children, {
    id: childId, started_at: embedded.started_at, last_at: embedded.last_at, _state: embedded,
  });
  let child = targets.children.get(childId);
  const provider = await providerFor(targets.harness ?? session.harness);
  if (targets.transcript) {
    const discovered = await provider?.discoverChild?.(targets.transcript, childId);
    if (discovered) {
      mergeChild(targets.children, discovered);
      Object.assign(targets.children.get(childId), {
        _file: discovered.file, _files: discovered.files ?? [discovered.file],
      });
      child = targets.children.get(childId);
    }
  }
  const catalog = { body: rootBody, children: targets.children };
  if (!child._files?.length) {
    return embeddedTimeline(session, catalog.body, child, child._state, since, requestedRevision);
  }
  const found = {
    provider: catalog.body.source.provider, file: child._file, files: child._files, id: child.id,
    via: 'claude-sidechain',
  };
  const sourceKey = `${session.id}:child:${child.id}`;
  const childIdentity = JSON.stringify([found.provider, 'child', session.id, child.id]);
  let body;
  try {
    body = await timelineFileFor(session, found, sourceKey, childIdentity, since, requestedRevision,
      child.id, catalog.body.source.session_id, true, true);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    delete child._file;
    delete child._files;
    dropSource(sourceKey);
    const replacement = targets.transcript
      ? await provider?.discoverChild?.(targets.transcript, childId)
      : null;
    if (!replacement) {
      return embeddedTimeline(session, catalog.body, child, child._state, since, requestedRevision);
    }
    mergeChild(targets.children, replacement);
    child = targets.children.get(childId);
    child._file = replacement.file;
    child._files = replacement.files ?? [replacement.file];
    found.file = replacement.file;
    found.files = child._files;
    const replacementIdentity = JSON.stringify([found.provider, 'child', session.id, child.id]);
    body = await timelineFileFor(session, found, sourceKey, replacementIdentity,
      since, requestedRevision, child.id, catalog.body.source.session_id, true, true);
  }
  return { ...body, agent: publicChild(session.id, child) };
}
