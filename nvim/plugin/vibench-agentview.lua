local session_id = vim.env.VIBENCH_SESSION
if not session_id or session_id == '' then return end

local playhead = require('vibench.playhead')
local timeline = require('vibench.timeline')
local M = {}
local timeline_owner = {}
local ns = vim.api.nvim_create_namespace('vibench-agentview')
local group = vim.api.nvim_create_augroup('VibenchAgentView', { clear = true })
local buffer, window, previous_buffer, rendered_step, reveal_line
local rendered_revision, rendered_index, rendered_signature, rendered_once
local enabled = true

local function valid_win(win)
  return win and vim.api.nvim_win_is_valid(win)
end

local function current_win(win)
  return valid_win(win) and vim.api.nvim_win_get_tabpage(win) == vim.api.nvim_get_current_tabpage()
end

local function valid_buf(buf)
  return buf and vim.api.nvim_buf_is_valid(buf)
end

local function visible_windows()
  local wins = {}
  if not valid_buf(buffer) then return wins end
  for _, win in ipairs(vim.fn.win_findbuf(buffer)) do
    if current_win(win) then wins[#wins + 1] = win end
  end
  return wins
end

local function panel_window(name)
  local panel = vim.g[name]
  if type(panel) ~= 'table' or type(panel.state) ~= 'function' then return nil end
  local ok, state = pcall(panel.state)
  return ok and state.window or nil
end

local function ordinary_window()
  local terminal = panel_window('vibench_agentterm')
  local scrubber = panel_window('vibench_scrubber')
  local tools = panel_window('vibench_tools')
  local toolinfo = panel_window('vibench_toolinfo')
  local data = panel_window('vibench_data')
  local chat = panel_window('vibench_chat')
  local function ordinary(win)
    return valid_win(win) and win ~= terminal and win ~= scrubber and win ~= tools and win ~= toolinfo
      and win ~= data and win ~= chat and not vim.wo[win].winfixbuf
      and vim.api.nvim_win_get_config(win).relative == ''
      and vim.fn.win_gettype(vim.api.nvim_win_get_number(win)) == ''
  end
  local current = vim.api.nvim_get_current_win()
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
  local text = type(value) == 'string' and value:gsub('\r\n', '\n'):gsub('\r', '\n') or ''
  local lines = vim.split(text, '\n', { plain = true })
  if #lines > 1 and lines[#lines] == '' then table.remove(lines) end
  return #lines > 0 and lines or { '' }
end

local function hunk_text(hunk)
  if type(hunk) == 'string' then return hunk end
  if type(hunk) ~= 'table' then return tostring(hunk or '') end
  local old_start, old_lines = tonumber(hunk.oldStart), tonumber(hunk.oldLines)
  local new_start, new_lines = tonumber(hunk.newStart), tonumber(hunk.newLines)
  if old_start and old_lines and new_start and new_lines then
    local header = ('@@ -%d,%d +%d,%d @@'):format(old_start, old_lines, new_start, new_lines)
    local lines = type(hunk.lines) == 'table' and table.concat(hunk.lines, '\n') or ''
    return header .. (lines == '' and '' or '\n' .. lines)
  end
  if type(hunk.text) == 'string' then return hunk.text end
  if type(hunk.content) == 'string' then return hunk.content end
  local lines = type(hunk.lines) == 'table' and table.concat(hunk.lines, '\n') or ''
  return type(hunk.header) == 'string' and hunk.header .. (lines == '' and '' or '\n' .. lines) or lines
end

local function raw_patch(step)
  local path = type(step.path) == 'string' and step.path or ''
  local chunks = { '--- ' .. path, '+++ ' .. path }
  if type(step.hunks) == 'string' then
    chunks[#chunks + 1] = step.hunks
    return text_lines(table.concat(chunks, '\n'))
  end
  for _, hunk in ipairs(type(step.hunks) == 'table' and step.hunks or {}) do
    chunks[#chunks + 1] = hunk_text(hunk)
  end
  if #chunks == 2 and type(step.result) == 'string' and step.result ~= '' then
    chunks[#chunks + 1] = step.result
  end
  return text_lines(table.concat(chunks, '\n'))
end

local function latest_file_step()
  local steps = timeline.state().steps
  for index = math.min(playhead.state().position, #steps), 1, -1 do
    local step = steps[index]
    if step.category == 'file' or step.kind == 'read' or step.kind == 'patch'
        or step.kind == 'write' then return step end
  end
end

local function region_ranges(region)
  if type(region) ~= 'table' then return {} end
  if region.start_line or region.startLine or region.start or type(region[1]) == 'number' then return { region } end
  return region
end

local function highlight_regions(region, line_count)
  local first_changed
  for _, range in ipairs(region_ranges(region)) do
    if type(range) == 'table' then
      local first = tonumber(range.start_line or range.startLine or range.start or range[1])
      local last = tonumber(range.end_line or range.endLine or range['end'] or range.finish or range[2])
      if first and not last then last = first + math.max(1, tonumber(range.lineCount) or 1) - 1 end
      if first and last then
        local first_line = math.max(1, math.floor(first))
        local last_line = math.min(line_count, math.floor(last))
        if first_line <= last_line then first_changed = math.min(first_changed or first_line, first_line) end
        for line = first_line, last_line do
          vim.api.nvim_buf_set_extmark(buffer, ns, line - 1, 0,
            { line_hl_group = 'VibenchAgentViewChanged', hl_mode = 'combine', priority = 20 })
        end
      end
    end
  end
  return first_changed
end

local function highlight_diff(lines)
  for index, line in ipairs(lines) do
    local group = line:sub(1, 4) ~= '+++ ' and line:sub(1, 1) == '+' and 'DiffAdd'
      or line:sub(1, 4) ~= '--- ' and line:sub(1, 1) == '-' and 'DiffDelete'
    if group then
      vim.api.nvim_buf_set_extmark(buffer, ns, index - 1, 0, { line_hl_group = group, priority = 20 })
    end
  end
end

local function first_diff_line(lines)
  for index, line in ipairs(lines) do
    if line:sub(1, 2) == '@@' then return index end
  end
  for index = 3, #lines do
    if lines[index]:match('^[+-]') then return index end
  end
  return 1
end

local function live_line(step)
  if step.kind == 'read' and tonumber(step.start_line) then return math.max(1, math.floor(step.start_line)) end
  for _, range in ipairs(region_ranges(step.region)) do
    local line = type(range) == 'table' and tonumber(range.start_line or range.startLine or range.start or range[1])
    if line then return math.max(1, math.floor(line)) end
  end
  for _, hunk in ipairs(type(step.hunks) == 'table' and step.hunks or {}) do
    local line = type(hunk) == 'table' and tonumber(hunk.newStart)
    if line then return math.max(1, math.floor(line)) end
  end
  return 1
end

local function open_live_file()
  local step = rendered_step
  if not step or type(step.path) ~= 'string' or step.path == '' then return end
  local cwd = type(step.cwd) == 'string' and step.cwd ~= '' and step.cwd or vim.fn.getcwd()
  local path = vim.fn.isabsolutepath(step.path) == 1 and step.path or vim.fs.joinpath(cwd, step.path)
  local ok, err = pcall(vim.cmd.edit, { args = { vim.fs.normalize(path) } })
  if not ok then
    vim.notify('vibench: could not open live file: ' .. tostring(err), vim.log.levels.ERROR)
    return
  end
  local line = math.min(live_line(step), vim.api.nvim_buf_line_count(0))
  vim.api.nvim_win_set_cursor(0, { line, 0 })
end

local function filetype_for(path)
  if type(path) ~= 'string' or path == '' then return '' end
  local ok, filetype = pcall(vim.filetype.match, { filename = path })
  return ok and filetype or ''
end

local function step_signature(step)
  local ok, encoded = pcall(vim.json.encode, step)
  return ok and encoded or tostring(step)
end

local function update_name(step)
  local path = step and type(step.path) == 'string' and step.path or ''
  local basename = path:match('([^/\\]+)[/\\]*$')
  local label = basename and ('agent view [%s]'):format(basename) or 'agent view'
  local name = 'vibench://agent-view/' .. session_id .. '/' .. label
  if vim.api.nvim_buf_get_name(buffer) ~= name then vim.api.nvim_buf_set_name(buffer, name) end
end

local function render(force)
  if not valid_buf(buffer) then return end
  local views = {}
  for _, win in ipairs(visible_windows()) do
    local ok, view = pcall(vim.api.nvim_win_call, win, vim.fn.winsaveview)
    if ok then views[win] = view end
  end
  local shared = timeline.state()
  local step = latest_file_step()
  local index = step and step.i or false
  local signature = step_signature(step)
  if not force and rendered_once and rendered_revision == shared.revision
      and rendered_index == index and rendered_signature == signature then
    rendered_step = step
    return
  end
  local lines, filetype, changed = { '' }, '', nil
  local raw = step and (step.kind == 'patch' or step.kind == 'write')
    and type(step.content) ~= 'string'
  if step then
    if step.kind == 'error' then
      lines = { 'ERROR' }
      vim.list_extend(lines, text_lines(step.error or step.response or step.result))
    elseif raw then
      lines, filetype = raw_patch(step), 'diff'
    else
      lines = text_lines(step.content)
      filetype = filetype_for(step.path)
      if step.kind == 'patch' or step.kind == 'write' then changed = step.region end
    end
  end
  vim.bo[buffer].readonly, vim.bo[buffer].modifiable = false, true
  vim.api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
  vim.bo[buffer].filetype = filetype
  vim.bo[buffer].modifiable, vim.bo[buffer].readonly = false, true
  vim.bo[buffer].modified = false
  update_name(step)
  vim.api.nvim_buf_clear_namespace(buffer, ns, 0, -1)
  if raw then highlight_diff(lines) end
  reveal_line = raw and first_diff_line(lines) or changed and highlight_regions(changed, #lines) or 1
  rendered_step, rendered_revision, rendered_index = step, shared.revision, index
  rendered_signature, rendered_once = signature, true
  for win, view in pairs(views) do
    if valid_win(win) then
      pcall(vim.api.nvim_win_call, win, function() vim.fn.winrestview(view) end)
    end
  end
end

local function reveal()
  if not valid_buf(buffer) then return end
  local line = math.max(1, math.min(reveal_line or 1, vim.api.nvim_buf_line_count(buffer)))
  for _, win in ipairs(visible_windows()) do
    pcall(vim.api.nvim_win_set_cursor, win, { line, 0 })
    pcall(vim.api.nvim_win_call, win, function() vim.cmd('normal! zt') end)
  end
end

local function close()
  enabled = false
  timeline.disconnect(timeline_owner)
  local closing = buffer
  if valid_buf(closing) and valid_win(window) and vim.api.nvim_win_get_buf(window) == closing then
    local restore = valid_buf(previous_buffer) and previous_buffer or vim.api.nvim_create_buf(true, false)
    vim.api.nvim_win_set_buf(window, restore)
  end
  if valid_buf(closing) then pcall(vim.api.nvim_buf_delete, closing, { force = true }) end
end

local function ensure_buffer()
  if valid_buf(buffer) then return buffer end
  local created = vim.api.nvim_create_buf(true, true)
  buffer = created
  vim.api.nvim_buf_set_name(created, 'vibench://agent-view/' .. session_id .. '/agent view')
  vim.bo[created].buftype = 'nofile'
  vim.bo[created].bufhidden = 'hide'
  vim.bo[created].swapfile = false
  vim.bo[created].readonly = true
  vim.bo[created].modifiable = false
  -- snacks skips nofile windows when picking where to open a file; without this
  -- it falls back to a winfixbuf drawer and :buffer fails with E1513
  vim.b[created].snacks_main = true
  playhead.attach(created)
  playhead.map_if_free(created, 'n', 'q', close, { silent = true, desc = 'Close Agent View' })
  playhead.map_if_free(created, 'n', 'gf', open_live_file, { silent = true, desc = 'Open live file' })
  vim.api.nvim_create_autocmd({ 'BufUnload', 'BufDelete' }, {
    group = group,
    buffer = created,
    callback = function()
      if buffer ~= created then return end
      enabled = false
      timeline.disconnect(timeline_owner)
      if valid_win(window) and vim.api.nvim_win_get_buf(window) == created then
        local restore = valid_buf(previous_buffer) and previous_buffer or vim.api.nvim_create_buf(true, false)
        pcall(vim.api.nvim_win_set_buf, window, restore)
      end
      buffer, window, previous_buffer, rendered_step = nil, nil, nil, nil
      rendered_revision, rendered_index, rendered_signature, rendered_once = nil, nil, nil, nil
    end,
  })
  render()
  return created
end

local function show(target, focus)
  enabled = true
  timeline.connect(timeline_owner)
  local view = ensure_buffer()
  local visible = visible_windows()
  if #visible > 0 then
    window = visible[1]
    if focus ~= false then pcall(vim.api.nvim_set_current_win, window) end
    render()
    if focus ~= false and playhead.state().watch then reveal() end
    return
  end
  if type(target) ~= 'number' or not valid_win(target) then target = ordinary_window() end
  if not target then
    local terminal = panel_window('vibench_agentterm')
    local anchor = terminal or panel_window('vibench_scrubber')
    if valid_win(anchor) then
      vim.api.nvim_set_current_win(anchor)
      local ok = pcall(vim.cmd, 'topleft new')
      if ok then
        target = vim.api.nvim_get_current_win()
        if valid_win(terminal) then
          local height = math.max(1, math.floor(tonumber(vim.g.vibench_agentterm_height) or 15))
          pcall(vim.api.nvim_win_set_height, terminal, height)
        end
      end
    end
    if not target then
      vim.notify('vibench: no ordinary window for Agent View', vim.log.levels.WARN)
      return
    end
  end
  local prior_buffer = vim.api.nvim_win_get_buf(target)
  if not pcall(vim.api.nvim_win_set_buf, target, view) then return end
  window, previous_buffer = target, prior_buffer
  if focus ~= false then vim.api.nvim_set_current_win(target) end
  render(true)
  if focus ~= false and playhead.state().watch then reveal() end
end

timeline.subscribe(function(_, event) render(event.reset) end)
vim.api.nvim_create_autocmd('User', {
  group = group,
  pattern = 'VibenchPlayheadChanged',
  callback = function() render(false) end,
})
local function set_highlights()
  local source = vim.api.nvim_get_hl(0, { name = 'DiffChange', link = false })
  vim.api.nvim_set_hl(0, 'VibenchAgentViewChanged', {
    bg = source.bg,
    ctermbg = source.ctermbg,
  })
end
set_highlights()
vim.api.nvim_create_autocmd('ColorScheme', { group = group, callback = set_highlights })
vim.api.nvim_create_user_command('VibenchAgentView', function() show() end, {})
vim.keymap.set('n', '<Plug>(VibenchAgentViewOpenFile)', open_live_file,
  { silent = true, desc = 'Open Agent View live file' })
vim.keymap.set('n', '<Plug>(VibenchAgentViewClose)', close,
  { silent = true, desc = 'Close vibench agent view' })
vim.keymap.set('n', '<Plug>(VibenchAgentViewOpen)', show,
  { silent = true, desc = 'Open vibench agent view' })
if vim.g.vibench_agentview_default_keymaps ~= false and vim.fn.maparg('<leader>a', 'n') == '' then
  vim.keymap.set('n', '<leader>a', '<Plug>(VibenchAgentViewOpen)',
    { silent = true, remap = true, desc = 'Open vibench agent view' })
end

M.show, M.close, M.reveal = function(focus) show(nil, focus) end, close, reveal
M.state = function()
  local visible = visible_windows()
  return {
    buffer = buffer,
    window = visible[1],
    visible = #visible > 0,
    enabled = enabled,
    step = rendered_step,
  }
end
vim.g.vibench_agentview = M
