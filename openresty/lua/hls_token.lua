-- HLS edge authorization.
--
-- The browser holds an HttpOnly hls_token cookie issued by app-cloud. This
-- script validates it against Redis (shared token store) and rewrites the HLS
-- URI to the MinIO bucket path. The media bytes are then proxied/cached by
-- OpenResty; app-cloud is only involved when the cookie is minted/refreshed.
--
-- URI shape:
--   /hls/{uid}/{uploadUuid}/index.m3u8
--   /hls/{uid}/{uploadUuid}/seg-00001.ts
-- Relative playlist URIs inherit the same /hls/{uid}/{uploadUuid}/ prefix, so
-- every segment carries the cookie and no per-segment signing is needed.

local redis = require "resty.redis"
local cjson = require "cjson.safe"

local cookie = ngx.var.cookie_hls_token
if not cookie or cookie == "" then
    ngx.log(ngx.WARN, "[HLS] missing hls_token cookie uri=", ngx.var.uri)
    return ngx.exit(401)
end

-- Per-worker token payload cache: HLS playback issues many segment
-- requests with the same cookie. A hit skips Redis entirely; a miss performs
-- one Redis GET and caches the payload for at most 30s (also bounded by exp).
local token_cache = ngx.shared.hls_tokens
local cache_key = "t:" .. cookie
local raw = token_cache:get(cache_key)
if not raw then
    local host = os.getenv("HLS_REDIS_HOST") or "redis"
    local port = tonumber(os.getenv("HLS_REDIS_PORT") or "6380")
    local password = os.getenv("HLS_REDIS_PASSWORD") or ""
    local db = tonumber(os.getenv("HLS_REDIS_DB") or "1")

    local red = redis:new()
    red:set_timeouts(200, 200, 200) -- connect/send/read ms; edge must fail fast
    local ok, err = red:connect(host, port)
    if not ok then
        ngx.log(ngx.ERR, "[HLS] redis connect failed: ", err)
        return ngx.exit(503)
    end
    if password ~= "" then
        local authOk, authErr = red:auth(password)
        if not authOk then
            ngx.log(ngx.ERR, "[HLS] redis auth failed: ", authErr)
            red:close()
            return ngx.exit(503)
        end
    end
    local dbOk, dbErr = red:select(db)
    if not dbOk then
        ngx.log(ngx.ERR, "[HLS] redis select failed: ", dbErr)
        red:close()
        return ngx.exit(503)
    end
    local getErr
    raw, getErr = red:get("cloud:hls:token:" .. cookie)
    if getErr then
        ngx.log(ngx.ERR, "[HLS] redis get failed: ", getErr)
        red:close()
        return ngx.exit(503)
    end
    red:set_keepalive(10000, 100)
end

if not raw or raw == ngx.null then
    ngx.log(ngx.WARN, "[HLS] unknown/expired token uri=", ngx.var.uri)
    return ngx.exit(403)
end

local data, decodeErr = cjson.decode(raw)
if not data or decodeErr then
    ngx.log(ngx.WARN, "[HLS] corrupt token payload")
    return ngx.exit(403)
end
if not token_cache:get(cache_key) then
    local ttl = math.min(30, math.max(1, tonumber(data.exp) - ngx.time()))
    token_cache:set(cache_key, raw, ttl)
end
if not data.exp or tonumber(data.exp) <= ngx.time() then
    return ngx.exit(403)
end

-- Session binding: app-cloud also sets an HttpOnly hls_ctx cookie whose value
-- is embedded in the token. A token copied out of logs/storage (or replayed
-- from another browser) cannot pass this check. Tokens minted before binding
-- existed omit the field and stay valid for their short TTL.
if type(data.bind) == "string" and data.bind ~= "" then
    local bind_cookie = ngx.var.cookie_hls_ctx
    if not bind_cookie or bind_cookie ~= data.bind then
        ngx.log(ngx.WARN, "[HLS] session binding mismatch uri=", ngx.var.uri,
            " uid=", tostring(data.uid), " uuid=", tostring(data.uuid))
        return ngx.exit(403)
    end
end

-- New tokens carry the exact authorized URI prefix, including the immutable
-- output version (hls/{uid}/{uuid}/{version}/). Older tokens fall back to the
-- unversioned prefix. Either way the path and the object prefix must agree.
local prefix
if type(data.path) == "string" and data.path ~= "" then
    prefix = data.path
else
    prefix = "/hls/" .. tostring(data.uid) .. "/" .. tostring(data.uuid) .. "/"
end
if string.sub(prefix, 1, 5) ~= "/hls/" or string.find(prefix, "..", 1, true) then
    ngx.log(ngx.WARN, "[HLS] invalid token path")
    return ngx.exit(403)
end

local uri = ngx.var.uri
if string.sub(uri, 1, #prefix) ~= prefix then
    ngx.log(ngx.WARN, "[HLS] token/path mismatch uri=", uri,
        " uid=", tostring(data.uid), " uuid=", tostring(data.uuid))
    return ngx.exit(403)
end

local rest = string.sub(uri, #prefix + 1)
if rest == "" or string.find(rest, "..", 1, true) then
    return ngx.exit(403)
end

if type(data.bucket) ~= "string" or type(data.prefix) ~= "string"
    or data.bucket == "" or data.prefix == ""
    or string.find(data.prefix, "..", 1, true) then
    ngx.log(ngx.WARN, "[HLS] invalid token target")
    return ngx.exit(403)
end

local object = "/" .. data.bucket .. "/" .. data.prefix .. "/" .. rest
ngx.var.hls_cache_key = object
ngx.req.set_uri(object, false)