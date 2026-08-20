# app-task

MindBase **定时出题任务执行器**(Go,自写 DB 轮询调度,无 xxl-job/pyxxl)。

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

`app-task/default.yaml`(嵌入二进制)提供默认值;环境变量覆盖(前缀 `APPTASK__`,双下划线嵌套):

```bash
APPTASK__RDBMS__URL=mysql+aiomysql://app_task:app-task@app-task-mysql:3306/app_task  # 独立 MySQL(schema 自建)
APPTASK__MONGO__URI=mongodb://admin:pass@mongo:27017/?authSource=admin
APPTASK__MONGO__DB_NAME=MindBase
APPTASK__APP__BASE_URL=http://apisix:9080        # 经 APISIX 调主 app
APPTASK__APP__CONSUMER_KEY=mindbase-internal-key  # APISIX key-auth
APPTASK__EMAIL__API_KEY=re_xxx                    # Resend
APPTASK__WEBUI__TOKEN=xxx                         # WebUI 控制台访问令牌(生产必设)
APPTASK__WEBUI__SESSION_TTL_MINUTES=720           # 登录会话有效期(分钟,默认 720)
APPTASK__TIMEZONE=Asia/Shanghai
```

> app-task 不读主 `app/config/` 的 YAML,但读项目根 `.env`(`APPTASK__` 前缀变量 + 共享密钥,godotenv)。新增配置项须同步更新 `default.yaml`。

## API 端点

### 服务间 / 用户端点（经 APISIX）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/tasks/register` | 主 app agent 调用,注册任务(uid/prompt/trigger_time/cc_emails/incomplete_message) |
| GET | `/tasks/{task_id}` | 任务详情(task + quiz + answer),X-Uid 鉴权 |
| GET | `/tasks` | 用户任务列表,X-Uid 鉴权 |
| GET | `/health` | 健康检查 |

### WebUI 管理端点（`webui.enabled=true` 时挂载,`/api/*` 需登录）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 嵌入式 SPA 控制台（仅登录会话可达，未登录 302 `/login`） |
| GET | `/login` | 独立登录页（用户名+密码；无控制台外壳；已登录访问则 302 回 `/`） |
| GET | `/assets/*` | 控制台静态资源（CSS/JS 公开；`*.html` 不经此路由提供） |
| POST | `/api/login` | 登录：`{username, password}` 换会话（HttpOnly Cookie + 响应体）；`{token}` 也可（master API 密钥） |
| POST | `/api/logout` | 登出：吊销当前会话并清除 Cookie |
| GET | `/api/info` | 服务信息 + 当前用户（`user.username/role/is_admin`） |
| GET | `/api/stats` | 仪表盘统计(任务/日志/邮件/脚本计数) |
| GET | `/api/tasks` | 全量任务列表(跨 uid,支持 `?status=&limit=&offset=`) |
| GET | `/api/tasks/{task_id}` | 任务详情 + 执行日志 |
| POST | `/api/tasks` | 注册任务(控制台表单,uid 缺省 0) |
| GET | `/api/logs` | 最近执行日志(`?task_id=` 过滤) |
| GET | `/api/emails` | 邮件队列(`?status=&limit=&offset=`) |
| POST | `/api/emails/{email_id}/retry` | 失败邮件重新入队(failed→pending) |
| GET | `/api/scripts` | Lua 脚本列表(最新版本) |
| GET | `/api/scripts/{script_id}` | 脚本详情(源码 + 版本历史 + 审计日志) |
| POST | `/api/scripts` | 创建/更新脚本(保存即新版本) |
| POST | `/api/scripts/{script_id}/toggle` | 启停脚本(不升版本,记录审计) |
| GET | `/api/users` | 账户列表（仅 admin） |
| POST | `/api/users` | 添加账户 `{username, password, role}`（仅 admin） |
| POST | `/api/users/{user_id}/password` | 修改密码（仅 admin） |
| DELETE | `/api/users/{user_id}` | 删除账户（仅 admin；不能删自己/最后一个 admin） |

> ⚠️ `POST /tasks/{task_id}/answer`（答题提交）已由主 app 提供（判题/入库/状态流转
> 属业务逻辑），经 APISIX `/tasks/*/answer`（priority 100, forward-auth）转发到 backend。
> app-task 只负责调度执行与通知，不处理答题。

## WebUI 控制台

app-task 内置一个 **go:embed 单二进制的管理控制台**（纯 HTML/CSS/JS，无构建步骤、无独立前端服务），由 Gin 直接提供在 8001 端口 `/`：

- **仪表盘**：任务/执行日志/邮件队列/脚本统计卡片 + 最近任务与最近日志
- **任务管理**：全量任务列表（状态过滤/分页）、注册新任务（表单）、任务详情（payload + task_log 溯源）
- **执行日志**：跨任务的最新执行记录，可按 task_id 过滤
- **Lua 脚本**：脚本列表/在线编辑（保存即新版本、立即生效）、启停开关、版本历史 + 审计日志
- **邮件队列**：状态过滤、失败邮件一键重试

**访问方式**：`http://<host>:8001/`。前端不依赖 APISIX；但 `/api/*` 管理端点暴露全部数据，控制台**始终需要登录**：

```bash
APPTASK__WEBUI__SESSION_TTL_MINUTES=720       # 登录会话有效期（默认 720 分钟）
APPTASK__WEBUI__TOKEN=your-token              # 可选：master API 密钥（脚本/API 调用 /api/* 用）
```

**登录模型（用户名+密码 + 独立登录页 + 服务端页面门禁）**：

- 账户存 app-task 自己的 MySQL `webui_user` 表（bcrypt 哈希）；**首次启动自动创建默认管理员 `admin` / `app-task-admin`**
- 未登录访问 `/` 会被服务端 **302 到独立登录页 `/login`**（登录页自包含，不含任何控制台 HTML/数据；`/assets/*.html` 也从静态路由隐藏，未登录拿不到应用外壳）
- 登录页输入用户名+密码，经 `POST /api/login` 校验（bcrypt）换取短期**会话**（crypto/rand 32 字节），写入 **HttpOnly + SameSite=Strict Cookie**（TLS 下自动加 `Secure`）--浏览器 JS 不可读（防 XSS 窃取）、跨站请求不携带（防 CSRF）、凭据不落浏览器存储
- 会话绑定用户身份；会话过期后任何 `/api/*` 调用返回 401，前端自动跳回 `/login`；顶栏「退出」吊销会话并跳回登录页
- **账户管理（仅 admin）**：控制台「账户」页可添加/删除账户、改密码；`member` 角色可操作控制台但不能管理账户；不能删除自己、不能删除最后一个 admin
- 脚本/API 调用方不走页面：用 `APPTASK__WEBUI__TOKEN`（master API 密钥，常量时间比对，等价 admin）或会话 ID 作为 `X-WebUI-Token` / `Authorization: Bearer` 头
- ⚠️ **生产务必修改默认 admin 密码**（控制台「账户」页对 admin 改密），否则任何知道默认凭据的人都能进控制台

**防护措施**：

- **防爆破限流**：同一来源 IP 每分钟最多 10 次失败凭证尝试（登录端点与 `/api/*` 门禁共享计数，无法绕过），超限返回 429；`SetTrustedProxies(nil)` 确保无法伪造 `X-Forwarded-For` 换 IP
- **安全响应头**：`X-Frame-Options: DENY` + `Content-Security-Policy: frame-ancestors 'none'`（防点击劫持）、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`/api/*` 一律 `Cache-Control: no-store`
- **CORS**：默认仅放行 `security.cors.allow_origins`（`http://localhost:3000`）中的来源，反射 Origin 并附带 `Vary: Origin`；`X-WebUI-Token`/`X-Operator` 已加入预检允许头
- **审计**：脚本上传/启停的 `operator` 自动填当前登录用户名

`webui.enabled=false` 可整体关闭页面与 `/api/*`。

## 调度模型(自写,无 xxl-job)

- **DB 轮询**:`scheduler` goroutine 每 30s 扫描 `task` 表
  - `status='pending' AND trigger_time<=NOW()` -> dispatch(HTTP 执行器 POST payload 到 executor_url)
  - 同步:2xx -> completed;非 2xx -> 按重试策略;异步:202 -> running,等回调
  - `status='running'` 超时/重试(`next_retry_at` 指数退避)
- **回调**:异步 executor 完成后 POST `/internal/task/{task_id}/complete` -> running -> completed/failed,写 task_log
- **重启恢复**:基于 DB 状态,scheduler 启动时立即 tick 一次补执行过期任务,不丢
- **精度**:30s(出题场景够用)

## 数据模型(app-task 独立 MySQL,schema 由 `db.Migrate()` 自建)

- **MySQL**:`task`(通用调度定义 + 状态机 pending/running/completed/failed + executor_url + payload + cron + 重试)、`task_log`(执行审计/溯源)、`script`/`script_log`(Lua 脚本与审计)、`email_queue`(邮件投递队列+重试)、`webui_user`(WebUI 控制台账户,bcrypt)
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
