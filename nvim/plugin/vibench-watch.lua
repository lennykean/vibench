local session_id = vim.env.VIBENCH_SESSION
if not session_id or session_id == '' then return end

local playhead = require('vibench.playhead')
local timeline = require('vibench.timeline')
local owner = {}
local pending = false
local routed_step

local destinations = {
  terminal = 'vibench_agentterm',
  file = 'vibench_agentview',
  chat = 'vibench_chat',
  tool_info = 'vibench_toolinfo',
  data = 'vibench_data',
}

local function current_window(win)
  return win and vim.api.nvim_win_is_valid(win)
    and vim.api.nvim_win_get_tabpage(win) == vim.api.nvim_get_current_tabpage()
end

local function step_fingerprint()
  local state = playhead.state()
  local step = timeline.state().steps[state.position]
  local ok, encoded = pcall(vim.json.encode, step)
  return ('%d:%s'):format(state.position, ok and encoded or tostring(step))
end

local function route()
  pending = false
  local state = playhead.state()
  local step = timeline.state().steps[state.position]
  routed_step = step_fingerprint()
  local panel = step and destinations[step.category] and vim.g[destinations[step.category]] or nil
  if not state.watch or type(panel) ~= 'table' or type(panel.show) ~= 'function' then return end
  if step.category == 'chat'
      and (type(panel.state) ~= 'function' or not panel.state().visible) then return end
  local prior = vim.api.nvim_get_current_win()
  panel.show(false)
  if type(panel.reveal) == 'function' then panel.reveal() end
  if current_window(prior) then pcall(vim.api.nvim_set_current_win, prior) end
end

local function schedule_route()
  if pending then return end
  pending = true
  vim.schedule(route)
end

timeline.subscribe(function(_, event)
  if event.reset or event.agent then
    routed_step = nil
    schedule_route()
  elseif event.steps and step_fingerprint() ~= routed_step then
    schedule_route()
  end
end)
vim.api.nvim_create_autocmd('User', {
  group = vim.api.nvim_create_augroup('VibenchWatch', { clear = true }),
  pattern = 'VibenchPlayheadChanged',
  callback = function(args)
    local changed = args.data and args.data.changed
    if not changed or changed.position or changed.watch then schedule_route() end
  end,
})

timeline.connect(owner)
