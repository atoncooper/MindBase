# app-pay-admin — 支付后台管理（Go + Gin）

MindBase 支付域（app-pay）的独立后台管理服务：订单 / 会员 / 权益事件 / 回调流水查询 + 会员补偿开通。

- **UI = Go html/template 服务端渲染**（`web/templates/`，表单直提 + POST-Redirect-GET + flash 消息，无前端框架/无构建链）；风格参照 MinIO 控制台（顶栏 + 水平 Tab）与阿里云控制台（高密度表格/筛选条/状态点）。
- **`/api/*` JSON 保留**给脚本与 master-token 调用方（与页面共用同一套账户与会话）。
- 设计文档：[plan/1.0.9-PayAdmin/1.0.9-PayAdmin.md](../plan/1.0.9-PayAdmin/1.0.9-PayAdmin.md)；架构与边界见根 `AGENTS.md` §2.9。

## 页面一览

| 路由 | 说明 |
|------|------|
| `/login`（GET/POST） | 登录（表单提交，失败原页报错） |
| `/orders` → `/orders/{order_no}` | 订单筛选列表 / 详情 + 渠道回调流水 |
| `/memberships` → `/memberships/{uid}/events` | 会员查询（uid 精确卡） / 单人权益事件 |
| `/events` | 全局权益事件流（uid/type 筛选，ADMIN_GRANT 审计） |
| `/products` | SKU 目录（只读） |
| `/grants`（GET/POST） | 补偿开通表单 + 最近 ADMIN_GRANT 记录（admin） |
| `/users`（GET + POST 创建/改密/删除） | 控制台账户管理（admin） |

## 启动

配置分三层（后者覆盖前者，只写差异项即可，不用改来改去）：

```
default.yaml（嵌入二进制，基础默认）
    ←  -config 指定的覆盖层文件
    ←  PAYADMIN__ 环境变量（最高）
```

| 形态 | 覆盖层 | 说明 |
|------|--------|------|
| 本地 dev | `config.dev.yaml` | 直连宿主映射的 app-pay-mysql（127.0.0.1:3307），debug + 文本日志 |
| Docker | `config.docker.yaml` | 已 COPY 进镜像；DB 连接由 compose 注入 `PAYADMIN__RDBMS__URL` |

### 方式一：本地 dev（go run）

> ⚠️ 必须**以模块方式**运行：`go run .`（文件模式 `go run main.go` 不在模块上下文里，会报
> `package app-pay-admin/... is not in std`）。

```powershell
cd app-pay-admin
go run .          # 自动探测并加载工作目录下的 config.dev.yaml
```

三种等价写法（任选）：裸 `go run .`（自动探测）、`go run . config.dev.yaml`（位置参数）、
`go run . -config config.dev.yaml`（显式 flag）。启动日志会打印 `[CONFIG] overlay loaded`
表明实际加载了哪个文件。不需要再手动设任何环境变量；DSN 口令取自 `config.dev.yaml`
（默认 `app-pay`，与根 `.env` 的 `PAY_MYSQL_PASSWORD` 保持一致即可）。

### 方式二：Docker（推荐日常使用）

```bash
# 从项目根目录（profiles 显式 opt-in；depends_on 自动等 app-pay-mysql 健康后启动）
docker compose --profile pay-admin up -d --build app-pay-admin
```

浏览器打开 **http://127.0.0.1:8003**（仅回环绑定，不经 APISIX）。
compose 已带 `command: ["-config", "config.docker.yaml"]` 并注入 DB 连接，无需其他配置。

两种形态都会**校验 `rdbms.url`**：缺 DSN 时启动即报错退出（fail loud），不会静默起一个连不上库的服务。

## TLS（HTTPS）与跨域（CORS）

**TLS（可选，默认关闭 = 纯 HTTP 回环）**

```bash
# 方式一（零配置）：开启 TLS 但不指定证书 → 启动时自动生成自签开发证书并保存
#   到 certs/auto.crt|auto.key（825 天，未到期重启直接复用，无需任何脚本）
#   运行期自动轮换：每日巡检，余量 <30 天自动重生成并热切换（无需重启）
PAYADMIN__SERVER__TLS__ENABLED=true go run .

# 方式二（无浏览器告警）：mini-CA 流程，信任 certs/ca.crt 后不再弹警告
bash scripts/gen-dev-cert.sh     # Windows PowerShell: scripts/gen-dev-cert.ps1
PAYADMIN__SERVER__TLS__ENABLED=true PAYADMIN__SERVER__TLS__CERT=certs/admin.crt PAYADMIN__SERVER__TLS__KEY=certs/admin.key go run .
```

- 启用后登录 cookie 自动带 `Secure`；明文 HTTP 请求被拒（Go TLS 内置行为）。
- 自动证书由 Go 原生生成（ECDSA P-256，SAN 含 localhost/127.0.0.1/::1/主机名/app-pay-admin，CA:TRUE 可导入信任区）；**不依赖 openssl**。
- **自动轮换**：`tls.Config.GetCertificate` + 每日巡检——自动模式余量 <30 天自动重生成并热切换（新连接立即用新证书，无需重启，文件被删自愈重建）；显式模式文件变化（外部续期）自动重载，临期仅告警需运维换发。
- `cert` 与 `key` 只给一个 → 启动即报错（须成对或同时留空）。
- 容器内启用：挂载证书卷 + 设置同名 env（见 docker-compose 注释）；自动证书默认写容器内 /app/certs（重建容器会重新生成，挂卷可持久化）。生产挂正式 CA 签发证书。
- Windows curl 校验自签证书需加 `--ssl-no-revoke`（schannel 吊销检查限制，非证书问题）。

**跨域（CORS，可选）**

控制台本身同源访问，无需 CORS。仅当有跨域前端/工具页要带 cookie 调 `/api/*` 时配置白名单：

```
PAYADMIN__SECURITY__CORS__ALLOW_ORIGINS=https://a.example.com,https://b.example.com
```

精确匹配 Origin 才回显 `Access-Control-Allow-Origin` 并带 `Allow-Credentials: true`；预检 OPTIONS 直接 204。

## 首次登录

- 种子账户：`admin` / `app-pay-admin`（仅在 `payadmin_user` 表为空时播种）
- **首次登录后请立即在「账户」页改密**；`PAYADMIN__WEBUI__TOKEN` 为可选 master API token（等价 admin，供脚本调用 `/api/*`）

## 测试

```bash
go test ./...   # glebarez 内存 SQLite + httptest，无需真实 MySQL
```
