-- Edge upload guard (Lua, OpenResty access phase).
--
-- Frontend large-file upload path is: browser chunk PUT -> OpenResty -> MinIO
-- (presigned URL; no APISIX, no app-cloud on the bytes path). This guard adds
-- the missing "who is uploading" check at the edge, in Lua:
--   * only write methods are guarded (downloads are authorized by the MinIO
--     presigned signature and stay untouched),
--   * the bearer session is verified through app-user (same authority as the
--     APISIX forward-auth plugin) using an internal subrequest,
--   * a hard size cap is enforced before any byte is proxied to MinIO.
-- Rejections happen in the access phase: the request body is never forwarded.

local method = ngx.req.get_method()
if method ~= "PUT" and method ~= "POST" then
    return
end

local MAX_UPLOAD = 5 * 1024 * 1024 * 1024  -- 5 GB (matches cloud upload limit)
local cl = tonumber(ngx.var.content_length or "")
if cl and cl > MAX_UPLOAD then
    ngx.log(ngx.WARN, "[UPLOAD_GUARD] payload too large: ", cl)
    return ngx.exit(413)
end

-- Verify the session (no creds -> 200 without identity; invalid -> 401).
local res = ngx.location.capture("/_upload_auth_verify")
if res.status ~= 200 then
    ngx.log(ngx.WARN, "[UPLOAD_GUARD] auth subrequest status=", res.status)
    return ngx.exit(401)
end

local uid = res.header["X-Uid"]
if not uid or uid == "" then
    ngx.log(ngx.WARN, "[UPLOAD_GUARD] rejected anonymous upload to ", ngx.var.uri)
    return ngx.exit(401)
end

-- The session header was only for the edge check; MinIO must see a purely
-- presigned request, otherwise it would try header-based SigV4 and reject it.
ngx.req.clear_header("Authorization")

-- Identity for audit/log correlation; MinIO ignores unknown headers and the
-- presigned signature stays valid (it only signs host + path/query).
ngx.req.set_header("X-Uid", uid)
local roles = res.header["X-Roles"]
if roles and roles ~= "" then
    ngx.req.set_header("X-Roles", roles)
end
