local source = debug.getinfo(1, 'S').source:sub(2)
local repo = vim.fs.dirname(vim.fs.dirname(vim.fs.dirname(source)))
vim.opt.runtimepath:prepend(vim.fs.joinpath(repo, 'nvim'))
vim.env.VIBENCH_SESSION = 'chat-headless'
vim.env.VIBENCH_SERVER = nil
vim.env.VIBENCH_SERVER_TOKEN = nil
vim.g.vibench_agentterm_server_json = vim.fs.joinpath(repo, 'does-not-exist.json')

local main_window = vim.api.nvim_get_current_win()
local main_buffer = vim.api.nvim_get_current_buf()
vim.api.nvim_buf_set_name(main_buffer, 'chat-headless-main.lua')

vim.cmd('topleft 16vsplit')
local sidebar_window = vim.api.nvim_get_current_win()
vim.api.nvim_buf_set_name(0, 'chat-headless-sidebar')
vim.wo.winfixwidth = true

vim.api.nvim_set_current_win(main_window)
vim.cmd('belowright 4split')
local drawer_window = vim.api.nvim_get_current_win()
vim.api.nvim_buf_set_name(0, 'chat-headless-drawer')
vim.wo.winfixheight = true
vim.g.vibench_toolinfo = { state = function() return { window = drawer_window } end }
vim.api.nvim_set_current_win(main_window)

dofile(vim.fs.joinpath(repo, 'nvim', 'plugin', 'vibench-scrubber.lua'))
assert(vim.wait(500, function() return vim.g.vibench_scrubber.state().visible end),
  'scrubber did not open for Chat geometry test')
vim.api.nvim_set_current_win(main_window)
vim.wo[main_window].winfixbuf = true
dofile(vim.fs.joinpath(repo, 'nvim', 'plugin', 'vibench-chat.lua'))

local chat = vim.g.vibench_chat
assert(chat and vim.fn.exists(':VibenchChat') == 2, 'Chat command did not load')
assert(vim.fn.maparg('<Plug>(VibenchChatToggle)', 'n') ~= ''
    and vim.fn.maparg('<Plug>(VibenchChatClose)', 'n') ~= '',
  'Chat toggle or close action is missing')
assert(vim.fn.maparg('<leader>C', 'n') == '<Plug>(VibenchChatToggle)',
  'Chat default mapping is missing')

vim.api.nvim_set_current_win(sidebar_window)
vim.cmd('VibenchChat')
local state = chat.state()
assert(state.visible and vim.api.nvim_get_current_win() == state.window, 'Chat did not open and focus')
assert(vim.api.nvim_win_get_config(state.window).relative == ''
    and vim.api.nvim_win_get_position(state.window)[2] > vim.api.nvim_win_get_position(main_window)[2],
  'Chat is not a native right split')
assert(vim.api.nvim_win_get_buf(main_window) == main_buffer, 'Chat replaced the normal main buffer')
assert(vim.api.nvim_win_get_buf(sidebar_window) ~= state.buffer,
  'Chat split or replaced the focused fixed-width sidebar')
assert(vim.wo[main_window].winfixbuf, 'Chat disturbed a fixed normal-file anchor')
assert(vim.wo[state.window].winbar == ' Chat ' and not vim.bo[state.buffer].buflisted,
  'Chat does not have exactly one panel title')
assert(vim.wo[state.window].winfixbuf, 'Chat does not protect its buffer')

local main_position = vim.api.nvim_win_get_position(main_window)
local chat_position = vim.api.nvim_win_get_position(state.window)
local drawer_position = vim.api.nvim_win_get_position(drawer_window)
local sidebar_position = vim.api.nvim_win_get_position(sidebar_window)
local scrubber = vim.g.vibench_scrubber.state()
local scrubber_position = vim.api.nvim_win_get_position(scrubber.window)
assert(main_position[1] == chat_position[1]
    and main_position[1] + vim.api.nvim_win_get_height(main_window) <= drawer_position[1]
    and chat_position[1] + vim.api.nvim_win_get_height(state.window) <= drawer_position[1],
  'Chat stacked over the bottom drawer')
assert(sidebar_position[1] == 0 and sidebar_position[2] == 0
    and sidebar_position[1] + vim.api.nvim_win_get_height(sidebar_window) > drawer_position[1],
  'Chat disturbed the full-height sidebar: ' .. vim.inspect({
    sidebar = { sidebar_position, vim.api.nvim_win_get_height(sidebar_window) },
    drawer = { drawer_position, vim.api.nvim_win_get_height(drawer_window) },
  }))
assert(scrubber_position[1] > drawer_position[1]
    and scrubber_position[2] == 0
    and vim.api.nvim_win_get_width(scrubber.window) == vim.o.columns,
  'Chat disturbed the global scrubber')

local rejected = vim.fn.bufadd(vim.fs.joinpath(repo, 'README.md'))
assert(not pcall(vim.api.nvim_win_set_buf, state.window, rejected)
    and vim.api.nvim_win_get_buf(state.window) == state.buffer,
  'a normal file replaced Chat')

local timeline = require('vibench.timeline')
local playhead = require('vibench.playhead')
local request_lines = { 'First request' }
for index = 2, 60 do request_lines[index] = 'request line ' .. index end
local steps = {
  { i = 0, kind = 'chat', category = 'chat', event = 'message', role = 'user',
    content = table.concat(request_lines, '\n') },
  { i = 1, kind = 'terminal', category = 'terminal', command = 'hidden command', output = 'hidden body' },
  { i = 2, kind = 'chat', category = 'chat', event = 'thinking', content = 'Considering options' },
  { i = 3, kind = 'other', category = 'tool_info', tool = 'Glob', result = 'hidden tool body' },
  { i = 4, kind = 'chat', category = 'chat', event = 'agent_spawn',
    subtype = 'reviewer', description = 'Review the change' },
  { i = 5, kind = 'chat', category = 'chat', event = 'message', role = 'assistant',
    content = 'Finished the first pass' },
  { i = 6, kind = 'chat', category = 'chat', event = 'agent_peer',
    name = 'reviewer', content = 'Looks good' },
  { i = 7, kind = 'chat', category = 'chat', event = 'task',
    task_id = 'task-1', status = 'completed', summary = 'Background work complete' },
}
timeline.ingest({
  source = { revision = 'chat-root-r1' },
  agent = { kind = 'root', id = 'chat-headless', root_id = 'chat-headless' },
  steps = steps,
})
assert(vim.wait(500, function()
  return table.concat(vim.api.nvim_buf_get_lines(state.buffer, 0, -1, false), '\n')
    :find('Background work complete', 1, true)
end), 'Chat did not render mixed chat events at Live')
local text = table.concat(vim.api.nvim_buf_get_lines(state.buffer, 0, -1, false), '\n')
assert(text:find('First request', 1, true) and text:find('Thinking', 1, true)
    and text:find('Agent spawn [reviewer]', 1, true) and text:find('Review the change', 1, true)
    and text:find('Peer [reviewer]', 1, true) and text:find('Task [task-1, completed]', 1, true),
  'Chat labels are missing')
assert(not text:find('hidden command', 1, true) and not text:find('hidden tool body', 1, true),
  'Chat rendered a non-chat tool body')
chat.reveal()
assert(vim.api.nvim_buf_get_lines(state.buffer,
      vim.api.nvim_win_get_cursor(state.window)[1] - 1,
      vim.api.nvim_win_get_cursor(state.window)[1], false)[1] == 'Task [task-1, completed]',
  'Chat did not move to the latest visible event')

playhead.seek(3, false)
text = table.concat(vim.api.nvim_buf_get_lines(state.buffer, 0, -1, false), '\n')
assert(text:find('First request', 1, true) and text:find('Considering options', 1, true)
    and not text:find('Agent spawn', 1, true) and not text:find('Finished the first pass', 1, true),
  'Chat did not honor the shared playhead cutoff')

playhead.set_watch(false)
vim.api.nvim_win_set_cursor(chat.state().window, { 50, 0 })
vim.api.nvim_win_call(chat.state().window, function() vim.cmd('normal! zt') end)
local held_view = vim.api.nvim_win_call(chat.state().window, vim.fn.winsaveview)
chat.show()
assert(vim.api.nvim_win_get_cursor(chat.state().window)[1] == 50,
  'focusing Chat discarded its position with Watch off')
vim.api.nvim_win_close(chat.state().window, true)
assert(vim.wait(500, function() return not chat.state().visible end),
  'native close did not release Chat')
chat.show()
local reopened_view = vim.api.nvim_win_call(chat.state().window, vim.fn.winsaveview)
assert(reopened_view.lnum == held_view.lnum and reopened_view.topline == held_view.topline,
  'reopening Chat discarded its position with Watch off')
playhead.set_watch(true)

timeline.select_agent({ kind = 'child', id = 'child-1', root_id = 'chat-headless' }, { mode = 'live' })
timeline.ingest({
  source = { revision = 'chat-child-r1' },
  agent = { kind = 'child', id = 'child-1', root_id = 'chat-headless' },
  steps = {
    { i = 0, kind = 'chat', category = 'chat', event = 'message', role = 'assistant',
      content = 'Child conversation' },
  },
})
assert(vim.wait(500, function()
  local content = table.concat(vim.api.nvim_buf_get_lines(state.buffer, 0, -1, false), '\n')
  return content:find('Child conversation', 1, true) and not content:find('First request', 1, true)
end), 'Chat did not retarget to the selected agent')

local q
vim.api.nvim_buf_call(state.buffer, function() q = vim.fn.maparg('q', 'n', false, true) end)
assert(type(q.callback) == 'function', 'Chat q mapping is missing')
vim.fn.maparg('<Plug>(VibenchChatClose)', 'n', false, true).callback()
assert(not chat.state().visible and vim.api.nvim_win_is_valid(main_window)
    and vim.api.nvim_win_is_valid(sidebar_window) and vim.api.nvim_win_is_valid(drawer_window),
  'Chat Close action closed an unrelated window')
vim.cmd('VibenchChat')
assert(chat.state().visible
    and table.concat(vim.api.nvim_buf_get_lines(chat.state().buffer, 0, -1, false), '\n')
      :find('Child conversation', 1, true),
  'Chat did not reopen with the selected conversation')

vim.g.vibench_scrubber.hide()
for _, other in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
  if other ~= chat.state().window then pcall(vim.api.nvim_win_close, other, true) end
end
q.callback()
assert(not chat.state().visible and #vim.api.nvim_tabpage_list_wins(0) == 1
    and vim.api.nvim_win_get_buf(0) ~= state.buffer and vim.wo.winbar == '',
  'Chat could not close when it was the last window')
vim.cmd('VibenchChat')
assert(chat.state().visible, 'Chat did not reopen after last-window close')
local chat_window = chat.state().window
vim.cmd('tabnew')
assert(not chat.state().visible and chat.state().window == nil,
  'Chat reported an off-tab window as visible')
vim.cmd('tabprevious')
assert(chat.state().visible and chat.state().window == chat_window,
  'Chat did not become visible again on its own tab')

print('chat_headless: PASS')
vim.cmd('qa!')
