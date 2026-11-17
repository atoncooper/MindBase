-- Soft cache purge for the OpenResty edge.
-- POST /_purge?zone=api|pages|video|static|all
-- The X-Purge-Token header must equal the container's PURGE_TOKEN (empty
-- PURGE_TOKEN disables the endpoint). Bumping a zone version orphans every
-- cached entry under that zone; entries then age out via max_size/inactive.
-- Versions are persisted to /var/cache/openresty/versions.json so a restart
-- cannot resurrect entries that were logically purged.

local ZONES = { api = true, pages = true, video = true, static = true }

local function fail(code, msg)
    ngx.status = code
    ngx.header["Content-Type"] = "application/json"
    ngx.say(string.format('{"ok":false,"error":"%s"}', msg))
    return ngx.exit(code)
end

local token = os.getenv("PURGE_TOKEN")
if not token or token == "" then
    return fail(ngx.HTTP_SERVICE_UNAVAILABLE, "purge disabled: PURGE_TOKEN not set")
end
if ngx.req.get_method() ~= "POST" then
    ngx.header["Allow"] = "POST"
    return fail(405, "method not allowed")
end

local given = ngx.req.get_headers()["X-Purge-Token"]
if not given or given ~= token then
    return fail(ngx.HTTP_FORBIDDEN, "forbidden")
end

local zone = ngx.var.arg_zone or "all"
if zone ~= "all" and not ZONES[zone] then
    return fail(400, "unknown zone (api|pages|video|static|all)")
end

local dict = ngx.shared.cache_versions
-- Unique-enough version: epoch micros as a string (bumped versions only need
-- to differ from the previous one).
local ver = string.format("%.0f", ngx.now() * 1000000)

local bumped = {}
local function bump(z)
    dict:set(z, ver)
    bumped[#bumped + 1] = z
end

if zone == "all" then
    for z in pairs(ZONES) do bump(z) end
else
    bump(zone)
end

-- Persist every zone's current version (stable JSON).
local parts = {}
for z in pairs(ZONES) do
    local v = dict:get(z)
    if v then parts[#parts + 1] = string.format('"%s":"%s"', z, v) end
end
local body = "{" .. table.concat(parts, ",") .. "}"
local persisted = false
local f = io.open("/var/cache/openresty/versions.json", "w")
if f then
    f:write(body)
    f:close()
    persisted = true
end

ngx.header["Content-Type"] = "application/json"
ngx.say(string.format(
    '{"ok":true,"zone":"%s","bumped":["%s"],"versions":%s,"persisted":%s}',
    zone, table.concat(bumped, '","'), body, tostring(persisted)))
