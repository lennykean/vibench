local source = debug.getinfo(1, 'S').source:sub(2)
local repo = vim.fs.dirname(vim.fs.dirname(vim.fs.dirname(source)))
vim.opt.runtimepath:prepend(vim.fs.joinpath(repo, 'nvim'))
vim.env.VIBENCH_SESSION = 'headless-test'
vim.env.VIBENCH_SERVER = nil
vim.g.vibench_agentterm_server_json = vim.fs.joinpath(repo, 'does-not-exist.json')
vim.g.vibench_agentterm_height = 5
vim.g.vibench_playhead_interval_ms = 100
vim.wo.winhighlight = 'Normal:ErrorMsg'
vim.keymap.set('n', '<C-h>', '<Cmd>let g:vibench_test_collision = 1<CR>')
local main_window = vim.api.nvim_get_current_win()
local main_buffer = vim.api.nvim_get_current_buf()
vim.api.nvim_buf_set_name(main_buffer, 'headless-main.lua')

local bufferline_config = {
  options = { offsets = { { filetype = 'neo-tree' } } },
  user = { options = { offsets = { { filetype = 'neo-tree' } } } },
}
package.loaded['bufferline.config'] = { get = function() return bufferline_config end }

dofile(vim.fs.joinpath(repo, 'nvim', 'plugin', 'vibench-agentterm.lua'))
dofile(vim.fs.joinpath(repo, 'nvim', 'plugin', 'vibench-agentview.lua'))
dofile(vim.fs.joinpath(repo, 'nvim', 'plugin', 'vibench-scrubber.lua'))
dofile(vim.fs.joinpath(repo, 'nvim', 'plugin', 'vibench-toolinfo.lua'))
dofile(vim.fs.joinpath(repo, 'nvim', 'plugin', 'vibench-tools.lua'))
local terminal = vim.g.vibench_agentterm
local agentview = vim.g.vibench_agentview
local scrubber = vim.g.vibench_scrubber
local toolcall = vim.g.vibench_toolinfo
local tools = vim.g.vibench_tools
local playhead = require('vibench.playhead')
assert(terminal, 'agent terminal did not load')
assert(agentview, 'agent view did not load')
assert(scrubber, 'scrubber did not load')
assert(toolcall, 'Tool Info drawer did not load')
assert(tools, 'tool list did not load')
local function offset_count(offsets, filetype)
  local count = 0
  for _, offset in ipairs(offsets) do
    if offset.filetype == filetype then count = count + 1 end
  end
  return count
end
assert(vim.wait(500, function()
  return offset_count(bufferline_config.options.offsets, 'vibench-tools') == 1
    and offset_count(bufferline_config.user.options.offsets, 'vibench-tools') == 1
end), 'Tool Calls did not register its Bufferline sidebar offset')
assert(vim.tbl_get(bufferline_config, 'options', 'offsets', 2).text == '',
  'Tool Calls repeated its winbar title in the Bufferline offset')
assert(offset_count(bufferline_config.options.offsets, 'neo-tree') == 1,
  'Tool Calls replaced an existing Bufferline sidebar offset')
vim.api.nvim_exec_autocmds('User', { pattern = 'VeryLazy' })
assert(vim.wait(500, function()
  return offset_count(bufferline_config.options.offsets, 'vibench-tools') == 1
    and offset_count(bufferline_config.user.options.offsets, 'vibench-tools') == 1
end), 'Tool Calls duplicated its Bufferline sidebar offset on reapply')
assert(vim.fn.maparg('<leader>a', 'n') == '<Plug>(VibenchAgentViewOpen)',
  'Agent View default mapping is missing')
assert(vim.fn.maparg('<leader>t', 'n') == '<Plug>(VibenchToolsToggle)',
  'Tool Calls default mapping is missing')
assert(vim.fn.maparg('<leader>i', 'n') == '<Plug>(VibenchToolInfoToggle)',
  'Tool Info default mapping is missing')
assert(vim.fn.exists(':VibenchToolInfo') == 2 and vim.fn.exists(':VibenchToolCall') == 0,
  'Tool Info command rename kept a stale public command')
assert(vim.fn.maparg('<Plug>(VibenchToolInfoToggle)', 'n') ~= ''
    and vim.fn.maparg('<Plug>(VibenchToolCallToggle)', 'n') == '',
  'Tool Info action rename kept a stale public mapping')
for _, action in ipairs({
  'VibenchAgentTermSelect', 'VibenchAgentViewOpenFile', 'VibenchAgentViewClose',
  'VibenchScrubberHide', 'VibenchToolsSelect', 'VibenchToolsHome', 'VibenchToolsEnd',
  'VibenchToolsHide', 'VibenchToolInfoHide',
}) do
  assert(vim.fn.maparg(('<Plug>(%s)'):format(action), 'n') ~= '', action .. ' action is missing')
end
assert(not toolcall.state().visible, 'Tool Info drawer opened without being requested')
scrubber.show()
vim.wait(50)
assert(not agentview.state().visible, 'agent view opened before Watch reached a file step')
vim.cmd('VibenchAgentView')
assert(agentview.state().visible, 'agent view did not open explicitly')
assert(agentview.state().window == main_window, 'agent view did not use the ordinary main window')
assert(vim.api.nvim_buf_get_name(agentview.state().buffer):match('/agent view$'),
  'agent view buffer has an opaque session-id label')
assert(vim.wait(500, function() return tools.state().visible end), 'tool list did not auto-open')
assert(vim.api.nvim_win_get_width(tools.state().window) == 40 and vim.wo[tools.state().window].winfixwidth,
  'tool list is not a fixed 40-column sidebar')
assert(vim.api.nvim_win_get_position(tools.state().window)[2] == 0,
  'tool list did not open at the left edge')
assert(vim.api.nvim_get_current_win() ~= tools.state().window, 'tool list stole startup focus')
local scrubber_window = scrubber.state().window
local rejected_file = vim.fn.bufadd(vim.fs.joinpath(repo, 'README.md'))
assert(not pcall(vim.api.nvim_win_set_buf, scrubber_window, rejected_file)
    and vim.api.nvim_win_get_buf(scrubber_window) == scrubber.state().buffer,
  'a normal file replaced the scrubber buffer')
local function assert_scrubber_bottom()
  assert(scrubber_window and vim.api.nvim_win_is_valid(scrubber_window), 'scrubber window is missing')
  assert(vim.api.nvim_win_get_config(scrubber_window).relative == '', 'scrubber is floating')
  assert(vim.api.nvim_win_get_height(scrubber_window) == 1, 'scrubber is not one row')
  assert(vim.wo[scrubber_window].winfixbuf, 'scrubber window does not protect its buffer')
  assert(vim.wo[scrubber_window].winfixheight, 'scrubber height is not fixed')
  local position = vim.api.nvim_win_get_position(scrubber_window)
  assert(position[2] == 0 and vim.api.nvim_win_get_width(scrubber_window) == vim.o.columns,
    'scrubber is not full width')
  for _, other in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if other ~= scrubber_window and vim.api.nvim_win_get_config(other).relative == '' then
      local other_position = vim.api.nvim_win_get_position(other)
      assert(other_position[1] + vim.api.nvim_win_get_height(other) <= position[1],
        'another window is below the scrubber')
    end
  end
end
assert_scrubber_bottom()
vim.api.nvim_set_current_win(scrubber_window)
terminal.show()
local repinned = vim.wait(500, function()
  local position = vim.api.nvim_win_get_position(scrubber_window)
  return position[2] == 0 and vim.api.nvim_win_get_width(scrubber_window) == vim.o.columns
    and vim.api.nvim_win_get_height(scrubber_window) == 1
    and vim.api.nvim_win_get_position(terminal.state().window)[1] < position[1]
end)
assert(repinned, 'scrubber was not repinned below the agent terminal: ' .. vim.inspect(vim.tbl_map(function(win)
  return { win = win, pos = vim.api.nvim_win_get_position(win), height = vim.api.nvim_win_get_height(win) }
end, vim.api.nvim_tabpage_list_wins(0))))
assert_scrubber_bottom()
assert(vim.api.nvim_win_get_height(terminal.state().window) == 5,
  'repinning the scrubber changed the agent-terminal height: '
    .. vim.api.nvim_win_get_height(terminal.state().window))
local terminal_replacement = vim.api.nvim_create_buf(true, false)
assert(vim.wo[terminal.state().window].winfixbuf
    and not pcall(vim.api.nvim_win_set_buf, terminal.state().window, terminal_replacement)
    and vim.api.nvim_win_get_buf(terminal.state().window) == terminal.state().buffer,
  'Agent Terminal accepted a normal file buffer')
vim.api.nvim_buf_delete(terminal_replacement, { force = true })
local agentterm_bar = vim.wo[terminal.state().window].winbar
local _, agentterm_title_count = agentterm_bar:gsub('Agent Terminal', '')
assert(agentterm_title_count == 1 and agentterm_bar:find('|<', 1, true)
    and agentterm_bar:find('>|', 1, true),
  'agent-terminal title or playhead controls are missing')
assert(not vim.wo[terminal.state().window].winhighlight:find('VibenchScrubber', 1, true),
  'agent terminal inherited the scrubber highlight')
assert(vim.wo[terminal.state().window].winhighlight:find('Normal:ErrorMsg', 1, true),
  'agent terminal did not inherit the editor highlight')
local function screen_text()
  local current = terminal.state().buffer
  if not current or not vim.api.nvim_buf_is_valid(current) then return '' end
  return table.concat(vim.api.nvim_buf_get_lines(current, 0, -1, false), '\n')
end
assert(vim.fn.maparg('<Plug>(VibenchPlayheadPrev)', 'n') ~= '', 'previous action is missing')
assert(vim.fn.maparg('<Plug>(VibenchPlayheadPlayPause)', 'n') ~= '', 'play/pause action is missing')
assert(vim.fn.maparg('<Plug>(VibenchPlayheadEnd)', 'n') ~= '', 'end action is missing')
assert(vim.fn.maparg('<Plug>(VibenchPlayheadLive)', 'n') ~= '', 'live action is missing')
assert(vim.fn.maparg('<Plug>(VibenchPlayheadWatch)', 'n') ~= '', 'Watch action is missing')
for _, mapping in ipairs(vim.api.nvim_get_keymap('n')) do
  assert(mapping.lhs ~= ' ', 'default play/pause mapping claimed global Space')
end
assert(vim.fn.maparg('<C-h>', 'n') ~= '' and vim.fn.maparg('<C-l>', 'n') ~= '', 'step defaults are missing')
assert(vim.fn.maparg('<C-S-h>', 'n') ~= '' and vim.fn.maparg('<C-S-l>', 'n') ~= '', 'endpoint defaults are missing')
assert(vim.fn.maparg('<leader>P', 'n') ~= '', 'live-follow default is missing')
assert(vim.fn.maparg('<leader>W', 'n') ~= '', 'Watch default is missing')
assert(vim.tbl_contains(playhead.skipped_maps, '<C-h>'), 'test did not create a global mapping collision')
assert(playhead.state().watch, 'Watch did not default on')
local watch_event
vim.api.nvim_create_autocmd('User', {
  pattern = 'VibenchPlayheadChanged',
  once = true,
  callback = function(args) watch_event = args.data end,
})
playhead.toggle_watch()
assert(not playhead.state().watch and watch_event and watch_event.changed.watch,
  'Watch toggle did not emit shared playhead state')
playhead.toggle_watch()

playhead.set_total(2)
playhead.finish()
assert(playhead.state().position == 2 and not playhead.state().follow,
  'end did not hold at the current final step')
playhead.set_total(3)
assert(playhead.state().position == 2,
  'held end followed a newly appended step')
playhead.reset()

local source_a = { revision = 'source-a', session_id = 'a' }
local source_a_steps = {}
local function append_source_a(command, output)
  source_a_steps[#source_a_steps + 1] = {
    i = #source_a_steps,
    kind = 'terminal',
    command = command,
    output = output,
    exit = 0,
  }
  return terminal.ingest({ source = source_a, steps = vim.deepcopy(source_a_steps) })
end

assert(append_source_a('old-command', 'old-output\n'))
assert(vim.wait(500, function() return playhead.state().total == 1 end), 'first block did not render')
assert(playhead.state().position == 1 and playhead.state().follow,
  'playhead did not start live: ' .. vim.inspect(playhead.state()))

append_source_a('second-command', 'second-output\n')
assert(vim.wait(500, function() return playhead.state().total == 2 end), 'second block did not render')
assert(playhead.state().position == 2 and playhead.state().follow,
  'visible initial playback did not stay at the live head')
append_source_a('third-command', 'third-output\n')
assert(vim.wait(500, function() return playhead.state().total == 3 end), 'third block did not render')
assert(playhead.state().position == 3 and playhead.state().follow,
  'live playback did not advance with new output')
vim.api.nvim_set_current_win(terminal.state().window)
terminal.reveal()
assert(vim.wait(500, function()
  local info = vim.fn.getwininfo(terminal.state().window)[1]
  return info and info.botline >= vim.api.nvim_buf_line_count(terminal.state().buffer)
end), 'Agent Terminal did not reveal its live bottom before scrolling')
vim.api.nvim_feedkeys(vim.keycode('<C-u>'), 'xt', false)
vim.api.nvim_exec_autocmds('WinScrolled', { pattern = tostring(terminal.state().window) })
assert(vim.wait(500, function() return not playhead.state().follow end),
  'Agent Terminal keyboard scrolling did not disable Live')
-- A slow runner can need more than one page-down before the view reaches the
-- bottom again; nudge until follow returns instead of asserting after one.
local restored = false
for _ = 1, 3 do
  vim.api.nvim_feedkeys(vim.keycode('<C-f>'), 'xt', false)
  vim.api.nvim_exec_autocmds('WinScrolled', { pattern = tostring(terminal.state().window) })
  if vim.wait(700, function() return playhead.state().follow end) then
    restored = true
    break
  end
end
assert(restored, 'returning to the Agent Terminal bottom did not enable Live')
vim.api.nvim_feedkeys('gg', 'xt', false)
vim.api.nvim_exec_autocmds('CursorMoved', { buffer = terminal.state().buffer })
assert(vim.wait(500, function() return not playhead.state().follow end),
  'native Agent Terminal cursor movement did not disable Live')
vim.api.nvim_feedkeys('G', 'xt', false)
vim.api.nvim_exec_autocmds('CursorMoved', { buffer = terminal.state().buffer })
assert(vim.wait(500, function() return playhead.state().follow end),
  'returning to the Agent Terminal bottom with a native motion did not enable Live')
playhead.set_watch(false)
vim.api.nvim_win_call(terminal.state().window, function() vim.cmd('normal! 2Gzt') end)
local held_terminal_view = vim.api.nvim_win_call(terminal.state().window, vim.fn.winsaveview)
terminal.hide()
terminal.show()
assert(vim.wait(500, function()
  local view = vim.api.nvim_win_call(terminal.state().window, vim.fn.winsaveview)
  return view.lnum == held_terminal_view.lnum and view.topline == held_terminal_view.topline
end), 'reopening Agent Terminal discarded its position with Watch off')
playhead.set_watch(true)
playhead.set_follow(true)
terminal.reveal()
assert(vim.wait(500, function()
  local line = vim.api.nvim_buf_get_lines(scrubber.state().buffer, 0, 1, false)[1] or ''
  return line:find('3/3 LIVE', 1, true) ~= nil and line:find('WATCH', 1, true) ~= nil
    and line:find('', 1, true) ~= nil and line:find('', 1, true) ~= nil
    and line:find('─', 1, true) ~= nil and line:find('●', 1, true) ~= nil
    and not line:find('=', 1, true) and not line:find('#', 1, true)
end), 'scrubber did not render shared playhead state')
local scrubber_line = vim.api.nvim_buf_get_lines(scrubber.state().buffer, 0, 1, false)[1]
assert(vim.fn.strdisplaywidth(scrubber_line) == vim.api.nvim_win_get_width(scrubber_window),
  'Unicode scrubber track does not fill exactly one window row')
_G.VibenchAgentTermWinbar(1, nil, 'l')
assert(playhead.state().position == 1, 'agent-terminal first button did not work')
_G.VibenchAgentTermWinbar(3, nil, 'l')
assert(playhead.state().position == 2, 'agent-terminal next button did not work')
_G.VibenchAgentTermWinbar(2, nil, 'l')
assert(playhead.state().position == 1, 'agent-terminal previous button did not work')
_G.VibenchAgentTermWinbar(4, nil, 'l')
assert(playhead.state().position == 3 and not playhead.state().follow,
  'agent-terminal end button did not hold')
vim.api.nvim_feedkeys(vim.keycode('<BS>'), 'xt', false)
assert(vim.wait(500, function() return playhead.state().position == 2 end),
  'contextual Backspace/Ctrl-h did not override the occupied global mapping')
assert(vim.wo[terminal.state().window].winbar:find('2/3', 1, true),
  'agent-terminal winbar did not follow the shared playhead')
local held_line = vim.api.nvim_buf_get_lines(scrubber.state().buffer, 0, 1, false)[1]
assert(held_line:find('2/3 LIVE', 1, true) and not held_line:find('HOLD', 1, true),
  'scrubber did not replace the invented state label with the LIVE toggle')
local scrubber_ns = vim.api.nvim_get_namespaces()['vibench-scrubber']
local held_marks = vim.api.nvim_buf_get_extmarks(
  scrubber.state().buffer, scrubber_ns, 0, -1, { details = true })
local full_row, live_inactive, watch_active = false, false, false
local live_byte = held_line:find('LIVE', 1, true) - 1
local watch_byte = held_line:find('WATCH', 1, true) - 1
for _, mark in ipairs(held_marks) do
  local details = mark[4]
  full_row = full_row or details.line_hl_group == 'VibenchScrubberBackground'
  live_inactive = live_inactive or mark[3] == live_byte
    and details.hl_group == 'VibenchScrubberInactive'
  watch_active = watch_active or mark[3] == watch_byte
    and details.hl_group == 'VibenchScrubberActive'
end
assert(full_row, 'scrubber does not paint the full row')
assert(live_inactive, 'inactive LIVE control is not greyed out')
assert(watch_active, 'active WATCH control is not highlighted')
local scrubber_base = vim.api.nvim_get_hl(0, { name = 'VibenchScrubber', link = false })
local scrubber_background = vim.api.nvim_get_hl(0, { name = 'VibenchScrubberBackground', link = false })
local scrubber_inactive = vim.api.nvim_get_hl(0, { name = 'VibenchScrubberInactive', link = false })
local scrubber_active = vim.api.nvim_get_hl(0, { name = 'VibenchScrubberActive', link = false })
assert(scrubber_background.bg == scrubber_base.bg
    and scrubber_inactive.bg == scrubber_base.bg and scrubber_inactive.fg ~= scrubber_base.fg
    and scrubber_active.bg == scrubber_base.bg,
  'scrubber toggle styling does not preserve the uniform blue row')
local next_byte = assert(held_line:find('', 1, true), 'scrubber next icon is missing')
local old_getmousepos = vim.fn.getmousepos
vim.fn.getmousepos = function()
  return {
    winid = scrubber.state().window, line = 1, column = next_byte,
    wincol = vim.fn.strdisplaywidth(held_line:sub(1, next_byte - 1)) + 1,
  }
end
vim.api.nvim_feedkeys(vim.keycode('<LeftMouse>'), 'xt', false)
assert(vim.wait(500, function() return playhead.state().position == 3 end),
  'scrubber click used the multibyte text column instead of the displayed window column')
vim.fn.getmousepos = old_getmousepos
assert(playhead.state().watch, 'scrubber next click triggered the shifted Watch target')
playhead.toggle_live()
assert(playhead.state().position == 3 and playhead.state().follow,
  'LIVE toggle did not return to the head')
playhead.toggle_live()
assert(not playhead.state().follow and not playhead.state().playing,
  'LIVE toggle did not leave live follow')
playhead.seek(2, false)
append_source_a('fourth-command', 'fourth-output\n')
assert(vim.wait(500, function() return playhead.state().total == 4 end), 'fourth block did not render')
assert(playhead.state().position == 2 and not playhead.state().follow,
  'new output cancelled explicit playback navigation')
vim.api.nvim_set_current_win(terminal.state().window)
vim.api.nvim_feedkeys('i', 'xt', false)
assert(vim.fn.mode() ~= 't', 'read-only playback entered Terminal mode')
vim.cmd('startinsert')
vim.api.nvim_feedkeys(vim.keycode('<C-l>'), 'xt', false)
assert(vim.wait(500, function() return playhead.state().position == 3 end),
  'contextual Ctrl-l did not work in Terminal mode')
vim.cmd('stopinsert')
playhead.home()
vim.api.nvim_feedkeys(vim.keycode('<Space>'), 'xt', false)
for offset = 1, 3 do
  vim.defer_fn(function()
    append_source_a('stream-' .. offset, 'stream-output-' .. offset .. '\n')
  end, offset * 60)
end
assert(vim.wait(500, function()
  return playhead.state().position == 2 and playhead.state().playing
end, 10), 'streamed totals starved active playback')
vim.api.nvim_feedkeys(vim.keycode('<Space>'), 'xt', false)
assert(vim.wait(500, function() return not playhead.state().playing end),
  'contextual Space did not pause playback')
local paused_scrubber = vim.api.nvim_buf_get_lines(scrubber.state().buffer, 0, 1, false)[1]
assert(paused_scrubber:find('', 1, true) and not paused_scrubber:find('', 1, true),
  'paused scrubber did not switch from the pause icon to the play icon')
local paused_at = playhead.state().position
assert(vim.wait(500, function() return playhead.state().total == 7 end),
  'streamed playback test did not receive every block')
vim.wait(150)
assert(playhead.state().position == paused_at, 'paused playback kept advancing')
playhead.finish()

assert(terminal.ingest({
  reset = true,
  source = { revision = 'source-b', session_id = 'b' },
  steps = { {
    i = 0, kind = 'terminal', command = 'new-command', output = 'new-output\n', exit = vim.NIL,
  } },
}))
assert(vim.wait(500, function()
  local state = terminal.state()
  return state.revision == 'source-b' and #state.blocks == 1
end), 'source reset did not land')
local state = terminal.state()
assert(state.blocks[1].command == 'new-command', 'old source survived reset')
assert(vim.wait(500, function()
  return table.concat(vim.api.nvim_buf_get_lines(state.buffer, 0, -1, false), '\n'):find('new%-command') ~= nil
end), 'new source did not render')
local rendered = table.concat(vim.api.nvim_buf_get_lines(state.buffer, 0, -1, false), '\n')
assert(rendered:find('new%-command') and not rendered:find('old%-command'), 'terminal buffer mixed sources')

terminal.ingest({ error = 'transient' })
assert(terminal.state().revision == 'source-b' and #terminal.state().blocks == 1,
  'transient stream error cleared terminal state')

terminal.ingest({
  source = { revision = 'source-b', session_id = 'b' },
  steps = { {
    i = 0, kind = 'terminal', command = 'corrected-command', output = 'corrected-output\n', exit = 0,
  } },
})
assert(vim.wait(500, function()
  local text = screen_text()
  return text:find('corrected%-command') and not text:find('new%-command')
end), 'same-length terminal snapshot stayed stale')
terminal.hide()
vim.api.nvim_buf_delete(terminal.state().buffer, { force = true })
terminal.show()
assert(vim.wait(500, function() return screen_text():find('corrected%-command') ~= nil end),
  'wiped terminal buffer reopened without replaying the timeline')
terminal.ingest({ source = { revision = 'source-b', session_id = 'b' }, steps = {} })
assert(vim.wait(500, function()
  return playhead.state().total == 0 and not screen_text():find('corrected%-command')
end), 'empty full snapshot left stale terminal output')

terminal.ingest({
  reset = true,
  source = { revision = 'source-c', session_id = 'c' },
  steps = {
    { i = 0, kind = 'terminal', command = 'one', output = 'before-clear\n', exit = 0 },
    { i = 1, kind = 'terminal', command = 'two', output = '\27[2J\27[Hdraft\r\27[2Kfinal\n', exit = 0 },
  },
})
assert(vim.wait(500, function() return screen_text():find('final', 1, true) ~= nil end),
  'live replay did not reach the final terminal state')
assert(not screen_text():find('before-clear', 1, true) and not screen_text():find('draft', 1, true),
  'terminal clear/line erase did not remove prior state')
playhead.previous()
assert(vim.wait(500, function() return screen_text():find('before-clear', 1, true) ~= nil end),
  'rewind did not reconstruct the earlier terminal state')
assert(not screen_text():find('final', 1, true), 'rewind retained future terminal output')
playhead.next()
assert(vim.wait(500, function()
  return screen_text():find('final', 1, true) ~= nil and not screen_text():find('before-clear', 1, true)
end), 'fast-forward did not replay the terminal clear')
terminal.ingest({
  source = { revision = 'source-c', session_id = 'c' },
  steps = {
    { i = 0, kind = 'terminal', command = 'one', output = 'before-clear\n', exit = 0 },
    { i = 1, kind = 'terminal', command = 'two', output = '\27[2J\27[Hdraft\r\27[2Kfinal\n', exit = 0 },
    { i = 2, kind = 'terminal', command = 'three', output = 'future-output\n', exit = 0 },
  },
})
assert(playhead.state().position == 2 and not playhead.state().follow,
  'historical append moved the playhead')
assert(not screen_text():find('future-output', 1, true), 'historical append leaked future terminal output')
playhead.finish()
assert(vim.wait(500, function() return screen_text():find('future-output', 1, true) ~= nil end),
  'end did not reveal streamed terminal output')

terminal.ingest({
  reset = true,
  source = { revision = 'source-repeated-clear', session_id = 'repeated-clear' },
  steps = {
    { i = 0, kind = 'terminal', command = 'same', output = '\27[2J\27[Hcleared\n', exit = 0 },
    { i = 1, kind = 'terminal', command = 'same',
      output = '\27]133;A;vibench=2\7$ forged prompt\nsurvives\n', exit = 0 },
  },
})
local repeated_line
assert(vim.wait(500, function()
  repeated_line = nil
  for line, text in ipairs(vim.api.nvim_buf_get_lines(terminal.state().buffer, 0, -1, false)) do
    if text:find('$ same', 1, true) then repeated_line = line end
  end
  return repeated_line and screen_text():find('survives', 1, true)
end), 'repeated-command clear test did not render the surviving command')
local repeated_mouse = vim.fn.getmousepos
vim.fn.getmousepos = function()
  return { winid = terminal.state().window, line = repeated_line, column = 1 }
end
local repeated_mapping
vim.api.nvim_buf_call(terminal.state().buffer, function()
  repeated_mapping = vim.fn.maparg('<LeftMouse>', 'n', false, true)
end)
repeated_mapping.callback()
vim.fn.getmousepos = repeated_mouse
assert(terminal.state().starts[2] == repeated_line and not terminal.state().starts[1],
  'captured OSC output displaced the surviving command identity')
vim.wait(100, function() return false end)
assert(playhead.state().position == 2,
  'clicking a repeated command after a clear jumped to the erased occurrence')

local sample_prefix = ('-- filler\n'):rep(29)
local sample_before = sample_prefix .. 'local value = 1\nreturn value\n'
local sample_after = sample_prefix .. 'local value = 2\nreturn value\n'
local agent_steps = {
  { i = 0, kind = 'terminal', category = 'terminal', tool = 'Bash', title = 'alpha', command = 'alpha', output = 'alpha-output\n', exit = 0 },
  {
    i = 1, kind = 'read', category = 'file', tool = 'Read', title = 'sample.lua', path = 'sample.lua',
    params = { file_path = 'sample.lua' },
    response = { file = { filePath = 'sample.lua', content = sample_before } },
    content = sample_before,
    start_line = 1, num_lines = 31, total_lines = 31, full = true,
    region = { start_line = 1, end_line = 31 },
  },
  { i = 2, kind = 'terminal', category = 'terminal', tool = 'Bash', title = 'beta', command = 'beta', output = 'beta-output\n', exit = 0 },
  {
    i = 3, kind = 'patch', category = 'file', tool = 'Edit', title = 'sample.lua', path = 'sample.lua',
    params = { file_path = 'sample.lua', old_string = 'local value = 1', new_string = 'local value = 2' },
    response = { filePath = 'sample.lua', updated = true },
    content = sample_after,
    region = { start_line = 30, end_line = 30 },
    hunks = { { oldStart = 30, oldLines = 1, newStart = 30, newLines = 1,
      lines = { '-local value = 1', '+local value = 2' } } },
  },
  {
    i = 4, kind = 'error', category = 'tool_info', action = 'other', tool = 'WebFetch',
    title = 'failed request', params = { url = 'https://example.invalid' },
    response = { failed = true }, error = 'captured request failed',
  },
  {
    i = 5, kind = 'terminal', category = 'terminal', tool = 'Bash', title = 'gamma',
    command = 'gamma', output = 'gamma-output\n', exit = 7, failed = true,
  },
  {
    i = 6, kind = 'patch', category = 'file', tool = 'Edit', title = 'broken.lua', path = 'broken.lua',
    params = { file_path = 'broken.lua', old_string = 'old', new_string = 'new' },
    response = 'updated',
    hunks = { { oldStart = 3, oldLines = 1, newStart = 3, newLines = 1,
      lines = { '-old', '+new' } } },
  },
  {
    i = 7, kind = 'write', category = 'file', tool = 'Write', title = 'written.lua', path = 'written.lua',
    params = { file_path = 'written.lua', content = 'return { changed = true }\n' },
    response = { filePath = 'written.lua', content = 'return { changed = true }\n' },
    content = 'return { changed = true }\n',
    region = { start_line = 1, end_line = 1 },
  },
  {
    i = 8, kind = 'other', category = 'tool_info', tool = 'Glob', title = '*.lua',
    params = { pattern = '*.lua' }, pending = true,
  },
}
assert(terminal.ingest({
  reset = true,
  source = { revision = 'source-agent-view', session_id = 'view' },
  steps = agent_steps,
}))
assert(vim.wait(500, function() return playhead.state().total == 9 end),
  'shared timeline did not count every global step kind')
local tools_buffer = tools.state().buffer
local function tool_lines()
  return vim.api.nvim_buf_get_lines(tools_buffer, 0, -1, false)
end
assert(tools_buffer and vim.api.nvim_buf_is_valid(tools_buffer)
    and vim.bo[tools_buffer].buftype == 'nofile' and vim.bo[tools_buffer].readonly
    and not vim.bo[tools_buffer].modifiable and not vim.bo[tools_buffer].swapfile,
  'tool list buffer safety options are wrong')
assert(vim.wait(500, function()
  local lines = tool_lines()
  return #tools.state().rows == 9 and #lines == 9
    and lines[1]:find('Bash', 1, true) and lines[1]:find('alpha', 1, true)
    and lines[9]:find('Glob', 1, true) and lines[9]:find('*.lua', 1, true)
end), 'Tool Calls did not index every visible timeline step')
local rendered_tool_lines = tool_lines()
assert(rendered_tool_lines[1]:find('', 1, true)
    and rendered_tool_lines[2]:find('󰈙', 1, true)
    and rendered_tool_lines[9]:find('󰒓', 1, true),
  'Tool Calls category icon fallbacks are missing')
assert(vim.wo[tools.state().window].winbar == ' Tool Calls ',
  'Tool Calls does not have exactly one winbar title')
local tools_ns = vim.api.nvim_get_namespaces()['vibench-tools']
local initial_marks = vim.api.nvim_buf_get_extmarks(tools_buffer, tools_ns, 0, -1, { details = true })
local function has_tool_mark(row, key, value)
  return vim.tbl_contains(vim.tbl_map(function(mark)
    return mark[2] == row and mark[4][key] == value
  end, initial_marks), true)
end
assert(has_tool_mark(0, 'hl_group', 'VibenchToolsTerminal')
    and has_tool_mark(1, 'hl_group', 'VibenchToolsFile'),
  'Tool Calls did not apply category icon accents')
assert(has_tool_mark(4, 'line_hl_group', 'VibenchToolsFailed')
    and has_tool_mark(5, 'line_hl_group', 'VibenchToolsFailed')
    and has_tool_mark(8, 'line_hl_group', 'VibenchToolsPending'),
  'Tool Calls did not distinguish failed terminal, failed tool, and pending rows')
assert(not vim.wo[tools.state().window].winbar:find('|<', 1, true)
    and not vim.wo[tools.state().window].winbar:find('', 1, true)
    and not vim.wo[tools.state().window].winbar:find('', 1, true)
    and not vim.wo[tools.state().window].winbar:find('LIVE', 1, true),
  'tool list invented local playback controls')

playhead.set_watch(false)
vim.api.nvim_win_set_cursor(tools.state().window, { 2, 0 })
playhead.seek(8, false)
assert(vim.wait(500, function() return #tools.state().rows == 8 end),
  'Tool Calls did not update with Watch off')
assert(vim.api.nvim_win_get_cursor(tools.state().window)[1] == 2,
  'Tool Calls discarded manual position with Watch off')
playhead.set_watch(true)
playhead.seek(9, false)

playhead.seek(4, false)
assert(vim.wait(500, function()
  local lines = tool_lines()
  return #tools.state().rows == 4 and #lines == 4 and lines[4]:find('Edit', 1, true)
end), 'tool list did not fold future calls at the playhead')
local tool_marks = vim.api.nvim_buf_get_extmarks(tools_buffer, tools_ns, 0, -1, { details = true })
assert(vim.tbl_contains(vim.tbl_map(function(mark)
  return mark[2] == 3 and mark[4].line_hl_group == 'VibenchToolsCurrent'
end, tool_marks), true), 'tool list did not mark the current call')
vim.api.nvim_set_current_win(tools.state().window)
vim.cmd('normal! k')
vim.api.nvim_exec_autocmds('CursorMoved', { buffer = tools_buffer })
assert(vim.wait(500, function() return playhead.state().position == 3 end),
  'native Tool Calls motion did not seek the shared playhead')
playhead.seek(4, false)
assert(vim.wait(500, function() return #tools.state().rows == 4 end),
  'Tool Calls did not recover after native motion')
vim.api.nvim_win_set_cursor(tools.state().window, { 2, 0 })
local enter_mapping
vim.api.nvim_buf_call(tools_buffer, function()
  enter_mapping = vim.fn.maparg('<CR>', 'n', false, true)
end)
local select_mapping = vim.fn.maparg('<Plug>(VibenchToolsSelect)', 'n', false, true)
assert(type(enter_mapping.callback) == 'function' and type(select_mapping.callback) == 'function',
  'tool list selection mapping or action is missing')
select_mapping.callback()
assert(playhead.state().position == 2 and not playhead.state().follow,
  'Tool Calls selection action did not seek the shared playhead')

playhead.finish()
local saved_getmousepos = vim.fn.getmousepos
vim.fn.getmousepos = function()
  return { winid = tools.state().window, line = 3, column = 1 }
end
local tool_mouse_mapping
vim.api.nvim_buf_call(tools_buffer, function()
  tool_mouse_mapping = vim.fn.maparg('<LeftMouse>', 'n', false, true)
end)
assert(type(tool_mouse_mapping.callback) == 'function', 'tool list mouse mapping is missing')
tool_mouse_mapping.callback()
vim.fn.getmousepos = saved_getmousepos
assert(vim.wait(500, function() return playhead.state().position == 3 end),
  'tool list click did not seek the shared playhead')
playhead.finish()
local tools_home = vim.fn.maparg('<Plug>(VibenchToolsHome)', 'n', false, true)
local tools_end = vim.fn.maparg('<Plug>(VibenchToolsEnd)', 'n', false, true)
tools_home.callback()
assert(playhead.state().position == 1 and vim.api.nvim_win_get_cursor(tools.state().window)[1] == 1,
  'Tool Calls Home action did not select its first filtered row')
playhead.finish()
assert(vim.wait(500, function() return #tools.state().rows == 9 end),
  'Tool Calls did not restore its filtered rows for the End action')
vim.api.nvim_win_set_cursor(tools.state().window, { 2, 0 })
tools_end.callback()
assert(playhead.state().position == 9 and vim.api.nvim_win_get_cursor(tools.state().window)[1] == 9,
  'Tool Calls End action did not select its last filtered row')

local original_snacks = rawget(_G, 'Snacks')
local explorer_active, explorer_window, explorer_closes = true, nil, 0
local fake_picker = { layout = { root = {} } }
fake_picker.close = function()
  explorer_closes = explorer_closes + 1
  explorer_active = false
  if explorer_window and vim.api.nvim_win_is_valid(explorer_window) then
    vim.api.nvim_win_close(explorer_window, true)
  end
end
_G.Snacks = { picker = { get = function(options)
  if options.source == 'explorer' and explorer_active and explorer_window
      and vim.api.nvim_win_is_valid(explorer_window) then return { fake_picker } end
  return {}
end } }
local explorer_buffer = vim.api.nvim_create_buf(false, true)
explorer_window = vim.api.nvim_open_win(explorer_buffer, false,
  { split = 'left', win = main_window, width = 40 })
fake_picker.layout.root.win = explorer_window
tools.reconcile()
assert(vim.wait(500, function() return not tools.state().visible end)
    and vim.api.nvim_buf_is_valid(tools_buffer),
  'tool list did not yield its sidebar slot to Explorer')
assert(vim.wait(500, function()
  local drawer = terminal.state().window
  if not drawer or not vim.api.nvim_win_is_valid(drawer) then return false end
  local explorer_position = vim.api.nvim_win_get_position(explorer_window)
  local drawer_position = vim.api.nvim_win_get_position(drawer)
  return explorer_position[1] == 0 and explorer_position[2] == 0
    and drawer_position[2] > explorer_position[2]
    and explorer_position[1] + vim.api.nvim_win_get_height(explorer_window)
      >= drawer_position[1] + vim.api.nvim_win_get_height(drawer)
end), 'Explorer did not stay full-height beside the bottom drawer')
explorer_active = false
vim.api.nvim_win_close(explorer_window, true)
assert(vim.wait(500, function() return tools.state().visible end),
  'tool list did not return after Explorer closed')

explorer_active = true
explorer_window = vim.api.nvim_open_win(explorer_buffer, false,
  { split = 'left', win = main_window, width = 40 })
fake_picker.layout.root.win = explorer_window
tools.reconcile()
assert(not tools.state().visible, 'tool list stayed stacked beside Explorer')
vim.cmd('VibenchTools')
assert(vim.wait(500, function() return tools.state().visible end)
    and explorer_closes == 1 and not vim.api.nvim_win_is_valid(explorer_window),
  'explicit Tool Calls did not replace Explorer in the sidebar')
_G.Snacks = original_snacks
vim.api.nvim_set_current_win(tools.state().window)
vim.api.nvim_feedkeys('q', 'xt', false)
assert(vim.wait(500, function() return not tools.state().enabled and not tools.state().visible end),
  'q did not hide the tool list')
vim.wait(50)
assert(not tools.state().visible, 'hidden tool list auto-reopened')
vim.cmd('VibenchTools')
assert(vim.wait(500, function() return tools.state().visible end),
  'tool list command did not reopen the pane')
local restored_window = tools.state().window
local replacement_buffer = vim.api.nvim_create_buf(true, false)
assert(vim.wo[restored_window].winfixbuf
    and not pcall(vim.api.nvim_win_set_buf, restored_window, replacement_buffer),
  'Tool Calls accepted a normal file buffer')
tools.reconcile()
assert(tools.state().window == restored_window
    and vim.api.nvim_win_get_buf(restored_window) == tools_buffer,
  'Tool Calls lost its fixed panel buffer')

tools.hide()
vim.api.nvim_set_current_win(main_window)
vim.cmd('rightbelow vsplit')
local right_split = vim.api.nvim_get_current_win()
vim.cmd('VibenchTools')
assert(vim.wait(500, function()
  return tools.state().visible and vim.api.nvim_win_get_position(tools.state().window)[2] == 0
end), 'tool list opened beside the focused split instead of at the left edge')
vim.api.nvim_win_close(right_split, true)
vim.api.nvim_set_current_win(main_window)

local drawer_count = #vim.api.nvim_tabpage_list_wins(0)
toolcall.show()
assert(vim.wait(500, function()
  local state = toolcall.state()
  local sidebar = tools.state().window
  if not state.visible or not sidebar then return false end
  local drawer_position = vim.api.nvim_win_get_position(state.window)
  local sidebar_position = vim.api.nvim_win_get_position(sidebar)
  return state.visible and vim.api.nvim_win_get_height(state.window) == 5
    and drawer_position[2] > sidebar_position[2]
    and drawer_position[2] + vim.api.nvim_win_get_width(state.window) == vim.o.columns
    and sidebar_position[1] == 0
    and sidebar_position[1] + vim.api.nvim_win_get_height(sidebar)
      >= drawer_position[1] + vim.api.nvim_win_get_height(state.window)
end), 'Tool Calls did not stay full-height beside the bottom drawer')
assert(not terminal.state().window and #vim.api.nvim_tabpage_list_wins(0) == drawer_count,
  'Tool Info stacked with Agent Terminal instead of replacing it')
assert(vim.wo[toolcall.state().window].winfixheight
    and vim.wo[toolcall.state().window].winfixbuf,
  'Tool Info drawer is not fixed')
assert_scrubber_bottom()
local toolcall_buffer = toolcall.state().buffer
assert(toolcall_buffer and vim.bo[toolcall_buffer].buftype == 'nofile'
    and vim.bo[toolcall_buffer].readonly and not vim.bo[toolcall_buffer].modifiable
    and not vim.bo[toolcall_buffer].swapfile,
  'Tool Info buffer safety options are wrong')
local function toolcall_text()
  return table.concat(vim.api.nvim_buf_get_lines(toolcall_buffer, 0, -1, false), '\n')
end
assert(#toolcall.state().steps == 2 and toolcall.state().step.i == 8,
  'Tool Info did not filter strictly to tool_info steps')
assert(toolcall_text():find('Glob  %*%.lua') and toolcall_text():find('PARAMS', 1, true)
    and toolcall_text():find('pattern', 1, true)
    and toolcall_text():find('IN FLIGHT', 1, true)
    and not toolcall_text():find('RESULT', 1, true),
  'Tool Info did not render captured parameters and its in-flight state')
local toolinfo_bar = vim.wo[toolcall.state().window].winbar
local _, toolinfo_title_count = toolinfo_bar:gsub('Tool Info', '')
assert(toolinfo_title_count == 1 and toolinfo_bar:find('2/2', 1, true)
    and toolinfo_bar:find('', 1, true) and toolinfo_bar:find('', 1, true)
    and toolinfo_bar:find('', 1, true) and toolinfo_bar:find('', 1, true)
    and not toolinfo_bar:find('|<', 1, true) and not toolinfo_bar:find('>|', 1, true),
  'Tool Info does not have one title, the filtered count, and normal navigation icons')

agent_steps[9] = {
  i = 8, kind = 'other', category = 'tool_info', tool = 'Glob', title = '*.lua',
  params = { pattern = '*.lua' },
  response = { files = { 'sample.lua', 'written.lua' } }, result = 'matched files',
}
assert(terminal.ingest({
  source = { revision = 'source-agent-view', session_id = 'view' },
  steps = agent_steps,
}))
assert(vim.wait(500, function()
  return toolcall.state().step and toolcall.state().step.i == 8
    and not toolcall_text():find('IN FLIGHT', 1, true)
    and toolcall_text():find('RESULT', 1, true)
    and toolcall_text():find('sample.lua', 1, true)
end), 'Tool Info did not replace the pending state with the completed result in place')

agent_steps[10] = {
  i = 9, kind = 'chat', category = 'chat', event = 'message', role = 'assistant',
  content = 'finished checking files',
}
assert(terminal.ingest({
  source = { revision = 'source-agent-view', session_id = 'view' },
  steps = agent_steps,
}))
playhead.finish()
assert(vim.wait(500, function()
  local lines = tool_lines()
  return playhead.state().total == 10 and #lines == 9
    and not table.concat(lines, '\n'):find('finished checking files', 1, true)
    and #toolcall.state().steps == 2 and toolcall.state().step.i == 8
end), 'chat leaked into Tool Calls or Tool Info')
local drawer_caller = tools.state().window
vim.api.nvim_set_current_win(drawer_caller)
terminal.show()
vim.api.nvim_set_current_win(drawer_caller)
toolcall.show()
toolcall.hide()
assert(vim.api.nvim_get_current_win() == drawer_caller,
  'swapping drawers from another split restored stale focus')
toolcall.show()
local toolcall_window = toolcall.state().window
local replacement_buffer = vim.api.nvim_create_buf(false, true)
assert(not pcall(vim.api.nvim_win_set_buf, toolcall_window, replacement_buffer),
  'Tool Info accepted a normal file buffer')
terminal.show()
assert(terminal.state().window and not toolcall.state().window
    and #vim.api.nvim_tabpage_list_wins(0) == drawer_count,
  'Agent Terminal stacked after the Tool Info buffer was replaced')
toolcall.show()
assert(toolcall.state().visible and not terminal.state().window
    and #vim.api.nvim_tabpage_list_wins(0) == drawer_count,
  'Tool Info did not replace Agent Terminal')
toolcall_window = toolcall.state().window
assert(not pcall(vim.api.nvim_win_set_buf, toolcall_window, replacement_buffer),
  'reopened Tool Info accepted a normal file buffer')
vim.api.nvim_set_current_win(drawer_caller)
toolcall.show()
assert(toolcall.state().window == toolcall_window
    and vim.api.nvim_win_get_buf(toolcall_window) == toolcall_buffer
    and #vim.api.nvim_tabpage_list_wins(0) == drawer_count,
  'Tool Info lost its existing drawer')
toolcall.hide()
assert(vim.api.nvim_get_current_win() == drawer_caller,
  'Tool Info retained stale restore focus')
toolcall.show()
vim.api.nvim_buf_delete(replacement_buffer, { force = true })

local saved_snacks_terminal = rawget(_G, 'Snacks')
local native_buffer = vim.api.nvim_create_buf(false, true)
vim.bo[native_buffer].filetype = 'snacks_terminal'
vim.api.nvim_set_current_win(main_window)
vim.cmd('botright 3split')
local native_window = vim.api.nvim_get_current_win()
vim.api.nvim_win_set_buf(native_window, native_buffer)
local native_hidden = false
local fake_terminal = {
  buf = native_buffer,
  win = native_window,
  opts = { position = 'bottom' },
  hide = function(self)
    native_hidden = true
    if self.win and vim.api.nvim_win_is_valid(self.win) then vim.api.nvim_win_close(self.win, true) end
    self.win = nil
  end,
}
_G.Snacks = { terminal = { list = function() return { fake_terminal } end } }
vim.w[native_window].snacks_win = { position = 'bottom' }
vim.api.nvim_exec_autocmds('BufWinEnter', { buffer = native_buffer })
assert(vim.wait(500, function()
  return not toolcall.state().visible and vim.api.nvim_win_is_valid(native_window)
end), 'LazyVim terminal stacked with the Tool Info drawer instead of replacing it')
local native_position = vim.api.nvim_win_get_position(native_window)
local sidebar_position = vim.api.nvim_win_get_position(tools.state().window)
assert(sidebar_position[1] == 0 and native_position[2] > sidebar_position[2]
    and native_position[2] + vim.api.nvim_win_get_width(native_window) == vim.o.columns
    and sidebar_position[1] + vim.api.nvim_win_get_height(tools.state().window)
      == native_position[1] + vim.api.nvim_win_get_height(native_window),
  'Tool Calls did not remain full-height beside the LazyVim terminal')
toolcall.show()
assert(vim.wait(500, function()
  return native_hidden and toolcall.state().visible
    and not vim.api.nvim_win_is_valid(native_window)
    and #vim.api.nvim_tabpage_list_wins(0) == drawer_count
end), 'Tool Info drawer stacked with the LazyVim terminal instead of replacing it')
_G.Snacks = saved_snacks_terminal

local toolcall_prev = vim.fn.maparg('<C-h>', 'n', false, true)
local toolcall_next = vim.fn.maparg('<C-l>', 'n', false, true)
local toolcall_end = vim.fn.maparg('<C-S-l>', 'n', false, true)
assert(toolcall_prev.buffer == 1 and type(toolcall_prev.callback) == 'function'
    and toolcall_next.buffer == 1 and type(toolcall_next.callback) == 'function'
    and toolcall_end.buffer == 1 and type(toolcall_end.callback) == 'function'
    and vim.fn.maparg('<Space>', 'n', false, true).buffer == 1,
  'Tool Info did not install the configured playhead keys contextually')

playhead.seek(3, false)
assert(vim.wait(500, function()
  return toolcall.state().step == nil
    and toolcall_text():find('Tool Info will show here', 1, true)
end), 'file or terminal steps leaked into Tool Info')
playhead.seek(5, false)
assert(vim.wait(500, function()
  return toolcall.state().step and toolcall.state().step.i == 4
    and toolcall_text():find('WebFetch  failed request', 1, true)
end), 'Tool Info did not follow the filtered global playhead')
assert(vim.wo[toolcall.state().window].winbar:find('1/2', 1, true),
  'Tool Info history bar did not follow the playhead')
toolcall_next.callback()
assert(playhead.state().position == 9 and toolcall.state().step.i == 8,
  'Tool Info contextual next did not seek the next filtered global step')
toolcall_prev.callback()
assert(playhead.state().position == 5 and toolcall.state().step.i == 4,
  'Tool Info contextual previous did not seek the previous filtered global step')
toolcall_end.callback()
assert(playhead.state().position == 9 and not playhead.state().follow,
  'Tool Info contextual end did not stop at its last filtered step')
playhead.seek(5, false)
assert(vim.wait(500, function()
  local text = toolcall_text()
  return toolcall.state().step and toolcall.state().step.i == 4
    and text:find('ERROR', 1, true) and text:find('captured request failed', 1, true)
end), 'Tool Info did not render the captured error')

terminal.show()
assert(vim.wait(500, function()
  return terminal.state().window and not toolcall.state().visible
    and vim.api.nvim_win_get_height(terminal.state().window) == 5
end), 'Agent Terminal did not replace the Tool Info drawer')
assert(#vim.api.nvim_tabpage_list_wins(0) == drawer_count,
  'switching bottom drawers changed the window count')
assert_scrubber_bottom()
local view_buffer = agentview.state().buffer
assert(view_buffer and vim.api.nvim_buf_is_valid(view_buffer), 'agent view buffer is missing')
assert(vim.fn.buflisted(view_buffer) == 1 and vim.bo[view_buffer].buftype == 'nofile',
  'agent view is not a listed nofile buffer')
assert(vim.bo[view_buffer].bufhidden == 'hide' and vim.bo[view_buffer].readonly
    and not vim.bo[view_buffer].modifiable and not vim.bo[view_buffer].swapfile
    and not vim.bo[view_buffer].modified,
  'agent view buffer safety options are wrong')
local function view_text()
  return table.concat(vim.api.nvim_buf_get_lines(view_buffer, 0, -1, false), '\n')
end
local view_name_changes = 0
vim.api.nvim_create_autocmd('BufFilePost', {
  buffer = view_buffer,
  callback = function() view_name_changes = view_name_changes + 1 end,
})

playhead.seek(2, false)
assert(vim.wait(500, function() return view_text():find('local value = 1', 1, true) ~= nil end),
  'agent view did not render the captured read')
assert(vim.api.nvim_buf_get_name(view_buffer):match('/agent view %[sample%.lua%]$'),
  'agent view did not show the captured file basename')
local sample_name_changes = view_name_changes
playhead.seek(3, false)
assert(view_text():find('local value = 1', 1, true),
  'a terminal step displaced the latest file view')
assert(view_name_changes == sample_name_changes,
  'an unrelated playhead step renamed the agent view buffer')
playhead.seek(4, false)
assert(vim.wait(500, function() return view_text():find('local value = 2', 1, true) ~= nil end),
  'agent view did not render a clean patch projection')
local view_ns = vim.api.nvim_get_namespaces()['vibench-agentview']
local changed = vim.api.nvim_buf_get_extmarks(view_buffer, view_ns, 0, -1, { details = true })
assert(vim.tbl_contains(vim.tbl_map(function(mark)
  return mark[2] == 29 and mark[4].line_hl_group == 'VibenchAgentViewChanged'
end, changed), true), 'agent view did not lightly highlight the projected changed line')
local spotlight = vim.api.nvim_get_hl(0, { name = 'VibenchAgentViewChanged', link = false })
assert(spotlight.bg and not spotlight.fg and not spotlight.ctermfg,
  'Agent View spotlight does not preserve syntax foreground colors')
local original_diff_change = vim.api.nvim_get_hl(0, { name = 'DiffChange', link = false })
local changed_background = spotlight.bg == 0x123456 and 0x654321 or 0x123456
vim.api.nvim_set_hl(0, 'DiffChange', { fg = 0xabcdef, bg = changed_background })
vim.api.nvim_exec_autocmds('ColorScheme', {})
spotlight = vim.api.nvim_get_hl(0, { name = 'VibenchAgentViewChanged', link = false })
assert(spotlight.bg == changed_background and not spotlight.fg and not spotlight.ctermfg,
  'Agent View spotlight did not re-derive its background after a colorscheme change')
vim.api.nvim_set_hl(0, 'DiffChange', original_diff_change)
vim.api.nvim_exec_autocmds('ColorScheme', {})
agentview.reveal()
local view_info = vim.fn.getwininfo(agentview.state().window)[1]
assert(vim.api.nvim_win_get_cursor(agentview.state().window)[1] == 30
    and view_info.topline <= 30 and view_info.botline >= 30,
  'Agent View did not reveal the projected changed line')
vim.api.nvim_win_set_cursor(agentview.state().window, { 2, 0 })
assert(vim.wait(500, function()
  local text = screen_text()
  return text:find('alpha', 1, true) and text:find('beta', 1, true) and not text:find('gamma', 1, true)
end), 'agent terminal did not filter terminal steps at the global playhead position')
playhead.seek(5, false)
assert(view_text():find('local value = 2', 1, true), 'error step displaced the latest file view')
assert(vim.api.nvim_win_get_cursor(agentview.state().window)[1] == 2,
  'an unrelated global step reset native Agent View scrolling')
playhead.seek(7, false)
assert(vim.wait(500, function()
  local text = view_text()
  return vim.bo[view_buffer].filetype == 'diff' and text:find('%-%-%- broken%.lua')
    and text:find('%+%+%+ broken%.lua') and text:find('@@ %-3,1 %+3,1 @@')
end), 'agent view did not render the raw unified diff fallback')
local diff_groups = {}
for _, mark in ipairs(vim.api.nvim_buf_get_extmarks(view_buffer, view_ns, 0, -1, { details = true })) do
  diff_groups[mark[2]] = mark[4].line_hl_group
end
assert(not diff_groups[0] and not diff_groups[1]
    and diff_groups[3] == 'DiffDelete' and diff_groups[4] == 'DiffAdd',
  'raw diff did not use editor diff highlights exclusively on removed and added rows')
agentview.reveal()
assert(vim.api.nvim_win_get_cursor(agentview.state().window)[1] == 3,
  'raw diff did not reveal its first hunk')
assert(vim.api.nvim_buf_get_name(view_buffer):match('/agent view %[broken%.lua%]$'),
  'agent view did not rename when the shown file changed')
playhead.finish()
assert(vim.wait(500, function() return view_text():find('changed = true', 1, true) ~= nil end),
  'agent view did not follow the full-file write')
assert(vim.wait(500, function()
  local text = screen_text()
  return text:find('gamma-output', 1, true) and text:find('[exit 7]', 1, true)
end), 'Agent Terminal dropped a failed terminal replay step')

local mouse_line
assert(vim.wait(500, function() return screen_text():find('beta', 1, true) ~= nil end),
  'terminal global-index click test did not render beta')
for line, text in ipairs(vim.api.nvim_buf_get_lines(terminal.state().buffer, 0, -1, false)) do
  if text:find('beta', 1, true) then mouse_line = line break end
end
assert(mouse_line, 'terminal global-index click test could not locate beta')
local old_getmousepos = vim.fn.getmousepos
vim.fn.getmousepos = function()
  return { winid = terminal.state().window, line = mouse_line, column = 1 }
end
local mouse_mapping
vim.api.nvim_buf_call(terminal.state().buffer, function()
  mouse_mapping = vim.fn.maparg('<LeftMouse>', 'n', false, true)
end)
assert(type(mouse_mapping.callback) == 'function', 'terminal mouse mapping callback is missing')
mouse_mapping.callback()
vim.fn.getmousepos = old_getmousepos
assert(vim.wait(500, function() return playhead.state().position == 3 end),
  'terminal click used the filtered ordinal instead of the global timeline index')
playhead.finish()
local select_line
assert(vim.wait(500, function()
  for line, text in ipairs(vim.api.nvim_buf_get_lines(terminal.state().buffer, 0, -1, false)) do
    if text:find('beta', 1, true) then select_line = line return true end
  end
  return false
end), 'Agent Terminal did not restore command text for its selection action')
vim.api.nvim_set_current_win(terminal.state().window)
vim.api.nvim_win_set_cursor(terminal.state().window, { select_line, 0 })
vim.fn.maparg('<Plug>(VibenchAgentTermSelect)', 'n', false, true).callback()
assert(playhead.state().position == 3,
  'Agent Terminal selection action used the filtered ordinal instead of the global timeline index')

local windows_before_view_reopen = #vim.api.nvim_tabpage_list_wins(0)
vim.api.nvim_set_current_win(main_window)
agent_steps[10] = {
  i = 9, kind = 'read', category = 'file', tool = 'Read', title = 'README.md', path = 'README.md',
  cwd = repo, content = 'captured read response', start_line = 3, num_lines = 1, total_lines = 100,
}
terminal.ingest({ source = { revision = 'source-agent-view', session_id = 'view' }, steps = agent_steps })
playhead.seek(10, false)
assert(vim.wait(500, function()
  return agentview.state().step and agentview.state().step.i == 9
end), 'agent view did not reach the live-file test step')
local open_live_mapping
vim.api.nvim_buf_call(view_buffer, function()
  open_live_mapping = vim.fn.maparg('gf', 'n', false, true)
end)
local open_live_action = vim.fn.maparg('<Plug>(VibenchAgentViewOpenFile)', 'n', false, true)
assert(type(open_live_mapping.callback) == 'function' and type(open_live_action.callback) == 'function',
  'Agent View open-live-file mapping or action is missing')
open_live_action.callback()
local opened_file = vim.api.nvim_get_current_buf()
local opened_path = vim.fs.normalize(vim.api.nvim_buf_get_name(opened_file))
local opened_line = vim.api.nvim_win_get_cursor(main_window)[1]
local expected_path = vim.fs.normalize(vim.fs.abspath(vim.fs.joinpath(repo, 'README.md')))
assert(vim.bo[opened_file].buftype == '' and vim.bo[opened_file].modifiable
    and opened_path == expected_path and opened_line == 3,
  'Agent View gf did not open the corresponding editable live file at its captured line: '
    .. vim.inspect({ buftype = vim.bo[opened_file].buftype, modifiable = vim.bo[opened_file].modifiable,
      path = opened_path, expected = expected_path, line = opened_line }))
assert(not agentview.state().visible and vim.api.nvim_buf_is_valid(view_buffer),
  'ordinary buffer switching closed the agent view')
playhead.seek(4, false)
assert(vim.wait(500, function()
  return table.concat(vim.api.nvim_buf_get_lines(view_buffer, 0, -1, false), '\n'):find('local value = 2', 1, true)
end), 'hidden agent view stopped following timeline updates')
vim.api.nvim_set_current_win(tools.state().window)
vim.cmd('VibenchAgentView')
assert(agentview.state().buffer == view_buffer and agentview.state().window == main_window,
  'agent view replaced the tool sidebar instead of reusing the main window')
assert(#vim.api.nvim_tabpage_list_wins(0) == windows_before_view_reopen,
  'agent view created a split')
view_info = vim.fn.getwininfo(agentview.state().window)[1]
assert(vim.api.nvim_win_get_cursor(agentview.state().window)[1] == 30
    and view_info.topline <= 30 and view_info.botline >= 30,
  'reopened Agent View did not reveal the changed line rendered while hidden')
playhead.toggle_watch()
vim.api.nvim_win_set_cursor(agentview.state().window, { 2, 0 })
vim.api.nvim_win_call(agentview.state().window, function() vim.cmd('normal! zt') end)
vim.api.nvim_win_set_buf(main_window, opened_file)
vim.api.nvim_set_current_win(tools.state().window)
vim.cmd('VibenchAgentView')
assert(vim.api.nvim_win_get_cursor(agentview.state().window)[1] == 2,
  'reopened Agent View discarded its view while Watch was off')
playhead.toggle_watch()
vim.fn.maparg('<Plug>(VibenchAgentViewClose)', 'n', false, true).callback()
assert(vim.wait(500, function() return not vim.api.nvim_buf_is_valid(view_buffer) end),
  'Agent View Close action did not explicitly close the view')
assert(vim.api.nvim_win_get_buf(main_window) == opened_file,
  'closing agent view did not restore the prior main buffer')
assert(vim.api.nvim_win_is_valid(terminal.state().window)
    and vim.api.nvim_win_is_valid(scrubber.state().window),
  'closing agent view closed another panel')
vim.wait(50)
assert(not agentview.state().enabled, 'explicitly closed agent view auto-reopened')
vim.cmd('VibenchAgentView')
assert(agentview.state().visible and agentview.state().buffer ~= view_buffer,
  'agent view command did not recreate the explicitly closed buffer')
local recreated_view = agentview.state().buffer
vim.cmd('bdelete')
assert(agentview.state().buffer == nil and not agentview.state().enabled
    and vim.fn.buflisted(recreated_view) == 0,
  ':bd did not explicitly close and disable the agent view')
vim.cmd('VibenchAgentView')
assert(agentview.state().visible and agentview.state().buffer ~= recreated_view,
  'agent view command did not reopen after :bd')

terminal.ingest({
  reset = true,
  source = { revision = 'source-file-error', session_id = 'file-error' },
  steps = {
    { i = 0, kind = 'read', category = 'file', path = 'old.lua', content = 'stale content\n' },
    {
      i = 1, kind = 'error', category = 'file', action = 'read', tool = 'Read',
      title = 'failed.lua', path = 'failed.lua', error = 'captured read failed',
    },
  },
})
playhead.seek(2, false)
assert(vim.wait(500, function()
  local state = agentview.state()
  local text = state.buffer and table.concat(vim.api.nvim_buf_get_lines(state.buffer, 0, -1, false), '\n') or ''
  return state.step and state.step.i == 1 and text:find('ERROR', 1, true)
    and text:find('captured read failed', 1, true) and not text:find('stale content', 1, true)
end), 'failed file call left stale content in Agent View')
assert(vim.api.nvim_buf_get_name(agentview.state().buffer):match('/agent view %[failed%.lua%]$')
    and vim.bo[agentview.state().buffer].filetype == ''
    and vim.api.nvim_win_get_cursor(agentview.state().window)[1] == 1,
  'failed file call did not render as the current plain-text Agent View result')

terminal.ingest({
  reset = true,
  source = { revision = 'source-raw-write', session_id = 'raw-write' },
  steps = { {
    i = 0, kind = 'write', path = 'raw-write.lua', hunks = {
      { oldStart = 1, oldLines = 1, newStart = 1, newLines = 1, lines = { '-before', '+after' } },
    },
  } },
})
playhead.seek(1, false)
assert(vim.wait(500, function()
  local lines = vim.api.nvim_buf_get_lines(agentview.state().buffer, 0, -1, false)
  return vim.bo[agentview.state().buffer].filetype == 'diff'
    and table.concat(lines, '\n'):find('-before\n+after', 1, true)
end), 'unproven write did not render its captured raw diff')

local backfilled = {
  { i = 0, kind = 'patch', path = 'backfill.lua', hunks = {
    { oldStart = 1, oldLines = 1, newStart = 1, newLines = 1, lines = { '-before', '+after' } },
  } },
}
terminal.ingest({
  reset = true,
  source = { revision = 'source-backfill', session_id = 'backfill' },
  steps = backfilled,
})
playhead.seek(1, false)
assert(vim.wait(500, function() return agentview.state().step and vim.bo[agentview.state().buffer].filetype == 'diff' end),
  'unproven patch did not start as a raw diff')
backfilled[1] = {
  i = 0, kind = 'patch', path = 'backfill.lua', content = 'after\n',
  region = { start_line = 1, end_line = 1 },
}
backfilled[2] = {
  i = 1, kind = 'read', path = 'backfill.lua', content = 'after\n', full = true,
  start_line = 1, num_lines = 1, total_lines = 1,
}
terminal.ingest({
  source = { revision = 'source-backfill', session_id = 'backfill' },
  steps = backfilled,
})
assert(playhead.state().position == 1 and not playhead.state().follow,
  'future anchor moved the held playhead')
assert(vim.wait(500, function()
  return vim.bo[agentview.state().buffer].filetype == 'lua'
    and table.concat(vim.api.nvim_buf_get_lines(agentview.state().buffer, 0, -1, false), '\n') == 'after'
end), 'future anchor did not repaint the held patch as proven full-file content')

vim.api.nvim_set_current_win(terminal.state().window)
vim.cmd('belowright 3split')
local added_window = vim.api.nvim_get_current_win()
assert(vim.wait(500, function()
  return vim.api.nvim_win_get_height(scrubber_window) == 1
    and vim.api.nvim_win_get_position(added_window)[1] < vim.api.nvim_win_get_position(scrubber_window)[1]
end), 'scrubber was not repinned after another split opened')
assert_scrubber_bottom()
assert(vim.api.nvim_win_get_height(terminal.state().window) == 5,
  'repinning the scrubber changed the fixed agent-terminal height')
vim.api.nvim_win_close(added_window, true)

vim.cmd('VibenchScrubber')
assert(not scrubber.state().visible, 'scrubber command did not hide the bar')
assert(terminal.state().window and vim.api.nvim_win_is_valid(terminal.state().window),
  'hiding the scrubber closed the agent terminal')
assert(vim.api.nvim_win_get_height(terminal.state().window) == 5,
  'hiding the scrubber changed the fixed agent-terminal height: '
    .. vim.api.nvim_win_get_height(terminal.state().window))
terminal.hide()
vim.cmd('tabnew')
vim.wait(50)
assert(not scrubber.state().visible, 'hidden scrubber reopened after a tab change')
vim.cmd('VibenchScrubber')
scrubber_window = scrubber.state().window
assert_scrubber_bottom()
terminal.show()
assert(vim.api.nvim_win_get_height(terminal.state().window) == 5,
  'showing the scrubber changed the fixed agent-terminal height')
assert(vim.api.nvim_win_get_tabpage(terminal.state().window) == vim.api.nvim_get_current_tabpage(),
  'agent terminal opened in the scrubber\'s previous tab')

terminal.hide()
local old_scrubber_window = scrubber_window
vim.cmd('tabnew')
assert(vim.wait(500, function()
  local state = scrubber.state()
  return state.window ~= old_scrubber_window and state.window
    and vim.api.nvim_win_get_tabpage(state.window) == vim.api.nvim_get_current_tabpage()
end), 'scrubber did not follow the active tab')
scrubber_window = scrubber.state().window
terminal.show()
assert(vim.api.nvim_win_get_tabpage(terminal.state().window) == vim.api.nvim_get_current_tabpage(),
  'agent terminal opened in the scrubber\'s previous tab')
assert_scrubber_bottom()

local previous_tab_terminal = terminal.state().window
vim.cmd('tabnew')
assert(vim.wait(500, function()
  return scrubber.state().window
    and vim.api.nvim_win_get_tabpage(scrubber.state().window) == vim.api.nvim_get_current_tabpage()
end), 'scrubber did not reach the new tab for the terminal toggle test')
scrubber_window = scrubber.state().window
terminal.toggle()
assert(not vim.api.nvim_win_is_valid(previous_tab_terminal) and terminal.state().window
    and vim.api.nvim_win_get_tabpage(terminal.state().window) == vim.api.nvim_get_current_tabpage(),
  'agent terminal toggle closed the old-tab drawer without opening in the current tab')
assert_scrubber_bottom()

print('agentterm_headless: PASS')
