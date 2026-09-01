local M = {}

local session_id = vim.env.VIBENCH_SESSION
local uv = vim.uv or vim.loop
local curl = require('vibench.curl')
local playhead = require('vibench.playhead')
local listeners, owners = {}, {}
local stream, stream_token = nil, 0
local sse_partial, sse_data = '', {}
local current = { steps = {} }
local selected, pending_landing
local saved_playheads = {}
local select_agent, last_selection_intent

local kinds = {
  terminal = true, read = true, patch = true, write = true, other = true, error = true, chat = true,
  data = true,
}
local month_days = { 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 }

local function urlencode(value)
  return tostring(value):gsub('[^%w%-._~]', function(char)
    return ('%%%02X'):format(char:byte())
  end)
end

local function target(agent)
  if type(agent) ~= 'table' or not tostring(agent.id or ''):match('^[A-Za-z0-9_-]+$') then return end
  local kind = agent.kind
  local root_id = kind == 'root' and agent.id or agent.root_id
  if kind ~= 'root' and kind ~= 'child' or not tostring(root_id or ''):match('^[A-Za-z0-9_-]+$') then return end
  local route = kind == 'root'
      and ('/agents/root/%s/timeline/events'):format(urlencode(root_id))
    or ('/agents/child/%s/%s/timeline/events'):format(urlencode(root_id), urlencode(agent.id))
  return {
    kind = kind, id = agent.id, root_id = root_id, events_url = route,
    name = agent.name, parent_agent_id = agent.parent_agent_id,
  }
end

selected = target({ kind = 'root', id = session_id, root_id = session_id })

local function agent_key(agent)
  return agent and ('%s:%s:%s'):format(agent.kind, agent.root_id, agent.id) or nil
end

local function server_info()
  local path = vim.g.vibench_agentterm_server_json
    or vim.env.VIBENCH_SERVER_JSON
    or vim.fs.joinpath(uv.os_homedir(), '.vibench', 'server.json')
  local ok, lines = pcall(vim.fn.readfile, path)
  if ok then
    local decoded, value = pcall(vim.json.decode, table.concat(lines, '\n'))
    if decoded and type(value) == 'table' and tonumber(value.port) then
      return {
        base = ('http://127.0.0.1:%d'):format(value.port),
        token = type(value.token) == 'string' and value.token or nil,
      }
    end
  end
  local base = vim.env.VIBENCH_SERVER
  if not (base and base:match('^http://127%.0%.0%.1:%d+$')) then return nil end
  return { base = base, token = vim.env.VIBENCH_SERVER_TOKEN }
end

local function server_base()
  local info = server_info()
  return info and info.base or nil
end

local function events_request()
  local info = server_info()
  if not info or not info.token or info.token == '' or not selected then return nil end
  return info.base .. selected.events_url, info.token
end

local function events_url()
  return (events_request())
end

local function snapshot()
  return {
    steps = current.steps,
    source = current.source,
    revision = current.revision,
    session = current.session,
    connected = stream ~= nil,
    url = current.url,
    error = current.error,
    exit = current.exit,
    agent = current.agent or selected,
    selection_intent = last_selection_intent,
  }
end

local function publish(event)
  local state = snapshot()
  for _, listener in ipairs(listeners) do pcall(listener, state, event or {}) end
end

local function normalized_steps(payload)
  local raw, legacy = payload.steps, false
  if raw == nil and type(payload.blocks) == 'table' then raw, legacy = payload.blocks, true end
  if type(raw) ~= 'table' then return nil, 'timeline payload has no steps snapshot' end
  local steps = {}
  for index, value in ipairs(raw) do
    if type(value) ~= 'table' or value.i ~= index - 1 then
      return nil, ('timeline step %d has a non-contiguous index'):format(index)
    end
    local step = legacy and vim.tbl_extend('force', { kind = 'terminal' }, value) or value
    if not kinds[step.kind] then return nil, ('timeline step %d has an invalid kind'):format(index) end
    steps[index] = step
  end
  return steps
end

local function revision_of(source)
  local revision = type(source) == 'table' and source.revision or nil
  return revision == vim.NIL and nil or revision
end

local function timestamp(value)
  if type(value) ~= 'string' then return nil end
  local year, month, day, hour, minute, second, fraction = value:match(
    '^(%d%d%d%d)%-(%d%d)%-(%d%d)T(%d%d):(%d%d):(%d%d)(.*)Z$')
  if not year or fraction ~= '' and not fraction:match('^%.%d+$') then return nil end
  year, month, day = tonumber(year), tonumber(month), tonumber(day)
  hour, minute, second = tonumber(hour), tonumber(minute), tonumber(second)
  local leap = year % 4 == 0 and (year % 100 ~= 0 or year % 400 == 0)
  local last_day = month_days[month]
  if month == 2 and leap then last_day = 29 end
  if not last_day or day < 1 or day > last_day or hour > 23 or minute > 59 or second > 59 then return nil end

  local shifted_year = year - (month <= 2 and 1 or 0)
  local era = math.floor(shifted_year / 400)
  local year_of_era = shifted_year - era * 400
  local shifted_month = month + (month > 2 and -3 or 9)
  local day_of_year = math.floor((153 * shifted_month + 2) / 5) + day - 1
  local day_of_era = year_of_era * 365 + math.floor(year_of_era / 4)
    - math.floor(year_of_era / 100) + day_of_year
  local days = era * 146097 + day_of_era - 719468
  return days * 86400 + hour * 3600 + minute * 60 + second
    + (fraction == '' and 0 or tonumber(fraction))
end

local function closest_position(steps, at)
  local wanted = timestamp(at)
  if not wanted or #steps == 0 then return #steps > 0 and 1 or 0 end
  local closest, distance
  for index, step in ipairs(steps) do
    local value = timestamp(step.at)
    if value then
      local current_distance = math.abs(value - wanted)
      if not distance or current_distance < distance then closest, distance = index, current_distance end
    end
  end
  return closest or 1
end

local function selection_landing()
  local state = playhead.state()
  if state.follow then return { mode = 'live' } end
  if state.total > 0 and state.position >= state.total then return { mode = 'end' } end
  local step = current.steps[state.position]
  return { mode = 'time', at = step and step.at or nil }
end

local function land(landing, steps)
  if not landing then return end
  if landing.saved then playhead.restore(landing.saved)
  elseif landing.mode == 'live' then playhead.set_follow(true)
  elseif landing.mode == 'end' then playhead.finish()
  else playhead.land(closest_position(steps, landing.at)) end
end

local function ingest(payload)
  if type(payload) ~= 'table' then return false end
  local request = type(payload.select_agent) == 'table' and payload.select_agent or nil
  local requested = target(request)
  local intent = request and tostring(request.intent_id or '') or ''
  local payload_agent = target(payload.agent)
  if requested and intent ~= '' then
    if intent ~= last_selection_intent then
      last_selection_intent = intent
      if agent_key(requested) ~= agent_key(selected) then
        local landing
        local returning = requested.kind == 'root' or (selected and selected.kind == 'child'
          and selected.parent_agent_id == requested.id and selected.root_id == requested.root_id)
        if requested.kind == 'child' and not returning then landing = selection_landing() end
        return select_agent(requested, landing)
      end
      select_agent(requested)
    elseif payload_agent and agent_key(payload_agent) ~= agent_key(selected) then
      return true
    end
  end
  if payload.error ~= nil and payload.error ~= vim.NIL then
    current.error = tostring(payload.error)
    publish({ error = true })
    return true
  end
  local steps, error_message = normalized_steps(payload)
  if not steps then
    current.error = error_message
    publish({ error = true })
    return false
  end
  local source = type(payload.source) == 'table' and payload.source or {}
  local revision = revision_of(source)
  local saved_landing = pending_landing and pending_landing.saved
  local stale_saved = saved_landing and (payload.reset == true
    or pending_landing.revision == nil or revision ~= pending_landing.revision)
  if stale_saved then pending_landing = nil end
  local reset = payload.reset == true or current.revision ~= nil and revision ~= current.revision
    or stale_saved == true
  current.steps, current.source, current.revision = steps, source, revision
  current.session, current.error = payload.session, nil
  current.agent = target(payload.agent) or selected
  publish({ reset = reset, steps = true })
  if reset then playhead.reset() end
  playhead.set_total(#steps)
  if #steps > 0 then
    local landing = pending_landing
    pending_landing = nil
    land(landing, steps)
  end
  return true
end

local function dispatch_sse()
  if #sse_data == 0 then return end
  local raw = table.concat(sse_data, '\n')
  sse_data = {}
  local ok, payload = pcall(vim.json.decode, raw)
  if ok then ingest(payload)
  else
    current.error = 'invalid SSE data: ' .. tostring(payload)
    publish({ error = true })
  end
end

local function feed_sse(chunk)
  if chunk == nil then
    if sse_partial ~= '' then
      local line = sse_partial:gsub('\r$', '')
      sse_partial = ''
      if line:sub(1, 5) == 'data:' then
        line = line:sub(6)
        if line:sub(1, 1) == ' ' then line = line:sub(2) end
        sse_data[#sse_data + 1] = line
      end
    end
    dispatch_sse()
    return
  end
  sse_partial = sse_partial .. chunk
  while true do
    local newline = sse_partial:find('\n', 1, true)
    if not newline then return end
    local line = sse_partial:sub(1, newline - 1):gsub('\r$', '')
    sse_partial = sse_partial:sub(newline + 1)
    if line == '' then
      dispatch_sse()
    elseif line:sub(1, 5) == 'data:' then
      line = line:sub(6)
      if line:sub(1, 1) == ' ' then line = line:sub(2) end
      sse_data[#sse_data + 1] = line
    end
  end
end

local function stop_stream()
  stream_token = stream_token + 1
  local running = stream
  stream = nil
  sse_partial, sse_data = '', {}
  if running then pcall(running.kill, running, 15) end
end

local function start_stream()
  if stream then return end
  local url, server_token = events_request()
  current.url = url
  if not url then return end
  stream_token = stream_token + 1
  local token = stream_token
  sse_partial, sse_data = '', {}
  local command, config_error = curl.command(server_token, {
    '--silent', '--show-error', '--fail', '--no-buffer', url,
  })
  if not command then
    current.error = 'curl authentication config: ' .. tostring(config_error)
    publish({ error = true })
    return
  end
  local ok, process = pcall(vim.system, command, {
      text = true,
      stdout = function(_, data)
        if data then vim.schedule(function() if token == stream_token then feed_sse(data) end end) end
      end,
    }, function(result)
      vim.schedule(function()
        if token ~= stream_token then return end
        feed_sse(nil)
        stream, current.exit = nil, result.code
        publish({ exit = true })
        vim.defer_fn(function()
          if token == stream_token and next(owners) and not stream then start_stream() end
        end, 1000)
      end)
    end)
  if ok then
    stream, current.error = process, nil
    publish({ connected = true })
  else
    current.error = tostring(process)
    publish({ error = true })
  end
end

function M.subscribe(listener)
  listeners[#listeners + 1] = listener
  listener(snapshot(), { initial = true })
end

function M.connect(owner)
  owners[owner] = true
  start_stream()
end

function M.disconnect(owner)
  owners[owner] = nil
  if not next(owners) then stop_stream() end
end

select_agent = function(agent, landing)
  local next_target = target(agent)
  if not next_target then return false end
  local previous_key, next_key = agent_key(selected), agent_key(next_target)
  if previous_key == next_key then
    selected, current.agent = next_target, next_target
    publish({ agent = true })
    return true
  end
  if previous_key then
    saved_playheads[previous_key] = { state = playhead.state(), revision = current.revision }
  end
  selected = next_target
  local saved = saved_playheads[next_key]
  pending_landing = landing or saved and { saved = saved.state, revision = saved.revision }
  stop_stream()
  current = { steps = {}, agent = selected }
  publish({ reset = true, steps = true, agent = true })
  playhead.reset()
  if next(owners) then start_stream() end
  return true
end
M.select_agent = select_agent

M.state = snapshot
M.events_url = events_url
M.server_base = server_base
M.server_info = server_info
M.timestamp = timestamp
M.selection_landing = selection_landing
M.ingest = ingest
M.feed = feed_sse
M.target = function() return vim.deepcopy(selected) end

vim.api.nvim_create_autocmd('VimLeavePre', {
  group = vim.api.nvim_create_augroup('VibenchTimeline', { clear = true }),
  callback = stop_stream,
})

return M
