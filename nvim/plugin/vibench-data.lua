local session_id = vim.env.VIBENCH_SESSION
if not session_id or session_id == '' then return end

local playhead = require('vibench.playhead')
local timeline = require('vibench.timeline')
local layout = require('vibench.layout')
local M = { steps = {}, skipped_maps = {} }
local owner = {}
local group = vim.api.nvim_create_augroup('VibenchData', { clear = true })
local buffer, window, previous_window, rendered_index, rendered_signature, closed_view

local function valid_win(win)
  return win and vim.api.nvim_win_is_valid(win)
end

local function current_win(win)
  return valid_win(win) and vim.api.nvim_win_get_tabpage(win) == vim.api.nvim_get_current_tabpage()
end

local function valid_buf(buf)
  return buf and vim.api.nvim_buf_is_valid(buf)
end

local function visible()
  return current_win(window) and valid_buf(buffer) and vim.api.nvim_win_get_buf(window) == buffer
end

local function step_at(position)
  local at = 0
  for index, step in ipairs(M.steps) do
    if step.i >= position then break end
    at = index
  end
  return M.steps[at], at
end

local function cell(value)
  if value == nil or value == vim.NIL then return '' end
  if type(value) == 'string' then return (value:gsub('[\r\n]', ' ')) end
  if type(value) == 'table' then return vim.inspect(value, { newline = ' ', indent = '' }) end
  return tostring(value)
end

local function row_text(row, widths)
  local parts = {}
  for column, width in ipairs(widths) do
    local value = cell(type(row) == 'table' and row[column] or nil)
    parts[column] = value .. (column < #widths and string.rep(' ', width - vim.fn.strdisplaywidth(value) + 2) or '')
  end
  return table.concat(parts)
end

local function table_lines(value)
  if type(value) ~= 'table' or type(value.columns) ~= 'table' or #value.columns == 0 then
    return { '(no data)' }
  end
  local rows = type(value.rows) == 'table' and value.rows or {}
  local headers, widths = {}, {}
  for column, name in ipairs(value.columns) do
    headers[column] = cell(name)
    widths[column] = vim.fn.strdisplaywidth(headers[column])
  end
  for _, row in ipairs(rows) do
    for column = 1, #headers do
      widths[column] = math.max(widths[column], vim.fn.strdisplaywidth(cell(type(row) == 'table' and row[column] or nil)))
    end
  end
  local lines = { row_text(headers, widths) }
  local separator = {}
  for column, width in ipairs(widths) do separator[column] = string.rep('-', width) end
  lines[#lines + 1] = row_text(separator, widths)
  for _, row in ipairs(rows) do lines[#lines + 1] = row_text(row, widths) end
  return lines
end

local function signature(step)
  local ok, encoded = pcall(vim.json.encode, step)
  return ok and encoded or tostring(step)
end

local function render(force)
  if not valid_buf(buffer) then return end
  local saved_view
  if visible() then
    local ok, view = pcall(vim.api.nvim_win_call, window, vim.fn.winsaveview)
    if ok then saved_view = view end
  end
  local step, at = step_at(playhead.state().position)
  local encoded = signature(step)
  if not force and rendered_index == at and rendered_signature == encoded then return end
  local lines = {}
  if step then
    if type(step.title) == 'string' and step.title ~= '' then lines[#lines + 1] = step.title end
    if type(step.command) == 'string' and step.command ~= '' then lines[#lines + 1] = '$ ' .. step.command end
    if #lines > 0 then lines[#lines + 1] = '' end
    if step.error ~= nil and step.error ~= vim.NIL then
      lines[#lines + 1] = 'ERROR'
      lines[#lines + 1] = cell(step.error)
    elseif step.pending then
      lines[#lines + 1] = 'IN FLIGHT (waiting for result)'
    else
      vim.list_extend(lines, table_lines(step.table))
    end
  else
    lines = { 'DATA will show here as the playhead reaches it' }
  end
  vim.bo[buffer].readonly, vim.bo[buffer].modifiable = false, true
  vim.api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
  vim.bo[buffer].modifiable, vim.bo[buffer].readonly = false, true
  vim.bo[buffer].modified = false
  rendered_index, rendered_signature = at, encoded
  if saved_view and visible() then
    pcall(vim.api.nvim_win_call, window, function() vim.fn.winrestview(saved_view) end)
  end
end

local function reveal()
  if not visible() then return end
  pcall(vim.api.nvim_win_set_cursor, window, { 1, 0 })
  pcall(vim.api.nvim_win_call, window, function() vim.cmd('normal! zt') end)
end

local function remember_view(win)
  if not valid_win(win) or vim.api.nvim_win_get_buf(win) ~= buffer then return end
  local ok, view = pcall(vim.api.nvim_win_call, win, vim.fn.winsaveview)
  if ok then closed_view = view end
end

local function close_window(restore)
  if not valid_win(window) then window, previous_window = nil, nil return end
  local closing = window
  local focused = vim.api.nvim_get_current_win() == closing
  remember_view(closing)
  window = nil
  pcall(vim.api.nvim_win_close, closing, true)
  if restore and focused and current_win(previous_window) then
    pcall(vim.api.nvim_set_current_win, previous_window)
  end
  previous_window = nil
end

local function hide()
  timeline.disconnect(owner)
  close_window(true)
end

local function ensure_buffer()
  if valid_buf(buffer) then return buffer end
  local created = vim.api.nvim_create_buf(false, true)
  buffer = created
  vim.api.nvim_buf_set_name(created, 'vibench://data/' .. session_id .. '/DATA')
  vim.bo[created].buftype = 'nofile'
  vim.bo[created].bufhidden = 'hide'
  vim.bo[created].swapfile = false
  vim.bo[created].modifiable = false
  vim.bo[created].readonly = true
  vim.bo[created].filetype = 'vibench-data'
  playhead.attach(created)
  playhead.map_if_free(created, 'n', 'q', hide, { silent = true, desc = 'Hide DATA' })
  vim.api.nvim_create_autocmd('WinLeave', {
    group = group,
    buffer = created,
    callback = function() remember_view(vim.api.nvim_get_current_win()) end,
  })
  vim.api.nvim_create_autocmd('BufWipeout', {
    group = group,
    buffer = created,
    callback = function()
      if buffer ~= created then return end
      buffer, rendered_index, rendered_signature = nil, nil, nil
      timeline.disconnect(owner)
    end,
  })
  render(true)
  return created
end

local function show(focus)
  local caller = vim.api.nvim_get_current_win()
  if visible() then
    if focus ~= false then
      pcall(vim.api.nvim_set_current_win, window)
      if playhead.state().watch then reveal() end
    end
    return
  end
  if valid_win(window) then close_window(false) end
  layout.claim_drawer('vibench_data')
  previous_window = vim.api.nvim_get_current_win()
  local scrubber = vim.g.vibench_scrubber
  local scrubber_window = type(scrubber) == 'table' and scrubber.state().window or nil
  local style_window = previous_window
  if style_window == scrubber_window then
    for _, candidate in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
      if candidate ~= scrubber_window and vim.api.nvim_win_get_config(candidate).relative == '' then
        style_window = candidate
        break
      end
    end
  end
  local previous_winhighlight = vim.wo[style_window].winhighlight
  local height = math.max(1, math.floor(tonumber(vim.g.vibench_data_height)
    or tonumber(vim.g.vibench_agentterm_height) or 15))
  if valid_win(scrubber_window)
      and vim.api.nvim_win_get_tabpage(scrubber_window) == vim.api.nvim_get_current_tabpage() then
    vim.api.nvim_set_current_win(scrubber_window)
    vim.cmd(('aboveleft %dsplit'):format(height))
  else
    vim.cmd(('botright %dsplit'):format(height))
  end
  window = vim.api.nvim_get_current_win()
  vim.api.nvim_win_set_buf(window, ensure_buffer())
  vim.wo[window].number, vim.wo[window].relativenumber = false, false
  vim.wo[window].signcolumn, vim.wo[window].foldcolumn = 'no', '0'
  vim.wo[window].wrap, vim.wo[window].cursorline, vim.wo[window].spell = false, true, false
  vim.wo[window].winhighlight = previous_winhighlight
  vim.wo[window].winbar = ' DATA '
  vim.wo[window].winfixbuf = true
  pcall(vim.api.nvim_win_set_height, window, height)
  vim.wo[window].winfixheight = true
  render(true)
  if closed_view then
    pcall(vim.api.nvim_win_call, window, function() vim.fn.winrestview(closed_view) end)
  end
  timeline.connect(owner)
  if focus ~= false and playhead.state().watch then reveal()
  elseif current_win(caller) then pcall(vim.api.nvim_set_current_win, caller) end
end

local function toggle()
  if visible() then hide() else show() end
end

timeline.subscribe(function(state, event)
  M.steps = {}
  for _, step in ipairs(state.steps) do
    if step.category == 'data' and (step.kind == 'data' or step.kind == 'error' and step.action == 'data') then
      M.steps[#M.steps + 1] = step
    end
  end
  render(event.reset)
end)
vim.api.nvim_create_autocmd('User', {
  group = group,
  pattern = 'VibenchPlayheadChanged',
  callback = function() render(false) end,
})
vim.api.nvim_create_autocmd('WinClosed', {
  group = group,
  callback = function(args)
    if window and tonumber(args.match) == window then
      window, previous_window = nil, nil
      timeline.disconnect(owner)
    end
  end,
})

vim.api.nvim_create_user_command('VibenchData', toggle, {})
vim.keymap.set('n', '<Plug>(VibenchDataHide)', hide,
  { silent = true, desc = 'Hide vibench DATA' })
vim.keymap.set('n', '<Plug>(VibenchDataToggle)', toggle,
  { silent = true, desc = 'Toggle vibench DATA' })
if vim.g.vibench_data_default_keymaps ~= false and vim.fn.maparg('<leader>D', 'n') == '' then
  vim.keymap.set('n', '<leader>D', '<Plug>(VibenchDataToggle)',
    { silent = true, remap = true, desc = 'Toggle vibench DATA' })
end

M.show, M.hide, M.toggle, M.reveal = show, hide, toggle, reveal
M.state = function()
  local step, at = step_at(playhead.state().position)
  return {
    buffer = buffer,
    window = current_win(window) and window or nil,
    visible = visible(),
    steps = M.steps,
    step = step,
    index = at,
  }
end
vim.g.vibench_data = M
