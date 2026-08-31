local source = debug.getinfo(1, 'S').source:sub(2)
local repo = vim.fs.dirname(vim.fs.dirname(vim.fs.dirname(source)))
vim.opt.runtimepath:prepend(vim.fs.joinpath(repo, 'nvim'))
vim.env.VIBENCH_SESSION = 'workspace-test'
vim.env.VIBENCH_SERVER = 'http://127.0.0.1:43123'
vim.env.VIBENCH_SERVER_TOKEN = 'workspace-secret'
vim.env.VIBENCH_SERVER_JSON = vim.fs.joinpath(repo, 'missing-server.json')
local real_system = vim.system
local published = {}
vim.system = function(command, options, callback)
  published[#published + 1] = { command = command, options = options }
  if callback then callback({ code = 0, stdout = '', stderr = '' }) end
  return { kill = function() end }
end

local first = vim.api.nvim_get_current_buf()
local alpha = vim.fn.fnamemodify(vim.fs.joinpath(repo, 'alpha.lua'), ':p')
vim.api.nvim_buf_set_name(first, alpha)
vim.api.nvim_buf_set_lines(first, 0, -1, false, { 'one', 'two selected', 'three' })
local second = vim.api.nvim_create_buf(true, false)
vim.api.nvim_buf_set_name(second, vim.fs.joinpath(repo, 'beta.lua'))
vim.api.nvim_buf_set_lines(second, 0, -1, false, { 'beta' })
vim.cmd('vsplit')
vim.api.nvim_win_set_buf(0, second)
vim.cmd('wincmd p')

dofile(vim.fs.joinpath(repo, 'nvim', 'plugin', 'vibench-workspace.lua'))
local workspace = vim.g.vibench_workspace
local playhead = require('vibench.playhead')
playhead.set_total(4)
playhead.seek(2, false)

local state = workspace.snapshot()
assert(state.schema == 'vibench.workspace.v1' and state.kind == 'workspace_state',
  'workspace schema is wrong')
assert(vim.fs.normalize(state.current.path) == vim.fs.normalize(alpha),
  'focused file is wrong: ' .. vim.inspect(state.current.path))
assert(#state.open_files == 2 and #state.windows == 2, 'open files or windows are missing')
assert(state.playhead.position == 2 and not state.playhead.follow and state.playhead.watch,
  'shared playhead position, Live, or Watch state is missing')
assert(state.selected_agent.kind == 'root' and state.selected_agent.id == 'workspace-test',
  'workspace state omitted the selected root agent')
vim.g.vibench_agentview = { state = function()
  return { window = vim.api.nvim_get_current_win(), visible = false, enabled = true }
end }
state = workspace.snapshot()
assert(not state.panels.agent_view.visible and not state.panels.agent_view.focused,
  'a hidden panel with a retained window was reported visible')
vim.g.vibench_agents = { state = function()
  return {
    window = vim.api.nvim_get_current_win(), visible = true, enabled = true,
    roots = { { id = 'workspace-test' } }, rows = { {}, {} },
  }
end }
vim.g.vibench_chat = { state = function()
  return { window = vim.api.nvim_get_current_win(), visible = true }
end }
state = workspace.snapshot()
assert(state.panels.agents.available and state.panels.agents.visible
    and state.panels.agents.focused and state.panels.agents.enabled
    and state.panels.agents.roots == 1 and state.panels.agents.count == 2,
  'workspace state omitted Agents panel state')
assert(state.panels.chat.available and state.panels.chat.visible and state.panels.chat.focused,
  'workspace state omitted Chat panel state')

vim.api.nvim_win_set_cursor(0, { 1, 0 })
vim.cmd('normal! v$')
vim.api.nvim_feedkeys(vim.keycode('<Esc>'), 'nx', false)
assert(vim.wait(100, function() return vim.fn.mode(1):sub(1, 1) ~= 'v' end),
  'quick visual mode did not end')
state = workspace.snapshot()
assert(state.selection and not state.selection.active and state.selection.text == 'one',
  'quick visual selection was lost')

vim.api.nvim_win_set_cursor(0, { 2, 0 })
vim.cmd('normal! v$')
state = workspace.snapshot()
assert(state.selection and state.selection.active and state.selection.mode == 'character',
  'active visual selection is missing')
assert(state.selection.start.line == 2 and state.selection['end'].line == 2,
  'visual selection range is wrong')
assert(state.selection.text == 'two selected', 'visual selection text is wrong')

vim.api.nvim_feedkeys(vim.keycode('<Esc>'), 'nx', false)
assert(vim.wait(100, function() return vim.fn.mode(1):sub(1, 1) ~= 'v' end),
  'visual mode did not end')
state = workspace.snapshot()
assert(state.selection and not state.selection.active and state.selection.text == 'two selected',
  'latest visual selection did not persist as inactive')
assert(vim.json.encode(state):find('vibench.workspace.v1', 1, true),
  'workspace state is not JSON encodable')
assert(vim.wait(500, function() return #published > 0 end), 'workspace state was not published')
local sent = published[#published]
assert(sent.command[#sent.command] == 'http://127.0.0.1:43123/sessions/workspace-test/workbench',
  'workspace state used the wrong endpoint')
local body = vim.json.decode(sent.options.stdin)
assert(body.selection and body.selection.text == 'two selected',
  'published state omitted the visual selection')
local function has_auth(request)
  for index, argument in ipairs(request.command) do
    if argument == '--config' then
      local ok, lines = pcall(vim.fn.readfile, request.command[index + 1])
      return ok and table.concat(lines, '\n'):find('authorization: Bearer workspace-secret', 1, true)
    end
  end
  return false
end
assert(has_auth(sent), 'workspace state omitted server authentication')
local timeline = require('vibench.timeline')
timeline.select_agent({ kind = 'child', id = 'child-1', root_id = 'workspace-test' })
state = workspace.snapshot()
assert(state.selected_agent.kind == 'child' and state.selected_agent.id == 'child-1',
  'workspace state did not follow selected child identity')
timeline.select_agent({ kind = 'root', id = 'workspace-test', root_id = 'workspace-test' })
assert(timeline.ingest({
  select_agent = {
    intent_id = 'workspace-intent', kind = 'root', id = 'workspace-test', root_id = 'workspace-test',
  },
  agent = { kind = 'root', id = 'workspace-test', root_id = 'workspace-test' },
  source = { revision = 'workspace-intent-r1' }, steps = {},
}), 'workspace agent-selection intent was rejected')
assert(workspace.snapshot().agent_selection_intent == 'workspace-intent',
  'workspace state omitted the handled agent-selection intent')
assert(vim.wait(500, function()
  return vim.iter(published):any(function(item)
    if type(item.options.stdin) ~= 'string' then return false end
    local ok, value = pcall(vim.json.decode, item.options.stdin)
    return ok and value.agent_selection_intent == 'workspace-intent'
  end)
end), 'workspace did not publish the handled agent-selection intent')
timeline.connect('workspace-test')
assert(vim.wait(500, function()
  return vim.iter(published):any(function(item)
    return item.command[#item.command]
        == 'http://127.0.0.1:43123/agents/root/workspace-test/timeline/events'
      and has_auth(item)
  end)
end), 'timeline stream omitted server authentication')
for _, request in ipairs(published) do
  assert(not table.concat(request.command, ' '):find('workspace-secret', 1, true),
    'server token leaked into a curl process command line')
end
timeline.disconnect('workspace-test')
vim.system = real_system

print('workspace_headless: PASS')
