local session_id = vim.env.VIBENCH_SESSION
if not session_id or session_id == '' then return end

local playhead = require('vibench.playhead')
local timeline = require('vibench.timeline')
local layout = require('vibench.layout')
local M = { steps = {}, skipped_maps = {} }
local timeline_owner = {}
local ns = vim.api.nvim_create_namespace('vibench-toolinfo')
local group = vim.api.nvim_create_augroup('VibenchToolInfo', { clear = true })
local buffer, window, previous_window, rendered_index, rendered_signature, closed_view
local icons = { first = '', previous = '', next = '', last = '' }

local function valid_win(win)
  return win and vim.api.nvim_win_is_valid(win)
end

local function valid_buf(buf)
  return buf and vim.api.nvim_buf_is_valid(buf)
end

local function current_win(win)
  return valid_win(win) and vim.api.nvim_win_get_tabpage(win) == vim.api.nvim_get_current_tabpage()
end

local function visible()
  return current_win(window) and valid_buf(buffer) and vim.api.nvim_win_get_buf(window) == buffer
end

local function call_at(position)
  local at = 0
  for index, step in ipairs(M.steps) do
    if step.i >= position then break end
    at = index
  end
  return M.steps[at], at
end

local function seek(index)
  local step = M.steps[index]
  if step then playhead.seek(step.i + 1, false) end
end

local function home() seek(1) end
local function previous()
  local _, at = call_at(playhead.state().position)
  if at > 1 then seek(at - 1) end
end
local function next_call()
  local _, at = call_at(playhead.state().position)
  if at < #M.steps then seek(at + 1) end
end
local function finish() seek(#M.steps) end

local function update_bar()
  if not visible() then return end
  local _, at = call_at(playhead.state().position)
  vim.wo[window].winbar = '%#VibenchToolInfoBar# Tool Info '
    .. '%1@v:lua.VibenchToolInfoWinbar@ ' .. icons.first .. ' %T'
    .. '%2@v:lua.VibenchToolInfoWinbar@ ' .. icons.previous .. ' %T'
    .. (' %d/%d '):format(at, #M.steps)
    .. '%3@v:lua.VibenchToolInfoWinbar@ ' .. icons.next .. ' %T'
    .. '%4@v:lua.VibenchToolInfoWinbar@ ' .. icons.last .. ' %T'
end

local function text_lines(value)
  local text = type(value) == 'string' and value:gsub('\r\n', '\n'):gsub('\r', '\n') or ''
  local lines = vim.split(text, '\n', { plain = true })
  if #lines > 1 and lines[#lines] == '' then table.remove(lines) end
  return #lines > 0 and lines or { '' }
end

local function value_lines(value)
  if value == vim.NIL then return { 'null' } end
  if type(value) == 'string' then
    if value == '' then return { '(empty)' } end
    local trimmed = value:match('^%s*(.-)%s*$')
    if trimmed:match('^[%[{]') then
      local ok, decoded = pcall(vim.json.decode, trimmed)
      if ok and type(decoded) == 'table' then return text_lines(vim.inspect(decoded)) end
    end
    return text_lines(value)
  end
  return text_lines(vim.inspect(value))
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
  local step, at = call_at(playhead.state().position)
  local encoded = signature(step)
  if not force and rendered_index == at and rendered_signature == encoded then
    update_bar()
    return
  end
  local lines, labels, pending_line = {}, {}, nil
  if step then
    local title = type(step.title) == 'string' and step.title or ''
    local header = (type(step.tool) == 'string' and step.tool or 'Tool')
      .. (title == '' and '' or '  ' .. title)
      .. (step.kind == 'error' and '  ERROR' or '')
    lines[#lines + 1] = header
    lines[#lines + 1] = ''
    lines[#lines + 1] = 'PARAMS'
    labels[#labels + 1] = #lines
    local params = step.params
    if params == nil then params = {} end
    vim.list_extend(lines, value_lines(params))
    local response = step.kind == 'error' and step.error or step.response
    if response == nil then response = step.response or step.result end
    if step.pending then
      lines[#lines + 1] = ''
      lines[#lines + 1] = 'IN FLIGHT (waiting for result)'
      pending_line = #lines
    elseif response ~= nil then
      lines[#lines + 1] = ''
      lines[#lines + 1] = step.kind == 'error' and 'ERROR' or 'RESULT'
      labels[#labels + 1] = #lines
      vim.list_extend(lines, value_lines(response))
    end
  else
    lines = { 'Tool Info will show here as the playhead reaches it' }
  end
  vim.bo[buffer].readonly, vim.bo[buffer].modifiable = false, true
  vim.api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
  vim.bo[buffer].modifiable, vim.bo[buffer].readonly = false, true
  vim.bo[buffer].modified = false
  vim.api.nvim_buf_clear_namespace(buffer, ns, 0, -1)
  if step then
    vim.api.nvim_buf_set_extmark(buffer, ns, 0, 0, {
      end_col = #lines[1],
      hl_group = step.kind == 'error' and 'VibenchToolInfoError' or 'VibenchToolInfoTool',
    })
    for _, line in ipairs(labels) do
      vim.api.nvim_buf_set_extmark(buffer, ns, line - 1, 0,
        { end_col = #lines[line], hl_group = 'VibenchToolInfoLabel' })
    end
    if pending_line then
      vim.api.nvim_buf_set_extmark(buffer, ns, pending_line - 1, 0,
        { end_col = #lines[pending_line], hl_group = 'VibenchToolInfoPending' })
    end
  end
  rendered_index, rendered_signature = at, encoded
  update_bar()
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
  timeline.disconnect(timeline_owner)
  close_window(true)
end

local function ensure_buffer()
  if valid_buf(buffer) then return buffer end
  local created = vim.api.nvim_create_buf(false, true)
  buffer = created
  vim.api.nvim_buf_set_name(created, 'vibench://tool-info/' .. session_id .. '/Tool Info')
  vim.bo[created].buftype = 'nofile'
  vim.bo[created].bufhidden = 'hide'
  vim.bo[created].swapfile = false
  vim.bo[created].modifiable = false
  vim.bo[created].readonly = true
  vim.bo[created].filetype = 'vibench-toolinfo'
  playhead.attach(created, { prev = previous, next = next_call, home = home, ['end'] = finish })
  playhead.map_if_free(created, 'n', '<Left>', previous, { silent = true })
  playhead.map_if_free(created, 'n', '<Right>', next_call, { silent = true })
  playhead.map_if_free(created, 'n', 'q', hide, { silent = true, desc = 'Hide Tool Info' })
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
      timeline.disconnect(timeline_owner)
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
  if valid_win(window) and not current_win(window) then close_window(false) end
  layout.claim_drawer('vibench_toolinfo')
  if current_win(window) then
    local caller = vim.api.nvim_get_current_win()
    if caller ~= window then previous_window = caller end
    vim.api.nvim_win_set_buf(window, ensure_buffer())
    if focus ~= false then pcall(vim.api.nvim_set_current_win, window) end
    render(true)
    if closed_view then
      pcall(vim.api.nvim_win_call, window, function() vim.fn.winrestview(closed_view) end)
    end
    if focus ~= false and playhead.state().watch then reveal() end
    timeline.connect(timeline_owner)
    return
  end
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
  local height = math.max(1, math.floor(tonumber(vim.g.vibench_toolinfo_height)
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
  vim.wo[window].wrap, vim.wo[window].spell = true, false
  vim.wo[window].winhighlight = previous_winhighlight
  vim.wo[window].winfixbuf = true
  pcall(vim.api.nvim_win_set_height, window, height)
  vim.wo[window].winfixheight = true
  render(true)
  if closed_view then
    pcall(vim.api.nvim_win_call, window, function() vim.fn.winrestview(closed_view) end)
  end
  timeline.connect(timeline_owner)
  if focus ~= false and playhead.state().watch then reveal()
  elseif current_win(caller) then pcall(vim.api.nvim_set_current_win, caller) end
end

local function toggle()
  if visible() then hide() else show() end
end

local function sync_timeline(state, event)
  M.steps = {}
  for _, step in ipairs(state.steps) do
    if step.category == 'tool_info' then M.steps[#M.steps + 1] = step end
  end
  render(event.reset)
end

local function set_highlights()
  vim.api.nvim_set_hl(0, 'VibenchToolInfoBar', { default = true, link = 'WinBar' })
  vim.api.nvim_set_hl(0, 'VibenchToolInfoTool', { default = true, link = 'Title' })
  vim.api.nvim_set_hl(0, 'VibenchToolInfoLabel', { default = true, link = 'Comment' })
  vim.api.nvim_set_hl(0, 'VibenchToolInfoPending', { default = true, link = 'DiagnosticInfo' })
  vim.api.nvim_set_hl(0, 'VibenchToolInfoError', { default = true, link = 'DiagnosticError' })
end
set_highlights()

timeline.subscribe(sync_timeline)
vim.api.nvim_create_autocmd('User', {
  group = group,
  pattern = 'VibenchPlayheadChanged',
  callback = function() render(false) end,
})
vim.api.nvim_create_autocmd('ColorScheme', { group = group, callback = set_highlights })
vim.api.nvim_create_autocmd('WinClosed', {
  group = group,
  callback = function(args)
    if window and tonumber(args.match) == window then
      window, previous_window = nil, nil
      timeline.disconnect(timeline_owner)
    end
  end,
})

_G.VibenchToolInfoWinbar = function(minwid, _, button)
  if button and button ~= 'l' then return end
  local action = ({ home, previous, next_call, finish })[tonumber(minwid)]
  if action then action() end
end

vim.keymap.set('n', '<Plug>(VibenchToolInfoToggle)', toggle,
  { silent = true, desc = 'Toggle vibench Tool Info' })
vim.keymap.set('n', '<Plug>(VibenchToolInfoHome)', home,
  { silent = true, desc = 'First Tool Info step' })
vim.keymap.set('n', '<Plug>(VibenchToolInfoPrev)', previous,
  { silent = true, desc = 'Previous Tool Info step' })
vim.keymap.set('n', '<Plug>(VibenchToolInfoNext)', next_call,
  { silent = true, desc = 'Next Tool Info step' })
vim.keymap.set('n', '<Plug>(VibenchToolInfoEnd)', finish,
  { silent = true, desc = 'Last Tool Info step' })
vim.keymap.set('n', '<Plug>(VibenchToolInfoHide)', hide,
  { silent = true, desc = 'Hide vibench Tool Info' })
vim.api.nvim_create_user_command('VibenchToolInfo', toggle, {})
M.show, M.hide, M.toggle, M.reveal = show, hide, toggle, reveal
M.state = function()
  local step, at = call_at(playhead.state().position)
  return {
    buffer = buffer,
    window = current_win(window) and window or nil,
    visible = visible(),
    steps = M.steps,
    step = step,
    index = at,
  }
end
vim.g.vibench_toolinfo = M

local configured = vim.g.vibench_toolinfo_keymaps or {}
local toggles = configured.toggle
if toggles == nil then toggles = { '<M-I>', '<leader>i' } end
if type(toggles) == 'string' then toggles = { toggles } end
if vim.g.vibench_toolinfo_default_keymaps ~= false and type(toggles) == 'table' then
  for _, lhs in ipairs(toggles) do
    if vim.fn.maparg(lhs, 'n') == '' then
      vim.keymap.set('n', lhs, '<Plug>(VibenchToolInfoToggle)',
        { silent = true, remap = true, desc = 'Toggle vibench Tool Info' })
    else
      M.skipped_maps[#M.skipped_maps + 1] = lhs
    end
  end
end
