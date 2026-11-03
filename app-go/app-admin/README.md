# app-admin — 云盘分享审核管理后台（Go + Gin）

MindBase 的**分享审核**后台服务（plan/1.0.16）：直连共享 bilirag MySQL，只读用户账户 / 分享元数据，唯一写操作是 `cloud_shares` 的 4 个审核列（ban / unban / approve）。配套前端 `frontend-admin/`（Vite + React + antd）。

- 使用与 API 文档：[docs/app-admin.md](../../docs/app-admin.md)；设计契约：[plan/1.0.16-ShareModeration](../../plan/1.0.16-ShareModeration/1.0.16-ShareModeration.md)
- 架构/红线：根 `AGENTS.md` §2.21
- Go API 端口 `8016`，**仅回环**、不经主站 APISIX/nginx；完整后台入口是 Compose `app-admin`（UI :3001）+ `app-admin-api`（本服务 API :8016）

## 职责边界

- **读**：`users` / `user_profile` / `rbac_user_role` / `rbac_role` / `cloud_shares` / `cloud_files` / `cloud_folders`（仅元数据）
- **写**：`cloud_shares.moderation_status/reason/time/by`（同事务写 `admin_audit`）
- **自有表**（`Migrate` 只 `CREATE TABLE IF NOT EXISTS`，守护测试锁定）：`admin_user` / `admin_session` / `admin_audit`
- ❌ 无 MinIO/对象读取、无 `AutoMigrate`/ALTER 共享表、不触碰 `is_revoked`；文件内容仅经 app-cloud 内部审核预览端点按需读取（**审核员可查看任意分享**，每次预览落审计，无下载）
- **沙箱管理（plan/1.0.19）**：不直连 `sandbox_*` 表，`/api/sandbox/*` 全部代理到 app-sandbox `/internal/admin/*`（`X-Admin-Token`）；写操作仅 admin 且落本服务审计（`sandbox.execution.cancel` / `sandbox.lease.release`），沙箱状态以控制层为唯一真相

## 沙箱控制台代理（plan/1.0.19 §四）

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
APPADMIN__SEED__USERNAME=admin     # 只插缺失
APPADMIN__SEED__PASSWORD=app-admin # 生产务必覆盖
APPADMIN__SESSION__TTL_MINUTES=720
APPADMIN__SECURITY__IP_ALLOWLIST=192.0.2.10/32,10.20.0.0/16 # 可选；空=由部署网络边界控制
APPADMIN__SECURITY__CORS__ALLOW_ORIGINS=https://admin.example.com # 仅跨域部署需要，精确 Origin
APPADMIN__LOG__OUTPUT=both         # stdout|file|both
```

IP 白名单匹配服务看到的 TCP 对端地址；当前不信任 `X-Forwarded-For`。经过 SSH 隧道、容器 NAT 或代理访问时，应用看到的可能是隧道/代理地址而非浏览器真实 IP，此时应在 SSH、防火墙或可信入口代理处限制真实来源。CORS 只约束浏览器跨域，不替代网络访问控制；浏览器写请求还必须带同源或白名单 `Origin`。`/health` 为容器与集群探针保留，不受 IP 白名单限制。

## 测试

```bash
cd app-go/app-admin && go test ./...   # gofmt / vet / build 同 CI（.github/workflows/ci-app-admin.yml）
```

## 目录

```
main.go / default.yaml / Dockerfile   # 入口 + 嵌入配置 + 多阶段构建（distroless）
internal/config     YAML + APPADMIN__ env + godotenv + Validate
internal/dto        纯 JSON 响应 DTO（契约形状，无依赖；service 组装 / router 序列化）
internal/db         GORM MySQL + 仅自有三表 Migrate + Ping
internal/logger     slog + Gin 访问日志/恢复 + lumberjack 文件 sink
internal/model      自有表 + 共享表只读映射（绝不迁移）
internal/repo       查询（users/shares/audit/会话）+ 唯一受控写 UPDATE
internal/service    业务装配（分页/DTO/审核语义/登录会话/限流/沙箱代理审计）
internal/sandbox    app-sandbox /internal/admin/* 出站客户端（X-Admin-Token + 错误映射）
internal/router     Gin 路由（/health + /api/*）+ session 闸门 + admin 闸门 + CORS/安全头
```
