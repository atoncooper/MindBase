# OpenResty 边缘层（替代 nginx）

> 2026-11 架构升级：**nginx → OpenResty**。OpenResty 负责 TLS 终止、负载均衡与多级缓存；
> 业务 API 打到 **APISIX**（API 网关，鉴权/路由/插件）；数据层与内部 TLS 不变。

## 1. 拓扑

    Client
      │ HTTPS :443（dev CA / 正式证书）
      ▼
    OpenResty（openresty/openresty:1.27.1.2-alpine）
      ├─ TLS 终止、HTTP/2、gzip、边缘限流（limit_req/limit_conn）
      ├─ 负载均衡：upstream apisix_backend（keepalive + max_fails + proxy_next_upstream 重试）
      ├─ 缓存：static_cache / video_cache / media_cache / pages_cache / api_cache（软 purge）
      │
      ├── 业务 API（/auth、/pay、/chat、/notes、/cloud、/task-quiz、/workspaces…）
      │     └──► APISIX :9443（https，dev CA 校验证书）──► app-ts / app-go / app-pay / app-content-mcp
      │
      └── 页面 / 静态 / 媒体（SSR 页面、/_next/static、/minio-proxy/、/cloud-stream/、/cloud/s/）
            └──► frontend:8443 / minio:9000 / app-cloud:8007（TLS 前端 sidecar，OpenResty stream）

## 2. 目录与配置

    openresty/
    ├── nginx.conf                  # 入口配置：cache zones、限流、upstream、Lua 版本号、TLS
    ├── locations.conf              # 路由分发（页面/静态/媒体 → 直连；业务 API → APISIX）
    ├── public-page-cache.conf      # 公开 SSR 页缓存片段（匿名页 include）
    ├── lua/purge.lua               # POST /_purge 软 purge 处理器
    └── tls-front/{frontend,sandbox,higress}.conf   # 同 netns TLS 前置（stream）

- 容器：`mind-base-openresty`，镜像 `openresty/openresty:1.27.1.2-alpine`，挂载 `openresty/*` + `secrets/certs/openresty`，缓存卷 `openresty_cache`。
- 证书：edge 叶子仍是 `secrets/certs/openresty/{fullchain,privkey,dev-ca}`（由 `scripts/gen-certs.sh` 的 `edge` 模式签发，SAN 含 openresty/mindbase/localhost 等全部别名）。
- 兼容 alias：compose 给 openresty 加了网络别名 `nginx`，供仍 bake 了 `http://nginx:80` 的旧 frontend 镜像使用；frontend 重建后可移除。

## 3. 负载均衡

- `upstream apisix_backend { server apisix:9443 max_fails=3 fail_timeout=10s; keepalive 32; }`
- `proxy_next_upstream error timeout 502/503/504`，重试 2 次、5s 预算。
- 扩容：APISIX 无状态（鉴权是 forward-auth 头调用），追加 `server apisix-2:9443;` 即可，无需粘性会话。
- ⚠️ upstream 是**静态解析**（拿到 keepalive/重试的代价）：APISIX 容器重建换 IP 后需 `docker compose up -d --force-recreate openresty`（或 `openresty -s reload` 使其重新解析）。

## 4. 缓存与软 purge

| zone | 内容 | TTL | 说明 |
|---|---|---|---|
| static_cache | `/_next/static` | 30d | 内容哈希文件，immutable |
| video_cache | `/cloud-stream/` | 24h | Range 请求按 `$http_range` 分键 |
| media_cache | `/mindbase/api/v1/media/`、旧 `/minio-proxy/` | 5m | 仅预签名 GET/HEAD；key 含 `$args` + `$http_range`；PUT/POST/无签名 bypass |
| hls_cache | `/hls/` | 24h | `hls_token` + `hls_ctx` 双 cookie：token 经 Redis 校验并绑定版本化 URI 前缀，ctx 校验会话绑定；key 为 MinIO 对象路径；播放列表/分片均由 app-cloud 之外代理；删文件即吊销 token，缓存条目在无有效 token 时不可达 |
| pages_cache | 公开 SSR 页（`/`、`/forgot-password`、`/reset-password`、`/notes/shared/`、`/quiz/shared/`、`/cloud/s/`） | 10m | 仅匿名；带 Authorization / RSC 请求 bypass；`proxy_ignore_headers Cache-Control Set-Cookie` 只作用于这些白名单页面 |
| api_cache | 少数公开只读 API（health、pay/products、favorites 等短 TTL 位置） | 5s–1h | 其余业务 API 不缓存 |

- 所有 key 带版本前缀：`$cache_ver_api|pages|video|static`（shared dict `cache_versions`）。
- `POST /_purge?zone=api|pages|video|static|all` + 头 `X-Purge-Token: $PURGE_TOKEN`：bump 版本 → 旧条目整体失效并在 `inactive/max_size` 后淘汰；版本写入 `/var/cache/openresty/versions.json`，重启不复活。
- 观测：缓存命中位置返回 `X-Cache-Status: MISS/HIT/BYPASS/EXPIRED`。
- 安全：`/_purge` 只允许回环/私网来源；`PURGE_TOKEN` 为空即禁用；生产改掉默认 `dev-purge-token`。

## 5. 迁移时改了什么

1. 删除 `nginx/` 目录与 `nginx` compose 服务；新增 `openresty/`（配置 + Lua + stream TLS 前置）。
2. 三个 TLS 前置 sidecar（frontend/sandbox/higress）镜像从 `nginx:alpine` 换成 OpenResty（`--with-stream` 已内置）。
3. 证书目录 `secrets/certs/nginx` → `secrets/certs/openresty`；`gen-certs.sh` 模式 `nginx` → `edge`，SAN 列表 `nginx` → `openresty`。
4. `/cloud/*`（已认证云盘 API）从“直连 app-cloud + auth_request”改为**经 APISIX forward-auth**（X-Uid 由网关注入，客户端伪造头被剥离）；`/cloud/s/<token>`（公开分享 XHR）与 `/cloud-stream/`（媒体流）仍直连 app-cloud/minio，由 edge 缓存。
5. frontend SSR 内部调用改为 `INTERNAL_API_URL=https://openresty:443`（dev CA 校验）；旧镜像的 `http://nginx:80` 由网络 alias 兜底。
6. 保留可回滚：旧配置在 git 历史（上一次提交的 `nginx/` 目录），需要时可 `git revert` 对应提交。

## 6. 运维速查

    docker compose up -d openresty                      # 启动/更新边缘
    docker exec mind-base-openresty openresty -t        # 配置语法检查
    docker exec mind-base-openresty openresty -s reload # 热加载（改 locations/upstream 后）
    docker compose logs -f openresty                    # 访问日志/错误（stdout/stderr）
    curl -X POST -H 'X-Purge-Token: <token>' 'https://localhost/_purge?zone=pages'
    curl -sI https://localhost/account | grep X-Cache-Status

## 7. 已知缺口

- `deploy/k8s`、`deploy/docker`、`deploy/swarm`、`deploy/china` 仍是 nginx 版清单，需按本文件同步（拆分/K8s 部署在本轮之前就未跟随 TLS 升级）。
- 管理台 UI 容器（`app-admin-ui`）仍用 `nginx:stable-alpine` 仅做静态 SPA + `/api` 反代（回环 3001，非公网 edge）；如需“镜像里完全没有 nginx”可再单独换基镜像。
## 8. 统一外路径命名空间（/mindbase/api/v1）

外部契约统一为：

| 类别 | 路径 | 处理 |
|---|---|---|
| 后端 API | `/mindbase/api/v1/<domain>/...`（如 `/mindbase/api/v1/cloud/folders`、`/mindbase/api/v1/sandbox/...`） | OpenResty 剥掉前缀 → APISIX（域路由/鉴权全在 APISIX），服务内部路径不变 |
| 公开分享页 | `/mindbase/s/cloud/<token>`、`/mindbase/s/notes/<token>`、`/mindbase/s/quiz/<token>` | edge rewrite 到现有 Next 路由（`/cloud/s/…` 等），浏览器 URL 为规范新地址 |
| 微信 OAuth 回调 | `/mindbase/oauth/wechat/callback` | edge rewrite 到 `/oauth/wechat/callback` 页面；`WECHAT__REDIRECT_URI` 指向新地址 |
| 支付异步回调 | `/mindbase/api/v1/pay/callback/alipay` | edge 剥离前缀 → APISIX → app-pay；`ALIPAY_NOTIFY_URL` 指向新地址（渠道后台需同步登记） |
| 预签名媒体 | `/mindbase/api/v1/media/<object>` | edge 剥离为 MinIO 根路径并回写 `Host: minio:9000`；`MINIO__PUBLIC_ENDPOINT` 指向该前缀 |
| 旧路径 | 无前缀的 `/auth`、`/pay`、`/cloud`、`/board` 等 | **兼容层已恢复**：为旧客户端/脚本保留 legacy API location（→ APISIX，含 OPTIONS/XHR 分发），标记 deprecated；所有客户端迁到 `/mindbase/api/v1/*` 后删除 |

> 备注：edge 剥离前缀后 APISIX 观测到的是裸路径；如需 APISIX 侧也看到 `/mindbase/api/v1`，下一步可改为「APISIX 增加带前缀路由 + proxy-rewrite」，属于纯配置增量。
>
> 注意：由于存在旧客户端/脚本仍调用裸路径，已恢复一层 **legacy compatibility** location（→ APISIX）作为过渡；`locations.conf` 当前约 73 个 location，待客户端迁移完成后可再次收口到 22 个。
>
> 本次收口后 `openresty/locations.conf` 从 59 个 location 降到 **22 个**：API 命名空间 6 个（media/chat SSE/task-quiz SSE/cloud 上传/cloud 公开分享/通用）、页面 6 个（3 个分享页 + OAuth + `/mindbase/` 兜底 + `/` 等公开页缓存）、媒体 4 个（avatar、cloud-stream、minio-proxy 兼容、media）、静态 1 个、运维 2 个（health/purge）+ `/api/share-base`。页面与 API 同路径的二义性消失，XHR 双用途分发逻辑全部删除。
## 9. 上传路径：哪些经过 APISIX，如何完全绕过

| 环节 | 路径 | 是否经过 APISIX |
|---|---|---|
| 分块字节流（chunk PUT） | 浏览器/脚本 → `https://<host>/mindbase/api/v1/media/<bucket>/<key>?X-Amz-…` → OpenResty（剥前缀 + `Host: minio:9000`）→ MinIO | **否**（预签名直传） |
| 上传会话元数据（init / heartbeat / complete） | `/mindbase/api/v1/cloud/upload/*` → OpenResty `auth_request` 校验 app-user → app-cloud | **否**（本轮改为 edge 直连） |
| 其余云盘 API（列表/详情/删除/分享等） | `/mindbase/api/v1/cloud/*` → APISIX forward-auth → app-cloud | 是（业务面，保留配额/审计/路由插件） |

### 前端直传 + Lua 边缘校验（主路径）

    浏览器 --chunk PUT(Authorization: Bearer …; presigned URL)--> OpenResty
      ├─ access_by_lua_file lua/upload_guard.lua
      │    ├─ 仅写方法：校验 Content-Length 上限（5GB，超限 413）
      │    ├─ 内部子请求 GET /_upload_auth_verify（app-user /internal/auth/verify）
      │    │    无凭证/无效 → 401；通过则取 X-Uid/X-Roles
      │    └─ 校验后清除 Authorization，避免与 MinIO 预签名签名冲突
      └─ proxy_pass https://minio:9000（Host 回写；MinIO 校验预签名）

- 字节流不经过 APISIX 也不经过 app-cloud；`init/heartbeat/complete` 同样是 edge 直连 app-cloud（仅元数据 JSON）。
- 校验逻辑全部在 OpenResty Lua（`openresty/lua/upload_guard.lua`），不需要 Python/外部脚本参与上传。
- 前端实现：`frontendv2/lib/api/cloud.ts` 的分块 XHR 增加 `Authorization` 头，其余不变（`xhr.upload.onprogress` 继续做真实进度）。
### 完全不经 OpenResty 的直连（容器网络内）

    # rclone（任意支持 S3 的工具均可）
    rclone copy ./big.bin minio:drive-videos/_edge-test/ --s3-endpoint https://minio:9000 --s3-access-key-id ... --s3-secret-access-key ...

    # minio/mc 容器（同网络，无需暴露端口）
    docker run --rm --network mindbase_mind-base-net -v $PWD:/data minio/mc \
      sh -c 'mc alias set m https://minio:9000 $MINIO_ACCESS_KEY $MINIO_SECRET_KEY && mc cp /data/big.bin m/drive-videos/_edge-test/'

### 安全 / 一致性

- 上传会话仍由 app-cloud 建会话、扣配额（init 仍到 app-cloud，只是不经 APISIX）；edge 侧保留 `limit_req`/`limit_conn`/body 上限。
- 完全直连 MinIO 的脚本使用 S3 全权凭据，**不受配额/审计/网关限流约束**，只建议 CI/运维在私有网络内用，并按 bucket/key 前缀隔离；不要把 MinIO 端口暴露公网。
- 预签名 URL 有时效（默认 3600s，`minio.presign_expire`）且只对指定 key 生效。
- 若要把**整个云盘 API** 也绕开 APISIX：把 `^~ /mindbase/api/v1/cloud/` 的 target 从 `apisix_backend` 换成 `$appcloud_upstream` + `auth_request`（一行配置），代价是失去 APISIX 的路由级限流/观测插件。

## 10. 媒体播放限速与 HLS 令牌（2026-11-28 播放性能修复）

### 10.1 播放与整文件下载分开限速

- 旧行为：`/mindbase/api/v1/media/` 与旧 `/minio-proxy/` 对**所有** GET 逐请求
  `limit_rate 8m`。`<video>` 播放是 Range 分片流，每个分片都被限速：实测 8 MiB
  Range 从直连 MinIO 的 **36 ms** 恶化到 **1.6–9.6 s**（首帧/拖动直接卡住）。
- 现行为（`nginx.conf` `map $http_range $minio_playback_rate`）：
  - 带 `Range` 的 GET（分片播放/拖动）→ **不限速**（`0`）；
  - 无 `Range` 的 GET（整文件下载）→ 仍受 `$minio_dl_rate`（默认 8m）限制，并加
    `limit_rate_after 1m` 让下载先快速出前 1 MiB；PUT（分块上传）保持不限速。
- 滥用保护未移除：`limit_conn conn_per_ip 8`、`limit_req`、预签名 URL 时效仍在。
  `limit_rate` 本来就是**每请求**上限（8 并发 × 8m 一直是聚合上限），因此 Range
  不限速不降低聚合带宽保护。
- 实测（同一 1.1 GB MP4，8 MiB Range，经 `https://localhost`）：

  | 路径 | TTFB | 吞吐 |
  |---|---|---|
  | 修复前（edge，逐请求 8m） | 2.0–8.4 s | 0.9–5.2 MB/s |
  | 修复后（edge，Range 不限速） | 0.03–0.07 s | 38–94 MB/s |
  | 直连 MinIO（无 edge 限速，基线） | 0.019 s | ~220 MB/s |

### 10.2 HLS 令牌改读双 Redis 库

- app-cloud 把 `cloud:hls:token:*` 写在其 `REDIS__URL` 指向的库（本部署 **db0**），
  而 `compose/gateway.yml` 给边缘的 `HLS_REDIS_DB` 是 **db1**。结果：刚签发的
  token 在边缘一律 unknown/expired → `/hls/*` **永远 403**，播放器重试一次后回退到
  限速原画（"慢"的另一半原因）。
- `lua/hls_token.lua` 现在先读 `HLS_REDIS_DB`，未命中再回退读 db0（token 隔离到
  db1 的部署仍可用，只多一次 GET）。实测修复后：master playlist 200、首个媒体
  playlist 42 ms、首个 TS 分片 46 ms（≈0.14 s 到首帧）。
- 后续可把两处 DB 配置对齐后删掉回退分支（保持向后兼容一个周期）。