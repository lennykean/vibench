local session_id = vim.env.VIBENCH_SESSION
if not session_id or session_id == '' then return end

local playhead = require('vibench.playhead')
local timeline = require('vibench.timeline')
local M = {}
local timeline_owner = {}
local ns = vim.api.nvim_create_namespace('vibench-chat')
local group = vim.api.nvim_create_augroup('VibenchChat', { clear = true })
local buffer, window, closed_view

local function valid_win(win)
  return win and vim.api.nvim_win_is_valid(win)
end

local function current_win(win)
  return valid_win(win) and vim.api.nvim_win_get_tabpage(win) == vim.api.nvim_get_current_tabpage()
end

local function valid_buf(buf)
  return buf and vim.api.nvim_buf_is_valid(buf)
end

local function panel_window(name)
  local panel = vim.g[name]
  if type(panel) ~= 'table' or type(panel.state) ~= 'function' then return nil end
  local ok, state = pcall(panel.state)
  return ok and state.window or nil
end

local function ordinary_window()
  local excluded = {}
  for _, name in ipairs({
    'vibench_agentterm', 'vibench_scrubber', 'vibench_tools', 'vibench_agents', 'vibench_toolinfo',
    'vibench_data',
  }) do
    local panel = panel_window(name)
    if panel then excluded[panel] = true end
  end
  local current = vim.api.nvim_get_current_win()
  local function ordinary(win)
    return valid_win(win) and win ~= window and not excluded[win]
      and vim.api.nvim_win_get_tabpage(win) == vim.api.nvim_get_current_tabpage()
      and vim.api.nvim_win_get_config(win).relative == ''
      and not vim.wo[win].winfixwidth
      and vim.fn.win_gettype(vim.api.nvim_win_get_number(win)) == ''
  end
  if ordinary(current) then return current end
  local best, area
  for _, candidate in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if ordinary(candidate) then
      local candidate_area = vim.api.nvim_win_get_width(candidate) * vim.api.nvim_win_get_height(candidate)
      if not area or candidate_area > area then best, area = candidate, candidate_area end
    end
  end
  return best
end

local function text_lines(value)
  if type(value) ~= 'string' or value == '' then return {} end
  local lines = vim.split(value:gsub('\r\n', '\n'):gsub('\r', '\n'), '\n', { plain = true })
  if lines[#lines] == '' then table.remove(lines) end
  return lines
end

local function compact(value)
  if type(value) ~= 'string' then return nil end
  local text = vim.trim(value:gsub('%s+', ' '))
  return text ~= '' and text or nil
end

local function details(step, keys)
  local values = {}
  for _, key in ipairs(keys) do
    local value = compact(step[key])
    if value then values[#values + 1] = value end
  end
  return #values > 0 and ' [' .. table.concat(values, ', ') .. ']' or ''
end

local function event_text(step)
  local event = step.event
  if event == 'message' then
    local role = compact(step.role)
    local label = role == 'user' and 'User' or role == 'assistant' and 'Assistant' or 'Message'
    return label, step.content, role == 'user' and 'VibenchChatUser' or 'VibenchChatAssistant'
  end
  if event == 'thinking' then
    return 'Thinking', step.redacted and '(redacted)' or step.content, 'VibenchChatThinking'
  end
  if event == 'agent_spawn' then
    return 'Agent spawn' .. details(step, { 'subtype' }), step.description, 'VibenchChatAgent'
  end
  if event == 'agent_peer' then
    return 'Peer' .. details(step, { 'name', 'status' }),
      step.content or step.summary or step.result, 'VibenchChatAgent'
  end
  if event == 'task' then
    return 'Task' .. details(step, { 'task_id', 'status' }),
      step.content or step.summary or step.result, 'VibenchChatTask'
  end
  return compact(event) or 'Chat', step.content, 'VibenchChatAssistant'
end

local function render()
  if not valid_buf(buffer) then return end
  local saved_view
  if valid_win(window) and vim.api.nvim_win_get_buf(window) == buffer then
    local ok, view = pcall(vim.api.nvim_win_call, window, vim.fn.winsaveview)
    if ok then saved_view = view end
  end
  local steps = timeline.state().steps
  local count = math.min(playhead.state().position, #steps)
  local lines, marks, latest = {}, {}, nil
  for index = 1, count do
    local step = steps[index]
    if step.category == 'chat' then
      if #lines > 0 then lines[#lines + 1] = '' end
      local label, content, highlight = event_text(step)
      latest = #lines + 1
      lines[#lines + 1] = label
      marks[#marks + 1] = { row = #lines - 1, width = #label, highlight = highlight }
      vim.list_extend(lines, text_lines(content))
    end
  end
  if #lines == 0 then lines[1] = '' end
  vim.bo[buffer].readonly, vim.bo[buffer].modifiable = false, true
  vim.api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
  vim.bo[buffer].modifiable, vim.bo[buffer].readonly = false, true
  vim.bo[buffer].modified = false
  vim.api.nvim_buf_clear_namespace(buffer, ns, 0, -1)
  for _, mark in ipairs(marks) do
    vim.api.nvim_buf_set_extmark(buffer, ns, mark.row, 0,
      { end_col = mark.width, hl_group = mark.highlight })
  end
  M.latest_line = latest
  if saved_view and valid_win(window) and vim.api.nvim_win_get_buf(window) == buffer then
    pcall(vim.api.nvim_win_call, window, function() vim.fn.winrestview(saved_view) end)
  end
end

local function reveal()
  if not M.latest_line or not valid_win(window) or vim.api.nvim_win_get_buf(window) ~= buffer then return end
  pcall(vim.api.nvim_win_set_cursor, window, { M.latest_line, 0 })
  pcall(vim.api.nvim_win_call, window, function() vim.cmd('normal! zt') end)
end

local function remember_view(win)
  if not valid_win(win) or vim.api.nvim_win_get_buf(win) ~= buffer then return end
  local ok, view = pcall(vim.api.nvim_win_call, win, vim.fn.winsaveview)
  if ok then closed_view = view end
end

local function close()
  timeline.disconnect(timeline_owner)
  local closing = window
  remember_view(closing)
  window = nil
  if not valid_win(closing) then return end
  if #vim.api.nvim_tabpage_list_wins(vim.api.nvim_win_get_tabpage(closing)) == 1 then
    vim.wo[closing].winfixbuf, vim.wo[closing].winbar = false, ''
    vim.api.nvim_win_set_buf(closing, vim.api.nvim_create_buf(true, false))
  else
    pcall(vim.api.nvim_win_close, closing, true)
  end
end

local function ensure_buffer()
  if valid_buf(buffer) then return buffer end
  local created = vim.api.nvim_create_buf(false, true)
  buffer = created
  vim.api.nvim_buf_set_name(created, 'vibench://chat/' .. session_id)
  vim.bo[created].buftype = 'nofile'
  vim.bo[created].bufhidden = 'hide'
  vim.bo[created].swapfile = false
  vim.bo[created].filetype = 'markdown'
  vim.bo[created].modifiable = false
  vim.bo[created].readonly = true
  playhead.map_if_free(created, 'n', 'q', close, { silent = true, desc = 'Close Chat' })
  vim.api.nvim_create_autocmd('WinLeave', {
    group = group,
    buffer = created,
    callback = function() remember_view(vim.api.nvim_get_current_win()) end,
  })
  vim.api.nvim_create_autocmd('BufWipeout', {
    group = group,
    buffer = created,
    callback = function() if buffer == created then buffer = nil end end,
  })
  render()
  return created
end

local function show(focus)
  if valid_win(window) and vim.api.nvim_win_get_tabpage(window) == vim.api.nvim_get_current_tabpage() then
    if focus ~= false then
      vim.api.nvim_set_current_win(window)
      if playhead.state().watch then reveal() end
    end
    return
  end
  if valid_win(window) then
    remember_view(window)
    pcall(vim.api.nvim_win_close, window, true)
  end
  local anchor = ordinary_window()
  if not anchor then
    vim.notify('vibench: no ordinary window for Chat', vim.log.levels.WARN)
    return
  end
  timeline.connect(timeline_owner)
  local ok, opened = pcall(vim.api.nvim_open_win, ensure_buffer(), focus ~= false,
    { split = 'right', win = anchor })
  if not ok then
    timeline.disconnect(timeline_owner)
    return
  end
  window = opened
  vim.wo[opened].winbar = ' Chat '
  vim.wo[opened].winfixbuf = true
  vim.wo[opened].wrap = true
  render()
  if closed_view then
    pcall(vim.api.nvim_win_call, opened, function() vim.fn.winrestview(closed_view) end)
  end
  if focus ~= false and playhead.state().watch then reveal() end
end

local function toggle()
  if valid_win(window) and vim.api.nvim_win_get_tabpage(window) == vim.api.nvim_get_current_tabpage() then
    close()
  else
    show()
  end
end

local function set_highlights()
  vim.api.nvim_set_hl(0, 'VibenchChatUser', { default = true, link = 'DiagnosticInfo' })
  vim.api.nvim_set_hl(0, 'VibenchChatAssistant', { default = true, link = 'Title' })
  vim.api.nvim_set_hl(0, 'VibenchChatThinking', { default = true, link = 'Comment' })
  vim.api.nvim_set_hl(0, 'VibenchChatAgent', { default = true, link = 'Identifier' })
  vim.api.nvim_set_hl(0, 'VibenchChatTask', { default = true, link = 'DiagnosticWarn' })
end
set_highlights()

timeline.subscribe(function() render() end)
vim.api.nvim_create_autocmd('User', {
  group = group,
  pattern = 'VibenchPlayheadChanged',
  callback = render,
})
vim.api.nvim_create_autocmd('ColorScheme', { group = group, callback = set_highlights })
vim.api.nvim_create_autocmd('WinClosed', {
  group = group,
  callback = function(args)
    if tostring(window) == args.match then
      window = nil
      timeline.disconnect(timeline_owner)
    end
  end,
})

vim.api.nvim_create_user_command('VibenchChat', toggle, {})
vim.keymap.set('n', '<Plug>(VibenchChatClose)', close,
  { silent = true, desc = 'Close vibench chat' })
vim.keymap.set('n', '<Plug>(VibenchChatToggle)', toggle,
  { silent = true, desc = 'Toggle vibench chat' })
if vim.g.vibench_chat_default_keymaps ~= false and vim.fn.maparg('<leader>C', 'n') == '' then
  vim.keymap.set('n', '<leader>C', '<Plug>(VibenchChatToggle)',
    { silent = true, remap = true, desc = 'Toggle vibench chat' })
end

M.show, M.close, M.toggle, M.reveal = show, close, toggle, reveal
M.state = function()
  local visible = current_win(window)
  return {
    buffer = buffer,
    window = visible and window or nil,
    visible = visible,
  }
end
vim.g.vibench_chat = M
