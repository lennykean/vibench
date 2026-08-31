-- ties this nvim to its vibench session: reads VIBENCH_SESSION from the
-- environment, resolves it against the vibench registry server, and exposes
-- the result as vim.g.vibench (:Vibench shows it). Inert outside sessions.
local id = vim.env.VIBENCH_SESSION
if not id or id == '' then return end
local curl = require('vibench.curl')

local function resolve()
  local server = require('vibench.timeline').server_info()
  if not server or not server.token then return end
  local url = ('%s/sessions/%s'):format(server.base, id)
  local command = curl.command(server.token, {
    '--silent', '--max-time', '2', url,
  })
  if not command then return end
  vim.system(command, { text = true }, function(res)
    if res.code ~= 0 or not res.stdout or res.stdout == '' then return end
    local ok, s = pcall(vim.json.decode, res.stdout)
    if not ok or type(s) ~= 'table' or not s.name then return end
    vim.schedule(function()
      vim.g.vibench = s
      vim.opt.title = true
      vim.opt.titlestring = 'vibench:' .. s.name
    end)
  end)
end

vim.api.nvim_create_user_command('Vibench', function()
  local s = vim.g.vibench
  if s then
    local details = { s.name, s.pwd }
    if s.harness then details[#details + 1] = 'harness ' .. s.harness end
    if s.harness_session_id then details[#details + 1] = 'session ' .. s.harness_session_id end
    vim.notify('vibench ' .. table.concat(details, '  '))
  else
    vim.notify('vibench bench metadata unavailable', vim.log.levels.WARN)
    resolve()
  end
end, {})

resolve()
