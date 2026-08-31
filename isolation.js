import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibench-test-'));
// Strip the ambient bench identity: tests run from inside a vibench pane
// otherwise inherit TMUX_PANE and VIBENCH_* values that make nested psmux
// panes and session resolution lie (see the psmux env-bleed issue).
const ambient = { ...process.env };
for (const key of Object.keys(ambient)) {
  if (key === 'TMUX' || key === 'TMUX_PANE' || key.startsWith('VIBENCH_')) delete ambient[key];
}
export const testEnv = {
  ...ambient,
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
