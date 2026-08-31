export const windowOwnerKey = (windowId) => `VIBENCH_WINDOW_${windowId.replace(/[^A-Za-z0-9]/g, '_')}`;
export const windowWatchKey = (windowId) => `VIBENCH_WATCH_${windowId.replace(/[^A-Za-z0-9]/g, '_')}`;

export function windowOwner(tmux, session, windowId) {
  if (!session || !windowId) return null;
  try {
    const key = windowOwnerKey(windowId);
    const line = tmux('show-environment', '-t', `=${session}`, key).split(/\r?\n/)
      .find((value) => value.startsWith(`${key}=`));
    const owner = line?.slice(key.length + 1).trim();
    return owner && /^[A-Za-z0-9_-]+$/.test(owner) ? owner : null;
  } catch { return null; }
}

export function resolvePaneSession(tmux, env = process.env) {
  const inherited = env.VIBENCH_SESSION || null;
  const managed = !!env.VIBENCH_TMUX_SOCKET;
  if (!managed) return inherited;
  if (!env.VIBENCH_TMUX_SESSION || !env.TMUX_PANE) return null;
  try {
    const [session, windowId, paneId] = tmux(
      'display-message', '-p', '-t', env.TMUX_PANE,
      '#{session_name}\t#{window_id}\t#{pane_id}',
    ).trim().split('\t');
    if (!session || !windowId || paneId !== env.TMUX_PANE
        || session !== env.VIBENCH_TMUX_SESSION) return null;
    return windowOwner(tmux, session, windowId);
  } catch { return null; }
}

export function ownedHostTarget(tmux, name, id) {
  try {
    const target = tmux('display-message', '-p', '-t', `=${name}`, '#{session_id}').trim();
    if (!target) return null;
    return tmux('show-environment', '-t', target, 'VIBENCH_SESSION').split(/\r?\n/)
      .includes(`VIBENCH_SESSION=${id}`) ? target : null;
  } catch { return null; }
}

export function cleanupOwnedHost(tmux, target, id) {
  if (!target || !id) return false;
  try {
    const owned = tmux('show-environment', '-t', target, 'VIBENCH_SESSION').split(/\r?\n/)
      .includes(`VIBENCH_SESSION=${id}`);
    const windows = tmux('list-windows', '-t', target, '-F', '#{window_id}').split(/\r?\n/).filter(Boolean);
    if (!owned || windows.length > 1) return false;
    tmux('kill-session', '-t', target);
    return true;
  } catch { return false; }
}
