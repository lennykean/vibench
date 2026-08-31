local session_id = vim.env.VIBENCH_SESSION
if not session_id or session_id == '' then return end

local playhead = require('vibench.playhead')
local timeline = require('vibench.timeline')
local layout = require('vibench.layout')
local M = {}
local timeline_owner = {}
local ns = vim.api.nvim_create_namespace('vibench-tools')
local group = vim.api.nvim_create_augroup('VibenchTools', { clear = true })
local buffer, window
local rows = {}
local cursor_row
local enabled, pending, focus_pending = true, false, false
local width = math.max(20, math.floor(tonumber(vim.g.vibench_tools_width) or 40))

local function add_bufferline_offset(offsets)
  if type(offsets) ~= 'table' then return end
  for _, offset in ipairs(offsets) do
    if offset.filetype == 'vibench-tools' then return end
  end
  offsets[#offsets + 1] = {
    filetype = 'vibench-tools',
    text = '',
    highlight = 'Directory',
    text_align = 'left',
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

local function valid_win(win)
  return win and vim.api.nvim_win_is_valid(win)
end

local function current_win(win)
  return valid_win(win) and vim.api.nvim_win_get_tabpage(win) == vim.api.nvim_get_current_tabpage()
end

local function valid_buf(buf)
  return buf and vim.api.nvim_buf_is_valid(buf)
end

local function tool_win()
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

local function ordinary_window()
  local terminal = panel_window('vibench_agentterm')
  local scrubber = panel_window('vibench_scrubber')
  local toolinfo = panel_window('vibench_toolinfo')
  local data = panel_window('vibench_data')
  local function ordinary(win)
    return current_win(win) and win ~= window and win ~= terminal and win ~= scrubber and win ~= toolinfo
      and win ~= data and vim.api.nvim_win_get_config(win).relative == ''
      and vim.fn.win_gettype(vim.api.nvim_win_get_number(win)) == ''
  end
  local best, column, area
  for _, candidate in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if ordinary(candidate) then
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

local function compact(value)
  return type(value) == 'string' and value:gsub('%s+', ' '):sub(1, 60) or ''
end

local fallback_tools = {
  terminal = 'Shell', read = 'Read', patch = 'Edit', write = 'Write', other = 'Tool',
}
local categories = {
  terminal = { filetype = 'sh', fallback = '', highlight = 'VibenchToolsTerminal' },
  file = { filetype = 'text', fallback = '󰈙', highlight = 'VibenchToolsFile' },
  tool_info = { filetype = 'config', fallback = '󰒓', highlight = 'VibenchToolsInfo' },
}

local function category_icon(category)
  local spec = categories[category] or categories.tool_info
  local icons = rawget(_G, 'MiniIcons') or package.loaded['mini.icons']
  if type(icons) == 'table' and type(icons.get) == 'function' then
    local ok, icon = pcall(icons.get, 'filetype', spec.filetype)
    if ok and type(icon) == 'string' and icon ~= '' then return icon end
  end
  return spec.fallback
end

local function row_text(step)
  local kind = step.kind == 'error' and step.action or step.kind
  local category = step.category
  local tool = compact(step.tool)
  if tool == '' then tool = fallback_tools[kind] or 'Tool' end
  local title = compact(step.title)
  if title == '' and type(step.path) == 'string' then title = step.path:match('[^/\\]+$') or step.path end
  if title == '' then title = compact(step.command) end
  local icon = category_icon(category)
  local prefix = (' %s %-12s'):format(icon, tool)
  return prefix .. (title == '' and '' or ' ' .. title), category, 1, 1 + #icon
end

local function render()
  if not valid_buf(buffer) then return end
  local saved_view
  if tool_win() and not playhead.state().watch then
    local ok, view = pcall(vim.api.nvim_win_call, window, vim.fn.winsaveview)
    if ok then saved_view = view end
  end
  local steps = timeline.state().steps
  local count = math.min(playhead.state().position, #steps)
  local lines, marks = {}, {}
  rows = {}
  for index = 1, count do
    local step = steps[index]
    if categories[step.category] then
      rows[#rows + 1] = step
      local line, category, icon_start, icon_end = row_text(step)
      lines[#lines + 1] = line
      marks[#marks + 1] = {
        row = #lines - 1, category = category, icon_start = icon_start, icon_end = icon_end,
        pending = step.pending == true, failed = step.kind == 'error' or step.failed == true,
      }
    end
  end
  if #lines == 0 then lines[1] = '' end
  vim.bo[buffer].readonly, vim.bo[buffer].modifiable = false, true
  vim.api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
  vim.bo[buffer].modifiable, vim.bo[buffer].readonly = false, true
  vim.bo[buffer].modified = false
  vim.api.nvim_buf_clear_namespace(buffer, ns, 0, -1)
  if #rows > 0 then
    vim.api.nvim_buf_set_extmark(buffer, ns, #rows - 1, 0,
      { line_hl_group = 'VibenchToolsCurrent', priority = 10 })
  end
  for _, mark in ipairs(marks) do
    if mark.pending or mark.failed then
      vim.api.nvim_buf_set_extmark(buffer, ns, mark.row, 0, {
        line_hl_group = mark.failed and 'VibenchToolsFailed' or 'VibenchToolsPending', priority = 20,
      })
    else
      vim.api.nvim_buf_set_extmark(buffer, ns, mark.row, mark.icon_start, {
        end_col = mark.icon_end, hl_group = categories[mark.category].highlight, priority = 20,
      })
    end
  end
  if saved_view and tool_win() then
    pcall(vim.api.nvim_win_call, window, function() vim.fn.winrestview(saved_view) end)
  elseif tool_win() and #rows > 0 then
    pcall(vim.api.nvim_win_set_cursor, window, { #rows, 0 })
    vim.api.nvim_win_call(window, function() vim.cmd('normal! zb') end)
  end
  if tool_win() then cursor_row = vim.api.nvim_win_get_cursor(window)[1] end
end

local function close_window()
  if not valid_win(window) then window = nil return end
  local closing = window
  window = nil
  pcall(vim.api.nvim_win_close, closing, true)
  refresh_bufferline()
end

local function hide()
  enabled, focus_pending = false, false
  timeline.disconnect(timeline_owner)
  close_window()
end

local function jump(step)
  if step then playhead.seek(step.i + 1, false) end
end

local function jump_cursor()
  if not tool_win() then return end
  jump(rows[vim.api.nvim_win_get_cursor(window)[1]])
end

local function jump_to_row(row)
  if not tool_win() or not rows[row] then return end
  cursor_row = row
  vim.api.nvim_win_set_cursor(window, { row, 0 })
  jump(rows[row])
end

local function home() jump_to_row(1) end
local function finish() jump_to_row(#rows) end

local function ensure_buffer()
  if valid_buf(buffer) then return buffer end
  local created = vim.api.nvim_create_buf(false, true)
  buffer = created
  vim.api.nvim_buf_set_name(created, 'vibench://tools/' .. session_id .. '/Tool Calls')
  vim.bo[created].buftype = 'nofile'
  vim.bo[created].bufhidden = 'hide'
  vim.bo[created].swapfile = false
  vim.bo[created].modifiable = false
  vim.bo[created].readonly = true
  vim.bo[created].filetype = 'vibench-tools'
  playhead.map_if_free(created, 'n', '<CR>', jump_cursor,
    { silent = true, desc = 'Jump to tool call' })
  playhead.map_if_free(created, 'n', '<Home>', home, { silent = true, desc = 'First tool call' })
  playhead.map_if_free(created, 'n', '<End>', finish, { silent = true, desc = 'Last tool call' })
  playhead.map_if_free(created, 'n', 'q', hide, { silent = true, desc = 'Hide tool calls' })
  playhead.map_if_free(created, 'n', '<LeftMouse>', function()
    local mouse = vim.fn.getmousepos()
    local step = mouse.winid == window and rows[mouse.line] or nil
    if not step then return '<LeftMouse>' end
    vim.schedule(function() jump(step) end)
    return '<Ignore>'
  end, { expr = true, silent = true, replace_keycodes = true })
  vim.api.nvim_create_autocmd('BufWipeout', {
    group = group,
    buffer = created,
    callback = function() if buffer == created then buffer, rows = nil, {} end end,
  })
  vim.api.nvim_create_autocmd('CursorMoved', {
    group = group,
    buffer = created,
    callback = function()
      if not tool_win() or vim.api.nvim_get_current_win() ~= window then return end
      local row = vim.api.nvim_win_get_cursor(window)[1]
      if row == cursor_row then return end
      cursor_row = row
      jump_cursor()
    end,
  })
  render()
  return created
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
  vim.wo[opened].winbar = ' Tool Calls '
  pcall(vim.api.nvim_win_set_width, opened, width)
  refresh_bufferline()
  render()
  if focus_pending then
    focus_pending = false
    pcall(vim.api.nvim_set_current_win, opened)
  end
end

local function pin_sidebar()
  if not tool_win() then return end
  layout.pin_sidebar(window, width)
  local bar = vim.g.vibench_scrubber
  if type(bar) == 'table' and type(bar.pin) == 'function' then bar.pin() end
  layout.pin_drawer()
end

local function reconcile()
  pending = false
  if not enabled then close_window() return end
  if explorer() then close_window() return end
  if valid_win(window) and not current_win(window) then close_window() end
  if current_win(window) then
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
    pin_sidebar()
  end
end

local function schedule_reconcile()
  if pending then return end
  pending = true
  vim.schedule(reconcile)
end

local function show(focus)
  enabled, focus_pending = true, focus ~= false
  timeline.connect(timeline_owner)
  local agents = vim.g.vibench_agents
  if type(agents) == 'table' and type(agents.hide) == 'function' then agents.hide() end
  local picker = explorer()
  if picker and type(picker.close) == 'function' then pcall(picker.close, picker) end
  schedule_reconcile()
end

local function toggle()
  if tool_win() then hide() else show(true) end
end

local function set_highlights()
  vim.api.nvim_set_hl(0, 'VibenchToolsCurrent', { default = true, link = 'Visual' })
  vim.api.nvim_set_hl(0, 'VibenchToolsFile', { default = true, link = 'DiagnosticInfo' })
  vim.api.nvim_set_hl(0, 'VibenchToolsTerminal', { default = true, link = 'DiagnosticOk' })
  vim.api.nvim_set_hl(0, 'VibenchToolsInfo', { default = true, link = 'Identifier' })
  vim.api.nvim_set_hl(0, 'VibenchToolsPending', { default = true, link = 'Comment' })
  vim.api.nvim_set_hl(0, 'VibenchToolsFailed', { default = true, link = 'DiagnosticError' })
end
set_highlights()

timeline.subscribe(function() render() end)
vim.api.nvim_create_autocmd('User', {
  group = group,
  pattern = 'VibenchPlayheadChanged',
  callback = render,
})
vim.api.nvim_create_autocmd('ColorScheme', {
  group = group,
  callback = function()
    set_highlights()
    vim.schedule(refresh_bufferline)
  end,
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
vim.api.nvim_create_user_command('VibenchTools', toggle, {})
vim.keymap.set('n', '<Plug>(VibenchToolsSelect)', jump_cursor,
  { silent = true, desc = 'Select Tool Calls row' })
vim.keymap.set('n', '<Plug>(VibenchToolsHome)', home,
  { silent = true, desc = 'First Tool Calls row' })
vim.keymap.set('n', '<Plug>(VibenchToolsEnd)', finish,
  { silent = true, desc = 'Last Tool Calls row' })
vim.keymap.set('n', '<Plug>(VibenchToolsHide)', hide,
  { silent = true, desc = 'Hide vibench tool calls' })
vim.keymap.set('n', '<Plug>(VibenchToolsToggle)', toggle,
  { silent = true, desc = 'Toggle vibench tool calls' })
if vim.g.vibench_tools_default_keymaps ~= false and vim.fn.maparg('<leader>t', 'n') == '' then
  vim.keymap.set('n', '<leader>t', '<Plug>(VibenchToolsToggle)',
    { silent = true, remap = true, desc = 'Toggle vibench tool calls' })
end

M.show, M.hide, M.toggle, M.reconcile = function() show(true) end, hide, toggle, reconcile
M.state = function()
  return {
    buffer = buffer,
    window = tool_win() and window or nil,
    visible = tool_win(),
    enabled = enabled,
    rows = rows,
  }
end
vim.g.vibench_tools = M

timeline.connect(timeline_owner)
vim.schedule(refresh_bufferline)
if vim.v.vim_did_enter == 1 then schedule_reconcile()
else vim.api.nvim_create_autocmd('VimEnter', { group = group, once = true, callback = schedule_reconcile }) end
