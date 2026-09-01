#!/usr/bin/env node
// vibench server: the session registry, run tmux-server style — started on
// demand by the CLI, one per user, localhost only, surviving CLI exits.
// It allocates session ids and remembers id -> {name, pwd}, so the nvim and
// harness sides of a session can look themselves (and each other) up from
// the VIBENCH_SESSION env var.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { agentCatalog, agentTimelineFor, forgetAgentSession, providerFor, terminalFor } from './transcript.js';

const DIR = process.env.VIBENCH_DIR || path.join(os.homedir(), '.vibench');
const SERVER_FILE = path.join(DIR, 'server.json');
const LOCK_FILE = path.join(DIR, 'server.lock');
const SESSIONS_FILE = path.join(DIR, 'sessions.json');
const SERVER_TOKEN = crypto.randomBytes(32).toString('hex');
const LAUNCH_RESERVATION_MS = 30_000;
const VERSION = crypto.createHash('sha256')
  .update(fs.readFileSync(new URL(import.meta.url)))
  .update(fs.readFileSync(new URL('./transcript.js', import.meta.url)))
  .update(fs.readFileSync(new URL('./tmux-host.js', import.meta.url)))
  .update(fs.readdirSync(new URL('./providers/', import.meta.url)).filter((file) => !file.endsWith('.test.js')).sort()
    .map((file) => fs.readFileSync(new URL(`./providers/${file}`, import.meta.url))).join(''))
  .digest('hex');

let sessions = {};
try { sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch { /* fresh */ }
const workbenches = new Map();
const agentSelections = new Map();
const testWorkbenchStaleMs = Number(process.env.VIBENCH_TEST_WORKBENCH_STALE_MS);
const WORKBENCH_STALE_MS = Number.isFinite(testWorkbenchStaleMs) && testWorkbenchStaleMs > 0
  ? testWorkbenchStaleMs : 15_000;
const WORKBENCH_TTL_MS = WORKBENCH_STALE_MS * 4;
const AGENT_SELECTION_MS = 3_000;

setInterval(() => {
  const now = Date.now();
  for (const [id, state] of workbenches) {
    if (now - state.received > WORKBENCH_TTL_MS) workbenches.delete(id);
  }
}, WORKBENCH_STALE_MS).unref();

function save() {
  const temporary = `${SESSIONS_FILE}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(sessions, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, SESSIONS_FILE);
  } catch {
    try { fs.unlinkSync(temporary); } catch { /* nothing staged */ }
  }
}

const samePath = (left, right) => typeof left === 'string' && typeof right === 'string'
  && (process.platform === 'win32' ? path.resolve(left).toLowerCase() : path.resolve(left))
    === (process.platform === 'win32' ? path.resolve(right).toLowerCase() : path.resolve(right));

function uniqueName(base) {
  const used = new Set(Object.values(sessions).map((session) => session.name));
  let candidate = base;
  for (let suffix = 2; used.has(candidate); suffix++) candidate = `${base}-${suffix}`;
  return candidate;
}

async function reapExpiredReservations(now = Date.now()) {
  let changed = false;
  for (const session of Object.values(sessions)) {
    const started = Date.parse(session.launch_started_at);
    if (session.launching !== true
        || Number.isFinite(started) && now - started < LAUNCH_RESERVATION_MS) continue;
    delete sessions[session.id];
    releaseAgents(session);
    workbenches.delete(session.id);
    const selection = agentSelections.get(session.id);
    if (selection) finishAgentSelection(session.id, selection, false);
    await forgetAgentSession(session);
    changed = true;
  }
  return changed;
}

function cleanupFiles() {
  try {
    const info = JSON.parse(fs.readFileSync(SERVER_FILE, 'utf8'));
    if (info.pid === process.pid) fs.unlinkSync(SERVER_FILE);
  } catch { /* not ours or already gone */ }
  try {
    if (Number(fs.readFileSync(LOCK_FILE, 'utf8')) === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch { /* not ours or already gone */ }
}

process.once('exit', cleanupFiles);

async function requestJson(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) tooLarge = true;
    else chunks.push(chunk);
  }
  if (tooLarge) throw Object.assign(new Error('body too large'), { status: 413 });
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function hasServerToken(req) {
  const supplied = req.headers.authorization;
  const expected = `Bearer ${SERVER_TOKEN}`;
  return typeof supplied === 'string' && supplied.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

// ---- spawned agents: children started by an agent in a bench, either
// headless (subagent) or as their own bench in a separate tmux session
// (peer). Registry rows persist the entries; process handles stay here. ----

const AGENT_OUTPUT_CAP = 64 * 1024;
const spawnHandles = new Map();
let registryLock = Promise.resolve();
function withRegistryLock(fn) {
  const run = registryLock.then(fn, fn);
  registryLock = run.then(() => {}, () => {});
  return run;
}
const CLI_ENTRY = fileURLToPath(new URL('./cli.js', import.meta.url));

// A restarted server has no handle on previously spawned processes.
{
  let changed = false;
  for (const session of Object.values(sessions)) {
    for (const agent of session.agents ?? []) {
      if (agent.status === 'running' && agent.mode === 'subagent') {
        agent.status = 'orphaned';
        changed = true;
      }
    }
  }
  if (changed) save();
}

// Deleting or reaping a session must not leak its children: kill running
// subagent processes and drop their handles and discovery timers.
function releaseAgents(session) {
  for (const agent of session?.agents ?? []) {
    const key = `${session.id}:${agent.agent_id}`;
    const handle = spawnHandles.get(key);
    if (!handle) continue;
    if (handle.poll) clearInterval(handle.poll);
    if (agent.mode === 'subagent' && agent.status === 'running') {
      try { handle.child.kill(); } catch { /* already gone */ }
    }
    spawnHandles.delete(key);
  }
}

function spawnEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === 'TMUX' || key === 'TMUX_PANE' || key.startsWith('VIBENCH_')) delete env[key];
  }
  if (process.env.VIBENCH_DIR) env.VIBENCH_DIR = process.env.VIBENCH_DIR;
  if (process.env.VIBENCH_CONFIG) env.VIBENCH_CONFIG = process.env.VIBENCH_CONFIG;
  if (process.env.VIBENCH_OPENCODE_DB) env.VIBENCH_OPENCODE_DB = process.env.VIBENCH_OPENCODE_DB;
  if (process.env.VIBENCH_CLAUDE_SESSIONS) env.VIBENCH_CLAUDE_SESSIONS = process.env.VIBENCH_CLAUDE_SESSIONS;
  if (process.env.VIBENCH_CLAUDE_PROJECTS) env.VIBENCH_CLAUDE_PROJECTS = process.env.VIBENCH_CLAUDE_PROJECTS;
  return env;
}

// Session ids already claimed by sibling spawned agents: discovery must not
// attribute the same harness session to two entries.
function claimedSessionIds(session, entry) {
  return (session.agents ?? [])
    .filter((sibling) => sibling !== entry && sibling.harness_session_id)
    .map((sibling) => sibling.harness_session_id);
}

const agentTitle = (prompt) => {
  const text = String(prompt).replace(/\s+/g, ' ').trim();
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
};

async function spawnAgent(session, body) {
  const reject = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!body || typeof body !== 'object' || Array.isArray(body)) reject('invalid spawn request');
  const { harness: harnessName, mode, prompt } = body;
  if (!['subagent', 'peer'].includes(mode)) reject('mode must be "subagent" or "peer"');
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 100_000) {
    reject('prompt must be a non-empty string');
  }
  const harness = loadConfig().harnesses.find((entry) => entry.name === harnessName);
  if (!harness) reject(`unknown harness "${harnessName}"`);
  const provider = await providerFor(harnessName);
  if (typeof provider?.spawnPlan !== 'function') {
    reject(`harness "${harnessName}" cannot spawn agents`);
  }
  if (body.callback === true) {
    reject(`no completion callback plugin is available for harness "${harnessName}"`);
  }
  const workspace = typeof body.workspace === 'string' && body.workspace ? body.workspace : session.pwd;
  try {
    if (!fs.statSync(workspace).isDirectory()) throw new Error();
  } catch { reject(`workspace is not a directory: ${workspace}`); }

  const agentId = crypto.randomBytes(4).toString('hex');
  const plan = provider.spawnPlan(mode, prompt);
  const entry = {
    agent_id: agentId, mode, harness: harnessName,
    harness_session_id: plan.sessionId ?? null,
    description: agentTitle(prompt), workspace,
    status: 'running', spawned_at: new Date().toISOString(),
  };
  const key = `${session.id}:${agentId}`;
  const finish = (status, result, exit = null) => {
    if (entry.status !== 'running') return;
    entry.status = status;
    entry.exit = exit;
    entry.result = String(result ?? '').slice(-AGENT_OUTPUT_CAP);
    entry.ended_at = new Date().toISOString();
    spawnHandles.delete(key);
    save();
  };

  let child;
  if (mode === 'subagent') {
    child = spawn(harness.cmd, [...(Array.isArray(harness.args) ? harness.args : []), ...plan.args], {
      cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: spawnEnvironment(), shell: false,
    });
  } else {
    const peerSession = `vibench-peer-${agentId}`;
    entry.tmux_session = peerSession;
    const launch = plan.args.flatMap((value) => ['--launch-arg', value]);
    child = spawn(process.execPath, [CLI_ENTRY,
      '--workspace', workspace, '--model-harness', harnessName,
      '--name', `peer-${agentId}`, '--no-attach', ...launch], {
      cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...spawnEnvironment(),
        VIBENCH_TMUX_SOCKET: session.tmux?.socket || 'vibench',
        VIBENCH_TMUX_SESSION: peerSession,
      },
    });
  }
  const handle = { child, output: '', errors: '' };
  spawnHandles.set(key, handle);
  entry.pid = child.pid ?? null;
  child.stdout.on('data', (data) => {
    handle.output = (handle.output + data).slice(-AGENT_OUTPUT_CAP);
    if (!entry.harness_session_id && !handle.discovering && plan.discover === 'output'
        && typeof provider.discoverSessionId === 'function') {
      handle.discovering = true;
      Promise.resolve(provider.discoverSessionId({
        output: handle.output, exclude: claimedSessionIds(session, entry),
      }))
        .then((found) => {
          if (found && !entry.harness_session_id) { entry.harness_session_id = found; save(); }
        }).catch(() => {})
        .finally(() => { handle.discovering = false; });
    }
  });
  child.stderr.on('data', (data) => {
    handle.errors = (handle.errors + data).slice(-AGENT_OUTPUT_CAP);
  });
  if (mode === 'subagent' && plan.discover === 'record'
      && typeof provider.discoverSessionId === 'function') {
    // Claude publishes the authoritative session id in its pid record at
    // startup; poll it while the child runs and briefly after it exits.
    const poll = setInterval(() => {
      if (entry.harness_session_id) { clearInterval(poll); return; }
      Promise.resolve(provider.discoverSessionId({ pid: child.pid }))
        .then((found) => {
          if (found && !entry.harness_session_id) {
            entry.harness_session_id = found;
            clearInterval(poll);
            save();
          }
        }).catch(() => {});
    }, 500);
    poll.unref?.();
    handle.poll = poll;
    child.once('exit', () => { setTimeout(() => clearInterval(poll), 5000).unref?.(); });
  }
  child.once('error', (error) => finish('failed', error.message));
  child.once('exit', (code) => {
    if (mode === 'subagent') {
      const result = code === 0 ? handle.output.trim()
        : [handle.output.trim(), handle.errors.trim()].filter(Boolean).join('\n');
      finish(code === 0 ? 'completed' : 'failed', result, code);
      return;
    }
    // The peer launcher exits after creating the bench; the peer itself
    // keeps running in its own tmux session.
    if (code !== 0) {
      finish('failed', [handle.output.trim(), handle.errors.trim()].filter(Boolean).join('\n'), code);
      return;
    }
    const bench = Object.values(sessions).find((candidate) =>
      (entry.harness_session_id && candidate.harness === harnessName
        && candidate.harness_session_id === entry.harness_session_id)
      || candidate.name === `peer-${agentId}`);
    if (bench) entry.bench_id = bench.id;
    spawnHandles.delete(key);
    save();
  });

  // The session can be deleted while the spawn body was validated and the
  // process created; never attach a child to an evicted registry row.
  if (sessions[session.id] !== session) {
    if (handle.poll) clearInterval(handle.poll);
    try { child.kill(); } catch { /* already gone */ }
    spawnHandles.delete(key);
    throw Object.assign(new Error('session was deleted during spawn'), { status: 409 });
  }
  session.agents ??= [];
  session.agents.push(entry);
  save();
  return entry;
}

async function refreshAgent(session, entry) {
  // A peer's bench can register after the launcher exits; keep retrying the
  // link until it appears.
  if (entry.mode === 'peer' && !entry.bench_id) {
    const bench = Object.values(sessions).find((candidate) =>
      (entry.harness_session_id && candidate.harness === entry.harness
        && candidate.harness_session_id === entry.harness_session_id)
      || candidate.name === `peer-${entry.agent_id}`);
    if (bench) {
      entry.bench_id = bench.id;
      save();
    }
  }
  if (entry.harness_session_id) return;
  try {
    const provider = await providerFor(entry.harness);
    const handle = spawnHandles.get(`${session.id}:${entry.agent_id}`);
    if (typeof provider?.discoverSessionId === 'function') {
      const found = await provider.discoverSessionId({
        pid: handle?.child?.pid,
        output: handle?.output,
        workspace: entry.workspace,
        after: entry.spawned_at,
        exclude: claimedSessionIds(session, entry),
      });
      if (found) {
        entry.harness_session_id = found;
        save();
        return;
      }
    }
    // A peer is a full bench; once linked, its own session matching is the
    // source of truth for the harness session id.
    if (entry.bench_id && sessions[entry.bench_id]) {
      const found = (await terminalFor(sessions[entry.bench_id]))?.source?.session_id;
      if (found && !entry.harness_session_id) {
        entry.harness_session_id = found;
        save();
      }
    }
  } catch { /* discovery is best-effort; the entry stays reachable */ }
}

function streamSignature(body) {
  const source = { ...(body.source ?? {}) };
  delete source.mtime;
  return JSON.stringify({
    session: body.session, agent: body.agent, source,
    steps: body.steps ?? [], events: body.events ?? [], select_agent: body.select_agent,
  });
}

function rememberEstablishedSource(session, established) {
  if (!session || established !== true || session.source_established === true) return false;
  session.source_established = true;
  return true;
}

function rememberTimelineSource(session, body) {
  if (rememberEstablishedSource(session, body?.source?.established)) save();
  return body;
}

function streamTerminal(req, res, url, id) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  const rawSince = url.searchParams.get('since');
  const since = rawSince !== null && /^-?\d+$/.test(rawSince) ? Number(rawSince) : undefined;
  let revision = url.searchParams.get('revision') || undefined;
  let signature;
  let sent = false;
  let timer;
  let closed = false;
  const stop = () => { closed = true; clearTimeout(timer); };
  res.once('close', stop);

  const tick = async () => {
    if (closed) return;
    const session = sessions[id];
    if (!session) { res.end(); stop(); return; }
    try {
      const full = rememberTimelineSource(session, await terminalFor(session, undefined, revision));
      const next = streamSignature(full);
      if (!sent) {
        const body = since === undefined ? full : await terminalFor(session, since, revision);
        res.write(`data: ${JSON.stringify(body)}\n\n`);
        sent = true;
      } else if (full.reset || next !== signature) {
        res.write(`data: ${JSON.stringify(full)}\n\n`);
      }
      signature = next;
      revision = full.source.revision;
    } catch (error) {
      if (!closed) res.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
    }
    // ponytail: one tail loop per connected panel; share loops by session if
    // a bench ever has enough simultaneous frontends for this to matter.
    timer = setTimeout(tick, 500);
  };
  void tick();
}

function timelineQuery(url) {
  if ([...url.searchParams].some(([key]) => !['since', 'revision'].includes(key))
      || url.searchParams.getAll('since').length > 1
      || url.searchParams.getAll('revision').length > 1) return null;
  const raw = url.searchParams.get('since');
  const since = raw === null ? undefined : /^-?\d+$/.test(raw) ? Number(raw) : NaN;
  const revision = url.searchParams.get('revision') ?? undefined;
  if (Number.isNaN(since) || since !== undefined && (!Number.isSafeInteger(since) || since < -1)
      || revision !== undefined && !/^[A-Za-z0-9._:-]{1,256}$/.test(revision)) return null;
  return { since, revision };
}

function withAgentSelection(rootId, body) {
  const selection = agentSelections.get(rootId);
  if (!body || !selection?.ready) return body;
  return { ...body, select_agent: { intent_id: selection.id, ...selection.agent } };
}

function finishAgentSelection(rootId, selection, acknowledged) {
  if (agentSelections.get(rootId) !== selection) return;
  agentSelections.delete(rootId);
  clearTimeout(selection.timer);
  selection.resolve(acknowledged);
}

function streamAgentTimeline(res, load) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  let revision;
  let signature;
  let sent = false;
  let timer;
  let closed = false;
  const stop = () => { closed = true; clearTimeout(timer); };
  res.once('close', stop);
  const tick = async () => {
    if (closed) return;
    try {
      const body = await load(undefined, revision);
      if (!body) { res.end(); stop(); return; }
      const next = streamSignature(body);
      if (!sent || body.reset || next !== signature) {
        res.write(`data: ${JSON.stringify(body)}\n\n`);
        signature = next;
        sent = true;
      }
      revision = body.source?.revision;
    } catch (error) {
      if (!closed) res.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
    }
    timer = setTimeout(tick, 500);
  };
  void tick();
}

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!hasServerToken(req)) return send(401, { error: 'unauthorized' });
  const rootAgentEvents = /^\/agents\/root\/([A-Za-z0-9_-]{1,128})\/timeline\/events$/.exec(url.pathname)?.[1];
  const childAgentEvents = /^\/agents\/child\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_-]{1,128})\/timeline\/events$/.exec(url.pathname);
  const rootAgentSelect = /^\/agents\/root\/([A-Za-z0-9_-]{1,128})\/select$/.exec(url.pathname)?.[1];
  const childAgentSelect = /^\/agents\/child\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_-]{1,128})\/select$/.exec(url.pathname);
  const rootAgentTimeline = /^\/agents\/root\/([A-Za-z0-9_-]{1,128})\/timeline$/.exec(url.pathname)?.[1];
  const childAgentTimeline = /^\/agents\/child\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_-]{1,128})\/timeline$/.exec(url.pathname);
  const agentsOf = /^\/sessions\/(\w+)\/agents$/.exec(url.pathname)?.[1];
  const agentOf = /^\/sessions\/(\w+)\/agents\/(\w+)$/.exec(url.pathname);
  const terminalEventsId = /^\/sessions\/(\w+)\/terminal\/events$/.exec(url.pathname)?.[1];
  const terminalId = /^\/sessions\/(\w+)\/terminal$/.exec(url.pathname)?.[1];
  const workbenchId = /^\/sessions\/(\w+)\/workbench$/.exec(url.pathname)?.[1];
  const idOf = /^\/sessions\/(\w+)$/.exec(url.pathname)?.[1];
  if (req.method === 'POST' && (rootAgentSelect || childAgentSelect)) {
    if (url.search) return send(400, { error: 'agent selection does not accept query parameters' });
    const rootId = rootAgentSelect || childAgentSelect[1];
    const session = sessions[rootId];
    if (!session) return send(404, { error: 'unknown root agent' });
    const agent = rootAgentSelect
      ? { kind: 'root', id: rootId, root_id: rootId }
      : { kind: 'child', id: childAgentSelect[2], root_id: rootId };
    const previous = agentSelections.get(rootId);
    if (previous) finishAgentSelection(rootId, previous, false);
    let resolve;
    const acknowledged = new Promise((done) => { resolve = done; });
    const selection = {
      id: crypto.randomBytes(8).toString('hex'),
      agent,
      ready: agent.kind === 'root',
      resolve,
    };
    agentSelections.set(rootId, selection);
    res.once('close', () => {
      if (!res.writableEnded) finishAgentSelection(rootId, selection, false);
    });
    if (selection.ready) {
      selection.timer = setTimeout(
        () => finishAgentSelection(rootId, selection, false), AGENT_SELECTION_MS);
    }
    if (agent.kind === 'child') {
      let child;
      try { child = await agentTimelineFor(session, 'child', agent.id); }
      catch (error) {
        if (agentSelections.get(rootId) !== selection) {
          if (res.destroyed) return;
          return send(409, { error: 'agent selection was superseded' });
        }
        finishAgentSelection(rootId, selection, false);
        return send(500, { error: error.message });
      }
      if (agentSelections.get(rootId) !== selection) {
        if (res.destroyed) return;
        return send(409, { error: 'agent selection was superseded' });
      }
      if (!child) {
        finishAgentSelection(rootId, selection, false);
        return send(404, { error: 'unknown child agent' });
      }
      selection.agent.parent_agent_id = child.agent?.parent_agent_id ?? null;
      selection.ready = true;
      selection.timer = setTimeout(
        () => finishAgentSelection(rootId, selection, false), AGENT_SELECTION_MS);
    }
    // ponytail: the existing workspace publish is the acknowledgement channel.
    return await acknowledged
      ? send(200, { ok: true, intent_id: selection.id })
      : send(504, { error: 'destination bench did not acknowledge agent selection' });
  }
  if (req.method === 'GET' && url.pathname === '/agents') {
    if (url.search) return send(400, { error: 'invalid catalog query' });
    try {
      const catalog = await agentCatalog(sessions);
      let changed = false;
      for (const root of catalog.roots) {
        if (rememberEstablishedSource(sessions[root.id], root.source_established)) changed = true;
      }
      if (changed) save();
      return send(200, catalog);
    }
    catch (error) { return send(500, { error: error.message }); }
  }
  if (req.method === 'GET' && rootAgentEvents) {
    if (url.search) return send(400, { error: 'timeline events do not accept query parameters' });
    const session = sessions[rootAgentEvents];
    if (!session) return send(404, { error: 'unknown root agent' });
    streamAgentTimeline(res, async (since, revision) => {
      const current = sessions[rootAgentEvents];
      if (!current) return null;
      const body = await agentTimelineFor(current, 'root', undefined, since, revision);
      return withAgentSelection(rootAgentEvents, rememberTimelineSource(current, body));
    });
    return;
  }
  if (req.method === 'GET' && childAgentEvents) {
    if (url.search) return send(400, { error: 'timeline events do not accept query parameters' });
    const session = sessions[childAgentEvents[1]];
    if (!session) return send(404, { error: 'unknown root agent' });
    try {
      if (!await agentTimelineFor(session, 'child', childAgentEvents[2])) {
        return send(404, { error: 'unknown child agent' });
      }
    } catch (error) { return send(500, { error: error.message }); }
    streamAgentTimeline(res, async (since, revision) => withAgentSelection(childAgentEvents[1],
      sessions[childAgentEvents[1]]
        ? await agentTimelineFor(sessions[childAgentEvents[1]], 'child', childAgentEvents[2], since, revision)
        : null));
    return;
  }
  if (req.method === 'GET' && rootAgentTimeline) {
    const query = timelineQuery(url);
    if (!query) return send(400, { error: 'invalid timeline query' });
    const session = sessions[rootAgentTimeline];
    if (!session) return send(404, { error: 'unknown root agent' });
    try {
      const body = await agentTimelineFor(session, 'root', undefined, query.since, query.revision);
      return send(200, rememberTimelineSource(session, body));
    }
    catch (error) { return send(500, { error: error.message }); }
  }
  if (req.method === 'GET' && childAgentTimeline) {
    const query = timelineQuery(url);
    if (!query) return send(400, { error: 'invalid timeline query' });
    const session = sessions[childAgentTimeline[1]];
    if (!session) return send(404, { error: 'unknown root agent' });
    try {
      const body = await agentTimelineFor(session, 'child', childAgentTimeline[2], query.since, query.revision);
      return body ? send(200, body) : send(404, { error: 'unknown child agent' });
    } catch (error) { return send(500, { error: error.message }); }
  }
  if (req.method === 'POST' && agentsOf) {
    if (!sessions[agentsOf]) return send(404, { error: 'unknown session' });
    try {
      const body = await requestJson(req);
      // Re-read after the body await: the session can vanish while it streams.
      const session = sessions[agentsOf];
      if (!session) return send(404, { error: 'unknown session' });
      return send(201, await spawnAgent(session, body));
    } catch (error) {
      return send(error.status ?? 500, { error: error.message });
    }
  }
  if (req.method === 'GET' && agentsOf) {
    const session = sessions[agentsOf];
    if (!session) return send(404, { error: 'unknown session' });
    for (const entry of session.agents ?? []) await refreshAgent(session, entry);
    return send(200, { agents: session.agents ?? [] });
  }
  if (req.method === 'GET' && agentOf) {
    const session = sessions[agentOf[1]];
    if (!session) return send(404, { error: 'unknown session' });
    const entry = (session.agents ?? []).find((agent) => agent.agent_id === agentOf[2]);
    if (!entry) return send(404, { error: 'unknown agent' });
    await refreshAgent(session, entry);
    return send(200, entry);
  }
  if (req.method === 'GET' && url.pathname === '/sessions' && !url.search) return send(200, sessions);
  if (req.method === 'GET' && terminalEventsId) {
    if (!sessions[terminalEventsId]) return send(404, { error: 'unknown session' });
    streamTerminal(req, res, url, terminalEventsId);
    return;
  }
  if (req.method === 'GET' && terminalId) {
    if (!sessions[terminalId]) return send(404, { error: 'unknown session' });
    const raw = url.searchParams.get('since');
    const since = raw !== null && /^-?\d+$/.test(raw) ? Number(raw) : undefined;
    const revision = url.searchParams.get('revision') || undefined;
    try {
      const session = sessions[terminalId];
      const body = await terminalFor(session, since, revision);
      return send(200, rememberTimelineSource(session, body));
    }
    catch (e) { return send(500, { error: e.message }); }
  }
  if (req.method === 'PUT' && workbenchId) {
    if (!sessions[workbenchId]) return send(404, { error: 'unknown session' });
    if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      return send(415, { error: 'application/json required' });
    }
    try {
      const snapshot = await requestJson(req);
      if (!snapshot || Array.isArray(snapshot) || snapshot.schema !== 'vibench.workspace.v1'
          || snapshot.kind !== 'workspace_state' || snapshot.session_id !== workbenchId) {
        return send(400, { error: 'invalid workspace state' });
      }
      if (typeof snapshot.selection?.text === 'string'
          && Array.from(snapshot.selection.text).length > 2000) {
        return send(400, { error: 'visual selection exceeds 2000 characters' });
      }
      const received = Date.now();
      workbenches.set(workbenchId, { snapshot, received });
      const selection = agentSelections.get(workbenchId);
      const selected = snapshot.selected_agent;
      if (selection && snapshot.agent_selection_intent === selection.id
          && selected?.kind === selection.agent.kind
          && selected.id === selection.agent.id && selected.root_id === selection.agent.root_id) {
        finishAgentSelection(workbenchId, selection, true);
      }
      return send(200, { ok: true, updated_at: new Date(received).toISOString() });
    } catch (e) {
      return send(e.status ?? 400, { error: e.message });
    }
  }
  if (req.method === 'GET' && workbenchId) {
    if (!sessions[workbenchId]) return send(404, { error: 'unknown session' });
    const state = workbenches.get(workbenchId);
    const age = state ? Date.now() - state.received : Infinity;
    if (age > WORKBENCH_TTL_MS) {
      workbenches.delete(workbenchId);
      return send(404, { error: 'workspace state unavailable' });
    }
    return send(200, {
      ...state.snapshot,
      updated_at: new Date(state.received).toISOString(),
      stale: age > WORKBENCH_STALE_MS,
    });
  }
  if (req.method === 'GET' && idOf) {
    return sessions[idOf] ? send(200, sessions[idOf]) : send(404, { error: 'unknown session' });
  }
  if (req.method === 'DELETE' && idOf) {
    const removed = sessions[idOf];
    delete sessions[idOf];
    workbenches.delete(idOf);
    const selection = agentSelections.get(idOf);
    if (selection) finishAgentSelection(idOf, selection, false);
    if (removed) {
      releaseAgents(removed);
      await forgetAgentSession(removed);
    }
    save();
    return send(200, { ok: true });
  }
  if (req.method === 'POST' && req.url === '/kill') {
    send(200, { ok: true });
    setTimeout(() => process.exit(0), 50);
    return;
  }
  if (req.method === 'POST' && req.url === '/sessions') {
    try {
      const incoming = await requestJson(req);
      // Two launches can race the claim-or-create search; serialize it so the
      // same harness session never gets two registry rows.
      return await withRegistryLock(async () => {
      const { name, pwd } = incoming;
      if (typeof incoming.id === 'string' && sessions[incoming.id]) {
        // agents entries are server-owned; a client merge must not corrupt them
        delete incoming.agents;
        sessions[incoming.id] = { ...sessions[incoming.id], ...incoming };
        save();
        return send(200, sessions[incoming.id]);
      }
      if (typeof name !== 'string' || !name || typeof pwd !== 'string' || !pwd) {
        return send(400, { error: 'name and pwd required' });
      }
      const reaped = await reapExpiredReservations();
      const ignored = new Set(Array.isArray(incoming.ignore_ids)
        ? incoming.ignore_ids.filter((id) => typeof id === 'string') : []);
      if (typeof incoming.harness_session_id === 'string' && incoming.harness_session_id) {
        const claimed = Object.values(sessions).find((session) => !ignored.has(session.id)
          && (session.launching !== true
            || (Number.isFinite(Date.parse(session.launch_started_at))
              && Date.now() - Date.parse(session.launch_started_at) < LAUNCH_RESERVATION_MS))
          && session.harness === incoming.harness
          && session.harness_session_id === incoming.harness_session_id
          && (session.watch_only === true) === (incoming.watch_only === true)
          && samePath(session.pwd, pwd));
        if (claimed) {
          if (reaped) save();
          return send(200, claimed);
        }
      }
      const id = crypto.randomBytes(4).toString('hex');
      sessions[id] = {
        id, name: uniqueName(name), pwd, created: new Date().toISOString(),
        launching: true, launch_started_at: new Date().toISOString(),
        ...(typeof incoming.harness === 'string' ? { harness: incoming.harness } : {}),
        ...(typeof incoming.harness_session_id === 'string'
          ? { harness_session_id: incoming.harness_session_id } : {}),
        ...(typeof incoming.watch_only === 'boolean' ? { watch_only: incoming.watch_only } : {}),
      };
      save();
      return send(201, sessions[id]);
      });
    } catch (e) {
      return send(e.status ?? 400, { error: e.message });
    }
  }
  send(404, { error: 'not found' });
});

// two CLIs racing to start the server: whoever finds a live one bows out
async function alreadyRunning() {
  try {
    const { port, token } = JSON.parse(fs.readFileSync(SERVER_FILE, 'utf8'));
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    const res = await fetch(`http://127.0.0.1:${port}/sessions`, {
      headers, signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch { return false; }
}

async function acquireLock() {
  fs.mkdirSync(DIR, { recursive: true });
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const handle = fs.openSync(LOCK_FILE, 'wx', 0o600);
      fs.writeFileSync(handle, String(process.pid));
      fs.closeSync(handle);
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await alreadyRunning()) return false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8'));
    process.kill(pid, 0);
    return false;
  } catch {
    try { fs.unlinkSync(LOCK_FILE); } catch { /* another starter won */ }
    return acquireLock();
  }
}

if (await alreadyRunning() || !await acquireLock()) process.exit(0);
server.listen(0, '127.0.0.1', () => {
  fs.mkdirSync(DIR, { recursive: true });
  const temporary = `${SERVER_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({
    port: server.address().port,
    pid: process.pid,
    version: VERSION,
    token: SERVER_TOKEN,
  }), { mode: 0o600 });
  fs.renameSync(temporary, SERVER_FILE);
});
