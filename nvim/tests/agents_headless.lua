local source = debug.getinfo(1, 'S').source:sub(2)
local repo = vim.fs.dirname(vim.fs.dirname(vim.fs.dirname(source)))
vim.opt.runtimepath:prepend(vim.fs.joinpath(repo, 'nvim'))
vim.env.VIBENCH_SESSION = 'agents-headless'
vim.env.VIBENCH_SERVER = 'http://127.0.0.1:43123'
vim.env.VIBENCH_SERVER_TOKEN = 'test-token'
vim.g.vibench_agentterm_server_json = vim.fs.joinpath(repo, 'does-not-exist.json')
vim.g.vibench_agents_refresh_ms = 10000

local main_window = vim.api.nvim_get_current_win()
vim.api.nvim_buf_set_name(0, 'agents-headless-main.lua')
vim.cmd('botright 4split')
local drawer_window = vim.api.nvim_get_current_win()
vim.api.nvim_buf_set_name(0, 'agents-headless-drawer')
vim.api.nvim_set_current_win(main_window)

local bufferline_config = {
  options = { offsets = { { filetype = 'neo-tree' } } },
  user = { options = { offsets = { { filetype = 'neo-tree' } } } },
}
package.loaded['bufferline.config'] = { get = function() return bufferline_config end }

local tool_calls_hidden = false
vim.g.vibench_tools = {
  hide = function() tool_calls_hidden = true end,
  state = function() return { window = nil } end,
}

local explorer_active, explorer_window = false, nil
local picker = {
  layout = { root = {} },
  close = function()
    explorer_active = false
    if explorer_window and vim.api.nvim_win_is_valid(explorer_window) then
      vim.api.nvim_win_close(explorer_window, true)
    end
    explorer_window = nil
  end,
}
_G.Snacks = { picker = { get = function(options)
  if options.source == 'explorer' and explorer_active then return { picker } end
  return {}
end } }

local catalog = {
  roots = {
    {
      id = 'old-root', name = 'Stopped bench', live = false,
      children = { { id = 'old-child', name = 'Old child', live = false, status = 'completed' } },
    },
    {
      kind = 'root', id = 'agents-headless', root_id = 'agents-headless',
      name = 'Current bench with a deliberately long descriptive name', live = true,
      events_url = '/agents/root/agents-headless/timeline/events',
      tmux = { socket = 'agents-socket', nvim = { window_id = '@1', session = 'vibench', pane_id = '%1' } },
      children = {
        { kind = 'child', id = 'child-1', root_id = 'agents-headless', spawn_position = 2,
          spawned_at = '2026-08-28T10:00:00.000Z',
          events_url = '/agents/child/agents-headless/child-1/timeline/events',
          name = 'Finished child with a deliberately long descriptive name',
          live = false, status = 'completed' },
        { kind = 'child', id = 'child-2', root_id = 'agents-headless',
          parent_agent_id = 'child-1', spawn_position = 2,
          spawned_at = '2026-08-28T10:08:00.000Z',
          events_url = '/agents/child/agents-headless/child-2/timeline/events',
          name = 'Nested child with a deliberately long descriptive name', live = true,
          status = 'in_progress' },
        { kind = 'child', id = 'child-3', root_id = 'agents-headless', spawn_position = 3,
          events_url = '/agents/child/agents-headless/child-3/timeline/events',
          name = 'Failed child', live = false, status = 'failed' },
        { kind = 'child', id = 'child-4', root_id = 'agents-headless', spawn_position = 4,
          events_url = '/agents/child/agents-headless/child-4/timeline/events',
          name = 'Another completed child', live = false, status = 'completed' },
        { kind = 'child', id = 'unknown-child', root_id = 'agents-headless',
          events_url = '/agents/child/agents-headless/unknown-child/timeline/events',
          name = 'Unknown spawn child', live = true, status = 'in_progress' },
      },
    },
    {
      kind = 'root', id = 'root-2', root_id = 'root-2', name = 'Other live bench', live = true,
      events_url = '/agents/root/root-2/timeline/events',
      children = {
        { kind = 'child', id = 'remote-child', root_id = 'root-2', spawn_position = 1,
          events_url = '/agents/child/root-2/remote-child/timeline/events',
          name = 'Remote child', live = true, status = 'in_progress' },
      },
      tmux = { socket = 'agents-socket', nvim = { window_id = '@2', session = 'vibench', pane_id = '%2' } },
    },
  },
}
local requests, streams, tmux_calls, selections = 0, {}, {}, {}
local tmux_owner = 'root-2'
local tmux_identity = 'vibench\t@2\t%2\n'
vim.system = function(command, options, callback)
  local url = command[#command]
  if type(url) == 'string' and url:match('/agents$') then
    requests = requests + 1
    vim.schedule(function()
      callback({ code = 0, stdout = vim.json.encode(catalog), stderr = '' })
    end)
    return { kill = function() end }
  end
  if type(url) == 'string' and url:match('/timeline/events$') then
    local request = { command = command, options = options, callback = callback, killed = false }
    streams[url] = request
    return { kill = function() request.killed = true end }
  end
  if type(url) == 'string' and url:match('/select$') then
    selections[#selections + 1] = { command = command, options = options, callback = callback }
    return { kill = function() end }
  end
  if vim.tbl_contains(command, 'display-message') then
    return { wait = function() return { code = 0, stdout = tmux_identity, stderr = '' } end }
  end
  if vim.tbl_contains(command, 'show-environment') then
    return { wait = function()
      return { code = 0, stdout = 'VIBENCH_WINDOW__2=' .. tmux_owner .. '\n', stderr = '' }
    end }
  end
  tmux_calls[#tmux_calls + 1] = { command = command, options = options }
  return { kill = function() end }
end

dofile(vim.fs.joinpath(repo, 'nvim', 'plugin', 'vibench-agents.lua'))
local agents = vim.g.vibench_agents
assert(agents and vim.fn.exists(':VibenchAgents') == 2, 'Agents command did not load')
assert(vim.fn.maparg('<leader>A', 'n') == '<Plug>(VibenchAgentsToggle)',
  'Agents default mapping is missing')
assert(vim.fn.maparg('<Plug>(VibenchAgentsToggle)', 'n') ~= '',
  'Agents Plug mapping is missing')
assert(vim.fn.maparg('<Plug>(VibenchAgentsSelect)', 'n') ~= ''
    and vim.fn.maparg('<Plug>(VibenchAgentsHide)', 'n') ~= '',
  'Agents selection or hide action is missing')

vim.cmd('VibenchAgents')
assert(vim.wait(1000, function()
  return agents.state().visible and #agents.state().rows == 8 and requests > 0
end), 'Agents did not open and fetch its rows')
assert(tool_calls_hidden, 'Agents did not replace Tool Calls')

local state = agents.state()
local text = table.concat(vim.api.nvim_buf_get_lines(state.buffer, 0, -1, false), '\n')
assert(text:find('Current bench', 1, true) and text:find('Finished child', 1, true)
    and text:find('Nested child', 1, true) and text:find('in progress', 1, true)
    and text:find('Failed child', 1, true) and text:find('Other live bench', 1, true),
  'Agents did not render nested child statuses')
assert(not text:find('Stopped bench', 1, true) and not text:find('Old child', 1, true),
  'Agents rendered a non-live root')
local lines = vim.api.nvim_buf_get_lines(state.buffer, 0, -1, false)
assert(lines[2]:find('├─', 1, true) and lines[3]:find('└─', 1, true)
    and lines[3]:find('Nested child', 1, true), 'Agents child hierarchy is not nested')
assert(vim.fn.strcharpart(lines[1], 0, 40):find('live', 1, true)
    and vim.fn.strcharpart(lines[2], 0, 40):find('completed', 1, true)
    and vim.fn.strcharpart(lines[3], 0, 40):find('in progress', 1, true)
    and vim.fn.strcharpart(lines[4], 0, 40):find('failed', 1, true),
  'Agents clipped a root or child status in the default sidebar width')
assert(lines[1]:find('▸', 1, true), 'Agents did not mark the selected root')

local timeline = require('vibench.timeline')
local playhead = require('vibench.playhead')
assert(timeline.timestamp('1970-01-01T00:00:00Z') == 0
    and timeline.timestamp('1969-12-31T23:59:59.500Z') == -0.5
    and timeline.timestamp('2000-01-01T00:00:00.125Z') == 946684800.125,
  'timeline did not convert known UTC epochs exactly')
assert(not timeline.timestamp('2024-02-30T00:00:00Z')
    and not timeline.timestamp('2024-01-01T00:00:00.Z'),
  'timeline accepted a malformed UTC timestamp')
local owner = {}
timeline.connect(owner)
local function stream_url(agent)
  return ('http://127.0.0.1:43123%s'):format(agent.events_url)
end
local function feed(agent, steps, revision)
  local stream = streams[stream_url(agent)]
  assert(stream and type(stream.options.stdout) == 'function',
    'timeline did not open ' .. stream_url(agent))
  stream.options.stdout(nil, 'data: ' .. vim.json.encode({
    session = { id = 'agents-headless', name = 'Current bench' },
    source = { revision = revision }, agent = agent, steps = steps,
  }) .. '\n\n')
  assert(vim.wait(1000, function()
    return timeline.state().agent.id == agent.id and playhead.state().total == #steps
  end), 'timeline did not ingest ' .. agent.id)
end
local root = catalog.roots[2]
local root_steps = {
  { i = 0, kind = 'chat', category = 'chat', event = 'message', at = '2026-08-28T09:00:00.000Z' },
  { i = 1, kind = 'other', category = 'tool_info', at = '2026-08-28T10:00:00.000Z' },
  { i = 2, kind = 'chat', category = 'chat', event = 'agent_spawn', at = '2026-08-28T10:07:00.000Z' },
  { i = 3, kind = 'terminal', category = 'terminal', command = 'done', at = '2026-08-28T11:00:00.000Z' },
}
feed(root, root_steps, 'root-r1')
assert(timeline.state().steps[1].category == 'chat',
  'categorized root stream dropped chat steps')

local function row_number(id)
  for index, row in ipairs(agents.state().rows) do
    if row.id == id then return index end
  end
end
local enter, click, select_action
vim.api.nvim_buf_call(state.buffer, function()
  enter = vim.fn.maparg('<CR>', 'n', false, true)
  click = vim.fn.maparg('<LeftMouse>', 'n', false, true)
  select_action = vim.fn.maparg('<Plug>(VibenchAgentsSelect)', 'n', false, true)
end)
assert(type(enter.callback) == 'function' and type(click.callback) == 'function'
    and type(select_action.callback) == 'function', 'Agents selection mappings or action are missing')
local function select(id)
  local row = assert(row_number(id), 'missing agent row ' .. id)
  vim.api.nvim_win_set_cursor(agents.state().window, { row, 0 })
  select_action.callback()
end
local function click_row(id)
  local row = assert(row_number(id), 'missing agent row ' .. id)
  local saved_getmousepos = vim.fn.getmousepos
  vim.fn.getmousepos = function()
    return { winid = agents.state().window, line = row, column = 1 }
  end
  click.callback()
  vim.fn.getmousepos = saved_getmousepos
end

select('root-2')
assert(#selections == 1 and #tmux_calls == 0,
  'root selection focused tmux before the destination acknowledged it')
assert(selections[1].command[#selections[1].command]
    == 'http://127.0.0.1:43123/agents/root/root-2/select',
  'root selection signaled the wrong destination')
assert(lines[1]:find('▸', 1, true), 'pending root selection moved the selected marker')
select('agents-headless')
selections[1].callback({ code = 0, stdout = '', stderr = '' })
vim.wait(50)
assert(#tmux_calls == 0, 'an obsolete root-selection callback focused tmux')
select('root-2')
assert(#selections == 2, 'replacement root selection did not signal the destination')
selections[2].callback({ code = 0, stdout = '', stderr = '' })
assert(vim.wait(500, function() return #tmux_calls == 1 end),
  'acknowledged root selection did not focus tmux')
assert(vim.deep_equal(tmux_calls[1].command,
  { 'tmux', '-L', 'agents-socket', 'select-window', '-t', '@2' }),
  'root selection used unstable tmux metadata: ' .. vim.inspect(tmux_calls[1].command))
assert(vim.api.nvim_buf_get_lines(state.buffer, row_number('root-2') - 1, row_number('root-2'), false)[1]
    :find('▸', 1, true), 'selected root marker did not move')
select('agents-headless')
assert(#tmux_calls == 1, 'selecting the current root ran tmux')

select('remote-child')
assert(#selections == 3 and #tmux_calls == 1,
  'remote child selection focused tmux before destination acknowledgement')
assert(selections[3].command[#selections[3].command]
    == 'http://127.0.0.1:43123/agents/child/root-2/remote-child/select',
  'remote child selection signaled the wrong destination')
selections[3].callback({ code = 0, stdout = '', stderr = '' })
assert(vim.wait(500, function() return #tmux_calls == 2 end),
  'acknowledged remote child selection did not focus its parent tmux window')
assert(vim.deep_equal(tmux_calls[2].command,
  { 'tmux', '-L', 'agents-socket', 'select-window', '-t', '@2' }),
  'remote child selection focused the wrong tmux window')
assert(vim.api.nvim_buf_get_lines(state.buffer,
    row_number('remote-child') - 1, row_number('remote-child'), false)[1]:find('▸', 1, true),
  'selected remote child marker did not move')
select('agents-headless')
assert(#tmux_calls == 2, 'returning from a remote child ran tmux for the current root')

tmux_owner = 'reused-root'
select('root-2')
selections[4].callback({ code = 0, stdout = '', stderr = '' })
vim.wait(50)
assert(#tmux_calls == 2, 'a reused tmux window id focused a different bench')
tmux_owner = 'root-2'
select('agents-headless')

tmux_identity = 'vibench\t@99\t%2\n'
select('root-2')
selections[5].callback({ code = 0, stdout = '', stderr = '' })
vim.wait(50)
assert(#tmux_calls == 2, 'a reused tmux pane id focused a different window')
tmux_identity = 'vibench\t@2\t%2\n'
select('agents-headless')

playhead.seek(1, false)
assert(not row_number('child-1') and not row_number('child-2') and not row_number('child-3'),
  'Agents showed a child or its descendants before the parent spawn position')
assert(not row_number('unknown-child'),
  'Agents showed a child with an unknown spawn point throughout parent history')
playhead.seek(3, false)
assert(not row_number('child-2'),
  'Agents showed a nested child before its wall-clock spawn point')
click_row('child-1')
assert(vim.wait(500, function() return timeline.target().id == 'child-1' end),
  'Agents mouse selection did not retarget the timeline')
local child1 = root.children[1]
local child1_steps = {
  { i = 0, kind = 'chat', category = 'chat', at = '2026-08-28T10:02:00.000Z' },
  { i = 1, kind = 'terminal', category = 'terminal', at = '2026-08-28T10:08:00.000Z' },
  { i = 2, kind = 'chat', category = 'chat', at = '2026-08-28T10:12:00.000Z' },
}
feed(child1, child1_steps, 'child-1-r1')
assert(playhead.state().position == 2 and not playhead.state().follow,
  'historical child descent did not align by wall clock: ' .. vim.inspect(playhead.state()))
assert(vim.api.nvim_buf_get_lines(state.buffer, row_number('child-1') - 1, row_number('child-1'), false)[1]
    :find('▸', 1, true), 'selected child marker did not move')

local child_selection_signal = {
  intent_id = 'child-selection-1', kind = 'child', id = 'remote-child', root_id = 'root-2',
}
assert(timeline.ingest({
  select_agent = child_selection_signal, agent = child1, steps = child1_steps,
}), 'destination child selection signal was rejected')
feed(catalog.roots[3].children[1], {
  { i = 0, kind = 'chat', category = 'chat', at = '2026-08-28T10:10:00.000Z' },
  { i = 1, kind = 'other', category = 'tool_info', at = '2026-08-28T10:20:00.000Z' },
}, 'remote-child-r1')
assert(playhead.state().position == 1 and not playhead.state().follow,
  'remote child selection ignored the destination parent playhead')

local selection_signal = {
  intent_id = 'selection-1', kind = 'root', id = 'agents-headless', root_id = 'agents-headless',
}
assert(timeline.ingest({ select_agent = selection_signal, agent = child1, steps = child1_steps }),
  'destination root selection signal was rejected')
assert(timeline.target().id == 'agents-headless', 'destination root selection did not retarget the timeline')
assert(timeline.ingest({ select_agent = selection_signal, agent = child1, steps = child1_steps }),
  'repeated destination root selection signal was rejected')
assert(timeline.target().id == 'agents-headless' and #timeline.state().steps == 0,
  'an old child payload overwrote the acknowledged root selection')
feed(root, root_steps, 'root-r1')
assert(playhead.state().position == 3 and not playhead.state().follow,
  'returning to the root did not restore its playhead')
select('child-1')
feed(child1, child1_steps, 'child-1-r1')
assert(playhead.state().position == 2, 'returning to a child did not restore its playhead')
select('agents-headless')
assert(timeline.ingest({ agent = root, source = { revision = 'root-r2' }, steps = {} }),
  'changed root revision was rejected')
assert(playhead.state().position == 0 and playhead.state().follow,
  'changed revision did not discard a stale saved landing on an empty snapshot')
assert(timeline.ingest({ agent = root, source = { revision = 'root-r2' }, steps = root_steps }),
  'replacement root snapshot was rejected')
assert(playhead.state().position == #root_steps and playhead.state().follow,
  'replacement root snapshot reused a stale saved position')

playhead.set_follow(true)
select('child-1')
feed(child1, child1_steps, 'child-1-r1')
assert(playhead.state().position == 3 and playhead.state().follow,
  'a saved child playhead overrode a fresh Live parent descent')
select('agents-headless')
feed(root, root_steps, 'root-r1')

playhead.set_follow(true)
select('child-3')
local child3 = root.children[3]
feed(child3, {
  { i = 0, kind = 'chat', category = 'chat', at = '2026-08-28T10:10:00.000Z' },
  { i = 1, kind = 'other', category = 'tool_info', at = '2026-08-28T10:20:00.000Z' },
}, 'child-3-r1')
assert(playhead.state().follow and playhead.state().position == 2,
  'Live parent descent did not land at the child Live head')
select('agents-headless')
feed(root, root_steps, 'root-r1')

select('child-1')
feed(child1, child1_steps, 'child-1-r1')
playhead.seek(2, false)
select('child-2')
local child2 = root.children[2]
feed(child2, {
  { i = 0, kind = 'chat', category = 'chat', at = '2026-08-28T10:30:00.000Z' },
  { i = 1, kind = 'terminal', category = 'terminal', at = '2026-08-28T10:40:00.000Z' },
}, 'child-2-r1')
assert(playhead.state().position == 1 and not playhead.state().follow,
  'historical child descent did not clamp to available history')
select('child-1')
feed(child1, child1_steps, 'child-1-r1')
assert(playhead.state().position == 2, 'nested parent playhead was not restored')

select('agents-headless')
feed(root, root_steps, 'root-r1')
playhead.finish()
select('child-4')
local child4 = root.children[4]
feed(child4, {}, 'child-4-r1')
feed(child4, {
  { i = 0, kind = 'chat', category = 'chat', at = '2026-08-28T11:10:00.000Z' },
  { i = 1, kind = 'terminal', category = 'terminal', at = '2026-08-28T11:20:00.000Z' },
}, 'child-4-r1')
assert(playhead.state().position == 2 and not playhead.state().follow,
  'empty child snapshot consumed the pending End landing')

local saved_timezone = vim.env.TZ
vim.env.TZ = 'America/Los_Angeles'
local dst_root = { kind = 'root', id = 'dst-root', root_id = 'dst-root' }
local dst_child = { kind = 'child', id = 'dst-child', root_id = 'dst-root' }
timeline.select_agent(dst_root)
timeline.ingest({ agent = dst_root, source = { revision = 'dst-root-r1' }, steps = {
  { i = 0, kind = 'chat', category = 'chat', at = '2024-03-10T00:00:00.000Z' },
  { i = 1, kind = 'chat', category = 'chat', at = '2024-03-10T03:10:00.000Z' },
  { i = 2, kind = 'chat', category = 'chat', at = '2024-03-10T05:00:00.000Z' },
} })
playhead.seek(2, false)
timeline.select_agent(dst_child, timeline.selection_landing())
timeline.ingest({ agent = dst_child, source = { revision = 'dst-child-r1' }, steps = {
  { i = 0, kind = 'chat', category = 'chat', at = 'malformed' },
  { i = 1, kind = 'chat', category = 'chat', at = '2024-03-10T01:50:00.000Z' },
  { i = 2, kind = 'chat', category = 'chat', at = '2024-03-10T03:50:00.000Z' },
} })
local dst_position = playhead.state().position
vim.env.TZ = saved_timezone
assert(dst_position == 3, 'agent alignment depended on the local DST boundary')
timeline.disconnect(owner)

local function offset_count(offsets)
  local count, match = 0, nil
  for _, offset in ipairs(offsets) do
    if offset.filetype == 'vibench-agents' then count, match = count + 1, offset end
  end
  return count, match
end
local count, offset = offset_count(bufferline_config.options.offsets)
assert(count == 1 and offset.text == '', 'Agents duplicated its title in the tab offset')
assert(offset_count(bufferline_config.user.options.offsets) == 1,
  'Agents did not register its user Bufferline offset')
assert(vim.wo[state.window].winbar == ' Agents ', 'Agents does not have exactly one winbar title')
assert(vim.wo[state.window].winfixwidth and vim.wo[state.window].winfixbuf
    and vim.api.nvim_win_get_width(state.window) == 40,
  'Agents sidebar geometry or fixed-buffer protection is wrong')
local sidebar_position = vim.api.nvim_win_get_position(state.window)
local drawer_position = vim.api.nvim_win_get_position(drawer_window)
assert(sidebar_position[1] == 0 and sidebar_position[2] == 0
    and drawer_position[2] > sidebar_position[2]
    and sidebar_position[1] + vim.api.nvim_win_get_height(state.window)
      >= drawer_position[1] + vim.api.nvim_win_get_height(drawer_window),
  'Agents did not stay full-height beside the bottom drawer')

local q
vim.api.nvim_buf_call(state.buffer, function() q = vim.fn.maparg('q', 'n', false, true) end)
assert(type(q.callback) == 'function', 'Agents q mapping is missing')
vim.fn.maparg('<Plug>(VibenchAgentsHide)', 'n', false, true).callback()
assert(not agents.state().visible and vim.api.nvim_win_is_valid(main_window)
    and vim.api.nvim_win_is_valid(drawer_window), 'Agents Hide action closed an unrelated window')
vim.cmd('VibenchAgents')
assert(vim.wait(1000, function() return agents.state().visible end),
  'Agents did not reopen after q')

vim.api.nvim_set_current_win(main_window)
vim.cmd('topleft 16vsplit')
explorer_window = vim.api.nvim_get_current_win()
picker.layout.root.win = explorer_window
explorer_active = true
vim.api.nvim_exec_autocmds('BufWinEnter', { buffer = vim.api.nvim_get_current_buf() })
assert(vim.wait(1000, function()
  return agents.state().enabled and not agents.state().visible
end), 'Agents did not yield its sidebar slot to Explorer')
explorer_active = false
vim.api.nvim_win_close(explorer_window, true)
explorer_window = nil
assert(vim.wait(1000, function() return agents.state().visible end),
  'Agents did not return after Explorer closed')

q.callback()
vim.api.nvim_set_current_win(main_window)
vim.cmd('topleft 16vsplit')
explorer_window = vim.api.nvim_get_current_win()
picker.layout.root.win = explorer_window
explorer_active = true
vim.cmd('VibenchAgents')
assert(vim.wait(1000, function()
  return not explorer_active and agents.state().visible
end), 'explicit Agents did not replace Explorer')

local last_agents_window = agents.state().window
for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
  if win ~= last_agents_window then vim.api.nvim_win_close(win, true) end
end
assert(#vim.api.nvim_tabpage_list_wins(0) == 1, 'Agents last-window test setup failed')
q.callback()
assert(not agents.state().visible and vim.api.nvim_win_is_valid(last_agents_window)
    and vim.api.nvim_win_get_buf(last_agents_window) ~= agents.state().buffer,
  'Agents claimed to hide while leaving its buffer in the last window')
vim.cmd('VibenchAgents')
assert(vim.wait(1000, function() return agents.state().visible end),
  'Agents did not reopen after hiding from the last window')
local agents_views = 0
for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
  if vim.api.nvim_win_get_buf(win) == agents.state().buffer then agents_views = agents_views + 1 end
end
assert(agents_views == 1, 'Agents duplicated its view after reopening from the last window')

print('agents_headless: PASS')
vim.cmd('qa!')
