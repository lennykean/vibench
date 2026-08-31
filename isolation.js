import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibench-test-'));
export const testEnv = {
  ...process.env,
  VIBENCH_DIR: path.join(testRoot, 'registry'),
  LOCALAPPDATA: path.join(testRoot, 'local-app-data'),
  XDG_CONFIG_HOME: path.join(testRoot, 'xdg-config'),
  XDG_DATA_HOME: path.join(testRoot, 'xdg-data'),
  VIBENCH_TMUX_SOCKET: `vibench-test-${process.pid}-${crypto.randomUUID()}`,
  VIBENCH_TMUX_SESSION: `vibench-test-${process.pid}-${crypto.randomUUID()}`,
};
export const tmux = (...args) => execFileSync('tmux', ['-L', testEnv.VIBENCH_TMUX_SOCKET, ...args], {
  encoding: 'utf8', windowsHide: true, timeout: 5000, env: testEnv,
});
export const cleanup = () => {
  try { tmux('kill-server'); } catch { /* no isolated server */ }
  fs.rmSync(testRoot, { recursive: true, force: true });
};
