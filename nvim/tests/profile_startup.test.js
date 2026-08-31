import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('the deployed Vibench profile loads every panel plugin', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibench-profile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    VIBENCH_DIR: path.join(root, 'state'),
    VIBENCH_SESSION: 'profile-test',
    VIBENCH_SERVER_JSON: path.join(root, 'missing-server.json'),
    NVIM_APPNAME: 'vibench',
  };
  delete env.TMUX_PANE;
  delete env.VIBENCH_TMUX_SOCKET;
  delete env.VIBENCH_TMUX_SESSION;
  if (process.platform === 'win32') env.LOCALAPPDATA = path.join(root, 'local');
  else {
    env.XDG_CONFIG_HOME = path.join(root, 'config');
    env.XDG_DATA_HOME = path.join(root, 'data');
  }

  execFileSync(process.execPath, ['cli.js', 'reset-nvim'], { cwd: repo, env, windowsHide: true });
  const commands = [
    'Vibench', 'VibenchAgents', 'VibenchAgentTerm', 'VibenchAgentView', 'VibenchChat',
    'VibenchData', 'VibenchScrubber', 'VibenchToolInfo', 'VibenchTools',
  ];
  const probe = `lua for _, name in ipairs(${JSON.stringify(commands)}) do assert(vim.fn.exists(':' .. name) == 2, name .. ' was not loaded') end`;
  assert.doesNotThrow(() => execFileSync('nvim', ['--headless', '-i', 'NONE', '-c', probe, '-c', 'qa!'], {
    cwd: repo, env, windowsHide: true, stdio: 'pipe', timeout: 30_000,
  }));
});
