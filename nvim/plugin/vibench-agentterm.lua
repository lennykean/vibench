-- Source-aware, read-only agent terminal fed by the vibench SSE endpoint.
local session_id = vim.env.VIBENCH_SESSION
if not session_id or session_id == '' then return end

local playhead = require('vibench.playhead')
local timeline = require('vibench.timeline')
local layout = require('vibench.layout')
local M = { blocks = {}, starts = {}, start_marks = {}, skipped_maps = {} }
local timeline_owner = {}
local prompt_ns = vim.api.nvim_create_namespace('vibench-agentterm-empty-prompt')
local block_ns = vim.api.nvim_create_namespace('vibench-agentterm-blocks')
local group = vim.api.nvim_create_augroup('VibenchAgentTerm', { clear = true })
local buffer, channel, marker_nonce, window, previous_window, closed_view
local generation = 0

local function random_nonce()
  local bytes = assert((vim.uv or vim.loop).random(16))
  return (bytes:gsub('.', function(byte) return ('%02x'):format(byte:byte()) end))
end

local function marker_sequence(nonce, index)
  return ('\27]133;A;vibench=%s:%d'):format(nonce, index)
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

local function line_count()
  return valid_buf(buffer) and vim.api.nvim_buf_line_count(buffer) or 1
end

local function at_bottom()
  if not valid_win(window) then return false end
  local info = vim.fn.getwininfo(window)[1]
  local cursor = vim.api.nvim_win_get_cursor(window)[1]
  return cursor >= line_count() or info and info.botline >= line_count()
    and cursor >= info.topline and cursor <= info.botline or false
end

local function update_bar()
  if not valid_win(window) then return end
  local state = playhead.state()
  vim.wo[window].winbar = ('%%#VibenchAgentTermBar#'
    .. ' Agent Terminal '
    .. '%%1@v:lua.VibenchAgentTermWinbar@ |< %%T'
    .. '%%2@v:lua.VibenchAgentTermWinbar@ < %%T'
    .. ' %d/%d '
    .. '%%3@v:lua.VibenchAgentTermWinbar@ > %%T'
    .. '%%4@v:lua.VibenchAgentTermWinbar@ >| %%T'):format(state.position, state.total)
end

local function refresh_starts()
  if not valid_buf(buffer) then return end
  local lines = vim.api.nvim_buf_get_lines(buffer, 0, -1, false)
  M.starts = {}
  local rows = {}
  for _, mark in ipairs(vim.api.nvim_buf_get_extmarks(buffer, block_ns, 0, -1, { details = true })) do
    local index, row = M.start_marks[mark[1]], mark[2]
    local line = lines[row + 1]
    if not mark[4].invalid and index and M.blocks[index] and line
        and (line == '$' or line:sub(1, 2) == '$ ') then
      if not rows[row] or index > rows[row] then rows[row] = index end
    end
  end
  for row, index in pairs(rows) do M.starts[index] = row + 1 end
end

local function block_at(line)
  refresh_starts()
  local found
  for index = 1, #M.blocks do
    local start = M.starts[index]
    if start and start <= line then found = M.blocks[index].i + 1 end
  end
  return found
end

local function select_block(index)
  if index then playhead.seek(index, false) end
end

local function select_cursor()
  if vim.api.nvim_get_current_buf() ~= buffer then return end
  select_block(block_at(vim.api.nvim_win_get_cursor(0)[1]))
end

local function new_buffer()
  generation = generation + 1
  local nonce = random_nonce()
  local created = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_name(created, ('vibench://agent-terminal/%s/%d'):format(session_id, generation))
  vim.bo[created].bufhidden = 'hide'
  vim.bo[created].swapfile = false
  if valid_win(window) then
    local fixed = vim.wo[window].winfixbuf
    vim.wo[window].winfixbuf = false
    vim.api.nvim_win_set_buf(window, created)
    vim.wo[window].winfixbuf = fixed
  end
  vim.api.nvim_create_autocmd('TermRequest', {
    group = group,
    buffer = created,
    callback = function(ev)
      if created ~= buffer then return end
      local index = tonumber(ev.data.sequence:match(
        '^\27%]133;A;vibench=' .. nonce .. ':(%d+)$'))
      local row = ev.data.cursor[1]
      if not index or ev.data.sequence ~= marker_sequence(nonce, index)
          or ev.data.terminator ~= '\7' or index < 1 or index > (M.rendered_cutoff or 0)
          or not M.blocks[index] or row < 1 then return end
      local mark = vim.api.nvim_buf_set_extmark(created, block_ns, row - 1, 0, { invalidate = true })
      M.start_marks[mark] = index
    end,
  })
  local created_channel = vim.api.nvim_open_term(created, {})
  vim.bo[created].modifiable = false
  vim.bo[created].readonly = true
  playhead.attach(created)
  for _, lhs in ipairs({ 'i', 'I', 'a', 'A', 'o', 'O', 'c', 'C', 's', 'S', 'r', 'R' }) do
    playhead.map_if_free(created, 'n', lhs, '<Ignore>', { silent = true })
  end
  vim.api.nvim_buf_set_extmark(created, prompt_ns, 0, 0,
    { virt_text = { { '$ ', 'VibenchAgentTermPrompt' } }, virt_text_pos = 'overlay' })
  playhead.map_if_free(created, 'n', '<LeftMouse>', function()
    local mouse = vim.fn.getmousepos()
    local index = valid_win(window) and mouse.winid == window and block_at(mouse.line) or nil
    if not index then return '<LeftMouse>' end
    vim.schedule(function() select_block(index) end)
    return '<Ignore>'
  end, { expr = true, silent = true, replace_keycodes = true })
  vim.api.nvim_create_autocmd('BufWipeout', {
    group = group,
    buffer = created,
    callback = function()
      if buffer ~= created then return end
      buffer, channel, marker_nonce, window = nil, nil, nil, nil
      M.start_marks = {}
      M.rendered_revision, M.rendered_cutoff, M.rendered_signature = nil, nil, nil
      timeline.disconnect(timeline_owner)
    end,
  })
  return created, created_channel, nonce
end

vim.api.nvim_create_autocmd({ 'CursorMoved', 'WinScrolled' }, {
  group = group,
  callback = function(args)
    local moved = args.event == 'WinScrolled' and tonumber(args.match) or vim.api.nvim_get_current_win()
    if moved ~= window or not valid_win(window) or vim.api.nvim_win_get_buf(window) ~= buffer then return end
    vim.schedule(function()
      if moved == window and valid_win(window) and vim.api.nvim_win_get_buf(window) == buffer then
        playhead.set_follow(at_bottom())
      end
    end)
  end,
})

local function ensure_buffer()
  if valid_buf(buffer) then return end
  buffer, channel, marker_nonce = new_buffer()
  M.channel = channel
end

local function replace_terminal()
  local old = buffer
  buffer, channel, marker_nonce = new_buffer()
  M.channel = channel
  if valid_buf(old) then pcall(vim.api.nvim_buf_delete, old, { force = true }) end
  M.starts, M.start_marks = {}, {}
end

local function reset_terminal()
  if valid_buf(buffer) then replace_terminal() end
  M.blocks, M.starts, M.highest, M.source, M.session = {}, {}, nil, nil, nil
  M.rendered_revision, M.rendered_cutoff, M.rendered_signature = nil, nil, nil
end

local function block_text(block, index)
  local command = type(block.command) == 'string' and block.command or ''
  local output = type(block.output) == 'string' and block.output or ''
  local cwd = type(block.cwd) == 'string' and ('  ' .. block.cwd) or ''
  local status = (block.exit == nil or block.exit == vim.NIL)
    and '' or ('  [exit %s]'):format(block.exit)
  local newline = output:match('[\r\n]$') and '' or '\r\n'
  return ('%s\7\27[1;36m$ %s\27[0m\27[2m%s%s\27[0m\r\n%s%s\r\n')
    :format(marker_sequence(marker_nonce, index), command, cwd, status, output, newline)
end

local function replay(position)
  if not valid_win(window) then return end
  local cutoff = 0
  for _, block in ipairs(M.blocks) do
    if block.i >= position then break end
    cutoff = cutoff + 1
  end
  local rendered = {}
  for index = 1, cutoff do rendered[index] = M.blocks[index] end
  local ok, signature = pcall(vim.json.encode, rendered)
  if not ok then signature = tostring(rendered) end
  if M.rendered_revision == M.revision and M.rendered_cutoff == cutoff
      and M.rendered_signature == signature then
    update_bar()
    return
  end
  local ok, saved_view = pcall(vim.api.nvim_win_call, window, vim.fn.winsaveview)
  if not ok then saved_view = nil end
  replace_terminal()
  update_bar()
  M.rendered_revision, M.rendered_cutoff, M.rendered_signature = M.revision, cutoff, signature
  if cutoff > 0 then
    local text = {}
    for index = 1, cutoff do text[index] = block_text(M.blocks[index], index) end
    vim.api.nvim_buf_clear_namespace(buffer, prompt_ns, 0, -1)
    vim.api.nvim_chan_send(channel, table.concat(text))
  end
  local rendered_generation = generation
  vim.schedule(function()
    if rendered_generation ~= generation or not valid_buf(buffer) then return end
    refresh_starts()
    if saved_view and valid_win(window) then
      pcall(vim.api.nvim_win_call, window, function() vim.fn.winrestview(saved_view) end)
    end
  end)
end

local function reveal()
  local rendered_generation = generation
  vim.schedule(function()
    if rendered_generation ~= generation or not valid_win(window) then return end
    refresh_starts()
    pcall(vim.api.nvim_win_set_cursor, window, { line_count(), 0 })
    pcall(vim.api.nvim_win_call, window, function() vim.cmd('normal! zb') end)
  end)
end

local function sync_timeline(state, event)
  if event.reset then reset_terminal() end
  local blocks = {}
  for _, step in ipairs(state.steps) do
    if step.kind == 'terminal' then blocks[#blocks + 1] = step end
  end
  M.blocks, M.starts = blocks, {}
  M.highest = state.steps[#state.steps] and state.steps[#state.steps].i or nil
  M.source, M.revision, M.session = state.source, state.revision, state.session
  if event.steps and not event.reset then replay(playhead.state().position) end
end

local function remember_view(win)
  if not valid_win(win) or vim.api.nvim_win_get_buf(win) ~= buffer then return end
  local ok, view = pcall(vim.api.nvim_win_call, win, vim.fn.winsaveview)
  if ok then closed_view = view end
end

local function restore_view()
  if not closed_view then return end
  local view, rendered_generation = vim.deepcopy(closed_view), generation
  vim.schedule(function()
    if rendered_generation == generation and valid_win(window)
        and vim.api.nvim_win_get_buf(window) == buffer then
      pcall(vim.api.nvim_win_call, window, function() vim.fn.winrestview(view) end)
    end
  end)
end

local function hide()
  if not valid_win(window) then return end
  local closing = window
  local focused = vim.api.nvim_get_current_win() == closing
  remember_view(closing)
  window = nil
  timeline.disconnect(timeline_owner)
  pcall(vim.api.nvim_win_close, closing, true)
  if focused and current_win(previous_window) then pcall(vim.api.nvim_set_current_win, previous_window) end
  previous_window = nil
end

local function show(focus)
  local caller = vim.api.nvim_get_current_win()
  if current_win(window) then
    if focus ~= false then
      pcall(vim.api.nvim_set_current_win, window)
      if playhead.state().watch then reveal() end
    end
    return
  end
  if valid_win(window) then
    local closing = window
    remember_view(closing)
    window, previous_window = nil, nil
    timeline.disconnect(timeline_owner)
    pcall(vim.api.nvim_win_close, closing, true)
  end
  layout.claim_drawer('vibench_agentterm')
  ensure_buffer()
  previous_window = vim.api.nvim_get_current_win()
  local height = math.max(1, math.floor(tonumber(vim.g.vibench_agentterm_height) or 15))
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
  if valid_win(scrubber_window)
      and vim.api.nvim_win_get_tabpage(scrubber_window) == vim.api.nvim_get_current_tabpage() then
    vim.api.nvim_set_current_win(scrubber_window)
    vim.cmd(('aboveleft %dsplit'):format(height))
  else
    vim.cmd(('botright %dsplit'):format(height))
  end
  window = vim.api.nvim_get_current_win()
  vim.api.nvim_win_set_buf(window, buffer)
  vim.cmd('stopinsert')
  vim.wo[window].number, vim.wo[window].relativenumber = false, false
  vim.wo[window].signcolumn, vim.wo[window].foldcolumn = 'no', '0'
  vim.wo[window].winhighlight = previous_winhighlight
  vim.wo[window].winfixbuf = true
  pcall(vim.api.nvim_win_set_height, window, height)
  vim.wo[window].winfixheight = true
  replay(playhead.state().position)
  restore_view()
  timeline.connect(timeline_owner)
  if focus ~= false and playhead.state().watch then reveal()
  elseif current_win(caller) then pcall(vim.api.nvim_set_current_win, caller) end
end

local function toggle()
  if current_win(window) then hide() else show() end
end

M.toggle, M.show, M.hide, M.reveal = toggle, show, hide, reveal
M.connect = function() timeline.connect(timeline_owner) end
M.disconnect = function() timeline.disconnect(timeline_owner) end
M.feed, M.ingest, M.events_url = timeline.feed, timeline.ingest, timeline.events_url
M.state = function()
  local shared = timeline.state()
  return {
    buffer = buffer,
    window = current_win(window) and window or nil,
    channel = channel,
    connected = shared.connected,
    blocks = M.blocks,
    starts = M.starts,
    highest = M.highest,
    steps = shared.steps,
    revision = shared.revision,
    source = shared.source,
    session = shared.session,
    playhead = playhead.state(),
    url = shared.url,
    error = shared.error,
    exit = shared.exit,
  }
end
vim.g.vibench_agentterm = M
timeline.subscribe(sync_timeline)

_G.VibenchAgentTermWinbar = function(minwid, _, button)
  if button and button ~= 'l' then return end
  local action = ({ playhead.home, playhead.previous, playhead.next, playhead.finish })[tonumber(minwid)]
  if action then action() end
end

vim.api.nvim_set_hl(0, 'VibenchAgentTermBar',
  { default = true, fg = '#FFFFFF', bg = '#2563EB', bold = true })
vim.api.nvim_set_hl(0, 'VibenchAgentTermPrompt', { default = true, fg = '#22C55E' })

vim.api.nvim_create_autocmd('User', {
  group = group,
  pattern = 'VibenchPlayheadChanged',
  callback = function(args)
    update_bar()
    local changed = args.data and args.data.changed
    local state = playhead.state()
    if state.total > 0 and (not changed or changed.position or changed.follow and state.follow) then
      replay(state.position)
    end
  end,
})

vim.api.nvim_create_autocmd('WinClosed', {
  group = group,
  callback = function(args)
    if window and tonumber(args.match) == window then
      window = nil
      timeline.disconnect(timeline_owner)
    end
  end,
})

vim.keymap.set('n', '<Plug>(VibenchAgentTermSelect)', select_cursor,
  { silent = true, desc = 'Select Agent Terminal command' })
vim.keymap.set('n', '<Plug>(VibenchAgentTermToggle)', toggle,
  { silent = true, desc = 'Toggle vibench agent terminal' })
vim.api.nvim_create_user_command('VibenchAgentTerm', toggle, {})
vim.api.nvim_create_user_command('VibenchAgentTermHealth', function()
  local skipped = vim.list_extend(vim.deepcopy(M.skipped_maps), playhead.skipped_maps)
  if #skipped == 0 then print('vibench-agentterm: ok')
  else print('vibench-agentterm: global defaults skipped outside playback: ' .. table.concat(skipped, ', ')) end
end, {})

local configured = vim.g.vibench_agentterm_keymaps or {}
local toggles = configured.toggle
if toggles == nil then toggles = { '<M-A>', '<leader>z' } end
if type(toggles) == 'string' then toggles = { toggles } end
if vim.g.vibench_agentterm_default_keymaps ~= false and type(toggles) == 'table' then
  for _, lhs in ipairs(toggles) do
    if vim.fn.maparg(lhs, 'n') == '' then
      vim.keymap.set('n', lhs, '<Plug>(VibenchAgentTermToggle)',
        { silent = true, remap = true, desc = 'Toggle vibench agent terminal' })
    else
      M.skipped_maps[#M.skipped_maps + 1] = lhs
    end
  end
end
