# app-pay-admin — 支付后台管理

> 独立 Go + Gin 后台管理服务：支付域**只读运营查询** + 唯一写操作（会员补偿开通）。全直连 `app_pay` 库，运行时不依赖 app-pay / APISIX。工程惯例对齐 app-task（嵌入式 WebUI、单二进制）。

## 定位与红线

- **数据访问**：全直连 `app_pay` 库；`pay_*` 表 schema 归 Java（app-pay）所有，**本服务绝不 AutoMigrate**（有守护测试 `TestMigrateOnlyCreatesAdminTables`），唯一自有表是 `payadmin_user`（管理账户）
- **写操作红线**：唯一写操作是会员补偿开通（grant）。禁止在本服务实现退款/关单/SKU 改价等其余资金写操作——需先在 app-pay 侧建端点保证审计一致
- **端口/暴露**：8003，compose 仅 `127.0.0.1` 回环绑定，**不经 APISIX**，浏览器直连

## 补偿开通（grant）

`POST /api/grants`（admin 角色）：`{"uid": >0, "duration_days": 1..3650, "reason": 必填}`。

Go 侧**复刻** app-pay `MembershipService.extend` 语义：事务内 `SELECT ... FOR UPDATE` 会员行 → 无记录则新建（tier=VIP）→ 未到期从 `expire_at` 顺延、已过期从 now 起算 → 同事务写 `pay_membership` + `pay_membership_event(type=ADMIN_GRANT)`，`last_order_no` 保留。

审计双留痕：

1. `pay_membership_event.reason` 以 `[操作人]` 前缀记录（Java 表无 operator 列，schema 不漂移）
2. 自有 JSONL `logs/pay-admin-audit.jsonl`（`MEMBERSHIP_EXTENDED`，365 天，lumberjack 轮转）——弥补绕过 Java PayAuditLogger 的缺口

## 鉴权

| 机制 | 说明 |
|------|------|
| 账户 | `payadmin_user` 表 + bcrypt；种子账户 **`admin` / `app-pay-admin`**（仅当表空时播种，首登后在「账户」页改密） |
| 会话 | 内存 session + **HttpOnly + SameSite=Strict cookie `payadmin_session`**（TLS 下自动 Secure），TTL 默认 12h |
| 角色 | `admin`（补偿开通/账户管理）/ `viewer`（只读）；grants 与用户管理仅 admin |
| Master token | `PAYADMIN__WEBUI__TOKEN`（`X-WebUI-Token` 头或 Bearer，等价 admin，常量时间比对） |
| 限流 | 每 IP 每分钟 10 次登录失败 → 429 + `Retry-After` |
| 加固 | `SetTrustedProxies(nil)` 防 XFF 伪造；nosniff / `X-Frame-Options: DENY` / CSP `frame-ancestors 'none'` / `/api/*` no-store；`webui.enabled=false` 整体关闭 |

## 界面与 API

WebUI 为 go:embed **html/template 服务端渲染**（无前端框架/构建链；POST-Redirect-GET + `?ok=`/`?err=` flash；MinIO 式顶栏 + 水平 Tab、阿里云式高密度表格）。

| 方法 | 路径 | 角色 | 说明 |
|------|------|------|------|
| GET/POST | `/login`、`/logout`（+ `/api/login` `/api/logout`） | — | 登录/登出（SSR 表单流 + JSON API 双载体） |
| GET | `/orders`、`/orders/{order_no}`、`/orders/{order_no}/callbacks`（+ `/api/orders*`） | viewer+ | 订单列表（`uid`/`status`/渠道/订单号/时间范围过滤，默认 `ORDER BY id DESC` 主键序）/ 详情 / 回调流水（脱敏报文 + 验签与处理结论） |
| GET | `/memberships`、`/memberships/{uid}/events`、`/events` | viewer+ | 会员查询（懒过期 active）/ 单人事件流 / 全局事件流（ADMIN_GRANT 审计） |
| GET | `/products` | viewer+ | SKU 目录（只读；改价走 app-pay 运营改库流程） |
| GET/POST | `/grants` | admin | 补偿开通 |
| GET/POST | `/users`、`/users/{id}/password`、`/users/{id}/delete`（+ `/api/users*`） | admin | 控制台账户管理（不能删自己/最后一个 admin） |
| GET | `/health` | — | 探活 |

JSON API 与 SSR 页面一一对应（`/api/*` 前缀），错误体 `{"detail": ...}`。

## 配置

三层合并：`default.yaml`（go:embed 嵌入）← `-config` 覆盖层（`config.dev.yaml` 本地 `go run .` 自动探测 / `config.docker.yaml` 镜像内）← `PAYADMIN__` 环境变量（最高）。另经 godotenv 读项目根 `.env`。`config.Validate` fail-loud：`rdbms.url` 必填、cert/key 必须成对。

```bash
PAYADMIN__RDBMS__URL=mysql+aiomysql://app_pay:app-pay@app-pay-mysql:3306/app_pay
PAYADMIN__WEBUI__TOKEN=...            # 可选 master token
PAYADMIN__WEBUI__SESSION_TTL_MINUTES=720
PAYADMIN__SERVER__TLS__ENABLED=...    # 见下
PAYADMIN__SERVER__TLS__CERT / _KEY / _CERT_DIR
PAYADMIN__SECURITY__CORS__ALLOW_ORIGINS=...   # 逗号分隔，仅跨域调 /api/* 需要
PAYADMIN__TIMEZONE=Asia/Shanghai      # 与 app-pay JVM 对齐（DSN loc=Local）
PAYADMIN__AUDIT__FILE=/app/logs/pay-admin-audit.jsonl
```

**TLS（可选）**：默认关（HTTP 回环）。`PAYADMIN__SERVER__TLS__ENABLED=true` 后两种模式——cert/key 成对提供 = 显式文件（变更自动重载、临期告警）；**双双留空 = 自动生成自签开发证书**（Go 原生 ECDSA P-256，825 天，重启复用），Rotator 每日巡检：余量 <30 天自动重生成并热切换、文件删除自愈。可选 mini-CA 无告警流程：`scripts/gen-dev-cert.sh|.ps1`。TLS 下 cookie 自动 Secure。

## 启动

```bash
# Docker（profile pay-admin；depends_on app-pay-mysql）
docker compose --profile pay-admin up -d --build app-pay-admin

# 本地（模块模式下 go run，自动加载 config.dev.yaml）
cd app-pay-admin && go run .
```

打开 `http://127.0.0.1:8003`，默认账户 `admin` / `app-pay-admin`，首登改密。

## 测试

```bash
cd app-pay-admin && go test ./...    # 31 个测试，内存 SQLite + httptest，无需真实 MySQL
```

覆盖：API 过滤与权限、grant 语义三例（新建/活跃顺延/过期起算）、SSR 登录流与页面门禁、master token、登录限流、安全响应头、角色闸门、配置覆盖优先级、迁移守护、证书轮换。

详细设计：`plan/1.0.9-PayAdmin/1.0.9-PayAdmin.md`（本地文档，不入 git）。
