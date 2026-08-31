-- Shared Vibench transport: a fixed, non-floating split at the bottom.
local session_id = vim.env.VIBENCH_SESSION
if not session_id or session_id == '' then return end

local playhead = require('vibench.playhead')
local M = {}
local ns = vim.api.nvim_create_namespace('vibench-scrubber')
local mouse_ns = vim.api.nvim_create_namespace('vibench-scrubber-mouse')
local group = vim.api.nvim_create_augroup('VibenchScrubber', { clear = true })
local buffer, window
local clicks = {}
local pin_pending = false
local enabled = true
local icons = { first = '', previous = '', play = '', pause = '', next = '', last = '' }

local function valid_win(win)
  return win and vim.api.nvim_win_is_valid(win)
end

local function current_win(win)
  return valid_win(win) and vim.api.nvim_win_get_tabpage(win) == vim.api.nvim_get_current_tabpage()
end

local function valid_buf(buf)
  return buf and vim.api.nvim_buf_is_valid(buf)
end

local function close()
  if not valid_win(window) then return end
  local closing = window
  local fixed = {}
  for _, other in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if other ~= closing and vim.api.nvim_win_get_config(other).relative == ''
        and vim.wo[other].winfixheight then
      fixed[#fixed + 1] = { window = other, height = vim.api.nvim_win_get_height(other) }
      vim.wo[other].winfixheight = false
    end
  end
  window = nil
  pcall(vim.api.nvim_win_close, closing, true)
  for _, item in ipairs(fixed) do
    if valid_win(item.window) then
      pcall(vim.api.nvim_win_set_height, item.window, item.height)
      vim.wo[item.window].winfixheight = true
    end
  end
  require('vibench.layout').pin_drawer()
end

local function hide()
  enabled = false
  close()
end

local function ensure_buffer()
  if valid_buf(buffer) then return buffer end
  buffer = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_name(buffer, 'vibench://scrubber/' .. session_id)
  vim.bo[buffer].buftype = 'nofile'
  vim.bo[buffer].bufhidden = 'hide'
  vim.bo[buffer].swapfile = false
  vim.bo[buffer].modifiable = false
  vim.bo[buffer].filetype = 'vibench-scrubber'
  playhead.attach(buffer)
  playhead.map_if_free(buffer, 'n', 'q', hide, { silent = true })
  playhead.map_if_free(buffer, 'n', '<Left>', playhead.previous, { silent = true })
  playhead.map_if_free(buffer, 'n', '<Right>', playhead.next, { silent = true })
  playhead.map_if_free(buffer, 'n', '<Home>', playhead.home, { silent = true })
  playhead.map_if_free(buffer, 'n', '<End>', playhead.finish, { silent = true })
  return buffer
end

local function render()
  if not valid_win(window) or not valid_buf(buffer) then return end
  local state = playhead.state()
  local labels = {
    icons.first, icons.previous, state.playing and icons.pause or icons.play, icons.next, icons.last,
  }
  local position = (' %d/%d '):format(state.position, state.total)
  local fixed = 4 + vim.fn.strdisplaywidth(position)
    + vim.fn.strdisplaywidth('WATCH') + vim.fn.strdisplaywidth('LIVE')
  for _, label in ipairs(labels) do fixed = fixed + vim.fn.strdisplaywidth(label) + 2 end
  local track_width = math.max(1, vim.api.nvim_win_get_width(window) - fixed)
  local ratio = state.total > 1 and (state.position - 1) / (state.total - 1) or 0
  local thumb = math.max(1, math.min(track_width, math.floor(ratio * (track_width - 1) + 1.5)))
  local progress = string.rep('─', thumb - 1) .. '●'
  local track = progress .. string.rep('─', track_width - thumb)

  local line, display_column, marks = '', 0, {}
  clicks = {}
  local function add(text, action, highlight)
    local first = #line
    local first_column = display_column + 1
    line = line .. text
    local last = #line
    display_column = display_column + vim.fn.strdisplaywidth(text)
    if action then
      clicks[#clicks + 1] = { first = first_column, last = display_column, action = action }
    end
    if highlight then marks[#marks + 1] = { first = first, last = last, group = highlight } end
  end
  local function button(label, action, highlight)
    add(label, action, highlight or 'VibenchScrubberButton')
    add('  ')
  end

  add(' ')
  button(labels[1], playhead.home)
  button(labels[2], playhead.previous)
  button(labels[3], playhead.toggle_play,
    state.playing and 'VibenchScrubberActive' or 'VibenchScrubberInactive')
  button(labels[4], playhead.next)
  button(labels[5], playhead.finish)
  button('WATCH', playhead.toggle_watch,
    state.watch and 'VibenchScrubberActive' or 'VibenchScrubberInactive')
  local track_first = display_column + 1
  local track_first_byte = #line
  add(track)
  local track_last = display_column
  clicks[#clicks + 1] = { first = track_first, last = track_last, track = true }
  marks[#marks + 1] = {
    first = track_first_byte,
    last = track_first_byte + #progress,
    group = 'VibenchScrubberProgress',
  }
  add(position)
  add('LIVE', playhead.toggle_live,
    state.follow and 'VibenchScrubberActive' or 'VibenchScrubberInactive')
  add(' ')

  vim.bo[buffer].modifiable = true
  vim.api.nvim_buf_set_lines(buffer, 0, -1, false, { line })
  vim.bo[buffer].modifiable = false
  vim.api.nvim_buf_clear_namespace(buffer, ns, 0, -1)
  vim.api.nvim_buf_set_extmark(buffer, ns, 0, 0,
    { line_hl_group = 'VibenchScrubberBackground', priority = 1 })
  for _, mark in ipairs(marks) do
    vim.api.nvim_buf_add_highlight(buffer, ns, mark.group, 0, mark.first, mark.last)
  end
end

local function is_bottom()
  if not current_win(window) or vim.api.nvim_win_get_config(window).relative ~= '' then return false end
  local position = vim.api.nvim_win_get_position(window)
  if position[2] ~= 0 or vim.api.nvim_win_get_width(window) ~= vim.o.columns then return false end
  for _, other in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if other ~= window and vim.api.nvim_win_get_config(other).relative == ''
        and vim.api.nvim_win_get_position(other)[1] > position[1] then return false end
  end
  return true
end

local function pin()
  if not current_win(window) then return end
  if not is_bottom() then
    local fixed = {}
    for _, other in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
      if other ~= window and vim.api.nvim_win_get_config(other).relative == ''
          and vim.wo[other].winfixheight then
        fixed[#fixed + 1] = { window = other, height = vim.api.nvim_win_get_height(other) }
        vim.wo[other].winfixheight = false
      end
    end
    vim.api.nvim_win_call(window, function() vim.cmd('silent! noautocmd wincmd J') end)
    pcall(vim.api.nvim_win_set_height, window, 1)
    for _, item in ipairs(fixed) do
      if valid_win(item.window) then
        pcall(vim.api.nvim_win_set_height, item.window, item.height)
        vim.wo[item.window].winfixheight = true
      end
    end
  end
  pcall(vim.api.nvim_win_set_height, window, 1)
  if valid_win(window) then vim.wo[window].winfixheight = true end
  render()
end

local function schedule_pin()
  if pin_pending then return end
  pin_pending = true
  vim.schedule(function()
    pin_pending = false
    pin()
  end)
end

local function show()
  enabled = true
  if current_win(window) then pin(); return end
  if valid_win(window) then close() end
  local prior = vim.api.nvim_get_current_win()
  local ok = pcall(vim.cmd, 'botright 1split')
  if not ok then return end
  window = vim.api.nvim_get_current_win()
  vim.api.nvim_win_set_buf(window, ensure_buffer())
  vim.wo[window].number, vim.wo[window].relativenumber = false, false
  vim.wo[window].signcolumn, vim.wo[window].foldcolumn = 'no', '0'
  vim.wo[window].statuscolumn, vim.wo[window].winbar = '', ''
  vim.wo[window].wrap, vim.wo[window].spell = false, false
  vim.wo[window].winfixbuf = true
  vim.wo[window].winfixheight = true
  vim.wo[window].winhighlight = table.concat({
    'Normal:VibenchScrubber', 'NormalNC:VibenchScrubber', 'EndOfBuffer:VibenchScrubber',
    'StatusLine:VibenchScrubber', 'StatusLineNC:VibenchScrubber',
  }, ',')
  pcall(vim.api.nvim_win_set_height, window, 1)
  if valid_win(prior) and prior ~= window then vim.api.nvim_set_current_win(prior) end
  pin()
end

local function toggle()
  if current_win(window) then hide() else show() end
end

local function handle_click(column)
  for _, click in ipairs(clicks) do
    if column >= click.first and column <= click.last then
      if click.track then
        local state = playhead.state()
        if state.total > 0 then
          local ratio = click.last == click.first and 0
            or (column - click.first) / (click.last - click.first)
          playhead.seek(math.floor(ratio * (state.total - 1) + 1.5), false)
        end
      else
        click.action()
      end
      return
    end
  end
end

local left_mouse = vim.keycode('<LeftMouse>')
vim.on_key(function(key)
  if key ~= left_mouse or not valid_win(window) then return end
  local prior = vim.api.nvim_get_current_win()
  vim.schedule(function()
    local mouse = vim.fn.getmousepos()
    if valid_win(window) and mouse.winid == window and mouse.line == 1 then
      handle_click(mouse.wincol)
      if valid_win(prior) and prior ~= window then pcall(vim.api.nvim_set_current_win, prior) end
    end
  end)
end, mouse_ns)

local function set_highlights()
  vim.api.nvim_set_hl(0, 'VibenchScrubberBackground', { bg = '#007ACC' })
  vim.api.nvim_set_hl(0, 'VibenchScrubber', { fg = '#FFFFFF', bg = '#007ACC' })
  vim.api.nvim_set_hl(0, 'VibenchScrubberButton', { fg = '#FFFFFF', bg = '#007ACC' })
  vim.api.nvim_set_hl(0, 'VibenchScrubberInactive', { fg = '#9CA3AF', bg = '#007ACC' })
  vim.api.nvim_set_hl(0, 'VibenchScrubberActive',
    { fg = '#FFFFFF', bg = '#007ACC', bold = true })
  vim.api.nvim_set_hl(0, 'VibenchScrubberProgress',
    { fg = '#FFFFFF', bg = '#007ACC', bold = true })
end
set_highlights()
vim.api.nvim_create_autocmd('ColorScheme', { group = group, callback = set_highlights })

vim.api.nvim_create_autocmd('User', {
  group = group,
  pattern = 'VibenchPlayheadChanged',
  callback = render,
})
vim.api.nvim_create_autocmd({ 'WinNew', 'WinResized', 'VimResized' }, {
  group = group,
  callback = schedule_pin,
})
vim.api.nvim_create_autocmd('TabEnter', {
  group = group,
  callback = function() if enabled then show() end end,
})
vim.api.nvim_create_autocmd('WinClosed', {
  group = group,
  callback = function(args)
    if window and tonumber(args.match) == window then window = nil else schedule_pin() end
  end,
})
vim.api.nvim_create_autocmd('BufWipeout', {
  group = group,
  buffer = ensure_buffer(),
  callback = function() buffer = nil end,
})

vim.api.nvim_create_user_command('VibenchScrubber', toggle, {})
vim.keymap.set('n', '<Plug>(VibenchScrubberHide)', hide,
  { silent = true, desc = 'Hide vibench scrubber' })
M.show, M.hide, M.toggle, M.pin = show, hide, toggle, pin
M.state = function() return { buffer = buffer, window = window, visible = valid_win(window) } end
vim.g.vibench_scrubber = M

if vim.v.vim_did_enter == 1 then vim.schedule(show)
else vim.api.nvim_create_autocmd('VimEnter', { group = group, once = true, callback = show }) end
