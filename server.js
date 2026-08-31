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
import { agentCatalog, agentTimelineFor, forgetAgentSession, terminalFor } from './transcript.js';

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
    if (removed) await forgetAgentSession(removed);
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
      const { name, pwd } = incoming;
      if (typeof incoming.id === 'string' && sessions[incoming.id]) {
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
