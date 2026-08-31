local api = vim.api
assert(vim.v.vim_did_enter == 1, 'test did not run in an attached TUI')
vim.g.vibench_agentterm_server_json = vim.env.VIBENCH_SERVER_JSON
vim.keymap.set('n', '<M-A>', '<Nop>', { desc = 'existing user mapping' })
vim.cmd('luafile ' .. vim.env.VIBENCH_PLUGIN)
vim.cmd('luafile ' .. vim.env.VIBENCH_SCRUBBER_PLUGIN)
local M = vim.g.vibench_agentterm
local S = vim.g.vibench_scrubber
assert(M, 'agent terminal plugin did not load')
assert(S, 'scrubber plugin did not load')

local function wait_for(test, message)
  assert(vim.wait(5000, test, 20), message)
end

S.show()
M.show()
local empty_marks = api.nvim_buf_get_extmarks(M.state().buffer, -1, 0, -1, { details = true })
assert(#empty_marks == 1 and empty_marks[1][4].virt_text[1][1] == '$ ', 'empty terminal is not a bare prompt')
wait_for(function() return #M.state().blocks == 4 end, 'initial blocks did not load')
local state = M.state()
wait_for(function()
  local rendered = table.concat(api.nvim_buf_get_lines(state.buffer, 0, -1, false), '\n')
  return rendered:find('command-one', 1, true) and rendered:find('command-four', 1, true)
end, 'blocks not rendered')
assert(not table.concat(api.nvim_buf_get_lines(state.buffer, 0, -1, false), '\n'):find('\27', 1, true),
  'ANSI escapes rendered as raw text')
assert(vim.fn.mode() == 'n', 'drawer did not leave the user in Normal mode')
local scrubber = S.state()
local scrubber_line = api.nvim_buf_get_lines(scrubber.buffer, 0, 1, false)[1]
assert(scrubber_line:find('4/4', 1, true), 'initial scrubber position is wrong')
assert(not scrubber_line:find('real%-e2e'), 'scrubber contains the session label')
assert(not scrubber_line:lower():find('block', 1, true), 'scrubber contains invented unit wording')
assert(not scrubber_line:find('gg', 1, true), 'scrubber contains shortcut hints')
assert(scrubber_line:find('', 1, true) and scrubber_line:find('LIVE', 1, true),
  'scrubber is missing play/live controls')
assert(vim.wo[state.window].winbar:find('4/4', 1, true), 'initial agent-terminal winbar position is wrong')
assert(vim.wo[state.window].winbar:find('|<', 1, true)
    and vim.wo[state.window].winbar:find('>|', 1, true),
  'agent-terminal winbar controls are missing')
assert(not vim.wo[state.window].winhighlight:find('VibenchScrubber', 1, true),
  'agent terminal inherited the scrubber highlight')
assert(api.nvim_win_get_config(scrubber.window).relative == '', 'scrubber is floating')
assert(api.nvim_win_get_height(scrubber.window) == 1, 'scrubber is not one row')
local bar = api.nvim_get_hl(0, { name = 'VibenchScrubber', link = false })
assert(bar.bg == 0x007ACC, 'scrubber highlight is not blue')
assert(vim.fn.maparg('g', 'n', false, true).buffer ~= 1, 'bare g shadows normal g-prefix motions')
assert(vim.fn.maparg('<C-h>', 'n') ~= '', 'previous default mapping is missing')
assert(vim.fn.maparg('<C-l>', 'n') ~= '', 'next default mapping is missing')
assert(vim.fn.maparg('<C-S-h>', 'n') ~= '', 'home default mapping is missing')
assert(vim.fn.maparg('<C-S-l>', 'n') ~= '', 'end default mapping is missing')
assert(vim.fn.maparg('<leader>P', 'n') ~= '', 'live-follow default mapping is missing')
assert(vim.fn.maparg('<Plug>(VibenchPlayheadPlayPause)', 'n') ~= '', 'play/pause <Plug> mapping is missing')
assert(vim.fn.maparg('<Plug>(VibenchPlayheadEnd)', 'n') ~= '', 'end <Plug> mapping is missing')
assert(vim.fn.maparg('<Plug>(VibenchPlayheadLive)', 'n') ~= '', 'live <Plug> mapping is missing')
assert(vim.fn.maparg('<M-A>', 'n') == '<Nop>', 'existing toggle mapping was overwritten')
assert(vim.fn.maparg('<leader>z', 'n') ~= '', 'free toggle mapping was not installed')
local health = api.nvim_exec2('VibenchAgentTermHealth', { output = true }).output
assert(health:find('<M%-A>'), 'health did not report skipped mapping: ' .. health)
vim.cmd('redraw')
vim.fn.writefile({ 'ready' }, vim.env.VIBENCH_READY)
