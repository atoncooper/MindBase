# app-user — 用户域服务（Go）

> 合并自 app-auth（身份）+ app-settings（偏好）+ app-bili（B 站获取）。
> 单 Go module / 单镜像 / 单进程；三个 Gin engine 分别监听 8006 / 8010 / 8015，
> 对外路径与端口语义保持不变（APISIX / nginx / app-ts 无需感知内部结构）。

## 端口

| 端口 | 承载 | 关键端点 |
|------|------|----------|
| 8006 | auth | `/auth/*`、`/internal/auth/verify`（APISIX forward-auth）、`/internal/auth/user/{uid}`（apikey）、`/health` |
| 8010 | bili | `/favorites/v2/*`、`/knowledge/*`、`/asr/*`、`/internal/bili/{scope,owns}`（apikey）、`/health` |
| 8015 | settings | `/preferences`、`/avatar/*`、`/health` |

## 代码结构

```
default.yaml                      # ★ 唯一配置文件（auth/bili/settings 三段，embed 进二进制）
cmd/app-user/main.go              # 组合根：一个 config → 全局 logger → mysql → redis → 三域 migrate → 三 engine
internal/
├── config/                       # ★ Config{Auth,Bili,Settings} + 三套 env 前缀加载
├── logger/                       # ★ 全局 logger（slog default + Gin/GORM 适配）
├── model/{auth,bili}/            # ★ 一个模型目录，按域细分
├── repo/{auth,bili,settings}/    # ★ 一个数据访问目录，按域细分
├── service/{auth,bili}/          # ★ 一个业务目录，按域细分
├── router/{auth,bili,settings}/   # ★ HTTP 路由（三 engine） + router/middleware
├── infra/                        # 连接/客户端/原语
│   ├── mysql/  redis/  mongo/  minio/
│   ├── db/{auth,bili,settings}/  # 各域 schema（CREATE-only + guard）
│   ├── cache/  security/
├── contracts/                    # BiliCredentialProvider（唯一跨域接口）
├── utils/                        # ★ 公共函数（指针/时间/身份归一化/请求元数据/任务ID/HTTPError）
├── bili/{asr,bili,events}/       # B站反爬/ASR/事件（业务集成，不是 infra）
└── tests/                        # 全部 Go 测试（独立 package tests）
```

配置只有 **一个** `app-go/app-user/default.yaml`（服务根目录，`auth:` / `bili:` / `settings:` 三段），
env 仍兼容三套 legacy 前缀（`APPAUTH__` / `APPBILI__` / `APPSETTINGS__`）；
logger 为全局包（`slog.SetDefault`），不向各层传递。
## 安全与限流

四层防护（结构重构后全部保留）：

| 层 | 机制 | 位置 |
|----|------|------|
| 边缘（nginx） | `/auth` 限流 1r/s burst3 + 每 IP 并发 5；通用/接口 10-20r/s；`auth_request` 校验并注入 X-Uid/X-Roles | `nginx/nginx.conf` + `nginx/locations.conf` |
| 网关（APISIX） | `auth_user` 限流 10r/s burst20；23 处 forward-auth；proxy-rewrite **剥离客户端伪造的 X-Uid/X-Roles**；consumer key-auth 保护 internal 面 | `apisix/apisix.yaml` |
| app-user HTTP | 共享 `middleware`：Recovery / RequestID / AccessLog / SecurityHeaders(`nosniff`,`DENY`,`no-store`) / CORS 白名单 / **constant-time apikey guard**；`/auth` 全局限流 5r/s/IP；16 条 per-endpoint 限流（per-IP/per-identifier/per-uid） | `internal/router/middleware` + `service/auth/rate_limits.go` |
| 业务（auth） | 登录节流（按 identifier+IP 计 1h 内 5 次失败锁 15min，避免被用来锁死他人账号）、图形验证码、设备证明 attest、密码 bcrypt（不存在账号也走一次 dummy bcrypt）、token 可撤销/设备绑定、AES-256-GCM 存储、雪花 ID | `internal/service/auth/*` |

信任边界：app-user 只信任网关/nginx 注入的 `X-Uid`/`X-Roles`；容器端口仅回环映射，直连调试口不经过网关（不要暴露公网）。M2M `apikey` 为空时 fail-closed（拒绝一切）。

### 2026-11 账号安全加固

- **会话吊销**：改密只保留当前设备（`RevokeOthersForUser`），重置密码吊销全部会话；登出/吊销按 token 逐个清 L1+Redis 缓存，不做全库 SCAN。
- **账号状态**：forward-auth、`/auth/*`、OAuth/手机登录均校验 `users.status`/`deleted_at`；状态与角色缓存在 `authz` cache（L1+Redis，60s），verify 稳态 0 SQL。
- **换绑 step-up**：绑定/验证新邮箱、手机号必须提供当前密码（账号已设密码时）；无密码但已有已验证联系方式的账号要求先设密码。密码重置只对 `email_verified=1` 的邮箱发信。
- **修改密码**：必须校验当前密码；有已验证邮箱用邮箱验证码，仅有已验证手机用短信验证码（后端 `twofa_sms`）。成功后保留当前设备、吊销其他全部会话，并通过 `other_sessions_revoked` 告知前端；同时异步发送密码变更提醒邮件。UI 增加确认密码、自动填充提示和会话吊销失败提示。
- **密码策略**：8–72 字节（bcrypt 只取前 72 字节，超长直接拒绝）、必须含字母+数字、本地常见弱口令黑名单、禁止与账号邮箱/手机相同；最近 5 个历史密码禁止复用（`user_password_history`）。
- **安全审计**：密码设置/修改/重置、邮箱/手机绑定/验证/解绑写入 `user_security_events`（联系方式脱敏）；邮箱/手机变更会向已验证邮箱发送提醒邮件。
- **token 不出现在 URL/日志**：删除 `?token=` 支持；会话列表只返回 `session_id`（sha256(token)[:16]），吊销走 `DELETE /auth/tokens/{session_id}`；access log 对 token/code/ticket/password 参数脱敏，nginx 访问日志不记 query。
- **重置 token 哈希存储**，验证码常量时间比较；无 AES key 且非 debug/显式 `security.allow_plaintext_fallback` 时启动失败。
- **限流 IP 可信**：nginx 边缘覆写 `X-Forwarded-For $remote_addr`，app-user 按真实源 IP 计限流；`/auth/login` 全局 1r/s、per-target 20/5min，硬锁按 identifier+IP。
- **body 上限**：auth/bili 1MB、settings 4MB（头像）；QR 客户端池 5000 条/10min TTL。
- **缓存可靠性**：token cache 撤销写 L1+Redis tombstone（阻止并发 Validate 回填）、无效 token 30s 负缓存、TTL ±10% 抖动、L1 硬上限淘汰；B站凭证只缓存在 auth 进程内存（绑定/刷新即失效，不再把明文 SESSDATA 写共享 Redis）；Redis 启动 ping 失败保留 client 供自动重连，auth/bili 的 health 检查 MySQL+Redis。

### 延迟分位与监控

- `GET /metrics`（auth 监听口 8006，仅回环/集群内）输出 Prometheus histogram `appuser_http_request_duration_seconds`，按 `service` + Gin route pattern 打标签；用 `histogram_quantile(0.99, ...)` 在 Prometheus 窗口内计算 p90/p95/p99/p999。
- `GET /debug/latency` 返回进程内近似 p50/p90/p95/p99/p999（毫秒，含 `count`）；p999 只在样本量足够时可信，低 QPS 端点应看 count 或改用更长窗口。
- 延迟采集覆盖三个 engine（auth/bili/settings），按路由模板聚合，避免原始 path 造成的标签基数爆炸。

### 上线 DDL

`db/migrations/20261107_user_perf_indexes.sql` 是给**已存在的共享库**补索引的一次性脚本（全新库已由 `db/system.sql` 建好）：低峰执行，逐组提交；`rbac_user_role` 加唯一索引前先按 (uid, role_id) 去重（脚本内有探查/去重 SQL）。
### 可选 TLS（内网加密）

默认三监听口是 **明文 HTTP**（TLS 由 nginx 终止）。如需 nginx/APISIX → app-user 这一段也加密：

1. 生成/挂载覆盖 `app-user` 主机名的证书（dev 可用 `scripts/gen-certs.sh` + `MB_CERT_EXTRA_SAN=app-user`）；
2. 设置 `APP_USER_TLS_CERT_FILE=/certs/fullchain.pem`、`APP_USER_TLS_KEY_FILE=/certs/privkey.pem`（compose 已挂载 `./nginx/certs` → `/certs`）；
3. 同步调用方：APISIX 三个 upstream 改 `scheme: https`（自签阶段 `tls.verify: false`，正式 CA 后开启校验 + 健康检查 `type: https`）；nginx `$appauth_upstream` 改 `https://app-user:8006` 并配置 `proxy_ssl_verify`；app-ts `APP_AUTH_BASE_URL`/`APP_BILI_BASE_URL` 改 https 并挂 CA（`NODE_EXTRA_CA_CERTS`）。

未设置时行为完全不变（HTTP）；设置后 `main` 对三个 `http.Server` 调 `ListenAndServeTLS`。
## 分层规则（router 层已用 tests/arch_test.go 钉死）

- **router**：只做 HTTP 参数解析/校验/响应，**禁止 SQL / DB / repo import**（`TestRouterLayerHasNoSQL`）；
- **service**：业务逻辑编排；
- **repo**：唯一允许出现 SQL/Cypher/gorm 查询的层；
- `infra/db/*` 只放 DDL/migrate（CREATE-only），不写业务查询。

> 迁移状态：router 层已清零；`service/auth` 与 `service/bili` 仍有历史内联 gorm 查询
>（auth ≈27、bili ≈30 处），下一步按同一规则迁移到 `internal/repo`（不影响对外行为）。
## 边界

- 数据所有权：auth 11 表（users/user_oauth/user_password_history/user_security_events/...）；bili 5 表（collection/favorite_folders/video/video_versions/async_tasks）+ Mongo `asr_documents`；settings 1 表（user_preferences）。
- 唯一跨域契约：`internal/contracts.BiliCredentialProvider`（auth 实现，bili 消费）——bili 不再直接读 `user_oauth`、不再持有 AES 解密。
- 依赖方向：`platform`/`contracts` 不 import 任何域；域之间禁止互相 import；`tests/arch_test.go` 钉死。
- 事件：bili 发布 `bili:page_ready` / `bili:tasks`（与合并前一致）。

## 配置

- 每域保留原有 env 前缀：`APPAUTH__*` / `APPBILI__*` / `APPSETTINGS__*`（compose 三套合并传入）。
- 共享 env：`RDBMS__URL`（经三套前缀映射）、`MONGO__URI`、`REDIS__URL`、`MINIO__*`、`SECURITY__API_KEY_ENCRYPTION_KEY(_FILE)`、`EMAIL__*`/`SMS__*`/`WECHAT__*`、`AI_GATEWAY__*`、`APISIX_CONSUMER_KEY`。
- MySQL DSN 固定 `loc=UTC`（与 bili/settings 原语义一致）；`time.Local` 在 DB 初始化后设置。

## 运行

```bash
cd app-go/app-user && go run ./cmd/app-user   # 需要 MySQL/Mongo/Redis/MinIO 可达
go test ./...                       # tests/ 黑盒测试（无需真实依赖）
docker compose up -d app-user

# 从旧三服务（app-auth/app-bili/app-settings）升级时：旧容器仍会占用
# 8006/8010/8015，必须先移除，否则新 app-user 会报 port already allocated：
docker compose up -d --remove-orphans app-user
# 已存在索引的共享库补索引（全新库无需执行）：
#   docker exec -i mind-base-mysql mysql -umind_base -p*** mind_base \
#     < db/migrations/20261107_user_perf_indexes.sql
```

## 测试

全部 Go 测试位于 `tests/` 独立包（`package tests`），不与被测包混放：
arch/ownership/routes golden/config/HTTP smoke + 迁移自三个旧服务的兼容测试（AES/bcrypt/token/雪花/WBI/DDL guard）。

真实 MySQL 的改密集成测试默认跳过，显式提供测试库时执行（会创建/删除一个唯一临时用户）：

```bash
APPUSER_TEST_MYSQL_DSN='mysql://mind_base:mind-base@127.0.0.1:3306/mind_base' \
  go test ./tests -run TestPasswordChangeIntegration -v
```