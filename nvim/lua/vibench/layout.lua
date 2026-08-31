local M = {}
local drawers = { 'vibench_agentterm', 'vibench_toolinfo', 'vibench_data' }
local group = vim.api.nvim_create_augroup('VibenchLayout', { clear = true })
-- A mouse drag on the drawer border is a WinResized with no layout churn:
-- remember that height instead of snapping back. WinNew/WinClosed churn
-- restores the remembered (or configured) height.
local heights = {}
local churn = false

local function current_window(win)
  return win and vim.api.nvim_win_is_valid(win)
    and vim.api.nvim_win_get_tabpage(win) == vim.api.nvim_get_current_tabpage()
end

local function hide_vibench_drawers(except)
  for _, name in ipairs(drawers) do
    local panel = name ~= except and vim.g[name] or nil
    if type(panel) == 'table' and type(panel.state) == 'function'
        and panel.state().window and type(panel.hide) == 'function' then
      panel.hide()
    end
  end
end

local function pin_sidebar(window, width)
  if not current_window(window) then return end
  local scrubber = vim.g.vibench_scrubber
  local scrubber_window = type(scrubber) == 'table' and type(scrubber.state) == 'function'
    and scrubber.state().window or nil
  local position = vim.api.nvim_win_get_position(window)
  local bottom = position[1] + vim.api.nvim_win_get_height(window)
  local needs_move = position[2] ~= 0
  for _, other in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if other ~= window and other ~= scrubber_window
        and vim.api.nvim_win_get_config(other).relative == '' then
      local other_position = vim.api.nvim_win_get_position(other)
      needs_move = needs_move
        or other_position[1] + vim.api.nvim_win_get_height(other) > bottom
    end
  end
  if needs_move then
    width = width or vim.api.nvim_win_get_width(window)
    vim.api.nvim_win_call(window, function() vim.cmd('silent! noautocmd wincmd H') end)
    pcall(vim.api.nvim_win_set_width, window, width)
  end
end
M.pin_sidebar = pin_sidebar

local function pin_explorer()
  local snacks = rawget(_G, 'Snacks')
  if type(snacks) ~= 'table' or type(snacks.picker) ~= 'table'
      or type(snacks.picker.get) ~= 'function' then return end
  local ok, pickers = pcall(snacks.picker.get, { source = 'explorer' })
  if not ok or type(pickers) ~= 'table' then return end
  for _, picker in ipairs(pickers) do
    local explorer = picker.layout and picker.layout.root and picker.layout.root.win
    if current_window(explorer) then
      pin_sidebar(explorer)
      return
    end
  end
end

function M.claim_drawer(owner)
  hide_vibench_drawers(owner)
  local snacks = rawget(_G, 'Snacks')
  if type(snacks) ~= 'table' or type(snacks.terminal) ~= 'table'
      or type(snacks.terminal.list) ~= 'function' then return end
  for _, terminal in pairs(snacks.terminal.list()) do
    if type(terminal) == 'table' and type(terminal.opts) == 'table'
        and terminal.opts.position == 'bottom' and current_window(terminal.win)
        and type(terminal.hide) == 'function' then
      pcall(terminal.hide, terminal)
    end
  end
end

function M.pin_drawer(adopt)
  pin_explorer()
  for _, item in ipairs({
    { name = 'vibench_agentterm', height = vim.g.vibench_agentterm_height },
    { name = 'vibench_toolinfo', height = vim.g.vibench_toolinfo_height or vim.g.vibench_agentterm_height },
    { name = 'vibench_data', height = vim.g.vibench_data_height or vim.g.vibench_agentterm_height },
  }) do
    local panel = vim.g[item.name]
    local state = type(panel) == 'table' and type(panel.state) == 'function' and panel.state() or nil
    if state and current_window(state.window) then
      local configured = math.max(1, math.floor(tonumber(item.height) or 15))
      if adopt then
        local live = vim.api.nvim_win_get_height(state.window)
        if live >= 1 then heights[item.name] = live end
      else
        pcall(vim.api.nvim_win_set_height, state.window, heights[item.name] or configured)
      end
      vim.wo[state.window].winfixheight = true
      return
    end
  end
end

vim.api.nvim_create_autocmd('BufWinEnter', {
  group = group,
  callback = function(args)
    vim.schedule(function()
      if not vim.api.nvim_buf_is_valid(args.buf)
          or vim.bo[args.buf].filetype ~= 'snacks_terminal' then return end
      for _, win in ipairs(vim.fn.win_findbuf(args.buf)) do
        local owner = current_window(win) and vim.w[win].snacks_win or nil
        if type(owner) == 'table' and owner.position == 'bottom' then
          hide_vibench_drawers()
          return
        end
      end
    end)
  end,
})

vim.api.nvim_create_autocmd({ 'WinNew', 'WinClosed' }, {
  group = group,
  callback = function()
    churn = true
    vim.schedule(function()
      churn = false
      M.pin_drawer(false)
    end)
  end,
})
-- WinNew and WinClosed fire before their consequent WinResized, so churn is
-- already set here when the resize came from layout changes rather than the
-- user's mouse.
vim.api.nvim_create_autocmd('WinResized', {
  group = group,
  callback = function()
    if churn then return end
    vim.schedule(function() M.pin_drawer(true) end)
  end,
})

return M
