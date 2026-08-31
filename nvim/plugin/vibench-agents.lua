local session_id = vim.env.VIBENCH_SESSION
if not session_id or session_id == '' then return end

local curl = require('vibench.curl')
local layout = require('vibench.layout')
local playhead = require('vibench.playhead')
local session = require('vibench.session')
local timeline = require('vibench.timeline')
local M = {}
local group = vim.api.nvim_create_augroup('VibenchAgents', { clear = true })
local buffer, window
local roots, rows = {}, {}
local selected = timeline.target()
local enabled, pending, focus_pending, fetching = false, false, false, false
local refresh_generation, selection_generation = 0, 0
local width = math.max(20, math.floor(tonumber(vim.g.vibench_agents_width) or 40))
local refresh_ms = math.max(250, math.floor(tonumber(vim.g.vibench_agents_refresh_ms) or 1000))

local function valid_win(win)
  return win and vim.api.nvim_win_is_valid(win)
end

local function current_win(win)
  return valid_win(win) and vim.api.nvim_win_get_tabpage(win) == vim.api.nvim_get_current_tabpage()
end

local function valid_buf(buf)
  return buf and vim.api.nvim_buf_is_valid(buf)
end

local function agents_win()
  return current_win(window) and valid_buf(buffer) and vim.api.nvim_win_get_buf(window) == buffer
end

local function panel_window(name)
  local panel = vim.g[name]
  if type(panel) ~= 'table' or type(panel.state) ~= 'function' then return nil end
  local ok, state = pcall(panel.state)
  return ok and state.window or nil
end

local function explorer()
  local snacks = rawget(_G, 'Snacks')
  if type(snacks) ~= 'table' or type(snacks.picker) ~= 'table'
      or type(snacks.picker.get) ~= 'function' then return nil end
  local ok, pickers = pcall(snacks.picker.get, { source = 'explorer' })
  if not ok or type(pickers) ~= 'table' then return nil end
  for _, picker in ipairs(pickers) do
    local root = picker.layout and picker.layout.root and picker.layout.root.win
    if current_win(root) then return picker end
  end
end

local function add_bufferline_offset(offsets)
  if type(offsets) ~= 'table' then return end
  for _, offset in ipairs(offsets) do
    if offset.filetype == 'vibench-agents' then return end
  end
  offsets[#offsets + 1] = {
    filetype = 'vibench-agents', text = '', highlight = 'Directory', text_align = 'left',
  }
end

local function refresh_bufferline()
  local config = package.loaded['bufferline.config']
  if type(config) ~= 'table' or type(config.get) ~= 'function' then return end
  local current = config.get()
  if type(current) ~= 'table' then return end
  current.options = current.options or {}
  current.options.offsets = current.options.offsets or {}
  add_bufferline_offset(current.options.offsets)
  if type(current.user) == 'table' then
    current.user.options = current.user.options or {}
    current.user.options.offsets = current.user.options.offsets
      or vim.deepcopy(current.options.offsets)
    add_bufferline_offset(current.user.options.offsets)
  end
  vim.cmd('redrawtabline')
end

local function compact(value, fallback)
  if type(value) ~= 'string' or value == '' then return fallback or '' end
  return value:gsub('%s+', ' '):sub(1, 60)
end

local function selected_agent(agent)
  return selected and agent.kind == selected.kind and agent.id == selected.id
    and (agent.root_id or agent.id) == selected.root_id
end

local function marker(agent)
  return selected_agent(agent) and '▸ ' or '  '
end

local function child_lines(root, lines)
  local children, ids, by_parent, seen = root.children or {}, {}, {}, {}
  for _, child in ipairs(children) do ids[child.id] = true end
  for _, child in ipairs(children) do
    local parent = ids[child.parent_agent_id] and child.parent_agent_id or root.id
    by_parent[parent] = by_parent[parent] or {}
    by_parent[parent][#by_parent[parent] + 1] = child
  end
  local function available(child, parent)
    local state = playhead.state()
    if not selected or selected.root_id ~= root.id or state.follow then return true end
    if selected.id == parent then
      local spawn = tonumber(child.spawn_position)
      if spawn then return state.position >= spawn end
      return state.total > 0 and state.position >= state.total
    end
    local step = timeline.state().steps[state.position]
    local current_at = timeline.timestamp(step and step.at)
    local spawned_at = timeline.timestamp(child.spawned_at or child.started_at)
    if current_at and spawned_at then return current_at >= spawned_at end
    return state.total > 0 and state.position >= state.total
  end
  local function walk(parent, prefix)
    local siblings = {}
    for _, child in ipairs(by_parent[parent] or {}) do
      if available(child, parent) then siblings[#siblings + 1] = child end
    end
    for index, child in ipairs(siblings) do
      if not seen[child.id] then
        seen[child.id] = true
        local last = index == #siblings
        local status = compact(child.status, child.live and 'live' or 'done'):gsub('_', ' ')
        lines[#lines + 1] = ('%s%s%s %s %s  %s'):format(
          marker(child), prefix, last and '└─' or '├─', child.live and '●' or '○',
          status, compact(child.name, child.id))
        rows[#rows + 1] = child
        walk(child.id, prefix .. (last and '   ' or '│  '))
      end
    end
  end
  walk(root.id, '  ')
  for _, child in ipairs(children) do
    local parent = ids[child.parent_agent_id] and child.parent_agent_id or root.id
    if not seen[child.id] and not ids[child.parent_agent_id] and available(child, parent) then
      local status = compact(child.status, child.live and 'live' or 'done'):gsub('_', ' ')
      lines[#lines + 1] = ('%s  └─ %s %s  %s'):format(
        marker(child), child.live and '●' or '○', status, compact(child.name, child.id))
      rows[#rows + 1] = child
    end
  end
end

local function render()
  if not valid_buf(buffer) then return end
  local lines = {}
  rows = {}
  for _, root in ipairs(roots) do
    if root.live then
      lines[#lines + 1] = ('%s● live  %s'):format(marker(root), compact(root.name, 'Unnamed bench'))
      rows[#rows + 1] = root
      child_lines(root, lines)
    end
  end
  if #lines == 0 then lines[1] = ' No live agents' end
  vim.bo[buffer].readonly, vim.bo[buffer].modifiable = false, true
  vim.api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
  vim.bo[buffer].modifiable, vim.bo[buffer].readonly = false, true
  vim.bo[buffer].modified = false
end

local function focus_root(root)
  local pane = type(root.tmux) == 'table' and root.tmux.nvim or nil
  if root.id == session_id or type(pane) ~= 'table'
      or type(pane.session) ~= 'string' or pane.session == ''
      or type(pane.window_id) ~= 'string' or pane.window_id == ''
      or type(pane.pane_id) ~= 'string' or pane.pane_id == '' then return end
  local command = { 'tmux' }
  if type(root.tmux.socket) == 'string' and root.tmux.socket ~= '' then
    vim.list_extend(command, { '-L', root.tmux.socket })
  end
  local function output(args)
    local full = vim.list_extend(vim.deepcopy(command), args)
    local ok, result = pcall(function() return vim.system(full, { text = true, timeout = 2000 }):wait() end)
    return ok and type(result) == 'table' and result.code == 0 and vim.trim(result.stdout or '') or nil
  end
  local identity = output({
    'display-message', '-p', '-t', pane.pane_id,
    '#{session_name}\t#{window_id}\t#{pane_id}',
  })
  if identity ~= table.concat({ pane.session, pane.window_id, pane.pane_id }, '\t') then return end
  local key = session.window_owner_key(pane.window_id)
  if output({ 'show-environment', '-t', '=' .. pane.session, key }) ~= key .. '=' .. root.id then return end
  vim.list_extend(command, { 'select-window', '-t', pane.window_id })
  pcall(vim.system, command, { text = true })
end

local function root_for(agent)
  local id = agent.kind == 'root' and agent.id or agent.root_id
  for _, root in ipairs(roots) do
    if root.id == id then return root end
  end
end

local function select_remote(agent, done)
  local server = timeline.server_info()
  local route = agent.kind == 'root'
      and ('/agents/root/%s/select'):format(agent.id)
    or ('/agents/child/%s/%s/select'):format(agent.root_id, agent.id)
  local command = server and server.token and curl.command(server.token, {
    '--silent', '--show-error', '--fail', '--max-time', '8', '--request', 'POST',
    server.base .. route,
  }) or nil
  if not command then return done(false) end
  local launched = pcall(vim.system, command, { text = true }, function(result)
    vim.schedule(function() done(result.code == 0) end)
  end)
  if not launched then done(false) end
end

local function select_line(line)
  local agent = rows[line]
  if not agent then return end
  local previous = selected
  selection_generation = selection_generation + 1
  local request = selection_generation
  if agent.root_id ~= session_id then
    select_remote(agent, function(ok)
      if request ~= selection_generation then return end
      if ok then
        focus_root(root_for(agent))
        selected = agent
        render()
      else
        vim.notify('Vibench: destination bench did not acknowledge selection', vim.log.levels.WARN)
      end
    end)
    return
  end
  selected = agent
  render()
  if agent.kind == 'root' then
    timeline.select_agent(agent)
  else
    local returning = previous and previous.kind == 'child'
      and previous.parent_agent_id == agent.id and previous.root_id == agent.root_id
    timeline.select_agent(agent, not returning and timeline.selection_landing() or nil)
  end
end

local function select_cursor()
  if agents_win() then select_line(vim.api.nvim_win_get_cursor(window)[1]) end
end

local function close_window()
  if not valid_win(window) then window = nil return end
  local closing = window
  window = nil
  if #vim.api.nvim_tabpage_list_wins(vim.api.nvim_win_get_tabpage(closing)) == 1 then
    vim.wo[closing].winfixbuf, vim.wo[closing].winfixwidth = false, false
    vim.wo[closing].winbar, vim.wo[closing].cursorline = '', false
    vim.api.nvim_win_set_buf(closing, vim.api.nvim_create_buf(true, false))
  else
    pcall(vim.api.nvim_win_close, closing, true)
  end
  refresh_bufferline()
end

local function hide()
  enabled, focus_pending = false, false
  refresh_generation = refresh_generation + 1
  close_window()
end

local function ensure_buffer()
  if valid_buf(buffer) then return buffer end
  local created = vim.api.nvim_create_buf(false, true)
  buffer = created
  vim.api.nvim_buf_set_name(created, 'vibench://agents/' .. session_id .. '/Agents')
  vim.bo[created].buftype = 'nofile'
  vim.bo[created].bufhidden = 'hide'
  vim.bo[created].swapfile = false
  vim.bo[created].modifiable = false
  vim.bo[created].readonly = true
  vim.bo[created].filetype = 'vibench-agents'
  playhead.map_if_free(created, 'n', '<CR>', select_cursor,
    { silent = true, desc = 'Select agent' })
  playhead.map_if_free(created, 'n', 'q', hide, { silent = true, desc = 'Hide agents' })
  playhead.map_if_free(created, 'n', '<LeftMouse>', function()
    local mouse = vim.fn.getmousepos()
    if mouse.winid ~= window or not rows[mouse.line] then return '<LeftMouse>' end
    vim.schedule(function() select_line(mouse.line) end)
    return '<Ignore>'
  end, { expr = true, silent = true, replace_keycodes = true })
  vim.api.nvim_create_autocmd('BufWipeout', {
    group = group,
    buffer = created,
    callback = function() if buffer == created then buffer, rows = nil, {} end end,
  })
  render()
  return created
end

local function ordinary_window()
  local terminal = panel_window('vibench_agentterm')
  local scrubber = panel_window('vibench_scrubber')
  local toolinfo = panel_window('vibench_toolinfo')
  local data = panel_window('vibench_data')
  local tools = panel_window('vibench_tools')
  local best, column, area
  for _, candidate in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if current_win(candidate) and candidate ~= window and candidate ~= terminal
        and candidate ~= scrubber and candidate ~= toolinfo and candidate ~= data and candidate ~= tools
        and vim.api.nvim_win_get_config(candidate).relative == ''
        and vim.fn.win_gettype(vim.api.nvim_win_get_number(candidate)) == '' then
      local candidate_column = vim.api.nvim_win_get_position(candidate)[2]
      local candidate_area = vim.api.nvim_win_get_width(candidate) * vim.api.nvim_win_get_height(candidate)
      if not column or candidate_column < column
          or candidate_column == column and candidate_area > area then
        best, column, area = candidate, candidate_column, candidate_area
      end
    end
  end
  return best
end

local function pin_sidebar()
  if not agents_win() then return end
  layout.pin_sidebar(window, width)
  local bar = vim.g.vibench_scrubber
  if type(bar) == 'table' and type(bar.pin) == 'function' then bar.pin() end
  layout.pin_drawer()
end

local refresh
local function schedule_refresh(generation)
  vim.defer_fn(function()
    if generation == refresh_generation and agents_win() then refresh() end
  end, refresh_ms)
end

refresh = function()
  if fetching or not agents_win() then return end
  local generation = refresh_generation
  local server = timeline.server_info()
  if not server or not server.token then schedule_refresh(generation) return end
  local command = curl.command(server.token, {
    '--silent', '--show-error', '--fail', '--max-time', '2', server.base .. '/agents',
  })
  if not command then schedule_refresh(generation) return end
  fetching = true
  local launched = pcall(vim.system, command, { text = true }, function(result)
    vim.schedule(function()
      fetching = false
      if generation ~= refresh_generation then
        if agents_win() then refresh() end
        return
      end
      if not agents_win() then return end
      if result.code == 0 and result.stdout and result.stdout ~= '' then
        local ok, payload = pcall(vim.json.decode, result.stdout)
        if ok and type(payload) == 'table' and type(payload.roots) == 'table' then
          roots = payload.roots
          render()
        end
      end
      schedule_refresh(generation)
    end)
  end)
  if not launched then
    fetching = false
    schedule_refresh(generation)
  end
end

local function open_window()
  local anchor = ordinary_window()
  if not anchor then return end
  local ok, opened = pcall(vim.api.nvim_open_win, ensure_buffer(), false,
    { split = 'left', win = anchor, width = width })
  if not ok then return end
  window = opened
  vim.wo[opened].number, vim.wo[opened].relativenumber = false, false
  vim.wo[opened].signcolumn, vim.wo[opened].foldcolumn = 'no', '0'
  vim.wo[opened].wrap, vim.wo[opened].spell = false, false
  vim.wo[opened].cursorline, vim.wo[opened].winfixwidth = true, true
  vim.wo[opened].winfixbuf = true
  vim.wo[opened].winbar = ' Agents '
  pcall(vim.api.nvim_win_set_width, opened, width)
  refresh_bufferline()
  render()
  pin_sidebar()
  refresh_generation = refresh_generation + 1
  refresh()
  if focus_pending then
    focus_pending = false
    pcall(vim.api.nvim_set_current_win, opened)
  end
end

local function reconcile()
  pending = false
  if not enabled then close_window() return end
  if explorer() then close_window() return end
  if valid_win(window) and not current_win(window) then close_window() end
  if agents_win() then
    local view = ensure_buffer()
    if vim.api.nvim_win_get_buf(window) ~= view then vim.api.nvim_win_set_buf(window, view) end
    render()
    pin_sidebar()
    if focus_pending then
      focus_pending = false
      pcall(vim.api.nvim_set_current_win, window)
    end
  else
    open_window()
  end
end

local function schedule_reconcile()
  if pending then return end
  pending = true
  vim.schedule(reconcile)
end

local function show(focus)
  enabled, focus_pending = true, focus ~= false
  local tools = vim.g.vibench_tools
  if type(tools) == 'table' and type(tools.hide) == 'function' then tools.hide() end
  local picker = explorer()
  if picker and type(picker.close) == 'function' then pcall(picker.close, picker) end
  schedule_reconcile()
end

local function toggle()
  if agents_win() then hide() else show(true) end
end

vim.api.nvim_create_autocmd('ColorScheme', {
  group = group,
  callback = function() vim.schedule(refresh_bufferline) end,
})
vim.api.nvim_create_autocmd('User', {
  group = group,
  pattern = { 'LazyLoad', 'VeryLazy' },
  callback = function() vim.schedule(refresh_bufferline) end,
})
vim.api.nvim_create_autocmd({ 'WinNew', 'WinClosed', 'BufWinEnter', 'TabEnter' }, {
  group = group,
  callback = schedule_reconcile,
})
vim.api.nvim_create_autocmd('User', {
  group = group,
  pattern = 'VibenchPlayheadChanged',
  callback = render,
})
timeline.subscribe(function(_, event)
  if event.agent then
    selected = timeline.target()
    render()
  end
end)
vim.api.nvim_create_user_command('VibenchAgents', toggle, {})
vim.keymap.set('n', '<Plug>(VibenchAgentsSelect)', select_cursor,
  { silent = true, desc = 'Select vibench agent' })
vim.keymap.set('n', '<Plug>(VibenchAgentsHide)', hide,
  { silent = true, desc = 'Hide vibench agents' })
vim.keymap.set('n', '<Plug>(VibenchAgentsToggle)', toggle,
  { silent = true, desc = 'Toggle vibench agents' })
if vim.g.vibench_agents_default_keymaps ~= false and vim.fn.maparg('<leader>A', 'n') == '' then
  vim.keymap.set('n', '<leader>A', '<Plug>(VibenchAgentsToggle)',
    { silent = true, remap = true, desc = 'Toggle vibench agents' })
end

M.show, M.hide, M.toggle, M.reconcile = function() show(true) end, hide, toggle, reconcile
M.state = function()
  return {
    buffer = buffer,
    window = agents_win() and window or nil,
    visible = agents_win(),
    enabled = enabled,
    roots = roots,
    rows = rows,
    selected = selected,
  }
end
vim.g.vibench_agents = M
vim.schedule(refresh_bufferline)
