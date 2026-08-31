// ~/.vibench/config.json: the harness list. No auto-detection by design; the
// user names what they run and with which extra args.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_DIR = process.env.VIBENCH_DIR || path.join(os.homedir(), '.vibench');
// VIBENCH_CONFIG overrides the path (tests use it)
export const CONFIG_FILE = process.env.VIBENCH_CONFIG || path.join(CONFIG_DIR, 'config.json');

const DEFAULTS = {
  harnesses: [
    { name: 'claude', cmd: 'claude', args: [] },
    { name: 'opencode', cmd: 'opencode', args: [] },
  ],
};

export function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const harnesses = (raw.harnesses ?? []).filter(
      (h) => h && typeof h.name === 'string' && typeof h.cmd === 'string',
    );
    if (harnesses.length) return { harnesses };
  } catch (e) {
    if (e.code === 'ENOENT') {
      try {
        fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULTS, null, 2) + '\n');
      } catch { /* unwritable home: run on defaults */ }
    }
  }
  return structuredClone(DEFAULTS);
}
