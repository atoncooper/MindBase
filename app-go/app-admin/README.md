# app-admin — 统一管理后台（Go + Gin）

MindBase 的**统一管理后台**：分享审核+ 支付运营（原独立服务 app-pay-admin，2026-11-03 合并）+ 控制台账户管理 + 沙箱控制台代理。直连共享 bilirag MySQL；支付运营使用**第二 GORM 连接**直连 `app_pay`（schema 归 app-pay/Java Flyway，本服务绝不 migrate）。配套前端 `frontend-admin/`（Vite + React + antd）。

- 使用与 API 文档：[docs/app-admin.md](../../docs/app-admin.md)；架构/红线：根 `AGENTS.md`
- Go API 端口 `8016`，**仅回环**、不经主站 APISIX/nginx；完整后台入口是 Compose `app-admin`（UI :3001）+ `app-admin-api`（本服务 API :8016）

## 职责边界

- **读**：`users` / `user_profile` / `rbac_user_role` / `rbac_role` / `cloud_shares` / `cloud_files` / `cloud_folders`（仅元数据）
- **写**：`cloud_shares.moderation_status/reason/time/by`（同事务写 `admin_audit`）；会员补偿开通（唯一资金写：`pay_membership` + `pay_membership_event` 同事务，复刻 app-pay `MembershipService.extend` 语义）
- **自有表**（`Migrate` 只 `CREATE TABLE IF NOT EXISTS`，守护测试锁定）：`admin_user` / `admin_session` / `admin_audit`
- **支付库（第二连接，只读 + 受控写）**：`pay_order` / `pay_membership` / `pay_membership_event` / `pay_callback_log` / `pay_product` / `pay_refund_approval`；`pay_*` schema 归 app-pay（Java Flyway），**绝不 AutoMigrate/ALTER**；退款复核只读审批表，approve/reject 经 app-pay internal 端点执行
- ❌ 无 MinIO/对象读取、无 `AutoMigrate`/ALTER 共享表、不触碰 `is_revoked`；文件内容仅经 app-cloud 内部审核预览端点按需读取（**审核员可查看任意分享**，每次预览落审计，无下载）
- **沙箱管理**：不直连 `sandbox_*` 表，`/api/sandbox/*` 全部代理到 app-sandbox `/internal/admin/*`（`X-Admin-Token`）；写操作仅 admin 且落本服务审计（`sandbox.execution.cancel` / `sandbox.lease.release`），沙箱状态以控制层为唯一真相

## 沙箱控制台代理

app-sandbox 控制层是沙箱资源的唯一真相；本服务只做**鉴权 + 透传 + 审计**，不新增查询语义、不重新映射上游字段（上游加字段无需改本服务）。

| 方法 | 路径 | 角色 | 上游 |
|---|---|---|---|
| GET | `/api/sandbox/overview` | viewer+ | GET /internal/admin/overview |
| GET | `/api/sandbox/executions`（uid/projectId/status/from/to/page/pageSize） | viewer+ | GET /internal/admin/executions |
| GET | `/api/sandbox/executions/:id` | viewer+ | GET /internal/admin/executions/:id |
| POST | `/api/sandbox/executions/:id/cancel`（可选 `{reason}`） | admin | POST /internal/admin/executions/:id/cancel |
| GET | `/api/sandbox/leases`（uid/state/page/pageSize） | viewer+ | GET /internal/admin/leases |
| POST | `/api/sandbox/leases/:id/release`（可选 `{reason}`） | admin | DELETE /internal/admin/leases/:id |
| GET | `/api/sandbox/quota`（uid/day） | viewer+ | GET /internal/admin/quota |
| GET | `/api/sandbox/audit`（uid/action/from/to/page/pageSize） | viewer+ | GET /internal/admin/audit |
| GET | `/api/sandbox/config` | viewer+ | GET /internal/admin/config |

错误映射：上游 4xx → 原样透传状态 + `{detail}`；上游 5xx / 不可达 / 非法 JSON → `502 {"detail":"sandbox 服务不可用"}`；未配置 → `503 {"detail":"sandbox 管理未配置"}`（其余后台功能不受影响）。上游 401/403 视为本服务 token 配错，同样收敛为 502（避免管理端 SPA 把 401 当成登录过期而踢出会话）。写操作成功后按「操作人 + 目标 + 结果 + 可选原因」写 `admin_audit`，审计失败即返回 500（不留无审计的管理动作）。

配置（两者必须同时提供，半配置会被清空并告警）：

```bash
APPADMIN__SANDBOX_ADMIN__BASE_URL=http://app-sandbox:8017
APPADMIN__SANDBOX_ADMIN__TOKEN=<openssl rand -hex 32>   # 与 app-sandbox SANDBOX__ADMIN__TOKEN 同一共享密钥，不下发浏览器
```

## 支付运营（app-pay 合并，2026-11-03）

支付域能力：订单 / 回调流水 / 会员 / 权益事件 / SKU 只读查询 + 会员补偿开通（唯一资金写）+ 退款双人复核（maker-checker）。**所有支付相关 uid 在 JSON 中一律字符串**（bigint 精度安全），金额为整数分。

| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | `/api/pay/orders`（uid/status/channel/sku/orderNo/tradeNo/createdFrom/createdTo/page/pageSize） | viewer+ | 订单列表（id DESC） |
| GET | `/api/pay/orders/:orderNo?tradeNo=` | viewer+ | 订单详情（orderNo 查不到用 tradeNo 兜底；404 order not found） |
| GET | `/api/pay/orders/:orderNo/callbacks` | viewer+ | 回调流水（脱敏报文 + 验签/处理结论） |
| GET | `/api/pay/memberships?uid=` | viewer+ | 带 uid 精确查（无记录 `membership:null`）；不带 uid 分页 |
| GET | `/api/pay/memberships/:uid/events` | viewer+ | 单人权益事件流 |
| GET | `/api/pay/events?uid=&type=` | viewer+ | 全局权益事件流（ADMIN_GRANT 审计） |
| GET | `/api/pay/products` | viewer+ | SKU 目录（sort ASC, id ASC） |
| POST | `/api/pay/grants` | admin | 补偿开通（事务 + `SELECT ... FOR UPDATE`(MySQL) + 日额度熔断 429） |
| GET | `/api/pay/refunds?status=` | admin | 退款复核列表（未配置整组 404 隐身） |
| POST | `/api/pay/refunds/:orderNo/approve`、`/reject` | admin | 经 app-pay internal 端点执行（checker=登录用户名）；上游失败 502 |

**关闭/降级语义**：未配置 `pay_rdbms.url` 或 PayDB 初始化失败 → 所有 `/api/pay/**` 登录后 503 `{"detail":"支付管理未配置"}`，其余后台不受影响；`/health` 相应返回 503 `pay database unavailable`。退款复核另需 `pay.ops.base_url` + `pay.ops.key` + 开关同时就绪，否则整组 404。

**审计三留痕**（资金写）：① `pay_membership_event.reason` 以 `[操作人] ` 前缀（事务内）；② `pay-audit.jsonl`（SHA-256 哈希链，lumberjack 轮转 365 天，`MEMBERSHIP_EXTENDED` / `REFUND_*` / `GRANT_DAILY_*`）；③ `admin_audit`（`pay_grant` / `pay_refund_approve` / `pay_refund_reject`；跨库无法同事务，失败仅告警，不把已落库的资金操作报成失败）。

## 控制台账户管理

`/api/console/users`（admin only，**独立于支付库**，pay 关闭也可用）：列表（username ASC）/ 新建（2..64 字符、密码 8..128、role admin|viewer 默认 viewer）/ 重置密码（强制下次登录改密 + 删除该账户全部会话）/ 删除（不能删自己、不能删最后一个 admin）。与只读业务用户查询 `GET /api/users` 完全分离。

## 启动

```bash
# Docker：完整管理后台入口（UI + API + 数据库/schema 依赖）
docker compose up -d --build app-admin  # http://127.0.0.1:3001，种子 admin / app-admin，首登强制改密

# 仅 API 调试
docker compose up -d --build app-admin-api  # http://127.0.0.1:8016

# 本地（模块模式；连宿主 MySQL）
cd app-go/app-admin
APPADMIN__RDBMS__URL='mysql+aiomysql://mind_base:mind-base@127.0.0.1:3306/mind_base' go run .
```

配置三层：`default.yaml`（嵌入）← `-config` 覆盖层 ← `APPADMIN__` env（最高）；读项目根 `.env`。

```bash
APPADMIN__RDBMS__URL=...           # 必填（compose 由 RDBMS__URL 注入）
APPADMIN__PAY_RDBMS__URL=...       # 可选；app_pay 第二连接（compose 由 PAY_MYSQL_* 注入），空=支付运营 503
APPADMIN__PAY__OPS__BASE_URL=http://apisix:9080  # 退款复核上游（与 key 同时配置才启用）
APPADMIN__PAY__OPS__KEY=...        # PAY_OPS_KEY（pay-ops consumer）；空=退款复核 404 隐身
APPADMIN__PAY__GRANT__DAILY_MAX_COUNT=50         # 补偿开通日额度（0=不限，对齐 app-pay）
APPADMIN__PAY__GRANT__DAILY_MAX_DAYS=1000
APPADMIN__PAY__AUDIT_FILE=/app/logs/pay-audit.jsonl
APPADMIN__SEED__USERNAME=admin     # 只插缺失
APPADMIN__SEED__PASSWORD=app-admin # 生产务必覆盖
APPADMIN__SESSION__TTL_MINUTES=720
# 登录安全：设备指纹（strict/id/off）、会话 IP 绑定（subnet/exact/off）
APPADMIN__SESSION__DEVICE_BINDING=strict
APPADMIN__SESSION__IP_BINDING=subnet
APPADMIN__SESSION__IPV4_PREFIX=24
APPADMIN__SESSION__IPV6_PREFIX=64
# 可信反向代理（只有这些 peer 的 X-Forwarded-* 被采信；compose 默认 UI 网段）
APPADMIN__SECURITY__TRUSTED_PROXIES=172.16.0.0/12
APPADMIN__SECURITY__LOGIN__MAX_FAILS_PER_IP=10
APPADMIN__SECURITY__LOGIN__MAX_FAILS_PER_ACCOUNT=10
APPADMIN__SECURITY__IP_ALLOWLIST=192.0.2.10/32,10.20.0.0/16 # 可选；空=由部署网络边界控制
APPADMIN__SECURITY__CORS__ALLOW_ORIGINS=https://admin.example.com # 仅跨域部署需要，精确 Origin
APPADMIN__LOG__OUTPUT=both         # stdout|file|both
```

IP 白名单匹配服务看到的 TCP 对端地址，且**不采信 `X-Forwarded-For`**；登录限流、会话 IP 绑定与审计则使用可信代理链解析出的真实客户端 IP（`APPADMIN__SECURITY__TRUSTED_PROXIES` 内的 peer 才可信）。CORS 只约束浏览器跨域，不替代网络访问控制；浏览器写请求还必须带同源或白名单 `Origin`。`/health` 为容器与集群探针保留，不受 IP 白名单限制。

**设备指纹**：所有 `/api/*` 请求必须带 `X-Device-Id`（16–128 位 `[A-Za-z0-9_-]`）。浏览器 SPA 自动生成并持久化在 localStorage，服务端只存其与 UA/语言组成的 SHA-256 指纹并绑定会话；`device_binding=strict` 时更换设备、清存储或 UA 变化会要求重新登录。脚本调用需先带该头登录，之后每次请求同时带 cookie 与相同设备 ID。

## 测试

```bash
cd app-go/app-admin && go test ./...   # gofmt / vet / build 同 CI（.github/workflows/ci-app-admin.yml）
```

## 目录

```
main.go / default.yaml / Dockerfile   # 入口 + 嵌入配置 + 多阶段构建（distroless）
internal/config     YAML + APPADMIN__ env + godotenv + Validate + Normalize*（可选平面半配置清理）
internal/dto        纯 JSON 响应 DTO（契约形状，无依赖；service 组装 / router 序列化）
internal/db         主库 GORM MySQL + 可选 PayDB 第二连接（PayInit/PayPing/PayAvailable）+ 仅自有三表 Migrate
internal/logger     slog + Gin 访问日志/恢复 + lumberjack 文件 sink
internal/model      自有表 + 共享表只读映射（绝不迁移）+ pay_* 只读映射
internal/repo       查询（users/shares/audit/会话/支付域）+ 受控写（审核列 / 账户）
internal/service    业务装配（分页/DTO/审核语义/登录会话/限流/沙箱代理审计/支付查询/补偿开通/JSONL 资金审计/账户规则）
internal/payops     app-pay internal 退款复核端点客户端（apikey + 错误 detail 透传）
internal/sandbox    app-sandbox /internal/admin/* 出站客户端（X-Admin-Token + 错误映射）
internal/router     Gin 路由（/health + /api/*）+ session 闸门 + admin 闸门 + pay/refund 闸门 + CORS/安全头
```
