local source = debug.getinfo(1, 'S').source:sub(2)
local repo = vim.fs.dirname(vim.fs.dirname(vim.fs.dirname(source)))
vim.opt.runtimepath:prepend(vim.fs.joinpath(repo, 'nvim'))
vim.env.VIBENCH_SESSION = 'data-headless'
vim.env.VIBENCH_SERVER = nil
vim.g.vibench_agentterm_server_json = vim.fs.joinpath(repo, 'does-not-exist.json')
vim.g.vibench_agentterm_height = 6
vim.g.vibench_workspace_publish = false
vim.keymap.set('n', '<C-h>', function() vim.g.vibench_data_global_mapping = true end,
  { desc = 'Global DATA mapping' })
vim.api.nvim_create_autocmd('FileType', {
  pattern = 'vibench-data',
  callback = function(args)
    vim.keymap.set('n', '<C-l>', function() vim.g.vibench_data_user_mapping = true end,
      { buffer = args.buf, desc = 'User DATA mapping' })
    vim.keymap.set('n', 'q', function() vim.g.vibench_data_user_close_mapping = true end,
      { buffer = args.buf, desc = 'User DATA close mapping' })
  end,
})

local main_window = vim.api.nvim_get_current_win()
vim.api.nvim_buf_set_name(0, 'data-main.lua')
for _, plugin in ipairs({ 'vibench-agentterm.lua', 'vibench-toolinfo.lua', 'vibench-data.lua' }) do
  dofile(vim.fs.joinpath(repo, 'nvim', 'plugin', plugin))
end

local terminal = vim.g.vibench_agentterm
local toolinfo = vim.g.vibench_toolinfo
local data = vim.g.vibench_data
local timeline = require('vibench.timeline')
local playhead = require('vibench.playhead')
assert(data and vim.fn.exists(':VibenchData') == 2, 'DATA command is missing')
assert(vim.fn.maparg('<Plug>(VibenchDataToggle)', 'n') ~= ''
    and vim.fn.maparg('<Plug>(VibenchDataHide)', 'n') ~= ''
    and vim.fn.maparg('<leader>D', 'n') == '<Plug>(VibenchDataToggle)',
  'DATA toggle or hide actions are missing')

local rows = {}
for index = 1, 15 do rows[index] = { index == 1 and 'longer' or 'row-' .. index, index } end
local steps = {
  { i = 0, kind = 'data', category = 'data', title = 'Inventory', command = 'run_table inventory',
    table = { columns = { 'name', 'count' }, rows = rows } },
  { i = 1, kind = 'terminal', category = 'terminal', command = 'between', output = '', exit = 0 },
  { i = 2, kind = 'data', category = 'data', title = 'Pending table', pending = true },
  { i = 3, kind = 'terminal', category = 'terminal', command = 'later', output = '', exit = 0 },
  { i = 4, kind = 'error', action = 'data', category = 'data', title = 'Broken table',
    command = 'run_table broken', error = 'captured failure' },
}
assert(timeline.ingest({ source = { revision = 'data-r1' }, steps = steps }),
  'timeline rejected normalized DATA steps')
assert(#data.state().steps == 3, 'DATA consumed a non-DATA timeline step or dropped a failed DATA step')

playhead.seek(1, false)
data.show(false)
assert(data.state().visible and vim.api.nvim_get_current_win() == main_window,
  'DATA show(false) did not open without stealing focus')
local state = data.state()
local data_window, data_buffer = state.window, state.buffer
local lines = vim.api.nvim_buf_get_lines(data_buffer, 0, -1, false)
assert(lines[1] == 'Inventory' and lines[2] == '$ run_table inventory'
    and lines[4] == 'name    count' and lines[6]:find('longer', 1, true),
  'DATA did not render its title, command, and padded captured table')
assert(vim.bo[data_buffer].buftype == 'nofile' and vim.bo[data_buffer].readonly
    and not vim.bo[data_buffer].modifiable and not vim.bo[data_buffer].swapfile,
  'DATA buffer is not read-only')
assert(vim.wo[data_window].winbar == ' DATA ' and not vim.wo[data_window].wrap
    and vim.wo[data_window].cursorline and not vim.wo[data_window].spell
    and vim.wo[data_window].winfixheight and vim.wo[data_window].winfixbuf,
  'DATA window options or single title are wrong')
assert(not pcall(vim.api.nvim_win_set_buf, data_window, vim.api.nvim_get_current_buf())
    and vim.api.nvim_win_get_buf(data_window) == data_buffer,
  'a normal file replaced the fixed DATA buffer')
local native_j, shared_prev, user_next, user_close, global_prev
vim.api.nvim_buf_call(data_buffer, function()
  native_j = vim.fn.maparg('j', 'n', false, true)
  shared_prev = vim.fn.maparg('<C-h>', 'n', false, true)
  user_next = vim.fn.maparg('<C-l>', 'n', false, true)
  user_close = vim.fn.maparg('q', 'n', false, true)
end)
vim.api.nvim_win_call(main_window, function()
  global_prev = vim.fn.maparg('<C-h>', 'n', false, true)
end)
assert(vim.tbl_isempty(native_j) and shared_prev.buffer == 1
    and shared_prev.desc == 'Vibench playhead: prev' and type(shared_prev.callback) == 'function'
    and global_prev.buffer == 0 and global_prev.desc == 'Global DATA mapping',
  'DATA replaced native movement or failed to shadow a global map locally')
assert(user_next.desc == 'User DATA mapping' and type(user_next.callback) == 'function'
    and vim.fn.maparg('<Plug>(VibenchPlayheadNext)', 'n') ~= '',
  'DATA replaced a user buffer-local mapping or removed its shared Plug action')
user_next.callback()
assert(vim.g.vibench_data_user_mapping, 'the preserved user buffer-local mapping did not run')
assert(user_close.desc == 'User DATA close mapping' and type(user_close.callback) == 'function',
  'DATA replaced a user buffer-local panel mapping')
user_close.callback()
assert(vim.g.vibench_data_user_close_mapping and data.state().visible,
  'the preserved user panel mapping did not run')

vim.api.nvim_win_set_cursor(data_window, { 8, 0 })
steps[6] = { i = 5, kind = 'terminal', category = 'terminal', command = 'future', output = '', exit = 0 }
timeline.ingest({ source = { revision = 'data-r1' }, steps = steps })
assert(playhead.state().position == 1 and vim.api.nvim_win_get_cursor(data_window)[1] == 8,
  'an unrelated timeline update changed DATA position or scroll')
playhead.set_watch(false)
vim.api.nvim_set_current_win(data_window)
vim.api.nvim_win_call(data_window, function() vim.cmd('normal! zt') end)
local held_view = vim.api.nvim_win_call(data_window, vim.fn.winsaveview)
data.show()
assert(vim.api.nvim_win_get_cursor(data.state().window)[1] == 8,
  'focusing DATA discarded its position with Watch off')
vim.api.nvim_win_close(data.state().window, true)
assert(vim.wait(500, function() return not data.state().visible end),
  'native close did not release DATA')
data.show()
local reopened_view = vim.api.nvim_win_call(data.state().window, vim.fn.winsaveview)
assert(reopened_view.lnum == held_view.lnum and reopened_view.topline == held_view.topline,
  'reopening DATA discarded its position with Watch off')
playhead.set_watch(true)
playhead.seek(2, false)
assert(data.state().step.i == 0, 'DATA did not retain the latest table before a non-DATA step')
playhead.seek(3, false)
assert(vim.wait(200, function()
  return table.concat(vim.api.nvim_buf_get_lines(data_buffer, 0, -1, false), '\n')
    :find('IN FLIGHT', 1, true) ~= nil
end), 'DATA did not render pending state')
playhead.seek(5, false)
assert(vim.wait(200, function()
  local text = table.concat(vim.api.nvim_buf_get_lines(data_buffer, 0, -1, false), '\n')
  return text:find('Broken table', 1, true) and text:find('captured failure', 1, true)
end), 'DATA did not render a failed DATA step')

local drawer_count = #vim.api.nvim_tabpage_list_wins(0)
terminal.show()
assert(terminal.state().window and not data.state().visible
    and #vim.api.nvim_tabpage_list_wins(0) == drawer_count,
  'Agent Terminal stacked with DATA instead of replacing it')
data.show()
assert(data.state().visible and not terminal.state().window
    and #vim.api.nvim_tabpage_list_wins(0) == drawer_count,
  'DATA stacked with Agent Terminal instead of replacing it')
toolinfo.show()
assert(toolinfo.state().visible and not data.state().visible
    and #vim.api.nvim_tabpage_list_wins(0) == drawer_count,
  'Tool Info stacked with DATA instead of replacing it')

toolinfo.hide()
vim.api.nvim_set_current_win(main_window)
vim.cmd('belowright 2split')
local lazy_window = vim.api.nvim_get_current_win()
local lazy_buffer = vim.api.nvim_create_buf(false, true)
vim.api.nvim_win_set_buf(lazy_window, lazy_buffer)
vim.bo[lazy_buffer].filetype = 'snacks_terminal'
local lazy_hidden = false
local fake_terminal = {
  win = lazy_window,
  opts = { position = 'bottom' },
  hide = function(self)
    lazy_hidden = true
    if vim.api.nvim_win_is_valid(self.win) then vim.api.nvim_win_close(self.win, true) end
  end,
}
_G.Snacks = { terminal = { list = function() return { fake_terminal } end } }
vim.api.nvim_set_current_win(main_window)
data.show(false)
assert(lazy_hidden and data.state().visible
    and #vim.api.nvim_tabpage_list_wins(0) == drawer_count,
  'DATA stacked with the LazyVim bottom terminal')

vim.g.vibench_workspace_publish = false
dofile(vim.fs.joinpath(repo, 'nvim', 'plugin', 'vibench-workspace.lua'))
local workspace_data = vim.g.vibench_workspace.snapshot().panels.data
assert(workspace_data.available and workspace_data.visible and workspace_data.count == 3
    and workspace_data.step == 4,
  'workspace state omitted DATA panel state')

data.hide()
vim.api.nvim_set_current_win(main_window)
dofile(vim.fs.joinpath(repo, 'nvim', 'plugin', 'vibench-watch.lua'))
playhead.set_watch(false)
playhead.seek(1, false)
playhead.set_watch(true)
assert(vim.wait(500, function()
  local current = data.state()
  return current.visible and vim.api.nvim_win_get_cursor(current.window)[1] == 1
end), 'Watch did not route and reveal DATA')
assert(vim.api.nvim_get_current_win() == main_window, 'Watch stole focus when it opened DATA')

vim.fn.maparg('<Plug>(VibenchDataHide)', 'n', false, true).callback()
assert(not data.state().visible and vim.api.nvim_win_is_valid(main_window),
  'DATA Hide action did not close only the drawer')

print('data_headless: PASS')
vim.cmd('qa!')
