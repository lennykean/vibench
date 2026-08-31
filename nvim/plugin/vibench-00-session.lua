-- psmux applies new-window environment at session scope. Resolve the bench
-- from this pane's live window map before the other Vibench plugins load.
local id, watch = require('vibench.session').resolve()
if id and id ~= '' then
  vim.env.VIBENCH_SESSION = id
  vim.env.VIBENCH_WATCH = watch
elseif vim.env.VIBENCH_TMUX_SOCKET then
  vim.env.VIBENCH_SESSION = nil
  vim.env.VIBENCH_WATCH = nil
end
