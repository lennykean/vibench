local source = debug.getinfo(1, 'S').source:sub(2)
local repo = vim.fs.dirname(vim.fs.dirname(vim.fs.dirname(source)))
vim.opt.runtimepath:prepend(vim.fs.joinpath(repo, 'nvim'))

local session = require('vibench.session')
local env = {
  VIBENCH_SESSION = 'wrong-bench',
  VIBENCH_TMUX_SOCKET = 'vibench-socket',
  VIBENCH_TMUX_SESSION = 'vibench',
  TMUX_PANE = '%7',
}
local calls = {}
local function mapped(command)
  calls[#calls + 1] = command
  if command[4] == 'display-message' then
    return { code = 0, stdout = 'vibench\t@4\t%7\n' }
  end
  if command[#command] == 'VIBENCH_WINDOW__4' then
    return { code = 0, stdout = 'OTHER=value\nVIBENCH_WINDOW__4=right-bench\nVIBENCH_WATCH__4=0\n' }
  end
  return { code = 0, stdout = 'VIBENCH_WINDOW__4=right-bench\nVIBENCH_WATCH__4=0\nOTHER=value\n' }
end

local resolved, watch = session.resolve(env, mapped)
assert(resolved == 'right-bench', 'window map did not replace inherited identity')
assert(watch == '0', 'window map did not replace inherited Watch state')
assert(vim.deep_equal(calls[1], {
  'tmux', '-L', 'vibench-socket', 'display-message', '-p', '-t', '%7',
  '#{session_name}\t#{window_id}\t#{pane_id}',
}), 'pane identity lookup did not target the current pane')
assert(vim.deep_equal(calls[2], {
  'tmux', '-L', 'vibench-socket', 'show-environment', '-t', '=vibench',
  'VIBENCH_WINDOW__4',
}), 'window ownership lookup used the wrong map key')
assert(vim.deep_equal(calls[3], {
  'tmux', '-L', 'vibench-socket', 'show-environment', '-t', '=vibench',
  'VIBENCH_WATCH__4',
}), 'window Watch lookup used the wrong map key')
local missing_owner, missing_watch = session.resolve(env, function(command)
  if command[4] == 'display-message' then return { code = 0, stdout = 'vibench\t@4\t%7\n' } end
  if command[#command] == 'VIBENCH_WINDOW__4' then
    return { code = 0, stdout = 'VIBENCH_WINDOW__4=right-bench\n' }
  end
  return { code = 1, stdout = '' }
end)
assert(missing_owner == 'right-bench' and missing_watch == nil,
  'missing window Watch map did not safely fall back to the default')
assert(session.resolve(vim.tbl_extend('force', env, { VIBENCH_TMUX_SESSION = '' }), mapped) == nil,
  'managed identity fell back when the tmux session was missing')
assert(session.resolve(vim.tbl_extend('force', env, { TMUX_PANE = '' }), mapped) == nil,
  'managed identity fell back when the pane id was missing')
assert(session.resolve(env, function(command)
  if command[4] == 'display-message' then
    return { code = 0, stdout = 'vibench\t@4\t%3\n' }
  end
  return { code = 0, stdout = 'VIBENCH_WINDOW__4=right-bench\n' }
end) == nil, 'a leaked parent TMUX_PANE was accepted')
assert(session.resolve({ VIBENCH_SESSION = 'headless-bench' }, function()
  error('unmanaged resolution invoked tmux')
end) == 'headless-bench', 'unmanaged headless identity did not use its explicit session')

local plugins = vim.fn.readdir(vim.fs.joinpath(repo, 'nvim', 'plugin'), function(name)
  return name:match('^vibench.*%.lua$') ~= nil
end)
table.sort(plugins)
assert(plugins[1] == 'vibench-00-session.lua', 'session resolver is not the first Vibench plugin')

local real_system = vim.system
vim.env.VIBENCH_SESSION = 'wrong-bench'
vim.env.VIBENCH_WATCH = '1'
vim.env.VIBENCH_TMUX_SOCKET = 'vibench-socket'
vim.env.VIBENCH_TMUX_SESSION = 'vibench'
vim.env.TMUX_PANE = '%7'
vim.system = function(command)
  local result = mapped(command)
  return { wait = function() return result end }
end
dofile(vim.fs.joinpath(repo, 'nvim', 'plugin', 'vibench-00-session.lua'))
assert(vim.env.VIBENCH_SESSION == 'right-bench', 'startup plugin did not publish mapped identity')
assert(vim.env.VIBENCH_WATCH == '0', 'startup plugin did not publish mapped Watch state')
package.loaded['vibench.playhead'] = nil
assert(not require('vibench.playhead').state().watch, 'playhead ignored the resolved initial Watch state')

vim.env.VIBENCH_SESSION = 'wrong-again'
vim.env.VIBENCH_WATCH = '0'
vim.env.TMUX_PANE = nil
dofile(vim.fs.joinpath(repo, 'nvim', 'plugin', 'vibench-00-session.lua'))
assert(vim.env.VIBENCH_SESSION == nil, 'startup plugin retained inherited identity after resolution failed')
assert(vim.env.VIBENCH_WATCH == nil, 'startup plugin retained inherited Watch state after resolution failed')
vim.system = real_system

vim.env.VIBENCH_SESSION = 'private-registry-id'
vim.g.vibench_agentterm_server_json = vim.fs.joinpath(repo, 'does-not-exist.json')
local notices = {}
local real_notify = vim.notify
vim.notify = function(message) notices[#notices + 1] = message end
dofile(vim.fs.joinpath(repo, 'nvim', 'plugin', 'vibench.lua'))
vim.g.vibench = {
  id = 'private-registry-id',
  name = 'demo',
  pwd = 'C:/workspace',
  harness = 'claude',
  harness_session_id = 'claude-session',
}
vim.cmd('Vibench')
assert(notices[#notices] == 'vibench demo  C:/workspace  harness claude  session claude-session',
  ':Vibench did not identify the bench by its public fields')
assert(not notices[#notices]:find('private-registry-id', 1, true),
  ':Vibench exposed the internal registry id')
vim.g.vibench = nil
vim.cmd('Vibench')
assert(not notices[#notices]:find('private-registry-id', 1, true),
  ':Vibench exposed the internal registry id while metadata was unavailable')
vim.notify = real_notify

print('session_headless: PASS')
vim.cmd('qa!')
