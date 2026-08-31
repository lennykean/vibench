import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { cleanup, testEnv, tmux } from '../../isolation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibench-agentterm-'));
const registry = path.join(temp, 'registry');
const projects = path.join(temp, 'projects');
const pwd = path.join(temp, 'work');
const project = path.join(projects, pwd.replace(/[:\\/.]/g, '-'));
const ready = path.join(temp, 'ready');
const tmuxName = `vibench-agentterm-${process.pid}-${Date.now()}`;
const repo = path.resolve(__dirname, '..', '..');
const slash = value => value.replace(/\\/g, '/');
const waitFor = async (test, message) => {
  for (let i = 0; i < 150; i++) {
    try { if (await test()) return; } catch { /* retry */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(typeof message === 'function' ? message() : message);
};

fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(registry, { recursive: true });
fs.mkdirSync(pwd, { recursive: true });
const blocks = ['one', 'two', 'three', 'four'].map((name, i) => ({
  i, command: `command-${name}`, output: i === 3 ? '\u001b[32mfour\u001b[0m\n'.repeat(8) : `${name}\n`.repeat(8),
  cwd: pwd, exit: 0,
}));
const server = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  response.write(`data: ${JSON.stringify({
    session: { name: 'real-e2e' }, blocks, source: { revision: 'e2e-source' },
  })}\n\n`);
});

try {
  const serverJson = path.join(registry, 'server.json');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(serverJson, JSON.stringify({ port: server.address().port }));

  const spec = slash(path.join(__dirname, 'agentterm_spec.lua'));
  const plugin = slash(path.join(repo, 'nvim', 'plugin', 'vibench-agentterm.lua'));
  const scrubberPlugin = slash(path.join(repo, 'nvim', 'plugin', 'vibench-scrubber.lua'));
  const init = path.join(temp, 'init.lua');
  fs.writeFileSync(init, `vim.opt.runtimepath:prepend('${slash(path.join(repo, 'nvim'))}')\nvim.api.nvim_create_autocmd('UIEnter', { once = true, callback = function() dofile('${spec}') end })\n`);
  tmux('new-session', '-d', '-s', tmuxName, '-x', '120', '-y', '35', '-c', repo,
    '-e', 'VIBENCH_SESSION=test-session', '-e', `VIBENCH_SERVER_JSON=${slash(serverJson)}`,
    '-e', `VIBENCH_PLUGIN=${plugin}`, '-e', `VIBENCH_SCRUBBER_PLUGIN=${scrubberPlugin}`,
    '-e', `VIBENCH_READY=${slash(ready)}`,
    `nvim --clean -u ${slash(init)}`);
  await waitFor(() => fs.existsSync(ready), () =>
    `real TUI did not render initial blocks:\n${tmux('capture-pane', '-p', '-e', '-a', '-t', `${tmuxName}:0.0`)}`);
  let screen;
  await waitFor(() => {
    screen = tmux('capture-pane', '-p', '-e', '-a', '-t', `${tmuxName}:0.0`);
    return screen.includes('4/4') && screen.includes('$ command-four');
  }, () => `real TUI screen missing scrubber or blocks:\n${screen}`);
  if (!screen.split(/\r?\n/).some(row => row.includes('four') && row.includes('\x1b['))) {
    throw new Error('real TUI screen did not render ANSI-styled output');
  }

  const pane = `${tmuxName}:0.0`;
  const press = (...keys) => tmux('send-keys', '-t', pane, ...keys);
  const pressLiteral = keys => tmux('send-keys', '-t', pane, '-l', keys);
  const expectView = async (action, position, command) => {
    pressLiteral(`:lua require('vibench.playhead').${action}()`);
    press('Enter');
    await waitFor(() => {
      screen = tmux('capture-pane', '-p', '-e', '-t', pane);
      const rows = screen.split(/\r?\n/);
      const bar = rows.findLastIndex(row => row.includes(position));
      const target = rows.findIndex(row => row.includes(command));
      return bar >= 0 && target >= 0 && target < bar;
    }, () => `action ${action} did not show ${position}/${command}:\n${screen}`);
  };
  await expectView('home', '1/4', '$ command-one');
  await expectView('next', '2/4', '$ command-two');
  await expectView('next', '3/4', '$ command-three');
  await expectView('previous', '2/4', '$ command-two');
  await expectView('finish', '4/4', '$ command-four');
  pressLiteral(':qa!'); press('Enter');
  await waitFor(() => { try { tmux('has-session', '-t', tmuxName); return false; } catch { return true; } },
    'Neovim TUI did not exit');
  process.stdout.write('agentterm_spec: PASS (real TUI, SSE render, shared-playhead navigation)\n');
} finally {
  try { tmux('kill-session', '-t', tmuxName); } catch { /* already gone */ }
  await waitFor(() => {
    try { tmux('has-session', '-t', tmuxName); return false; } catch { return true; }
  }, 'test-owned tmux session survived cleanup');
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
  cleanup();
}
