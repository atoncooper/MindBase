# 定时出题任务（app-task）

app-task 是 MindBase 的**定时出题任务**功能:用户填出题方向 + 难度 + 触发时间,系统到点自动用 LLM 按指定难度生成题目、邮件通知用户和抄送人,用户在系统内限时答题;超时未答则发「未完成语录」提醒。

> app-task 是独立的后端执行服务(**Go + Gin + GORM + 自写 DB 轮询 scheduler**,无 xxl-job、无外部调度中心),与主应用共享同一数据库(MySQL + Mongo)。AI agent 在主应用,app-task 只负责执行。

---

## 功能概览

| 能力 | 说明 |
|------|------|
| 定义任务 | 用户填出题方向 + 难度 + 触发时间 + 抄送人 + 未完成语录,提交注册 |
| 难度选择 | 考研难度三档:简单(基础概念)/中等(常规应用)/压轴(综合难题);覆盖考研全科目(数学/英语/政治/专业课) |
| 定时出题 | 到触发时间自动调 LLM **按指定难度**生成题目(纯 LLM,不查知识库),结构化返回(题目+选项+答案+难度+答题时限) |
| 邮件通知 | 题目以 HTML 邮件发给用户 + 抄送人,含答题时限(邮件不含链接,需登录系统答题) |
| 限时答题 | 用户登录系统在「任务列表」找到任务作答;选择题点选选项,填空/简答输入文本;提交后判定对错(选择/填空精确匹配,简答包含匹配),答错显示正确答案 |
| 超时提醒 | 答题时限到期未提交,自动发「未完成语录」邮件(用户自定义,无则用默认模板) |
| 可靠投递 | 邮件持久化队列 + 失败重试(max 5,指数退避),app-task 重启不丢邮件/任务/题目 |

---

## 启动

### 方式一:一键脚本(本地开发,启动前端+后端+app-task)

```bash
# Linux / macOS
./scripts/start-task.sh

# Windows PowerShell
.\scripts\start-task.ps1
```

### 方式二:Docker(含基础设施 + APISIX)

```bash
docker compose --profile task up -d --build
```

启动:前端 + 主应用 + app-task + APISIX + MySQL + Mongo + Redis。

### 访问地址

| 服务 | 地址 |
|------|------|
| 前端 | http://localhost:3000 |
| 主应用 API 文档 | http://localhost:8000/docs |
| app-task | http://localhost:8001 |
| APISIX 数据面(proxy) | http://localhost:9080 |
| APISIX Admin API | http://localhost:9180 |

> app-task 启动时等主应用健康 + MySQL/Mongo 就绪;schema 由主应用管理(app-task 不建表,只读写)。

---

## 使用流程

### 1. 定义任务

登录系统,打开 dock「定时出题」(或访问 `/task-quiz`):

- **出题方向**:粗粒度,如「数学1填空题」「英语阅读理解」「政治马原」「408数据结构选择题」(支持考研全科目)
- **难度**:简单(基础概念)/中等(常规应用)/压轴(综合难题)—— LLM 按选的难度出题
- **触发时间**:本地时间,到点自动出题
- **抄送人邮箱**:可多个,可无
- **未完成语录**:可选,超时未答时发的提醒语(留空用默认模板)

提交后任务进入 `pending`,1.2s 后跳转 `/tasks` 看任务列表。

### 2. 收到题目邮件

到触发时间后,app-task scheduler 出题并发邮件:

- 邮件含:题干、选项(选择题)/答题区(填空/简答)、答题时限
- 邮件**不含任何链接**,需登录系统答题

### 3. 答题

登录系统,「我的任务」(`/tasks`)-> 详情(`/tasks/[id]`)->「去答题」(`/tasks/[id]/answer`):

- 选择题:点选选项(提交选项文本,跟 `quiz.answer` 精确匹配)
- 填空/简答题:输入文本(填空精确匹配,简答包含匹配)
- 提交后显示对错,**答错显示正确答案**
- 答题时限内提交 -> `completed`

### 4. 超时未答

答题时限到期未提交:

- 任务变 `overdue`
- 系统发「未完成语录」邮件给用户 + 抄送人

---

## 任务状态

| 状态 | 含义 |
|------|------|
| `pending` | 已注册,等待触发时间 |
| `sent` | 已出题 + 邮件已发,等待用户答题 |
| `completed` | 用户已答题提交 |
| `overdue` | 答题时限到期未提交,已发未完成语录 |
| `failed` | LLM 出题失败(格式错/超时,重试 3 次后) |

状态机防竞态:`ConditionalUpdate(WHERE status=...)` 原子更新,按 status 幂等(ExecuteQuiz/CheckTimeout/SubmitAnswer 均幂等)。

---

## 配置

app-task 从项目根 `.env` + 内嵌 `default.yaml` 读取配置(前缀 `APPTASK__`,双下划线嵌套)。关键变量(见 `.env.example` + `app-task/default.yaml`):

| 变量 | 说明 | 示例 |
|------|------|------|
| `APPTASK__RDBMS__URL` | MySQL 连接(共享主应用同库,DSN 自动转换) | `mysql+aiomysql://mind_base:mind-base@mysql:3306/mind_base` |
| `APPTASK__MONGO__URI` | MongoDB 连接(共享主应用同库) | `mongodb://admin:mind-base@mongo:27017/?authSource=admin` |
| `APPTASK__APP__BASE_URL` | 主应用网关地址(经 APISIX) | `http://apisix:9080` |
| `APPTASK__APP__CONSUMER_KEY` | APISIX 服务间调用密钥 | `mindbase-internal-key-change-me` |
| `APPTASK__EMAIL__API_KEY` | Resend 邮件 API Key | `re_xxx` |
| `APPTASK__TIMEZONE` | 业务时区(默认 Asia/Shanghai,嵌入 time/tzdata) | `Asia/Shanghai` |
| `APISIX_CONSUMER_KEY` | APISIX key-auth 密钥(主应用 + app-task 共用) | `mindbase-internal-key-change-me` |
| `APPTASK__LOG__LEVEL` | 日志级别(debug/info/warn/error,默认 info;`app.debug=true` 自动 debug) | `debug` |
| `APPTASK__LOG__FORMAT` | 日志格式(text/json,默认 text) | `json` |
| `APPTASK__LOG__OUTPUT` | 日志输出(stdout/file/both,默认 stdout;docker 默认 both) | `both` |
| `APPTASK__LOG__FILE__PATH` | 日志文件路径(默认 /app/logs/app-task.log) | `/app/logs/app-task.log` |
| `APPTASK__LOG__FILE__MAX_SIZE` | 单文件上限 MB(默认 100) | `100` |
| `APPTASK__LOG__FILE__MAX_BACKUPS` | 保留旧文件数(默认 7) | `7` |
| `APPTASK__LOG__FILE__MAX_AGE` | 保留天数(默认 30) | `30` |
| `APPTASK__LOG__FILE__COMPRESS` | gzip 旧文件(默认 true) | `true` |

> 邮件用 [Resend](https://resend.com),免费 100 封/天。未配置 API key 时 worker 以 dry-run 模式标记邮件已发(不实际发送),便于本地调试。

---

## 数据存储

app-task 与主应用共享同一数据库(`task_quiz_*` 前缀表):

| 数据 | 存储 | 说明 |
|------|------|------|
| 任务元数据 + 状态 | MySQL `task_quiz_task` | 出题方向、**难度**、触发时间、状态流转、deadline |
| 答题记录 | MySQL `task_quiz_answer` | 用户答案、是否正确、提交时间 |
| 邮件队列 | MySQL `task_quiz_notification` | 邮件内容、发送状态、重试次数(可靠投递) |
| 题目内容 | MongoDB `task_quiz_questions` | 题干、选项、答案、难度、答题时限 |

数据表由主应用管理(`app/models.py` + `app/system.sql`),app-task 只读写,不建表。`internal/model/model.go` 镜像表结构(不 import app/),改动需两侧同步。

> `task_quiz_task.difficulty` 字段(easy/medium/hard)由前端选择,存表,出题时传 LLM 按指定难度生成。**新增字段需 ALTER 现有库**:`ALTER TABLE task_quiz_task ADD COLUMN difficulty varchar(20) NOT NULL DEFAULT 'medium';`

---

## 鉴权

所有用户请求经 APISIX 网关:

- **用户端点**(`/task-quiz/*`、`/tasks/*`):APISIX `forward-auth` 调主应用 `/internal/auth/verify` 验 bili_session,通过后注入 `X-Uid`,backend/app-task 信任 `X-Uid`
- **服务间调用**(`/internal/quiz/generate-llm`、`/tasks/register`):APISIX `key-auth`(consumer `internal`),backend/app-task 用 apikey 调用
- **其他主应用端点**(`/auth`、`/chat`、`/favorites` 等):APISIX 透传(catch_all),主应用自验 bili_session(`get_current_uid`)

APISIX 配置见 `apisix/apisix.yaml`(docker)或 `apisix/apisix.dev.yaml`(VM dev)。traditional 模式可用 `scripts/import_apisix.py` 导入 yaml 到运行中的 APISIX。

---

## 日志

app-task 用 Go 标准库 `log/slog` 结构化日志,经 `internal/logger` 包统一:

- **Gin 访问日志**:每请求一条(module=http,带 method/path/status/size/latency/ip,按状态码分级)
- **Gin panic recovery**:panic 走 `slog.Error`(不走 stderr)
- **GORM SQL 日志**:经 GORM `NewSlogLogger` adapter,统一 slog 格式(慢查询 >200ms 告警)
- **业务日志**:`[TASK]`/`[SCHEDULER]`/`[NOTIFICATION_WORKER]` 前缀,带结构化字段(task_id/err 等)

日志输出可配置(stdout/file/both),file 模式用 [lumberjack](https://github.com/natefinch/lumberjack) 轮转(100MB/文件,保留 7 个,30 天,gzip)。docker 默认 `both`(stdout + `/app/logs/app-task.log`,挂 `app_task_logs` volume)。

---

## 调度

app-task 自写 DB 轮询 scheduler(无 xxl-job,无外部调度中心):

- **DB 轮询**:goroutine 每 30s 扫 `task_quiz_task` 表
  - `status='pending' AND trigger_time<=NOW()` -> `ExecuteQuiz`(出题 + 发邮件 + 设 deadline + 转 sent)
  - `status='sent' AND deadline<=NOW()` -> `CheckTimeout`(转 overdue + 发未完成语录)
- **重启恢复**:scheduler 启动立即 tick 一次,补执行过期任务,不丢
- **deadline**:`ExecuteQuiz` 时设 `deadline = NOW() + answer_time_limit_seconds`,`CheckTimeout` 轮询 deadline

---

## 常见问题

**Q: app-task 启动失败,提示表不存在 / 字段不存在?**
A: app-task 依赖主应用创建 `task_quiz_*` 表。先确保主应用启动并完成数据库初始化。新增 `difficulty` 字段需对现有库执行 `ALTER TABLE task_quiz_task ADD COLUMN difficulty varchar(20) NOT NULL DEFAULT 'medium';`(新库由 `system.sql` 自动建)。

**Q: 没收到题目邮件?**
A: 检查 `APPTASK__EMAIL__API_KEY` 是否配置(Resend key);查 app-task 日志 `[NOTIFICATION_WORKER]` 行;查 MySQL `task_quiz_notification` 表 `status`(pending=待发,sent=已发,failed=重试耗尽)。

**Q: 任务一直 pending 没触发?**
A: 查 app-task 日志 `[SCHEDULER]` 行;确认 scheduler 启动;查 `task_quiz_task.trigger_time`(UTC)是否已过;scheduler 30s 轮询,稍等。

**Q: 出题失败(task 状态 failed)?**
A: 主应用 LLM 出题端点连续 3 次格式错误/超时。查主应用日志 `[INTERNAL_QUIZ]`;确认 `LLM__API_KEY` 配置;查 app-task 日志 `[TASK] generate quiz failed`。

**Q: 难度没生效?**
A: 确认前端选了难度(简单/中等/压轴);查 `task_quiz_task.difficulty` 字段(easy/medium/hard);查 app-task 调 `/internal/quiz/generate-llm` 的 body 含 difficulty;主应用 `internal_quiz.py` prompt 按指定难度出题。

**Q: 前端 /tasks/* 报 `Unexpected token '<'` JSON 错?**
A: dev 模式 `/tasks/*`、`/task-quiz/*` 既是 Next.js 页面路由又是 API 路径,`fallback` rewrites 在页面之后导致 API fetch 命中页面返回 HTML。已用 `next.config.ts` 的 `beforeFiles` + `X-Requested-With` header 区分:fetch(带 header)-> APISIX,页面导航(无 header)-> Next.js 页面。确认 `task-quiz-api.ts` 的 `authHeaders()` 带 `X-Requested-With: XMLHttpRequest`。

**Q: APISIX 404 Route Not Found?**
A: APISIX 没配路由。standalone 模式改 `apisix/apisix.dev.yaml` + 重启;traditional 模式用脚本导入:`python scripts/import_apisix.py apisix/apisix.dev.yaml`(先清旧再导新,幂等)。

**Q: APISIX 502 Bad Gateway?**
A: APISIX 连不上 backend。确认 backend 监听 `0.0.0.0:8000`(不是 127.0.0.1,否则 VM 连不上);VM dev 确认 APISIX 能访问宿主机 `192.168.138.1:8000`(Windows 防火墙放行);查 APISIX health check(`/health` path 正确,非 `/heath` 拼写错)。

**Q: 日志在哪?**
A: docker:`docker logs mind-base-app-task`(stdout)+ 容器内 `/app/logs/app-task.log`(轮转,挂 `app_task_logs` volume)。本地 go run:stdout(默认)或配 `APPTASK__LOG__OUTPUT=file` + `APPTASK__LOG__FILE__PATH=./logs/app-task.log`。

**Q: 邮件想改格式?**
A: 修改 app-task 邮件模板(`internal/service/template/`)。
