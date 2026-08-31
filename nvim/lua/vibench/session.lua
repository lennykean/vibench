local M = {}

function M.window_owner_key(window_id)
  return 'VIBENCH_WINDOW_' .. tostring(window_id):gsub('[^%w]', '_')
end

function M.window_watch_key(window_id)
  return 'VIBENCH_WATCH_' .. tostring(window_id):gsub('[^%w]', '_')
end

local function default_run(command)
  return vim.system(command, { text = true }):wait()
end

local function output(run, command)
  local ok, result = pcall(run, command)
  if not ok or type(result) ~= 'table' or result.code ~= 0 then return nil end
  return vim.trim(result.stdout or '')
end

local function environment_value(text, key)
  for _, line in ipairs(vim.split(text or '', '\n', { plain = true })) do
    local value = line:match('^' .. key .. '=(.*)$')
    if value then return value end
  end
end

function M.resolve(env, run)
  env, run = env or vim.env, run or default_run
  local inherited = env.VIBENCH_SESSION
  local managed = env.VIBENCH_TMUX_SOCKET and env.VIBENCH_TMUX_SOCKET ~= ''
  if not managed then return inherited, env.VIBENCH_WATCH end
  if not env.VIBENCH_TMUX_SESSION or env.VIBENCH_TMUX_SESSION == '' then return nil end
  local pane = env.TMUX_PANE
  if not pane or pane == '' then return nil end
  local identity = output(run, {
    'tmux', '-L', env.VIBENCH_TMUX_SOCKET, 'display-message', '-p', '-t', pane,
    '#{session_name}\t#{window_id}\t#{pane_id}',
  })
  if not identity then return nil end
  local parts = vim.split(identity, '\t', { plain = true })
  local session, window_id, actual_pane = parts[1], parts[2], parts[3]
  if session ~= env.VIBENCH_TMUX_SESSION or not window_id or window_id == ''
      or actual_pane ~= pane then return nil end
  local key = M.window_owner_key(window_id)
  local mapped = output(run, {
    'tmux', '-L', env.VIBENCH_TMUX_SOCKET, 'show-environment', '-t', '=' .. session, key,
  })
  local owner = environment_value(mapped, key)
  if not owner or not owner:match('^[%w_-]+$') then return nil end
  local watch_key = M.window_watch_key(window_id)
  local watch_mapped = output(run, {
    'tmux', '-L', env.VIBENCH_TMUX_SOCKET, 'show-environment', '-t', '=' .. session, watch_key,
  })
  local watch = environment_value(watch_mapped, watch_key)
  if watch ~= '0' and watch ~= '1' then watch = nil end
  return owner, watch
end

return M
