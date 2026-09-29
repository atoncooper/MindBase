# app-task

MindBase **定时出题任务执行器**(Go,自写 DB 轮询调度,无 xxl-job/pyxxl)。

> 📚 深入文档：[docs/cluster.md](docs/cluster.md)（集群与分布式一致性）·
> [docs/cli.md](docs/cli.md)（at 命令行参考）

## 定位

`app-task/` 负责定时出题任务的**执行**:接收任务注册 -> DB 轮询调度 -> 到时调主 app 用纯 LLM 生成题目 -> HTML 邮件发给用户+抄送人 -> 接收用户答题 / 超时发未完成语录。

- **agent 在主 app**(`app/agent/task_quiz/`),不在 app-task
- ❌ 不 `import app/`;❌ 不接 AgentHarness / agent / rag / LangGraph
- ❌ 不依赖 xxl-job / pyxxl(已移除,改用内置 DB 轮询 scheduler)
- ✅ 独立 MySQL 实例(`app_task` 库,schema 启动时 `db.Migrate()` 自建;不共享主 app MySQL/Mongo)
- ✅ 经 APISIX HTTP 调主 app 出题端点
- ✅ 独立进程、独立端口(8001)、独立配置、单二进制(Go distroless)
- ✅ **内置 WebUI 控制台**(go:embed 单二进制,见下文「WebUI 控制台」)

## 业务链路

```
主 app task-quiz agent --HTTP /tasks/register--> app-task(MySQL 存 pending 任务)
                                                        |
                          scheduler goroutine 每 30s 轮询 trigger_time 到期
                                                        v
app-task --HTTP /internal/quiz/generate-llm (经 APISIX)--> 主 app (纯 LLM 出题)
app-task --渲染 HTML + 入队--> notification worker --Resend--> 用户+抄送人
app-task --设 deadline + mark sent--> scheduler 轮询 deadline 到期
用户登录 --> /tasks/{id}/answer --> 主 app (判题/入库/状态流转 sent->completed)
app-task --scheduler 轮询 deadline--> 超时 mark overdue + 未完成语录
```

## 目录结构

```
app-task/
├── go.mod / go.sum
├── Dockerfile                 # Go 多阶段构建(distroless + time/tzdata)
├── docker-compose.yml         # 独立启动(app-task + 自有 MySQL,不拉起主栈)
├── .env.example               # 独立部署覆盖项(复制为 .env 使用)
├── default.yaml               # 配置(嵌入二进制,APPTASK__ env 覆盖)
├── README.md
├── main.go                    # 入口:config + DB(独立 MySQL,db.Migrate 建表) + scheduler + worker + Gin + graceful shutdown
├── web/                       # 嵌入式 WebUI 控制台(go:embed,无构建步骤)
│   ├── web.go                 #   embed.FS
│   └── assets/                #   index.html + app.css + app.js(SPA)
├── internal/
│   ├── config/config.go       # YAML + APPTASK__ env + godotenv
│   ├── db/db.go               # GORM MySQL(DSN 转换 aiomysql->pymysql)+ schema 自建
│   ├── model/model.go         # GORM 模型(task/task_log/email_queue/script/script_log)
│   ├── repo/
│   │   ├── task.go            # CRUD + conditional_update 状态机 + list_due/list_overdue + 管理查询
│   │   ├── task_log.go        # 执行溯源日志(含跨任务最近日志)
│   │   ├── email_queue.go     # 邮件队列 scan + mark_sent/failed + 管理查询/重试
│   │   └── script.go          # 脚本版本 + 审计日志 + 启停
│   ├── service/
│   │   ├── task_service.go    # register/complete
│   │   ├── scheduler.go       # DB 轮询调度(30s tick)
│   │   ├── email_service.go   # 邮件投递 worker(重试/崩溃恢复)
│   │   ├── util.go            # 共享 helper
│   │   └── template/          # 邮件模板(Go html/template)
│   ├── executor/              # 执行器:http + lua(GLUE 式脚本)
│   ├── queue/                 # 持久化队列(WAL)
│   └── router/                # Gin 路由:router.go + task.go + complete.go + script.go + email.go
│       └── webui.go/console.go # 嵌入式控制台 API + 静态资源(见「WebUI 控制台」)
```

> APISIX 网关配置在项目根 `apisix/`（config.yaml + apisix.yaml + apisix.dev.yaml），与 `nginx/` 平级。

## 启动

### Docker(与主 app 一起)

```bash
docker compose --profile task up -d --build
```

启动的服务:apisix + app-task + backend + mysql + mongo + redis。

### Docker(独立启动,不拉起主栈)

```bash
cd app-task && docker compose up -d --build
```

只启动 `app-task` + 它自己的 MySQL(`app-task-mysql`,utf8mb4,schema 由 `db.Migrate()` 自建,数据在独立 volume,不与主栈共享)。启动后 WebUI 控制台在 `http://localhost:8001/`。

- **配置覆盖**:复制 `app-task/.env.example` 为 `.env`(compose 自动加载,注入 `APPTASK__*` 环境变量,如 `APPTASK__EMAIL__API_KEY` / `APPTASK__WEBUI__TOKEN`)
- **登录默认开启**:控制台走用户名+密码登录,首次启动自动创建默认管理员 `admin` / `app-task-admin`;compose 还自带一个开发用 master API 密钥(见 `docker-compose.yml` 的 `APPTASK__WEBUI__TOKEN`,供脚本/API 调用,可用 `.env` 覆盖或留空)。⚠️ 生产务必在「账户」页改掉默认 admin 密码
- **端口冲突**:与主栈同时运行会抢 8001--先停主栈的 app-task(项目根 `docker compose stop app-task`)或改 `APP_TASK_PORT`
- **任务执行期访问主栈**:app-task 启动不依赖主 app,但任务的 `executor_url` 若指向 `apisix`/`backend` 主机名,需取消 `docker-compose.yml` 中 `mind-base-net` 外部网络的注释,把容器加入主栈网络

### 本地开发

```bash
# 从项目根
go run ./app-task
# 或构建单二进制
cd app-task && go build -o app-task . && ./app-task
```

> app-task 使用独立 MySQL 实例(docker `app-task-mysql`,库 `app_task`),schema 由 `db.Migrate()` 自建,不共享主 app 的 MySQL/Mongo;出题业务(业务行 `quiz_task`/`quiz_task_answer` + 题库 Mongo `task_quiz_questions`)在主 app(executor 侧)。

## 配置

`app-task/default.yaml`(嵌入二进制)提供默认值。**两种注入方式**（可叠加，结果一致）：

1. **YAML 占位符**（对齐主 app loader）：值写成 `${VAR}`（未设 → 空）或 `${VAR:默认}`（未设 → 默认值），加载时从环境变量展开——`.env` 先于展开加载，所以密钥可只放 `.env`，YAML 里只留占位符。已用于 `rdbms.url` / `email.api_key` / `webui.token` / `redis.url` / `tls.cert/key` / `http_executor.ca_file`；
2. **环境变量覆盖**（前缀 `APPTASK__`,双下划线嵌套）：

```bash
APPTASK__RDBMS__URL=mysql+aiomysql://app_task:app-task@app-task-mysql:3306/app_task  # 独立 MySQL(schema 自建)
APPTASK__MONGO__URI=mongodb://admin:pass@mongo:27017/?authSource=admin
APPTASK__MONGO__DB_NAME=MindBase
APPTASK__APP__BASE_URL=http://apisix:9080        # 经 APISIX 调主 app
APPTASK__SECURITY__SERVICE_KEYS=key1,key2        # 引导 API 密钥(逗号分隔;缺省回退 APPTASK__APP__CONSUMER_KEY)
                                                  # 保护 /tasks/*、/scripts*、/internal/*(app-task 自身校验,
                                                  # 不依赖 APISIX);控制台「API 密钥」页可生成/吊销更多
APPTASK__EMAIL__API_KEY=re_xxx                    # Resend
APPTASK__WEBUI__TOKEN=xxx                         # WebUI 控制台访问令牌(生产必设)
APPTASK__WEBUI__SESSION_TTL_MINUTES=720           # 登录会话有效期(分钟,默认 720)
APPTASK__WEBUI__SESSION_STORE=memory              # memory | redis(多实例控制台)
APPTASK__CLUSTER__ADMISSION=open                  # open | pre_approved(须先预登记,见集群文档)
APPTASK__SCHEDULER__WEIGHT=4                      # 本节点派发份额(manager 等兼职节点调低)
APPTASK__SERVER__TLS__ENABLED=true                # 容器内 HTTPS(默认关;证书见下文「HTTPS」)
APPTASK__TIMEZONE=Asia/Shanghai
```

> app-task 不读主 `app/config/` 的 YAML,但读项目根 `.env`(`APPTASK__` 前缀变量 + 共享密钥,godotenv——先于 `${}` 展开加载)。新增配置项须同步更新 `default.yaml`;`.env` 只放密钥/敏感项,普通配置留在 `default.yaml` 作字面量默认值。

## API 端点

### 服务间 / 用户端点（经 APISIX）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/tasks/register` | 主 app agent 调用,注册任务(uid/prompt/trigger_time/cc_emails/incomplete_message) |
| GET | `/tasks/{task_id}` | 任务详情(task + quiz + answer),X-Uid 鉴权 |
| GET | `/tasks` | 用户任务列表,X-Uid 鉴权 |
| POST | `/internal/script/run` | 立即执行脚本 `{script_id, payload}`(同步返回 run_id/status/error/logs/duration_ms;结果落 script_run,与定时派发同管线;需 API key) |
| GET | `/health` | 健康检查 |

### WebUI 管理端点（`webui.enabled=true` 时挂载,`/api/*` 需登录）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 根路径：已登录 302 `/console`，未登录 302 `/login` |
| GET/POST | `/login` | 登录页 + 表单提交（SSR；`POST /api/login` 为 JSON 等价端点） |
| POST | `/logout` | 登出（表单流，吊销会话并清 Cookie） |
| GET | `/assets/*` | 控制台静态资源（CSS 公开；模板源码不经此路由提供） |
| GET | `/console` | 仪表盘（仅登录会话可达，未登录 302 `/login`） |
| GET | `/console/tasks`(+`/new`,`/{task_id}`) | 任务列表（状态过滤/分页）/ 新建表单 / 详情溯源 |
| POST | `/console/tasks` | 表单创建任务（PRG → 详情页） |
| GET | `/console/logs` | 执行日志（`?task_id=` 过滤） |
| GET | `/console/scripts`(+`/new`,`/{id}`,`/{id}/edit`) | 脚本列表 / 新建 / 详情 / 编辑（保存即新版本） |
| GET/POST | `/console/scripts/{id}/run` | 试运行表单 / 立即执行（同步跑一次,结果落 script_run） |
| GET | `/console/scripts/{id}/runs/{run_id}` | 运行结果页（status/耗时/ctx.log 输出/payload） |
| POST | `/console/scripts`(+`/{id}/toggle`) | 表单保存脚本 / 启停（审计） |
| GET | `/console/emails` | 邮件队列（状态过滤/分页） |
| POST | `/console/emails/{email_id}/retry` | 失败邮件重新入队 |
| GET/POST | `/console/users`(+`/{id}/password`,`/{id}/delete`) | 账户管理（仅 admin） |
| POST | `/api/login` | 登录（JSON）：`{username, password}` 换会话（HttpOnly Cookie + 响应体）；`{token}` 也可（master API 密钥） |
| POST | `/api/logout` | 登出：吊销当前会话并清除 Cookie |
| GET | `/api/info` | 服务信息 + 当前用户（`user.username/role/is_admin`） |
| GET | `/api/stats` | 仪表盘统计(任务/日志/邮件/脚本计数) |
| GET | `/api/tasks` | 全量任务列表(跨 uid,支持 `?status=&limit=&offset=`) |
| GET | `/api/tasks/{task_id}` | 任务详情 + 执行日志 |
| POST | `/api/tasks` | 注册任务(控制台;uid 省略时自动归属当前登录控制台用户,显式传入则用传入值;master token 会话缺省 0) |
| GET | `/api/logs` | 最近执行日志(`?task_id=` 过滤) |
| GET | `/api/emails` | 邮件队列(`?status=&limit=&offset=`) |
| POST | `/api/emails/{email_id}/retry` | 失败邮件重新入队(failed→pending) |
| GET | `/api/scripts` | Lua 脚本列表(最新版本) |
| GET | `/api/scripts/{script_id}` | 脚本详情(源码 + 版本历史 + 审计日志) |
| POST | `/api/scripts` | 创建/更新脚本(保存即新版本;`script_id` 省略时服务端自动生成 UUID) |
| POST | `/api/scripts/{script_id}/toggle` | 启停脚本(不升版本,记录审计) |
| GET | `/api/users` | 账户列表（仅 admin） |
| POST | `/api/users` | 添加账户 `{username, password, role}`（仅 admin） |
| POST | `/api/users/{user_id}/password` | 修改密码（仅 admin） |
| DELETE | `/api/users/{user_id}` | 删除账户（仅 admin；不能删自己/最后一个 admin） |

> 页面挂在 `/console` 前缀下：根路径空间留给 APISIX 网关契约端点（`/tasks/*`、`/scripts*`），互不挤占。

> ⚠️ `POST /tasks/{task_id}/answer`（答题提交）已由主 app 提供（判题/入库/状态流转
> 属业务逻辑），经 APISIX `/tasks/*/answer`（priority 100, forward-auth）转发到 backend。
> app-task 只负责调度执行与通知，不处理答题。

## WebUI 控制台

app-task 内置一个 **go:embed 单二进制的 SSR 管理控制台**（html/template + Gin，服务端渲染；UI 基于 **Bootstrap 3.4.1**（vendor 进 assets，MIT）+ 项目主题层 `app.css`，无构建步骤、无独立前端服务），交互走经典 **POST-redirect-GET + flash 消息**（`?ok=/?err=`），模式与 app-pay-admin 控制台一致：

- **仪表盘**：任务/执行日志/邮件队列/脚本统计卡片 + 最近任务与最近日志
- **任务管理**：全量任务列表（状态过滤/分页）、注册新任务（表单页；**属主 uid 自动 = 当前登录控制台用户**，无需手输）、任务详情（payload + task_log 溯源）
- **执行日志**：跨任务的最新执行记录，可按 task_id 过滤
- **Lua 脚本**：脚本列表/在线编辑（保存即新版本、立即生效；**script_id 由系统生成 UUID，不是用户输入**，编辑时只读保留；**编辑器为 vendored CodeMirror 5**：Lua/JSON 语法高亮、括号匹配 + 自动补全、活动行高亮、Ctrl-/ 行注释、Ctrl+S 保存、行号 + Ln/Col 状态栏；任务 payload/试运行/只读视图共用同一引擎）、启停、版本历史 + 审计日志、**试运行**（填 payload 立即执行一次，回显 ctx.log 输出/错误/耗时；也有 `/internal/script/run` 内部端点供服务按 script_id 调用，结果都落 script_run 可回溯）
- **邮件队列**：状态过滤、失败邮件一键重试

**访问方式**：`http://<host>:8001/console`（开启 `server.tls` 后用 `https://`，见「HTTPS」）。前端不依赖 APISIX；但 `/api/*` 管理端点暴露全部数据，控制台**始终需要登录**：

```bash
APPTASK__WEBUI__SESSION_TTL_MINUTES=720       # 登录会话有效期（默认 720 分钟）
APPTASK__WEBUI__TOKEN=your-token              # 可选：master API 密钥（脚本/API 调用 /api/* 用）
```

**登录模型（用户名+密码 + 独立登录页 + 服务端页面门禁）**：

- 账户存 app-task 自己的 MySQL `webui_user` 表（bcrypt 哈希）；**首次启动自动创建默认管理员 `admin` / `app-task-admin`**
- 未登录访问控制台页面会被服务端 **302 到独立登录页 `/login`**（登录页自包含，不含任何控制台 HTML/数据；模板源码也从静态路由隐藏，未登录拿不到页面外壳）
- 登录页表单 `POST /login` 校验（bcrypt）换取短期**会话**（crypto/rand 32 字节），写入 **HttpOnly + SameSite=Strict Cookie**（TLS 下自动加 `Secure`）--浏览器 JS 不可读（防 XSS 窃取）、跨站请求不携带（防 CSRF）、凭据不落浏览器存储
- 会话绑定用户身份；会话过期后任何页面请求 302 回 `/login`、任何 `/api/*` 调用返回 401；顶栏「退出」吊销会话并跳回登录页
- **账户管理（仅 admin）**：控制台「账户」页可添加/删除账户、改密码；`member` 角色可操作控制台但不能管理账户；不能删除自己、不能删除最后一个 admin
- 脚本/API 调用方不走页面：用 `APPTASK__WEBUI__TOKEN`（master API 密钥，常量时间比对，等价 admin）或会话 ID 作为 `X-WebUI-Token` / `Authorization: Bearer` 头
- ⚠️ **生产务必修改默认 admin 密码**（控制台「账户」页对 admin 改密），否则任何知道默认凭据的人都能进控制台

**防护措施**：

- **防爆破限流**：同一来源 IP 每分钟最多 10 次失败凭证尝试（登录端点与 `/api/*` 门禁共享计数，无法绕过），超限返回 429；`SetTrustedProxies(nil)` 确保无法伪造 `X-Forwarded-For` 换 IP
- **安全响应头**：`X-Frame-Options: DENY` + `Content-Security-Policy: frame-ancestors 'none'`（防点击劫持）、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`/api/*` 一律 `Cache-Control: no-store`
- **CORS**：默认仅放行 `security.cors.allow_origins`（`http://localhost:3000`）中的来源，反射 Origin 并附带 `Vary: Origin`；`X-WebUI-Token`/`X-Operator` 已加入预检允许头
- **审计**：脚本上传/启停的 `operator` 自动填当前登录用户名

`webui.enabled=false` 可整体关闭页面与 `/api/*`。

## HTTPS（TLS）

WebUI 与全部端点（`/api/*`、`/tasks/*`、`/health`）可整体切到 HTTPS，由 `server.tls` 控制（默认关 = 纯 HTTP）：

```bash
APPTASK__SERVER__TLS__ENABLED=true    # 开启 HTTPS（重启生效）
# 证书二选一：
#   ① 不配 cert/key —— 启动自动生成自签开发证书（ECDSA P-256，SAN 覆盖
#      localhost/app-task/127.0.0.1/::1，825 天），写入 cert_dir 的 auto.crt/auto.key；
#      有效期内重启复用，临期/文件丢失自动轮换（每日巡检，无需重启）。
#      把 auto.crt 导入系统信任链即可免浏览器告警。
#   ② 显式指定文件（生产：正式 CA 签发）：
APPTASK__SERVER__TLS__CERT=/app/certs/server.crt
APPTASK__SERVER__TLS__KEY=/app/certs/server.key
```

- **实现**：`internal/certgen`（与 app-pay-admin 同一套模式）——显式模式文件变化自动重载、临期告警；自动模式原子落盘（tmp+rename）+ 热切换（`GetCertificate`，新连接立即用新证书）
- **Cookie**：登录会话 Cookie 在 TLS 下自动携带 `Secure`（既有逻辑，无需配置）
- **compose**：`app-task` 服务已挂 `./app-task/certs:/app/certs`（证书持久化，重建容器不再换证书）；该目录已 gitignore（私钥敏感）
- **端口不变**：仍是 8001，`http://` 换成 `https://` 访问即可


## CLI（`at` 命令，docker 风格）

> 完整命令参考（flags/env/退出码/脚本化）见 [docs/cli.md](docs/cli.md)。

app-task 二进制本身就是 CLI（单二进制双角色，规范对齐 docker：`<名词> <动词> [flags]`）：

- **无参数 / `at serve`**：启动服务端（调度器 + API + 控制台，等价旧的 `go run ./app-task`）
- **其余命令为客户端**：HTTP 调用运行中的 app-task（`/api/*` 控制台面 + 接受控制台凭据的服务面端点）

```bash
# 服务端
at serve                      # 或直接 at（无参数）

# 客户端（凭据：master token 或 at_ 服务密钥；env AT_URL / AT_TOKEN / APPTASK__WEBUI__TOKEN）
at info                       # 服务信息 + 统计（对应 docker info）
at ps                         # 任务列表（= at task ls，对应 docker ps）
at task ls --status failed
at task create --type lua --script-id <uuid> --cron "0 23 * * *" --payload '{"a":1}'
at task create --executor-url https://exec:9000/run --trigger-time "2026-10-01 09:00:00"
at task inspect <task_id>     # 详情 + 日志（JSON）
at task logs <task_id>
at script ls
at script upload --file notify.lua --name 通知脚本   # 省略 --id 时系统生成 script_id
at script run <script_id> --payload '{"n":1}'        # 立即执行一次
at logs [--task-id xxx]       # 全局最近执行日志
at email ls --status failed
at email retry <email_id>
```

- 表格输出用 tabwriter 对齐；所有 ls/inspect 支持 `--json`（docker inspect 风格）
- `--url` / `--token` 全局 flags，env 回退链：flag > `AT_URL`/`AT_TOKEN` > `APPTASK__WEBUI__TOKEN` > 默认 `http://127.0.0.1:8001`
- 请求头同时携带 `X-WebUI-Token`（master token → /api/*）与 `X-API-Key`（at_ 密钥 → 服务面），未知凭据按服务端语义报 401
- `task create` 属主 uid 默认自动归属当前凭据（master token = 0），`--uid` 显式指定时才传

## API 密钥认证（service 面）

`/tasks/*`、`/scripts*`、`/internal/*` 由 app-task **自身**校验 API key（不依赖 APISIX——直连 8001 的请求同样被拦）。控制台 `/console/*`、`/api/*`、`/health` 不在此列。

- **凭据头**（三选一）：`X-API-Key: …` / `apikey: …` / `Authorization: Bearer …`
- **密钥来源**：①控制台「API 密钥」页生成（明文只显示一次，服务端只存 SHA-256）；②启动引导密钥 `APPTASK__SECURITY__SERVICE_KEYS`（逗号分隔，回退 `APPTASK__APP__CONSUMER_KEY`；APISIX 消费者密钥保持原样即可工作）；③控制台登录会话（管理页自身）
- **权限范围（scopes）**：生成时勾选 tasks / scripts / internal（对应三组路由前缀），越范围请求返回 403；控制台会话与引导密钥默认全范围
- **资源控制**：每密钥限流（次/分钟，0=不限，超限 429）、有效期（0=永不过期）、活跃密钥数量上限（50）、payload 上限（/tasks/register 与 /internal/script/run 64KB、/internal/email/send 256KB）
- **边界**：名称全局唯一（含已吊销——名称标识一把密钥的完整生命周期；DB 唯一索引兜底，存量重名行启动时自动加 `-dupN` 后缀迁移）；吊销立即生效；auth 失败按来源 IP 限流（10 次/分 → 429）
- **自助改密**：顶栏「改密」（任意登录用户，需验证当前密码）；admin 仍可在「账户」页重置他人密码
- **第三方 executor**：异步回调 `POST /internal/task/{id}/complete` 也需要密钥——为每个 executor 在控制台生成独立密钥并配置到其回调设置
- APISIX 用户路由（`/tasks`、`/tasks/*`）已由网关注入 `X-API-Key`（proxy-rewrite set），前端用户请求无需感知密钥

## 密钥管理（中心密钥库，ctx.secret）

第三方服务凭据（API key/token）存储在 app-task 自己的 MySQL `secret` 表，**AES-256-GCM 加密**（密钥 env `SECURITY__API_KEY_ENCRYPTION_KEY`，base64 32 字节，与主 app/app-auth 共用同一变量）。控制台「密钥管理」页（仅 admin）：

- **写入（write-only）**：添加/更新时录入明文，保存后**永不回显**（管理员也只能更新或删除）；每条密钥有独立 `secret_id`（UUID，创建时生成），**更新/删除按 ID 寻址**；名称全局唯一且创建后不可改（它是脚本读取句柄）
- **脚本访问**：`local token = ctx.secret('github_token')`，配合 `ctx.http_req` 自定义请求头调用外部 API：

```lua
function handle(ctx)
  local token = ctx.secret('github_token')
  local body, status = ctx.http_req({
    method = 'GET',
    url = 'https://api.github.com/user',
    headers = { Authorization = 'Bearer ' .. token },
  })
  -- body, status 或 nil, err
end
```

- **日志自动脱敏**：脚本运行期间取过的密钥值，出现在 `ctx.log`、失败信息、task_log、script_run 中一律替换 `***`（脚本故意打印也拿不到明文）
- **边界**：密钥数量上限 100；名称 `[a-z][a-z0-9_]`；未配置加密密钥时功能禁用（ctx.secret 报错）

## 调度模型(自写,无 xxl-job)

- **DB 轮询**:scheduler 每 30s(可配)认领一批到期任务并**并行派发**
  - `ClaimTasksBatch`:事务内读取 `status='pending' AND trigger_time<=NOW()` 的候选任务并整体置为 `dispatching`(MySQL 上 `FOR UPDATE SKIP LOCKED`,多实例读到互不相交的候选集;正确性由事务内 status 过滤保证)
  - 每个任务由独立 goroutine 派发,并发受两级闸门限制:全局 worker 池(`scheduler.workers`,默认 16)+ 按 executor_url 的并发闸(`scheduler.per_url_limit`,默认 8——单个坏掉的第三方执行器最多占自己的 8 个槽位)。池/闸饱和时任务**释放认领**回 pending,下个 tick 再试
  - 同步:2xx -> completed;非 2xx -> 按重试策略(指数退避,cap 5min);异步:202 -> running,等回调
  - `dispatching` 超 `scheduler.dispatching_timeout_seconds`(默认 120s)被任意实例回收回 pending(实例崩溃后任务自动重派,at-least-once);`running` 超过 10 分钟未回调判失败
- **回调**:异步 executor 完成后 POST `/internal/task/{task_id}/complete` -> running -> completed/failed,写 task_log
- **重启恢复**:基于 DB 状态,scheduler 启动时立即 tick 一次补执行过期任务,不丢
- **精度**:30s;多实例 tick 各带 0–interval/10 随机抖动错峰

## 集群(HA,多实例)

> 架构/一致性模型/运维 runbook 的完整文档见 [docs/cluster.md](docs/cluster.md)。

app-task 天然支持多实例部署(**无主架构**,所有实例对称跑同一套 tick,靠 DB 认领互斥):

- **互斥**:任务认领是条件更新(`WHERE status='pending'`),一个任务只会被一个实例执行;MySQL 实例数多时 SKIP LOCKED 让候选集天然分片
- **故障回收**:实例宕机后其 `dispatching` 认领(带 owner/claimed_at,可在控制台溯源)在超时后被其他实例收回重派
- **邮件队列同样集群安全**:投递前条件认领 `pending → sending`(claim 互斥),卡死(>2 分钟)自动回收重发——与任务调度同一套模式,双实例下不可能重复投递(at-least-once,投递幂等由收件侧判重)
- **加入节点（Web / CLI 两条入口）**：控制台「集群」页（或 `at node join --name worker-3 --weight 4`）**预登记**新节点（node_id/权重/登记人留痕，重复预登记幂等刷新；已 active 的 node_id 拒绝 409），即时生成可复制的加入指引（env 片段 + 启动/验证命令；**RDBMS 连接串永不经 API 回显**，占位符 + 从密钥渠道获取）；新节点首次心跳后自动从「待接入」转正。名册行 24 小时无心跳自动清理（预登记可随时重新生成）。默认任何能连 DB 的实例自动注册（joined_via=auto）。**准入闸门（可选）**：`cluster.admission: pre_approved` 时，未预登记的节点**拒绝启动**（fail-closed，日志指向加入入口），把"谁在集群里"变成显式治理——但要说清威胁模型：节点凭据就是共享 DB 凭据，持有者本就有全部读写权，预登记闸门防的是误配置与无序扩容，不是持库凭据的攻击者（那是 DB 凭据保管的职责）。
- **权重分摊（`scheduler.weight`，默认 1）**:每个节点的认领上限按 `weight ÷ 集群内最大存活权重` 缩放——4 台机器里 manager 设 1、其他三台设 4，manager 每 tick 只认领一个 worker 的 1/4；最大权重节点宕机后分母自动缩小，存活节点自动回满容量。权重经心跳写入名册（cluster_node.weight），仪表盘/`at node ls` 可见。注意权重是**容量上限的相对缩放**（任务少时先到先得），不是严格公平队列——那是预留的 SCFQ 队列（`task.weight`，M4）的职责。
- **节点名册与存活（`internal/cluster` 包）**:每个实例启动时在 `cluster_node` 表注册（node_id 与 task.owner 同一身份），每 10s 一次心跳，**3 次失联即判死**（存活是从 last_heartbeat 计算出来的，不落库）；优雅停机主动注销名册。调度器每个 tick 先查死节点：其 `dispatching` 认领**立即接管重派**（不用等 120s TTL；正确性由 fencing 保证，卡顿未死的节点会把结果按孤儿丢弃）。可观测：控制台仪表盘「集群节点」面板、`GET /api/cluster`、CLI `at node ls`；名册行保留 24h 供溯源后自动清理。
- **部署**:两种方式——
  1. 根 compose:`docker compose --profile ha up -d app-task-ha`(第二实例 `mind-base-app-task-ha`,控制台 `127.0.0.1:8011`,身份 `APPTASK__SCHEDULER__INSTANCE_ID` 已设);
  2. 独立 compose:`cd app-task && docker compose --profile ha up -d --build`(`app-task-ha`,同上)。
  滚动升级不缺 tick(未完成的认领由存活实例接管)
- **共享状态**:`webui.session_store: redis` 时,控制台会话/API 密钥一次性展示/每 IP 失败节流/每密钥限流计数全部走 Redis(`redis.url`,与主 app/app-auth 共享 `REDIS__URL`);默认 `memory` 单实例零依赖——两实例走各自回环端口时无需开启,若前面挂同一域名 LB,两实例同设 redis。限流与节流在 Redis 故障时 fail-open

### 一致性模型

- **总体策略**：刻意**不做分布式共识/分布式锁**——所有调度状态收敛到单一 MySQL（ACID 事务），实例全部对称无状态，互斥靠「条件更新 + fencing token」实现。好处：不存在脑裂面、不存在多主冲突；代价：MySQL 本身是单点（宕机则全集群暂停，不做多主复制，那会引入真正的分布式一致性难题）。
- **保证的性质**：
  - **状态机转换恰好一次**（exactly-once transitions）：认领/finalize/回收/回调全部条件更新；cron 延展是「条件占用链接 + 插入」单事务（并发延展绝不产生孤儿重复）；
  - **执行副作用 at-least-once**（绝不丢失，但可能重复触发）：dispatching/sending 超时回收意味着执行器可能被触发两次——**执行器必须幂等**（dispatch 携带 X-Task-Id 供去重；app-pay 超时委托用 payload version 守卫）；
  - **fencing**：每次认领铸造新 `claim_token`，finalize/release 只在 token 仍是当前认领时生效——卡顿超 TTL 的陈旧持有者无法覆盖新认领，其结果记孤儿（`orphaned dispatch result discarded` WARN）并丢弃；
  - **迟到成功丢弃**：running 超 10 分钟判 failed 后到达的回调不复活任务（幂等返回当前状态）——副作用已发生但状态不回退，收件侧幂等兜底。
- **显式取舍（可用性 > 一致性）**：限流/节流在 Redis 故障时 fail-open；单实例 reclaim 竞争窗口内允许重复触发（幂等契约兜底）。
- **时钟**：认领 TTL 比较用实例时钟，compose 同主机时钟天然一致、k8s 依赖 NTP；120s TTL 对秒级偏斜有约百倍裕度。

## 数据模型(app-task 独立 MySQL,schema 由 `db.Migrate()` 自建)

- **MySQL**:`task`(通用调度定义 + 状态机 pending/running/completed/failed + executor_url + payload + cron + 重试)、`task_log`(执行审计/溯源)、`script`/`script_log`(Lua 脚本与审计)、`script_run`(立即执行记录)、`email_queue`(邮件投递队列+重试)、`api_key`(service 面 API 密钥,SHA-256 哈希,名称唯一 + key_id)、`secret`(中心密钥库,AES-256-GCM,secret_id + 名称唯一)、`webui_user`(WebUI 控制台账户,bcrypt)
- `internal/model/model.go` 是自有 GORM 模型(不 import app/);业务字段一律进 `task.payload`(JSON),调度器不建列、不解释
- 出题业务行 `quiz_task`/`quiz_task_answer` + 题库 Mongo `task_quiz_questions` 属**主 app**(见 CLAUDE.md §5 task-quiz 模块)

## 可靠性

- **LLM structured output**:主 app 出题端点 `with_structured_output` + 重试 max 3
- **邮件可靠**:notification 表持久化 + 后台 worker 重试(max 5,指数退避)+ 崩溃恢复不丢邮件
- **状态机竞态**:`conditional_update`(`WHERE status=...`)防 completed/overdue 竞态
- **幂等**:execute_quiz/check_timeout 按 status 幂等(MySQL 状态机保证)

## 模块边界

- ✅ `router` -> `service` -> `repo`(同主 app 分层)
- ✅ 独立配置、独立日志、独立生命周期
- ✅ 独立 MySQL 实例(`app_task` 库,schema 自建),不共享主 app 的 MySQL / Mongo
- ✅ 经 APISIX HTTP 调主 app 出题端点
- ❌ **禁止反向依赖 `app/`**(不 import app.*)
- ❌ 禁止接入主应用的 AgentHarness / agent / rag / Milvus
- ❌ 禁止自带 agent / 用户交互(agent 在主 app)

## 规范

详见 `CLAUDE.md` §2.7「app-task 定时出题任务执行器」。
