local source = debug.getinfo(1, 'S').source:sub(2)
local repo = vim.fs.dirname(vim.fs.dirname(vim.fs.dirname(source)))
vim.opt.runtimepath:prepend(vim.fs.joinpath(repo, 'nvim'))
vim.env.VIBENCH_SESSION = 'watch-headless'
vim.env.VIBENCH_SERVER = nil
vim.env.VIBENCH_SERVER_TOKEN = nil
vim.g.vibench_agentterm_server_json = vim.fs.joinpath(repo, 'does-not-exist.json')
vim.g.vibench_agentterm_height = 5
local tool_calls_shown = 0
vim.g.vibench_tools = { show = function() tool_calls_shown = tool_calls_shown + 1 end }

local main_window = vim.api.nvim_get_current_win()
local user_buffer = vim.api.nvim_get_current_buf()
vim.api.nvim_buf_set_name(user_buffer, 'watch-user-buffer.lua')
vim.api.nvim_buf_set_lines(user_buffer, 0, -1, false, { 'local unsaved = true' })
vim.bo[user_buffer].modified = true

for _, plugin in ipairs({
  'vibench-agentterm.lua', 'vibench-agentview.lua', 'vibench-chat.lua',
  'vibench-toolinfo.lua', 'vibench-watch.lua',
}) do
  dofile(vim.fs.joinpath(repo, 'nvim', 'plugin', plugin))
end

local terminal = vim.g.vibench_agentterm
local agentview = vim.g.vibench_agentview
local chat = vim.g.vibench_chat
local toolinfo = vim.g.vibench_toolinfo
local timeline = require('vibench.timeline')
local playhead = require('vibench.playhead')
assert(not terminal.state().window and not agentview.state().visible
    and not chat.state().visible and not toolinfo.state().visible,
  'a replay panel opened before the timeline had a current step')

local file_lines = {}
for index = 1, 45 do file_lines[index] = ('line %d'):format(index) end
local chat_lines = {}
for index = 1, 35 do chat_lines[index] = ('message %d'):format(index) end
local params = {}
for index = 1, 12 do params['value_' .. index] = index end
local steps = {
  { i = 0, kind = 'terminal', category = 'terminal', command = 'long output',
    output = table.concat(file_lines, '\n'), exit = 0 },
  { i = 1, kind = 'patch', category = 'file', path = 'watched.lua',
    content = table.concat(file_lines, '\n'), region = { start_line = 30, end_line = 30 } },
  { i = 2, kind = 'chat', category = 'chat', event = 'message', role = 'assistant',
    content = table.concat(chat_lines, '\n') },
  { i = 3, kind = 'other', category = 'tool_info', tool = 'Glob', params = params, pending = true },
}

timeline.ingest({
  source = { revision = 'watch-r1' },
  agent = { kind = 'root', id = 'watch-headless', root_id = 'watch-headless' },
  steps = steps,
})
assert(vim.wait(500, function() return toolinfo.state().visible end),
  'Watch did not open Tool Info for the exact current category')
assert(vim.api.nvim_get_current_win() == main_window, 'Watch stole focus when it opened Tool Info')
local drawer_count = #vim.api.nvim_tabpage_list_wins(0)

playhead.seek(1, false)
assert(vim.wait(500, function()
  return terminal.state().window and not toolinfo.state().visible
end), 'Watch did not swap Tool Info for Agent Terminal')
assert(#vim.api.nvim_tabpage_list_wins(0) == drawer_count,
  'Watch stacked bottom drawers instead of swapping them')
assert(vim.wait(500, function()
  local win = terminal.state().window
  return win and vim.api.nvim_win_get_cursor(win)[1]
    == vim.api.nvim_buf_line_count(terminal.state().buffer)
end), 'Watch did not reveal the bottom of Agent Terminal')
vim.api.nvim_win_set_cursor(terminal.state().window, { 2, 0 })

playhead.seek(2, false)
assert(vim.wait(500, function() return agentview.state().visible end),
  'Watch did not open Agent View for a file step')
assert(vim.api.nvim_win_get_cursor(agentview.state().window)[1] == 30,
  'Watch did not reveal Agent View first relevant line')
assert(vim.api.nvim_win_get_cursor(terminal.state().window)[1] == 2,
  'an unrelated file step changed Agent Terminal scroll')
assert(vim.api.nvim_buf_is_valid(user_buffer) and vim.bo[user_buffer].modified,
  'Watch discarded the modified user buffer')
vim.api.nvim_win_set_cursor(agentview.state().window, { 5, 0 })

steps[5] = { i = 4, kind = 'chat', category = 'chat', event = 'message', role = 'assistant',
  content = 'new work after the held file step' }
timeline.ingest({
  source = { revision = 'watch-r1' },
  agent = { kind = 'root', id = 'watch-headless', root_id = 'watch-headless' },
  steps = steps,
})
vim.wait(50)
assert(vim.api.nvim_win_get_cursor(agentview.state().window)[1] == 5,
  'an unrelated appended step re-revealed the held Agent View')

local first_tab_view = agentview.state().window
vim.api.nvim_win_set_cursor(first_tab_view, { 7, 0 })
vim.cmd('tabnew')
local second_tab = vim.api.nvim_get_current_tabpage()
playhead.set_watch(false)
vim.wait(20)
playhead.set_watch(true)
assert(vim.wait(500, function()
  local win = agentview.state().window
  return win and vim.api.nvim_win_get_tabpage(win) == second_tab
end), 'Watch reused an off-tab Agent View instead of opening in the current tab')
assert(vim.api.nvim_win_get_cursor(first_tab_view)[1] == 7,
  'Watch scrolled an off-tab Agent View')
vim.cmd('tabclose')
assert(agentview.state().window == first_tab_view, 'Agent View did not resolve the active-tab window')
vim.api.nvim_win_set_cursor(first_tab_view, { 5, 0 })

playhead.seek(3, false)
vim.wait(50)
assert(not chat.state().visible, 'Watch auto-opened Chat for a chat step')
assert(vim.api.nvim_win_get_cursor(agentview.state().window)[1] == 5,
  'an unrelated chat step changed Agent View scroll')
chat.show()
vim.api.nvim_set_current_win(main_window)
vim.api.nvim_win_set_cursor(chat.state().window, { 20, 0 })
playhead.set_watch(false)
playhead.set_watch(true)
assert(vim.wait(500, function()
  return vim.api.nvim_win_get_cursor(chat.state().window)[1] == 1
end),
  'Watch did not reveal the latest Chat message while Chat was visible')
vim.api.nvim_win_set_cursor(chat.state().window, { 20, 0 })

playhead.set_watch(false)
playhead.seek(4, false)
vim.wait(50)
assert(not toolinfo.state().visible and terminal.state().window,
  'Watch off opened or swapped a category panel')
assert(vim.api.nvim_win_get_cursor(chat.state().window)[1] == 20,
  'Watch off changed Chat scroll')

toolinfo.show()
assert(toolinfo.state().visible, 'Tool Info did not open manually with Watch off')
vim.api.nvim_win_set_cursor(toolinfo.state().window, { 5, 0 })
steps[4] = vim.tbl_extend('force', steps[4], { pending = false, response = 'finished' })
timeline.ingest({
  source = { revision = 'watch-r1' },
  agent = { kind = 'root', id = 'watch-headless', root_id = 'watch-headless' },
  steps = steps,
})
assert(vim.wait(500, function()
  local text = table.concat(vim.api.nvim_buf_get_lines(toolinfo.state().buffer, 0, -1, false), '\n')
  return text:find('finished', 1, true) ~= nil
end), 'a pending completion did not update Tool Info with Watch off')
assert(vim.api.nvim_win_get_cursor(toolinfo.state().window)[1] == 5,
  'a pending completion changed Tool Info scroll with Watch off')

vim.api.nvim_win_call(toolinfo.state().window, function() vim.cmd('normal! zt') end)
local held_toolinfo_view = vim.api.nvim_win_call(toolinfo.state().window, vim.fn.winsaveview)
toolinfo.hide()
toolinfo.show()
local reopened_toolinfo_view = vim.api.nvim_win_call(toolinfo.state().window, vim.fn.winsaveview)
assert(reopened_toolinfo_view.lnum == held_toolinfo_view.lnum
    and reopened_toolinfo_view.topline == held_toolinfo_view.topline,
  'reopening Tool Info discarded its position with Watch off')
toolinfo.hide()
playhead.set_watch(true)
assert(vim.wait(500, function()
  return toolinfo.state().visible and vim.api.nvim_win_get_cursor(toolinfo.state().window)[1] == 1
end), 'turning Watch on did not open and reveal the current category')
assert(vim.api.nvim_win_get_cursor(chat.state().window)[1] == 20,
  'turning Watch on for Tool Info changed Chat scroll')
assert(vim.api.nvim_buf_is_valid(user_buffer) and vim.bo[user_buffer].modified,
  'Watch lost unsaved user changes after category routing')
assert(tool_calls_shown == 0, 'Watch routed a timeline category to Tool Calls')

print('watch_headless: PASS')
vim.cmd('qa!')
