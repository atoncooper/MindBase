# APISIX 配置维护（traditional + etcd，Admin HTTPS / 内嵌 Dashboard）

APISIX 3.20 以 **traditional + etcd** 模式运行：路由、上游、消费者、SSL、插件配置
全部存 etcd，通过 **Admin API** 或 **内嵌 Dashboard UI** 管理。

## 文件

- `config.yaml`：进程配置（etcd 连接/mTLS、HTTPS Admin/UI、9443 监听、SSE 等）。
- `apisix.yaml.template`：**声明式 seed，不是运行时配置源**。容器启动时由
  `render-config.sh` 渲染成 seed，`apisix-sync`（派生镜像内置）在 etcd **为空**时
  全量导入；之后它只负责同步 `ssls`（证书轮换）和 `consumers`（`.env` 内部 key 轮换）。
- `render-config.sh`：把 `__APISIX_*` / `__PAY_*` 占位符替换为 env，并注入 9443
  监听证书 PEM；**渲染产物不提交**。
- `Dockerfile` / `entrypoint.sh` / `sync/`：MindBase 派生镜像
  `atoncooper/mind-base-apisix`（stock APISIX + apisix-sync）。

> 日常改路由/上游/插件：**不要改模板**——在 Dashboard 或 Admin API 操作，写入 etcd。
> 改模板只在两种场景有意义：① 首次迁移（etcd 为空）② 灾备重建/审计基线。

## 访问 Admin API / Dashboard

- 仅 HTTPS：`https://<admin-ip>:19180/ui/`（容器内 Admin API 仍是 9180，宿主发布端口为 19180，规避 Logitech G HUB 占用 9180）。
- 仅指定来源 IP（全部是**配置文件**，不走 env）：
  - compose 的端口发布写死 `127.0.0.1:19180:9180`；需要管理网访问时改成
    `<管理网 IP>:19180:9180`（client/deploy 各栈同文件改一行）；
  - `apisix/config.yaml` 的 `deployment.admin.allow_admin` 默认已含回环 +
    私网（Docker 发布端口后 APISIX 看到的是 Docker 网关 IP，如 172.19.0.1，
    不是浏览器原始 IP）；
  - **真正限定"只有我的 IP 能访问"要靠宿主绑定地址 + 防火墙/安全组/SSH 隧道**，
    APISIX 层的 allow_admin 只能限制网段（k8s 用 `config.k8s.yaml`）。
- 登录 key = `.env` 的 `APISIX_ADMIN_KEY`（Admin API 用 `X-API-KEY` 头）。
- 证书复用 `secrets/certs/apisix/server.crt|key`（dev CA 或正式 CA）；浏览器需信任
  签发 CA，且证书 SAN 必须覆盖访问用的域名/IP（`MB_CERT_EXTRA_SAN` 可追加）。

## 迁移 / 初始化流程（维护窗口）

1. `.env` 只设置 `APISIX_ADMIN_KEY`；来源 IP 白名单与 etcd 地址在
   `apisix/config.yaml`（k8s 为 `config.k8s.yaml`），端口在 compose 字面量。
2. 停 `openresty`；按 **cert-gen → etcd → apisix** 顺序启动
   （root/client compose 已用 `depends_on` 保证；deploy 栈见各自 README）。
3. 看日志确认 seed 导入：
   `docker compose logs apisix | grep apisix-sync` → `seed imported: N resources`。
4. 验证 Admin API：
   `curl -k -H "X-API-KEY: $APISIX_ADMIN_KEY" https://127.0.0.1:19180/apisix/admin/routes`。
5. 浏览器/SSH 隧道打开 `https://<IP>:19180/ui/`。
6. 起 `openresty`，回归 forward-auth / SSE / 上传。

之后 etcd 是唯一配置源；模板仅在 etcd 为空时导入。变更请走 Dashboard/Admin API。

> 首次迁移时若 etcd 已有历史数据（例如旧的测试路由），先备份并清空 `/apisix`
> 前缀，或手动执行一次强制导入（在 apisix 容器内，seed/CA 已由 entrypoint 生成）：
>
> ```bash
> docker compose exec apisix /usr/local/bin/apisix-sync \
>   --seed /tmp/apisix-rendered/apisix.yaml \
>   --admin-url https://127.0.0.1:9180 --ca /tmp/ca-bundle.crt \
>   --server-name localhost --force-import --interval 0
> ```

## 备份 / 回滚

- etcd 备份：`etcdctl snapshot save`（带 `--cacert/--cert/--key`，路径见 compose 挂载）。
- 配置导出（审计基线）：`curl -k -H "X-API-KEY: ..." https://.../apisix/admin/<resource>`。
- 回滚：恢复上一版 `config.yaml`（yaml 模式/旧镜像）+ 重启；etcd 数据保留不影响旧模式。

## 网关策略矩阵（每条路由都走完整策略，不是"裸转发"）

| 能力 | 实现位置 | 说明 |
|---|---|---|
| 认证（用户） | 路由 `forward-auth` | 调 app-user `/internal/auth/verify`，注入 `X-Uid`/`X-Roles`；先 remove 客户端伪造值 |
| 认证（服务） | `key-auth` + `consumer-restriction` | 3 个 consumer：`internal` / `pay_readonly` / `pay_ops`；内部路由只允许 `internal`，防只读 key 越权上传脚本 |
| 凭据隔离 | `key-auth.hide_credentials` | apikey 不进入上游；需要上游二次校验的（app-task/app-content/app-pay/app-sandbox）由 `proxy-rewrite` 注入 `X-API-Key`/`X-Internal-Key` |
| consumer 配额 | `consumers[].plugins.limit-count` | internal 12000/min、pay_readonly 3000/min、pay_ops 600/min；超限 429 |
| 路由限流 | `limit-req` | 按真实客户端 IP（见 real-ip）；内部内容接口 20rps/burst10，sandbox 30rps，支付回调 50rps |
| 并发保护 | `limit-conn` | SSE/LLM/沙箱/脚本上传按 IP 限并发，超限 503（不排队打爆后端） |
| 真实客户端 IP | 全局规则 `real-ip` | 边缘 nginx 覆盖 `X-Forwarded-For`，还原真实 IP；否则所有按 IP 限流会退化成"全站共享一个桶" |
| 超时 | 路由 `timeout` + upstream `timeout` | SSE（task-quiz/chat）read 3600s；LLM 生成 300s；脚本上传 send 60s/read 120s；普通 30s |
| 重试 | upstream `retries` | 普通 API 2 次；SSE 0 次（重放半条流会污染输出） |
| 健康检查 | upstream `checks`（active+passive） | 5s 探 `/health`，失败节点摘除，快速 503 而非挂死 |
| 连接复用 | upstream `keepalive_pool` | size 10 / idle 60s / requests 100，降低后端握手开销 |
| 请求追踪 | `request-id`（全路由） | 生成并回写 `X-Request-Id`，贯穿 nginx/APISIX/Go 服务日志 |
| 安全响应头 | 全局规则 `response-rewrite` | `X-Content-Type-Options` / `X-Frame-Options` / `Referrer-Policy` / `Permissions-Policy`（header_filter，不影响 SSE） |
| 指标 | 全局规则 `prometheus` | 导出 `apisix:9091/metrics`（容器网络内，不发布到宿主），配 `plugin_attr.prometheus` |
| 复用策略 | `plugin_configs` | `pc_internal_keyauth` / `pc_internal_keyauth_task`：6 条内部路由共享同一套认证+限流+凭据策略，改一处全生效 |
| 路由分组 | 路由 `labels.domain` | `user` / `internal` / `pay`，Dashboard 按标签过滤，便于审计 |
| 匹配优先级 | 路由 `priority` | 更具体路径优先（如 `/tasks/register` 100 > `/tasks/*` 50），避免被通配符吞掉 |
| TLS | `config.yaml` `ssl_protocols` | 9443 监听 TLS 下限 1.2（1.3 启用），`server_tokens off` 隐藏版本号 |

### 为什么不是每条路由都手写一遍

- 相同策略用 `plugin_configs` 收敛：改限流/认证只改一处，不会出现"某条 API 忘了加鉴权"。
- 不同策略内联：有的路由需要 `proxy-rewrite` 改路径（sandbox）、有的要 `limit-req` 不同阈值（支付回调）、有的不能有 forward-auth（board preflight）——差异显式写在路由里，评审时一眼可见。

### 尚未启用的高级能力（按需在 Dashboard 打开，别直接改模板）

- `api-breaker`：对纯 GET 列表接口熔断（当前失败由 upstream 健康检查兜底；对写接口不建议开）。
- `traffic-split`：灰度发布（新建 v2 upstream + 在路由加 `traffic-split` 按权重/Header 分流）。
- `proxy-cache`：APISIX 侧缓存（当前由 OpenResty 边缘缓存承担，避免两份缓存一致性成本）。
- `request-validation`：JSON Schema 入参校验（需与后端契约逐字段对齐后再上）。
- `opentelemetry` / `zipkin`：链路追踪（需要 collector；`plugin_attr` 已预留位置）。
- `http-logger` / `kafka-logger`：访问日志外送（需要日志汇聚端点）。

## 一致性约定（评审/启动冒烟时逐条确认）

- seed 中 route id / upstream id / plugin_config id 唯一，引用均存在；
- 所有路由带 `labels.domain`；`/internal/*` 必须 `key-auth` + `consumer-restriction`；
- 需要上游二次校验 key 的内部路由，必须由 `proxy-rewrite` 注入 `X-API-Key`/`X-Internal-Key`（或显式 `hide_credentials: false` 并注释原因——目前只有 `coding_plan_internal`）；
- 用户路由必须 `forward-auth`（`auth_user`/preflight 等显式公开端点除外），且 remove `X-Uid`/`X-Roles`；
  ⚠️ **不能在 `proxy-rewrite` 里 remove `Authorization`**：该插件在 forward-auth 之前执行，会把 Bearer 提前删掉，forward-auth 读不到凭证 → 不注入 `X-Uid` → 下游（如 app-pay）返回 401；
  身份头只信网关注入值，支付服务本身不解析 Authorization。
- 禁止 `catch_all`；核心路由 `auth_user/cloud_user/workspaces_user/notes_user/pay_user` 齐全；公开端点（`system_ts /health`、`pay_callback`、分享页经宽松 forward-auth）必须有显式注释与限流；
- API 面清单见 [docs/api-inventory.md](../docs/api-inventory.md)，新增接口需同步 APISIX 路由 + edge location + 清单；
- 全局规则必须包含 `real-ip`（否则按 IP 限流失效）、`prometheus`、`response-rewrite`；
- 仅通过 HTTPS + allow_admin 访问 Admin API/UI，禁止暴露到公网。

## 已知边界

- SSE 路由单独声明更长 read timeout。
- 上传字节、HLS、媒体对象由 OpenResty 直连 MinIO，不经过 APISIX。
- 公开分享 `/cloud/s/*` 是 OpenResty 直连 app-cloud 的例外。
- 修改 upstream TLS 校验策略前先确认内部 CA 已挂载；当前上游仍不校验证书。

## 改路由的两种方式

- **Dashboard/Admin API（推荐）**：写 etcd，立即生效，无需重启。
- **模板 + 空 etcd**：仅用于灾备重建（`docker compose down -v` etcd 后重新导入）。
