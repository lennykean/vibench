import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const authorized = (token, headers = {}) => ({ ...headers, authorization: `Bearer ${token}` });

function sseData(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  return {
    reader,
    async next() {
      for (;;) {
        const boundary = pending.indexOf('\n\n');
        if (boundary >= 0) {
          const block = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          const data = block.split('\n').find((line) => line.startsWith('data: '));
          if (data) return JSON.parse(data.slice(6));
          continue;
        }
        const chunk = await reader.read();
        if (chunk.done) return null;
        pending += decoder.decode(chunk.value, { stream: true });
      }
    },
  };
}

const nextSse = (events, timeout = 4000) => Promise.race([
  events.next(),
  sleep(timeout).then(() => { throw new Error('timed out waiting for SSE data'); }),
]);

async function waitForServer(file) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const { port, token } = JSON.parse(fs.readFileSync(file, 'utf8'));
      const base = `http://127.0.0.1:${port}`;
      if ((await fetch(`${base}/sessions`, { headers: authorized(token) })).ok) return { base, token };
    } catch { /* still starting */ }
    await sleep(50);
  }
  throw new Error('server did not start');
}

test('keeps the latest Neovim workspace state in memory per session', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibench-server-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: here,
    env: { ...process.env, VIBENCH_DIR: dir, VIBENCH_TEST_WORKBENCH_STALE_MS: '100' },
    stdio: 'ignore',
    windowsHide: true,
  });
  let base, token;
  t.after(async () => {
    if (child.exitCode === null) {
      const closed = once(child, 'close');
      try {
        if (!base) throw new Error('server did not start');
        await fetch(`${base}/kill`, { method: 'POST', headers: authorized(token) });
      } catch { child.kill(); }
      await Promise.race([closed, sleep(2000)]);
      if (child.exitCode === null) child.kill();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const started = await waitForServer(path.join(dir, 'server.json'));
  base = started.base;
  token = started.token;
  const headers = authorized(token, { 'content-type': 'application/json' });

  assert.equal((await fetch(`${base}/sessions`)).status, 401);
  const created = await (await fetch(`${base}/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'state-test', pwd: here }),
  })).json();
  const claim = {
    name: 'claimed', pwd: here, harness: 'claude',
    harness_session_id: 'provider-session', watch_only: false,
  };
  const firstClaimResponse = await fetch(`${base}/sessions`, {
    method: 'POST', headers, body: JSON.stringify({ ...claim, watch_only: undefined }),
  });
  const firstClaim = await firstClaimResponse.json();
  const repeatedClaimResponse = await fetch(`${base}/sessions`, {
    method: 'POST', headers, body: JSON.stringify(claim),
  });
  const repeatedClaim = await repeatedClaimResponse.json();
  await fetch(`${base}/sessions`, {
    method: 'POST', headers,
    body: JSON.stringify({ id: firstClaim.id, launching: true, launch_started_at: '1970-01-01T00:00:00.000Z' }),
  });
  const expiredClaimResponse = await fetch(`${base}/sessions`, {
    method: 'POST', headers, body: JSON.stringify(claim),
  });
  const expiredClaim = await expiredClaimResponse.json();
  const replacementResponse = await fetch(`${base}/sessions`, {
    method: 'POST', headers,
    body: JSON.stringify({ ...claim, ignore_ids: [firstClaim.id, expiredClaim.id] }),
  });
  const replacement = await replacementResponse.json();
  assert.equal(firstClaimResponse.status, 201);
  assert.equal(firstClaim.launching, true);
  assert.equal(repeatedClaimResponse.status, 200);
  assert.equal(repeatedClaim.id, firstClaim.id);
  assert.equal(expiredClaimResponse.status, 201);
  assert.equal(expiredClaim.name, 'claimed');
  const registryAfterReap = await (await fetch(`${base}/sessions`, {
    headers: authorized(token),
  })).json();
  assert.equal(registryAfterReap[firstClaim.id], undefined);
  assert.equal(replacementResponse.status, 201);
  assert.equal(replacement.name, 'claimed-2');
  await Promise.all([expiredClaim.id, replacement.id].map((id) => fetch(`${base}/sessions/${id}`, {
    method: 'DELETE', headers,
  })));
  const snapshot = {
    schema: 'vibench.workspace.v1',
    kind: 'workspace_state',
    session_id: created.id,
    selected_agent: { kind: 'root', id: created.id, root_id: created.id },
    current: { path: path.join(here, 'server.js'), visible_lines: { first: 10, last: 20 } },
    selection: { active: true, text: 'selected' },
  };
  for (const [url, options] of [
    [`${base}/agents`, {}],
    [`${base}/agents/root/${created.id}/timeline`, {}],
    [`${base}/agents/root/${created.id}/timeline/events`, {}],
    [`${base}/agents/root/${created.id}/select`, { method: 'POST' }],
    [`${base}/agents/child/${created.id}/child-1/select`, { method: 'POST' }],
    [`${base}/agents/child/${created.id}/child-1/timeline`, {}],
    [`${base}/agents/child/${created.id}/child-1/timeline/events`, {}],
    [`${base}/sessions/${created.id}`, {}],
    [`${base}/sessions/${created.id}/terminal`, {}],
    [`${base}/sessions/${created.id}/terminal/events`, {}],
    [`${base}/sessions/${created.id}`, { method: 'DELETE' }],
    [`${base}/sessions`, {
      method: 'POST', body: JSON.stringify({ id: created.id, name: 'hijacked' }),
    }],
    [`${base}/kill`, { method: 'POST' }],
  ]) assert.equal((await fetch(url, options)).status, 401, `${options.method ?? 'GET'} ${url}`);
  const unchanged = await (await fetch(`${base}/sessions/${created.id}`, {
    headers: authorized(token),
  })).json();
  assert.equal(unchanged.name, 'state-test');
  assert.equal((await fetch(`${base}/sessions`, { headers: authorized(token) })).status, 200,
    'unauthorized kill stopped the server');
  const catalog = await (await fetch(`${base}/agents`, { headers: authorized(token) })).json();
  assert.equal(catalog.roots.length, 1);
  assert.deepEqual(catalog.roots[0].children, []);
  assert.equal(catalog.roots[0].id, created.id);
  assert.equal(catalog.roots[0].timeline_url, `/agents/root/${created.id}/timeline`);
  const rootTimeline = await (await fetch(`${base}${catalog.roots[0].timeline_url}`, {
    headers: authorized(token),
  })).json();
  assert.equal(rootTimeline.agent.kind, 'root');
  assert.deepEqual(rootTimeline.steps, []);
  assert.deepEqual(rootTimeline.events, []);
  const stream = await fetch(`${base}${catalog.roots[0].events_url}`, {
    headers: authorized(token),
  });
  assert.equal(stream.status, 200);
  const events = sseData(stream.body);
  assert.equal((await events.next()).agent.kind, 'root');
  assert.equal((await fetch(`${base}/agents/root/missing/select`, {
    method: 'POST', headers: authorized(token),
  })).status, 404);
  const selectionResponse = fetch(`${base}/agents/root/${created.id}/select`, {
    method: 'POST', headers: authorized(token),
  });
  const selectionEvent = (await nextSse(events)).select_agent;
  assert.match(selectionEvent.intent_id, /^[a-f0-9]{16}$/);
  assert.deepEqual({ ...selectionEvent, intent_id: undefined }, {
    intent_id: undefined, kind: 'root', id: created.id, root_id: created.id,
  });
  assert.equal((await fetch(`${base}/sessions/${created.id}/workbench`, {
    method: 'PUT', headers, body: JSON.stringify(snapshot),
  })).status, 200);
  assert.equal(await Promise.race([
    selectionResponse.then(() => true), sleep(100).then(() => false),
  ]), false, 'an uncorrelated workspace update acknowledged the agent selection');
  assert.equal((await fetch(`${base}/sessions/${created.id}/workbench`, {
    method: 'PUT', headers,
    body: JSON.stringify({ ...snapshot, agent_selection_intent: selectionEvent.intent_id }),
  })).status, 200);
  assert.equal((await selectionResponse).status, 200);
  assert.equal((await nextSse(events)).select_agent, undefined,
    'acknowledged agent selection remained on the stream');
  await fetch(`${base}/sessions`, {
    method: 'POST', headers, body: JSON.stringify({ id: created.id, name: 'state-test-updated' }),
  });
  assert.equal((await events.next()).agent.name, 'state-test-updated',
    'agent stream retained the session object from connection time');
  assert.equal((await fetch(`${base}/agents?extra=1`, { headers: authorized(token) })).status, 400);
  assert.equal((await fetch(`${base}/agents/root/${created.id}/timeline?since=nope`, {
    headers: authorized(token),
  })).status, 400);
  assert.equal((await fetch(`${base}/agents/child/${created.id}/child-1/timeline`, {
    headers: authorized(token),
  })).status, 404);
  assert.equal((await fetch(`${base}/sessions/${created.id}/workbench`)).status, 401);
  assert.equal((await fetch(`${base}/sessions/missing/workbench`, {
    method: 'PUT', headers, body: JSON.stringify(snapshot),
  })).status, 404);
  assert.equal((await fetch(`${base}/sessions/${created.id}/workbench`, {
    method: 'PUT', headers, body: JSON.stringify({ ...snapshot, session_id: 'wrong' }),
  })).status, 400);
  assert.equal((await fetch(`${base}/sessions/${created.id}/workbench`, {
    method: 'PUT', headers,
    body: JSON.stringify({ ...snapshot, selection: { text: 'x'.repeat(2001) } }),
  })).status, 400);
  assert.equal((await fetch(`${base}/sessions/${created.id}/workbench`, {
    method: 'PUT', headers, body: JSON.stringify(snapshot),
  })).status, 200);

  const state = await (await fetch(`${base}/sessions/${created.id}/workbench`, { headers })).json();
  assert.equal(state.selection.text, 'selected');
  assert.equal(state.stale, false);
  assert.match(state.updated_at, /^\d{4}-\d\d-/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8'))[created.id].selection, undefined);

  await sleep(200);
  const stale = await (await fetch(`${base}/sessions/${created.id}/workbench`, { headers })).json();
  assert.equal(stale.stale, true);
  assert.equal((await fetch(`${base}/sessions/${created.id}/workbench`, {
    method: 'PUT', headers, body: JSON.stringify(snapshot),
  })).status, 200);
  await sleep(250);
  assert.equal((await (await fetch(`${base}/sessions/${created.id}/workbench`, { headers })).json()).stale, true,
    'heartbeat did not refresh workspace state lifetime');
  await sleep(200);
  assert.equal((await fetch(`${base}/sessions/${created.id}/workbench`, { headers })).status, 404,
    'expired workspace state remained available');

  await fetch(`${base}/sessions/${created.id}`, {
    method: 'DELETE', headers: authorized(token),
  });
  assert.equal(await Promise.race([
    events.reader.read().then(({ done }) => done),
    sleep(1500).then(() => false),
  ]), true, 'agent stream stayed open after its root was deleted');
  assert.equal((await fetch(`${base}/sessions/${created.id}/workbench`, { headers })).status, 404);
});

test('streams a watch-only root and retained child through their lifecycle', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibench-agent-server-'));
  const projects = path.join(dir, 'claude-projects');
  const project = path.join(projects, 'project');
  const registryId = 'internalbench';
  const rootId = 'rootsession';
  const childId = 'a1234567890abcdef';
  const embeddedId = 'embeddedchild';
  const tailId = 'tailchild';
  const rootFile = path.join(project, `${rootId}.jsonl`);
  const childDirectory = path.join(project, rootId, 'subagents');
  const childFile = path.join(childDirectory, `agent-${childId}.jsonl`);
  fs.mkdirSync(childDirectory, { recursive: true });
  const line = (value) => `${JSON.stringify(value)}\n`;
  fs.writeFileSync(rootFile, [
    { type: 'user', timestamp: '2026-08-28T10:00:00.000Z', message: { content: 'start' } },
    { type: 'assistant', timestamp: '2026-08-28T10:00:01.000Z', message: { content: [
      { type: 'tool_use', id: 'spawn', name: 'Agent', input: { description: 'Review it' } },
    ] } },
    { type: 'user', timestamp: '2026-08-28T10:00:02.000Z', message: { content: [
      { type: 'tool_result', tool_use_id: 'spawn', content: 'started' },
    ] }, toolUseResult: { agentId: childId, status: 'async_launched' } },
    { isSidechain: true, agentId: embeddedId, sessionId: rootId,
      type: 'assistant', timestamp: '2026-08-28T10:00:00.500Z', message: { content: [
        { type: 'tool_use', id: 'embedded-shell', name: 'Bash', input: { command: 'echo embedded' } },
      ] } },
    { isSidechain: true, agentId: tailId, sessionId: rootId,
      type: 'assistant', timestamp: '2026-08-28T10:00:03.000Z', message: { content: [
        { type: 'tool_use', id: 'tail-shell', name: 'Bash', input: { command: 'echo tail' } },
      ] } },
  ].map(line).join(''));
  const childRecords = (message, timestamp = '2026-08-28T10:00:03.000Z') => [
    { isSidechain: true, agentId: childId, sessionId: rootId,
      type: 'user', timestamp, message: { content: message } },
    { isSidechain: true, agentId: childId, sessionId: rootId,
      type: 'assistant', timestamp: '2026-08-28T10:00:04.000Z', message: { content: [
        { type: 'tool_use', id: 'child-shell', name: 'Bash', input: { command: 'echo child' } },
      ] } },
    { isSidechain: true, agentId: childId, sessionId: rootId,
      type: 'user', timestamp: '2026-08-28T10:00:05.000Z', message: { content: [
        { type: 'tool_result', tool_use_id: 'child-shell', content: 'child output' },
      ] }, toolUseResult: { stdout: 'child output', stderr: '', exitCode: 0 } },
  ];
  fs.writeFileSync(childFile, childRecords('child start').map(line).join(''));
  const workflowDirectory = path.join(childDirectory, 'workflows', 'wf_earlier');
  fs.mkdirSync(workflowDirectory, { recursive: true });
  const workflowFile = path.join(workflowDirectory, `agent-${childId}.jsonl`);
  fs.writeFileSync(workflowFile, [
    { isSidechain: true, agentId: childId, sessionId: rootId,
      type: 'user', timestamp: '2026-08-28T09:00:00.000Z', message: { content: 'workflow start' } },
    { isSidechain: true, agentId: childId, sessionId: rootId,
      type: 'assistant', timestamp: '2026-08-28T09:00:01.000Z', message: { content: [
        { type: 'tool_use', id: 'workflow-shell', name: 'Bash', input: { command: 'echo workflow' } },
      ] } },
    { isSidechain: true, agentId: childId, sessionId: rootId,
      type: 'user', timestamp: '2026-08-28T09:00:02.000Z', message: { content: [
        { type: 'tool_result', tool_use_id: 'workflow-shell', content: 'workflow output' },
      ] }, toolUseResult: { stdout: 'workflow output', stderr: '', exitCode: 0 } },
  ].map(line).join(''));
  fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
    [registryId]: {
      id: registryId, name: 'watched root', pwd: project, harness: 'claude',
      watch_only: true, harness_session_id: rootId,
    },
  }));

  const serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: here,
    env: { ...process.env, VIBENCH_DIR: dir, VIBENCH_CLAUDE_PROJECTS: projects },
    stdio: 'ignore',
    windowsHide: true,
  });
  let base, token;
  t.after(async () => {
    if (serverProcess.exitCode === null) {
      const closed = once(serverProcess, 'close');
      try {
        if (base) await fetch(`${base}/kill`, { method: 'POST', headers: authorized(token) });
      } catch { serverProcess.kill(); }
      await Promise.race([closed, sleep(2000)]);
      if (serverProcess.exitCode === null) serverProcess.kill();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  ({ base, token } = await waitForServer(path.join(dir, 'server.json')));
  const headers = authorized(token);

  const catalog = await (await fetch(`${base}/agents`, { headers })).json();
  assert.equal(catalog.roots[0].id, registryId);
  assert.equal(catalog.roots[0].source_session_id, rootId);
  assert.equal(catalog.roots[0].source_established, true);
  const persisted = await (await fetch(`${base}/sessions`, { headers })).json();
  assert.equal(persisted[registryId].source_established, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8'))[registryId].source_established, true);
  assert.equal(catalog.roots[0].children.find(({ id }) => id === childId).status, 'async_launched');
  assert.equal(catalog.roots[0].children.find(({ id }) => id === embeddedId).spawn_position, 2);
  assert.equal(catalog.roots[0].children.find(({ id }) => id === tailId).spawn_position, 4);

  const rootTimeline = await (await fetch(
    `${base}/agents/root/${registryId}/timeline`, { headers },
  )).json();
  assert.deepEqual(rootTimeline.steps.map(({ category }) => category),
    ['chat', 'tool_info', 'chat']);
  assert.equal(rootTimeline.steps.find(({ tool }) => tool === 'Agent').category, 'tool_info');
  assert.deepEqual(rootTimeline.events.map(({ kind }) => kind), ['message', 'agent_spawn']);
  const legacy = await (await fetch(`${base}/sessions/${registryId}/terminal`, { headers })).json();
  assert.deepEqual(legacy.steps.map(({ i, kind }) => ({ i, kind })), [{ i: 0, kind: 'other' }],
    'legacy terminal route included prose or non-contiguous indices');
  const childTimeline = await (await fetch(
    `${base}/agents/child/${registryId}/${childId}/timeline`, { headers },
  )).json();
  assert.deepEqual(childTimeline.steps.map(({ category }) => category),
    ['chat', 'terminal', 'chat', 'terminal']);
  assert.deepEqual(childTimeline.steps.filter(({ tool }) => tool === 'Bash')
    .map(({ command, output }) => ({ command, output })), [
    { command: 'echo workflow', output: 'workflow output' },
    { command: 'echo child', output: 'child output' },
  ]);
  assert.deepEqual(childTimeline.events.map(({ content }) => content),
    ['workflow start', 'child start']);
  assert.deepEqual(childTimeline.source.transcripts, [workflowFile, childFile]);

  assert.equal((await fetch(`${base}/agents/child/${registryId}/missing/select`, {
    method: 'POST', headers,
  })).status, 404);
  assert.equal((await fetch(`${base}/sessions`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ id: registryId, source_established: false }),
  })).status, 200);
  const selectionStream = sseData((await fetch(
    `${base}/agents/root/${registryId}/timeline/events`, { headers },
  )).body);
  await nextSse(selectionStream);
  assert.equal((await (await fetch(`${base}/sessions`, { headers })).json())[registryId].source_established, true,
    'root timeline stream did not persist established source state');
  const childSelectionResponse = fetch(
    `${base}/agents/child/${registryId}/${childId}/select`, { method: 'POST', headers });
  const childSelection = (await nextSse(selectionStream)).select_agent;
  assert.deepEqual({ ...childSelection, intent_id: undefined }, {
    intent_id: undefined, kind: 'child', id: childId, root_id: registryId,
    parent_agent_id: null,
  });
  assert.equal((await fetch(`${base}/sessions/${registryId}/workbench`, {
    method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      schema: 'vibench.workspace.v1', kind: 'workspace_state', session_id: registryId,
      selected_agent: { kind: 'child', id: childId, root_id: registryId },
      agent_selection_intent: childSelection.intent_id,
    }),
  })).status, 200);
  assert.equal((await childSelectionResponse).status, 200);
  assert.equal((await nextSse(selectionStream)).select_agent, undefined);
  await selectionStream.reader.cancel();

  const rootEvents = sseData((await fetch(
    `${base}/agents/root/${registryId}/timeline/events`, { headers },
  )).body);
  const secondRootEvents = sseData((await fetch(
    `${base}/agents/root/${registryId}/timeline/events`, { headers },
  )).body);
  const childEvents = sseData((await fetch(
    `${base}/agents/child/${registryId}/${childId}/timeline/events`, { headers },
  )).body);
  const embeddedEvents = sseData((await fetch(
    `${base}/agents/child/${registryId}/${embeddedId}/timeline/events`, { headers },
  )).body);
  const legacyEvents = sseData((await fetch(
    `${base}/sessions/${registryId}/terminal/events`, { headers },
  )).body);
  const firstRoot = await nextSse(rootEvents);
  const secondFirstRoot = await nextSse(secondRootEvents);
  const firstChild = await nextSse(childEvents);
  const firstEmbedded = await nextSse(embeddedEvents);
  const firstLegacy = await nextSse(legacyEvents);
  assert.equal(firstRoot.steps.length, 3);
  assert.equal(secondFirstRoot.steps.length, 3);
  assert.equal(firstChild.steps.length, 4);
  assert.deepEqual(firstLegacy.steps.map(({ i, kind }) => ({ i, kind })),
    [{ i: 0, kind: 'other' }]);
  const embeddedPending = firstEmbedded.steps.find(({ tool }) => tool === 'Bash');
  assert.equal(embeddedPending.pending, true);

  fs.appendFileSync(rootFile, line({
    isSidechain: true, agentId: embeddedId, sessionId: rootId,
    type: 'user', timestamp: '2026-08-28T10:00:05.500Z', message: { content: [
      { type: 'tool_result', tool_use_id: 'embedded-shell', content: 'embedded output' },
    ] }, toolUseResult: { stdout: 'embedded output', stderr: '', exitCode: 0 },
  }));
  const completedEmbedded = await nextSse(embeddedEvents);
  const embeddedShell = completedEmbedded.steps.find(({ tool }) => tool === 'Bash');
  assert.equal(completedEmbedded.reset, false);
  assert.equal(completedEmbedded.source.revision, firstEmbedded.source.revision);
  assert.equal(embeddedShell.i, embeddedPending.i);
  assert.equal(embeddedShell.pending, undefined);
  assert.equal(embeddedShell.output, 'embedded output');

  const laterDirectory = path.join(childDirectory, 'workflows', 'wf_later');
  fs.mkdirSync(laterDirectory, { recursive: true });
  const laterFile = path.join(laterDirectory, `agent-${childId}.jsonl`);
  fs.writeFileSync(laterFile, line({
    isSidechain: true, agentId: childId, sessionId: rootId,
    type: 'user', timestamp: '2026-08-28T10:00:06.000Z', message: { content: 'later segment' },
  }));
  const extendedChild = await nextSse(childEvents);
  assert.equal(extendedChild.reset, false);
  assert.equal(extendedChild.source.revision, firstChild.source.revision);
  assert.deepEqual(extendedChild.source.transcripts, [workflowFile, childFile, laterFile]);
  assert.equal(extendedChild.events.at(-1).content, 'later segment');

  fs.appendFileSync(rootFile, line({
    type: 'assistant', timestamp: '2026-08-28T10:00:06.000Z', message: { content: [
      { type: 'tool_use', id: 'root-shell', name: 'Bash', input: { command: 'echo root' } },
    ] },
  }));
  const [pending, secondPending, legacyPending] = await Promise.all([
    nextSse(rootEvents), nextSse(secondRootEvents), nextSse(legacyEvents),
  ]);
  const pendingShell = pending.steps.find(({ tool }) => tool === 'Bash');
  assert.equal(pendingShell.pending, true);
  assert.equal(secondPending.steps.find(({ tool }) => tool === 'Bash').pending, true);
  assert.deepEqual(legacyPending.steps.map(({ i, kind }) => ({ i, kind })),
    [{ i: 0, kind: 'other' }, { i: 1, kind: 'terminal' }]);
  const pendingRevision = pending.source.revision;

  fs.appendFileSync(rootFile, line({
    type: 'user', timestamp: '2026-08-28T10:00:07.000Z', message: { content: [
      { type: 'tool_result', tool_use_id: 'root-shell', content: 'root output' },
    ] }, toolUseResult: { stdout: 'root output', stderr: '', exitCode: 0 },
  }));
  const [completed, secondCompleted, legacyCompleted] = await Promise.all([
    nextSse(rootEvents), nextSse(secondRootEvents), nextSse(legacyEvents),
  ]);
  assert.equal(completed.reset, false);
  assert.equal(completed.source.revision, pendingRevision);
  const completedShell = completed.steps.find(({ tool }) => tool === 'Bash');
  assert.equal(completedShell.i, pendingShell.i);
  assert.equal(completed.steps.length, pending.steps.length);
  assert.equal(completedShell.pending, undefined);
  assert.equal(completedShell.output, 'root output');
  assert.equal(secondCompleted.steps.find(({ tool }) => tool === 'Bash').output, 'root output');
  assert.equal(legacyCompleted.steps[1].output, 'root output');

  fs.appendFileSync(rootFile, line({
    type: 'user', timestamp: '2026-08-28T10:00:08.000Z',
    origin: { kind: 'task-notification' }, message: { content:
      `<task-notification><task-id>${childId}</task-id><status>completed</status></task-notification>` },
  }));
  const [, , completedChild] = await Promise.all([
    nextSse(rootEvents), nextSse(secondRootEvents), nextSse(childEvents),
  ]);
  assert.equal(completedChild.agent.status, 'completed');
  assert.equal(completedChild.agent.ended_at, '2026-08-28T10:00:08.000Z');
  const completedCatalog = await (await fetch(`${base}/agents`, { headers })).json();
  const completedCatalogChild = completedCatalog.roots[0].children.find(({ id }) => id === childId);
  assert.equal(completedCatalogChild.status, 'completed');
  assert.equal(completedCatalogChild.live, false);
  assert.equal(completedCatalogChild.ended_at,
    '2026-08-28T10:00:08.000Z');

  fs.rmSync(childFile);
  fs.rmSync(workflowFile);
  fs.rmSync(laterFile);
  const missingChild = await nextSse(childEvents);
  assert.equal(missingChild.reset, true);
  assert.equal(missingChild.source.reason, 'child transcript not yet created');
  fs.writeFileSync(childFile,
    childRecords('replacement child', '2026-08-28T11:00:03.000Z').map(line).join(''));
  const replacementChild = await nextSse(childEvents);
  assert.equal(replacementChild.reset, true);
  assert.equal(replacementChild.events[0].content, 'replacement child');
});

test('spawns, tracks, and reports subagents; refuses callbacks', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibench-server-'));
  const fixture = path.join(dir, 'fake-claude.js');
  fs.writeFileSync(fixture, `
    const args = process.argv.slice(2);
    const prompt = args[args.indexOf('-p') + 1];
    const sessionId = args[args.indexOf('--session-id') + 1];
    if (!prompt || !sessionId) { console.error('bad args'); process.exit(2); }
    console.log('answered: ' + prompt);
  `);
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({
    harnesses: [{ name: 'claude', cmd: process.execPath, args: [fixture] }],
  }));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: here,
    env: { ...process.env, VIBENCH_DIR: dir, VIBENCH_CONFIG: config },
    stdio: 'ignore',
    windowsHide: true,
  });
  let base; let token;
  t.after(async () => {
    if (child.exitCode === null) {
      const closed = once(child, 'close');
      try {
        if (!base) throw new Error('server did not start');
        await fetch(`${base}/kill`, { method: 'POST', headers: authorized(token) });
      } catch { child.kill(); }
      await closed;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  ({ base, token } = await waitForServer(path.join(dir, 'server.json')));

  const created = await (await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: authorized(token, { 'content-type': 'application/json' }),
    body: JSON.stringify({ name: 'parent', pwd: dir }),
  })).json();

  const refused = await fetch(`${base}/sessions/${created.id}/agents`, {
    method: 'POST',
    headers: authorized(token, { 'content-type': 'application/json' }),
    body: JSON.stringify({ harness: 'claude', mode: 'subagent', prompt: 'hi', callback: true }),
  });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /no completion callback plugin/);

  const unknown = await fetch(`${base}/sessions/${created.id}/agents`, {
    method: 'POST',
    headers: authorized(token, { 'content-type': 'application/json' }),
    body: JSON.stringify({ harness: 'mystery', mode: 'subagent', prompt: 'hi' }),
  });
  assert.equal(unknown.status, 400);

  const spawned = await fetch(`${base}/sessions/${created.id}/agents`, {
    method: 'POST',
    headers: authorized(token, { 'content-type': 'application/json' }),
    body: JSON.stringify({ harness: 'claude', mode: 'subagent', prompt: 'count the beans' }),
  });
  assert.equal(spawned.status, 201);
  const entry = await spawned.json();
  assert.match(entry.agent_id, /^\w+$/);
  assert.match(entry.harness_session_id, /^[0-9a-f-]{36}$/);
  assert.equal(entry.mode, 'subagent');
  assert.equal(entry.status, 'running');

  let finished;
  for (let attempt = 0; attempt < 50; attempt++) {
    finished = await (await fetch(`${base}/sessions/${created.id}/agents/${entry.agent_id}`, {
      headers: authorized(token),
    })).json();
    if (finished.status !== 'running') break;
    await sleep(100);
  }
  assert.equal(finished.status, 'completed');
  assert.match(finished.result, /answered: count the beans/);
  assert.equal(finished.exit, 0);

  const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8'));
  assert.equal(persisted[created.id].agents[0].status, 'completed');
});
