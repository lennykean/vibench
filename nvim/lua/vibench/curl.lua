local M = {}
local uv = vim.uv or vim.loop
local config_path, config_token

local function cleanup()
  if config_path then pcall(uv.fs_unlink, config_path) end
  config_path, config_token = nil, nil
end

local function config_for(token)
  if type(token) ~= 'string' or token == '' or token:find('[\r\n]') then return nil end
  if token == config_token and config_path and uv.fs_stat(config_path) then return config_path end
  cleanup()
  local fd, candidate = uv.fs_mkstemp(vim.fn.tempname() .. 'XXXXXX')
  if not fd then return nil, candidate end
  local escaped = token:gsub('\\', '\\\\'):gsub('"', '\\"')
  local written, write_error = uv.fs_write(fd,
    'header = "authorization: Bearer ' .. escaped .. '"\n', 0)
  uv.fs_close(fd)
  if not written then
    pcall(uv.fs_unlink, candidate)
    return nil, write_error
  end
  config_path, config_token = candidate, token
  return candidate
end

function M.command(token, args)
  local config, error_message = config_for(token)
  if not config then return nil, error_message end
  local command = { 'curl', '--config', config }
  vim.list_extend(command, args)
  return command
end

vim.api.nvim_create_autocmd('VimLeavePre', {
  group = vim.api.nvim_create_augroup('VibenchCurl', { clear = true }),
  callback = cleanup,
})

return M
