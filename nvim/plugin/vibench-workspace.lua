-- Current Neovim workbench state for the resident server and MCP.
local session_id = vim.env.VIBENCH_SESSION
if not session_id or session_id == '' then return end

local playhead = require('vibench.playhead')
local timeline = require('vibench.timeline')
local curl = require('vibench.curl')
local M = {}
local group = vim.api.nvim_create_augroup('VibenchWorkspace', { clear = true })
local last_selection, selection_signature
local closing, sending, dirty = false, false, false
local generation = 0

local function now()
  return os.date('!%Y-%m-%dT%H:%M:%SZ')
end

local function valid_buf(buf)
  return type(buf) == 'number' and vim.api.nvim_buf_is_valid(buf)
end

local function valid_win(win)
  return type(win) == 'number' and vim.api.nvim_win_is_valid(win)
end

local function buffer_info(buf)
  if not valid_buf(buf) then return {} end
  local name = vim.api.nvim_buf_get_name(buf)
  local buftype = vim.bo[buf].buftype
  return {
    buffer = buf,
    path = buftype == '' and name ~= '' and name or nil,
    uri = buftype ~= '' and name ~= '' and name or nil,
    filetype = vim.bo[buf].filetype,
    buftype = buftype,
    listed = vim.fn.buflisted(buf) == 1,
    loaded = vim.api.nvim_buf_is_loaded(buf),
    modified = vim.bo[buf].modified,
  }
end

local visual_modes = {
  v = 'character', V = 'line',
  [vim.keycode('<C-v>')] = 'block',
  s = 'character', S = 'line',
  [vim.keycode('<C-s>')] = 'block',
}
local region_modes = {
  s = 'v', S = 'V',
  [vim.keycode('<C-s>')] = vim.keycode('<C-v>'),
}

local function remember_selection(raw_mode, first, last, active)
  local kind = visual_modes[raw_mode]
  if not kind then return nil end
  local region_mode = region_modes[raw_mode] or raw_mode
  local ok, region = pcall(vim.fn.getregion, first, last, { type = region_mode })
  if not ok or type(region) ~= 'table' then return nil end
  local buf = vim.api.nvim_get_current_buf()
  local text = table.concat(region, '\n')
  local truncated = vim.fn.strchars(text) > 2000
  if truncated then text = vim.fn.strcharpart(text, 0, 2000) end
  local a = { line = first[2], column = first[3] }
  local b = { line = last[2], column = last[3] }
  if a.line > b.line or a.line == b.line and a.column > b.column then a, b = b, a end
  local signature = vim.json.encode({ buf, region_mode, first[2], first[3], last[2], last[3], text })
  local at = last_selection and selection_signature == signature and last_selection.at or now()
  local info = buffer_info(buf)
  last_selection = {
    active = active,
    mode = kind,
    buffer = buf,
    path = info.path,
    uri = info.uri,
    start = a,
    ['end'] = b,
    text = text,
    truncated = truncated,
    at = at,
  }
  selection_signature = signature
  return vim.deepcopy(last_selection)
end

local function selection()
  local raw_mode = vim.fn.mode(1):sub(1, 1)
  if visual_modes[raw_mode] then
    return remember_selection(raw_mode, vim.fn.getpos('v'), vim.fn.getpos('.'), true)
  end
  if not last_selection then return nil end
  local previous = vim.deepcopy(last_selection)
  previous.active = false
  return previous
end

local function panel(name, summarize)
  local value = vim.g[name]
  if type(value) ~= 'table' or type(value.state) ~= 'function' then
    return { available = false, visible = false, focused = false }
  end
  local ok, state = pcall(value.state)
  if not ok or type(state) ~= 'table' then
    return { available = false, visible = false, focused = false }
  end
  local result = summarize(state)
  local win = tonumber(state.window)
  result.available = true
  if type(state.visible) == 'boolean' then result.visible = state.visible
  else result.visible = valid_win(win) end
  result.focused = result.visible and valid_win(win) and win == vim.api.nvim_get_current_win()
  return result
end

local function panels()
  return {
    agent_terminal = panel('vibench_agentterm', function(state)
      return {
        connected = state.connected == true,
        commands = type(state.blocks) == 'table' and #state.blocks or 0,
        error = state.error and tostring(state.error) or nil,
      }
    end),
    agent_view = panel('vibench_agentview', function(state)
      return {
        enabled = state.enabled == true,
        step = type(state.step) == 'table' and state.step.i or nil,
        path = type(state.step) == 'table' and state.step.path or nil,
      }
    end),
    agents = panel('vibench_agents', function(state)
      return {
        enabled = state.enabled == true,
        roots = type(state.roots) == 'table' and #state.roots or 0,
        count = type(state.rows) == 'table' and #state.rows or 0,
      }
    end),
    chat = panel('vibench_chat', function() return {} end),
    tool_calls = panel('vibench_tools', function(state)
      return { enabled = state.enabled == true, count = type(state.rows) == 'table' and #state.rows or 0 }
    end),
    tool_info = panel('vibench_toolinfo', function(state)
      return {
        count = type(state.steps) == 'table' and #state.steps or 0,
        step = type(state.step) == 'table' and state.step.i or nil,
      }
    end),
    data = panel('vibench_data', function(state)
      return {
        count = type(state.steps) == 'table' and #state.steps or 0,
        step = type(state.step) == 'table' and state.step.i or nil,
      }
    end),
    scrubber = panel('vibench_scrubber', function() return {} end),
  }
end

function M.snapshot()
  local current_tab = vim.api.nvim_get_current_tabpage()
  local current_win = vim.api.nvim_get_current_win()
  local current_buf = vim.api.nvim_get_current_buf()
  local tabs = vim.api.nvim_list_tabpages()
  local current_tab_index = 1
  local windows = {}
  for tab_index, tab in ipairs(tabs) do
    if tab == current_tab then current_tab_index = tab_index end
    for _, win in ipairs(vim.api.nvim_tabpage_list_wins(tab)) do
      if valid_win(win) then
        local info = vim.fn.getwininfo(win)[1] or {}
        local cursor = vim.api.nvim_win_get_cursor(win)
        windows[#windows + 1] = vim.tbl_extend('force', buffer_info(vim.api.nvim_win_get_buf(win)), {
          window = win,
          tab = tab_index,
          focused = win == current_win,
          floating = vim.api.nvim_win_get_config(win).relative ~= '',
          cursor = { line = cursor[1], column = cursor[2] + 1 },
          visible_lines = { first = info.topline, last = info.botline },
        })
      end
    end
  end

  local open_files = {}
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    local info = buffer_info(buf)
    if info.listed and info.loaded and info.buftype == '' and info.path then
      info.visible = #vim.fn.win_findbuf(buf) > 0
      info.current = buf == current_buf
      open_files[#open_files + 1] = info
    end
  end

  local current_info = buffer_info(current_buf)
  local current_cursor = vim.api.nvim_win_get_cursor(current_win)
  local wininfo = vim.fn.getwininfo(current_win)[1] or {}
  current_info.window = current_win
  current_info.tab = current_tab_index
  current_info.cursor = { line = current_cursor[1], column = current_cursor[2] + 1 }
  current_info.visible_lines = { first = wininfo.topline, last = wininfo.botline }
  local timeline_state = timeline.state()

  return {
    schema = 'vibench.workspace.v1',
    kind = 'workspace_state',
    session_id = session_id,
    captured_at = now(),
    cwd = vim.fn.getcwd(),
    mode = vim.fn.mode(1),
    tabs = { current = current_tab_index, count = #tabs },
    current = current_info,
    open_files = open_files,
    windows = windows,
    selection = selection(),
    selected_agent = timeline_state.agent,
    agent_selection_intent = timeline_state.selection_intent,
    playhead = playhead.state(),
    panels = panels(),
  }
end

local function publish()
  if closing or vim.g.vibench_workspace_publish == false then return end
  if sending then dirty = true return end
  local server = timeline.server_info()
  if not server or not server.token then return end
  local ok, body = pcall(vim.json.encode, M.snapshot())
  if not ok then return end
  local command = curl.command(server.token, {
    '--silent', '--show-error', '--fail', '--max-time', '2',
    '--request', 'PUT', '--header', 'content-type: application/json',
    '--data-binary', '@-',
    ('%s/sessions/%s/workbench'):format(server.base, vim.uri_encode(session_id)),
  })
  if not command then return end
  sending = true
  local launched = pcall(vim.system, command, { stdin = body, text = true }, function()
    vim.schedule(function()
      sending = false
      if dirty then
        dirty = false
        publish()
      end
    end)
  end)
  if not launched then sending = false end
end

local function queue()
  generation = generation + 1
  local queued = generation
  vim.defer_fn(function()
    if not closing and queued == generation then publish() end
  end, 150)
end

timeline.subscribe(function(_, event)
  if event.agent then queue() end
end)

local function mode_changed()
  local old_mode = tostring(vim.v.event.old_mode or ''):sub(1, 1)
  local new_mode = tostring(vim.v.event.new_mode or ''):sub(1, 1)
  if visual_modes[old_mode] and not visual_modes[new_mode] then
    remember_selection(old_mode, vim.fn.getpos("'<"), vim.fn.getpos("'>"), false)
  elseif visual_modes[new_mode] then
    selection()
  end
  queue()
end

local function heartbeat()
  if closing then return end
  publish()
  vim.defer_fn(heartbeat, 5000)
end

vim.api.nvim_create_autocmd({
  'BufAdd', 'BufDelete', 'BufEnter', 'BufModifiedSet', 'BufWinEnter',
  'CursorMoved', 'CursorMovedI', 'DirChanged', 'FocusGained',
  'TabEnter', 'TabNew', 'TabClosed', 'TextChanged', 'TextChangedI',
  'WinEnter', 'WinNew', 'WinClosed', 'WinScrolled',
}, { group = group, callback = queue })
vim.api.nvim_create_autocmd('ModeChanged', { group = group, callback = mode_changed })
-- Buffer numbers get reused after a wipeout; a cached selection must not keep
-- pointing its numeric handle at whatever buffer inherits the number.
vim.api.nvim_create_autocmd('BufWipeout', {
  group = group,
  callback = function(args)
    if last_selection and last_selection.buffer == args.buf then
      last_selection.buffer = nil
    end
  end,
})
vim.api.nvim_create_autocmd('User', {
  group = group,
  pattern = 'VibenchPlayheadChanged',
  callback = queue,
})
vim.api.nvim_create_autocmd('VimLeavePre', {
  group = group,
  callback = function() closing = true end,
})

vim.g.vibench_workspace = M
if vim.v.vim_did_enter == 1 then queue()
else vim.api.nvim_create_autocmd('VimEnter', { group = group, once = true, callback = queue }) end
vim.defer_fn(heartbeat, 5000)
