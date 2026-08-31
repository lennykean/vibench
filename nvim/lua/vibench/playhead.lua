local M = { skipped_maps = {} }

local current = {
  position = 0,
  total = 0,
  follow = true,
  playing = true,
  watch = vim.env.VIBENCH_WATCH ~= '0',
}
local installed = {}
local contextual = {}
local timer_generation = 0
local timer_pending = false

local function copy(changed)
  return {
    position = current.position,
    total = current.total,
    follow = current.follow,
    playing = current.playing,
    watch = current.watch,
    changed = changed,
  }
end

local function update(position, total, follow, playing, watch)
  if watch == nil then watch = current.watch end
  local changed = {
    position = position ~= current.position,
    total = total ~= current.total,
    follow = follow ~= current.follow,
    playing = playing ~= current.playing,
    watch = watch ~= current.watch,
  }
  if not changed.position and not changed.total and not changed.follow and not changed.playing
      and not changed.watch then return copy() end
  current.position, current.total, current.follow, current.playing, current.watch =
    position, total, follow, playing, watch
  if changed.position or changed.follow or changed.playing then
    timer_generation = timer_generation + 1
    timer_pending = false
  end
  pcall(vim.api.nvim_exec_autocmds, 'User', {
    pattern = 'VibenchPlayheadChanged',
    modeline = false,
    data = copy(changed),
  })
  if current.playing and not current.follow and current.position < current.total and not timer_pending then
    timer_pending = true
    local generation = timer_generation
    local delay = math.max(50, math.floor(tonumber(vim.g.vibench_playhead_interval_ms) or 750))
    vim.defer_fn(function()
      if generation ~= timer_generation then return end
      timer_pending = false
      if not current.playing or current.follow or current.position >= current.total then return end
      update(current.position + 1, current.total, false, true)
    end, delay)
  end
  return copy()
end

local function clamp(position, total)
  if total == 0 then return 0 end
  return math.max(1, math.min(math.floor(tonumber(position) or 1), total))
end

function M.state()
  return copy()
end

function M.set_total(total)
  total = math.max(0, math.floor(tonumber(total) or 0))
  local position = current.follow and total or clamp(current.position, total)
  return update(position, total, current.follow, current.playing)
end

function M.seek(position, follow)
  follow = follow == true
  return update(clamp(position, current.total), current.total, follow, follow)
end

function M.set_follow(follow)
  follow = follow == true
  local position = follow and current.total or current.position
  return update(position, current.total, follow, follow)
end

function M.toggle_play()
  return update(current.position, current.total, false, not current.playing)
end

function M.toggle_live()
  return M.set_follow(not current.follow)
end

function M.set_watch(watch)
  return update(current.position, current.total, current.follow, current.playing, watch == true)
end

function M.toggle_watch()
  return M.set_watch(not current.watch)
end

function M.previous()
  return M.seek(current.position - 1, false)
end

function M.next()
  return M.seek(current.position + 1, false)
end

function M.home()
  return M.seek(1, false)
end

function M.finish()
  return M.seek(current.total, false)
end

function M.reset()
  return update(0, 0, true, true)
end

function M.restore(state)
  state = type(state) == 'table' and state or {}
  local follow = state.follow == true
  local position = follow and current.total or clamp(state.position, current.total)
  return update(position, current.total, follow, follow or state.playing == true)
end

local actions = {
  { key = 'prev', name = 'Prev', default = '<C-h>', aliases = { '<BS>' }, call = M.previous },
  { key = 'play', name = 'PlayPause', default = '<Space>', global = false, call = M.toggle_play },
  { key = 'next', name = 'Next', default = '<C-l>', call = M.next },
  { key = 'home', name = 'Home', default = '<C-S-h>', call = M.home },
  { key = 'end', name = 'End', default = '<C-S-l>', call = M.finish },
  { key = 'live', name = 'Live', default = '<leader>P', call = M.toggle_live },
  { key = 'watch', name = 'Watch', default = '<leader>W', call = M.toggle_watch },
}

for _, action in ipairs(actions) do
  vim.keymap.set('n', ('<Plug>(VibenchPlayhead%s)'):format(action.name), action.call,
    { silent = true, desc = 'Vibench playhead: ' .. action.key })
end

function M.map_if_free(buffer, mode, lhs, rhs, options)
  local existing
  vim.api.nvim_buf_call(buffer, function()
    existing = vim.fn.maparg(lhs, mode, false, true)
  end)
  if type(existing) == 'table' and existing.buffer == 1 then return false end
  vim.keymap.set(mode, lhs, rhs,
    vim.tbl_extend('force', options or {}, { buffer = buffer }))
  return true
end

function M.attach(buffer, overrides)
  overrides = overrides or {}
  for _, mapping in ipairs(contextual) do
    for _, mode in ipairs({ 'n', 't' }) do
      M.map_if_free(buffer, mode, mapping.lhs, overrides[mapping.key] or mapping.call, {
        silent = true,
        desc = 'Vibench playhead: ' .. mapping.key,
      })
    end
  end
  return M
end

function M.setup(options)
  options = options or {}
  for lhs, rhs in pairs(installed) do
    local mapping = vim.fn.maparg(lhs, 'n', false, true)
    if mapping.rhs == rhs then pcall(vim.keymap.del, 'n', lhs) end
  end
  installed, contextual, M.skipped_maps = {}, {}, {}

  if options.default_keymaps == false or options.keymaps == false then return M end
  local configured = type(options.keymaps) == 'table' and options.keymaps or {}
  for _, action in ipairs(actions) do
    local lhs = configured[action.key]
    local uses_default = lhs == nil
    if uses_default then lhs = action.default end
    if lhs then
      contextual[#contextual + 1] = { lhs = lhs, key = action.key, call = action.call }
      if uses_default then
        for _, alias in ipairs(action.aliases or {}) do
          contextual[#contextual + 1] = { lhs = alias, key = action.key, call = action.call }
        end
      end
    end
    local install_global = lhs and (not uses_default or action.global ~= false)
    if install_global and vim.fn.maparg(lhs, 'n') == '' then
      local rhs = ('<Plug>(VibenchPlayhead%s)'):format(action.name)
      vim.keymap.set('n', lhs, rhs,
        { silent = true, remap = true, desc = 'Vibench playhead: ' .. action.key })
      installed[lhs] = rhs
    elseif install_global then
      M.skipped_maps[#M.skipped_maps + 1] = lhs
    end
  end
  return M
end

local options = type(vim.g.vibench_playhead) == 'table' and vim.g.vibench_playhead or {}
if vim.g.vibench_playhead_default_keymaps == false then options.default_keymaps = false end
if type(vim.g.vibench_playhead_keymaps) == 'table' then options.keymaps = vim.g.vibench_playhead_keymaps end
M.setup(options)

return M
