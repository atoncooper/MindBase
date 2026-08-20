# app-task — 纯调度器

app-task 是 **纯任务调度器**(xxl-task 调度中心 + 远程执行器模式):只负责**调度、调用执行、记录结果**。
一切业务执行逻辑(出题、发邮件、推送、判题……)都由**第三方 executor** 承担——app-task 到点把 task 的
payload 通过 HTTP 发给 executor,执行成功记录 completed,失败按重试策略处理。

> 定位:调度 ≠ 业务。app-task 的库里只有 `task`(调度定义)+ `task_log`(执行记录)+ 可选的 `script`(Lua 执行器);
> 没有也不应该有业务模型。

## 架构

```
                         ┌──────────────────────────────────┐
 注册 task (POST /tasks)  → │  app-task (纯调度器)             │
                         │  task 表 + task_log 表              │
                         │  Scheduler: 到点扫 pending        │
                         │    → dispatch(HTTP)               │
                         └───────────────┬──────────────────┘
                                         │ POST payload (透传)
                                         ▼
                              第三方 executor(业务全在这边)
                                ├─ 同步: 2xx = 成功 → completed
                                ├─ 异步: 202 = 接受 → running
                                │        → 干完回调 POST /internal/task/{id}/complete
                                └─ 失败/超时 → retry 或 failed
```

### 执行模型(每个 task 可配)

| 模式 | task.async | 流程 |
|------|-----------|------|
| 同步 | false(默认) | POST executor_url → 2xx=completed;非 2xx=failed/retry |
| 异步 | true | POST executor_url → 202=running;executor 完成后回调 `/internal/task/{id}/complete` → completed/failed |
| Lua 内建 | task_type=lua | 可选内置脚本执行器(GLUE 模式),脚本经 `/scripts` 上传 |

## 数据模型(app-task 独立 MySQL,表: task / task_log / script / script_log / email_queue / webui_user)

| 表 | 内容 |
|------|------|
| `task` | **调度定义**:task_id、uid、task_type(http/lua)、payload(不透明 JSON,原样透传)、executor_url、async、cron_expr、cron_next_task_id、trigger_time、status(pending/running/completed/failed)、max_retry/retry_count/next_retry_at、weight、last_result |
| `task_log` | **执行审计**(溯源):每次触发一条——task_id、trigger_at、executor、request(payload 摘要)、response、status(success/failed/timeout/retry)、duration_ms、error |
| `script` / `script_log` | 可选 Lua 执行器的脚本与上传审计 |
| `email_queue` | **邮件投递队列**(平台能力):to/cc/subject/html、status(pending/sent/failed/dry_run)、重试计数与指数退避、last_error |
| `webui_user` | **WebUI 控制台账户**:username + bcrypt password_hash + role(admin/member) |

> schema 由 app-task 启动时 `db.Migrate()` 自建。业务字段一律进 `task.payload`(JSON),调度器不建列、不解释。

## WebUI 控制台（登录）

app-task 内置 **go:embed 单二进制的管理控制台**(`/`,纯 HTML/CSS/JS,无独立前端服务),**始终需要登录**:

- **登录 = 用户名 + 密码**:账户存 `webui_user` 表(bcrypt);**首次启动自动创建默认管理员 `admin` / `app-task-admin`**,生产务必在「账户」页改密
- **独立登录页 + 服务端页面门禁**:未登录访问 `/` 302 到 `/login`,应用外壳不发给未认证请求;登录成功签发 **HttpOnly + SameSite=Strict 会话 Cookie**(12h,`APPTASK__WEBUI__SESSION_TTL_MINUTES` 可调),会话绑定用户身份
- **账户管理仅 admin**:「账户」页添加/删除/改密;角色 `admin`/`member`(member 可操作控制台但不能管账户;不能删自己/最后一个 admin);脚本审计 `operator` 自动填登录用户名
- `APPTASK__WEBUI__TOKEN` 是**可选 master API 密钥**(脚本/API 直接调 `/api/*`,等价 admin),不是登录凭据
- 防护:每 IP 每分钟 10 次失败凭证限流(429)、`crypto/subtle` 常量时间比对、`SetTrustedProxies(nil)` 防 XFF 伪造、安全响应头(`frame-ancestors 'none'`/`nosniff`/`no-store`)、CORS 白名单
- `webui.enabled=false` 整体关闭页面与 `/api/*`

## API

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| POST | `/tasks/register` | 注册 task(task_type/payload/executor_url/async/cron/trigger_time/max_retry/weight) | APISIX key-auth |
| GET | `/tasks/{task_id}` | task 详情 + 最近执行日志 | forward-auth(X-Uid) |
| GET | `/tasks` | 用户 task 列表 | forward-auth(X-Uid) |
| POST | `/internal/task/{task_id}/complete` | **异步回调**:executor 报告结果(running→completed/failed) | APISIX key-auth |
| POST | `/scripts` | 上传 Lua 脚本(版本+1,编译校验,审计留痕) | APISIX key-auth |
| GET | `/scripts` / `/scripts/logs` | 脚本列表 / 上传审计 | APISIX key-auth |

## 调度模型(自写 DB 轮询)

- 每 30s tick:到期 `pending` → dispatch;`running` 超过 10 分钟未回调 → 超时 failed;终态 cron task → 克隆下一条
- **同步成功**:pending → completed,写 task_log(success)
- **异步接受**:pending → running,等回调;回调后 running → completed/failed,写 task_log
- **失败重试**:retry_count < max_retry → 回 pending + next_retry_at(指数退避 1,2,4…s 封顶 5min);耗尽 → failed
- **重启恢复**:状态全在 DB,启动立即 tick 补执行

## 第三方 executor 对接

任何服务都可作为 executor:注册 task 时给 `executor_url` + `async`,app-task 到点 POST payload(原样)。

- **HTTPS 支持**:`executor_url` 可以是 `http://` 或 `https://`(scheme 白名单校验)。生产证书默认严格校验;私有 CA 用配置 `http_executor.ca_file`(PEM)信任;自签名内网端点显式开 `http_executor.insecure_skip_verify=true`(生产禁用)。
- **同步 executor**:请求里执行业务,2xx 返回即成功;非 2xx 返回错误信息(调度器按重试策略处理)
- **异步 executor**:收到请求先回 202(accepted),业务执行完后 POST 到 app-task 的
  `/internal/task/{task_id}/complete`(body:`{"status":"completed|failed","result":"...","error":"..."}`,key-auth)报告结果

示例(出题业务 = 主 app 作为 executor):

```bash
# 注册:到点调主 app 出题端点,异步(主 app 生成完回调)
curl -X POST http://apisix:9080/tasks/register -H 'apikey: xxx' -d '{
  "uid": 1, "task_type": "http",
  "payload": {"prompt": "数学1填空题", "difficulty": "hard"},
  "executor_url": "http://backend:8000/internal/quiz/generate-llm",
  "async": true, "trigger_time": "2030-01-01T00:00:00Z"
}'
```

## 邮件投递（平台能力，executor 回调触发）

app-task 承担**通用邮件投递**（调度平台能力，非业务）：executor 执行完业务后，需要发邮件就回调 app-task，按规范格式提交，app-task 入队 + 后台 worker 可靠投递（失败重试 max 5 指数退避、崩溃恢复、无 API key 时 dry_run 标记不假装已发）。

### 邮件格式规范（`POST /internal/email/send`，key-auth）

```json
{
  "to": ["user@example.com"],          // 必填，收件人
  "cc": ["cc@example.com"],            // 可选，抄送
  "subject": "【MindBase】出题提醒",      // 必填，≤255
  "html": "<div>...</div>",             // 必填，HTML 正文（executor 渲染业务内容）
  "reference_id": "task-xxx"             // 可选，业务关联标识（审计/幂等）
}
```

响应：`{"email_id":"...", "status":"queued"}`。邮件内容由 executor 渲染（业务侧），app-task 只懂这份投递格式。

```bash
# 配置（default.yaml email / notification 段）
APPTASK__EMAIL__API_KEY=re_xxx      # Resend key；缺省 → dry_run（不假装发送）
APPTASK__EMAIL__FROM=MindBase <x@y.com>
# notification: worker_interval_seconds=30 / retry_max=5 / retry_backoff_base=2
```

## 主 app 接入（出题业务 executor）

全链路（主 app 作为 executor 承担出题业务）：

```
agent → POST /tasks/register（key-auth）→ app-task（task 存 DB）
到点 → app-task POST executor_url（X-Task-Id: task_id, payload 透传）→ 主 app /internal/quiz/generate-llm
主 app：建 quiz_task 业务行 → 后台 LLM 出题 → 202（app-task 标 running）
出题完成：更新业务行(deadline) → 渲染题目邮件 → 回调 /internal/email/send → 回调 /internal/task/{task_id}/complete
用户答题 → 主 app 判题 → 存 quiz_task_answer → 业务状态 completed
超时（主 app 每 60s 扫 quiz_task.deadline）→ 未答 → 渲染未完成语录 → 回调 /internal/email/send → overdue
```

| 环节 | 实现 |
|------|------|
| 业务状态 | 主 app `quiz_task` / `quiz_task_answer` 表（task_id 关联，业务生命周期独立于调度） |
| 出题邮件 | 主 app `quiz_task_service.render_quiz_email` 渲染（≤2 题内联）→ 回调 app-task 投递 |
| 答题判题 | 主 app 判题（Mongo 题目）→ 存答案 → 业务 completed（task 已完成，无需再回调） |
| 超时语录 | 主 app 后台每 60s 扫 deadline → 未答发语录（overdue_emailed 幂等）→ overdue |
| 注册 | agent `submit_task` → `/tasks/register`（executor_url=主 app 出题端点, async=true） |

> 说明：`/tasks/{task_id}` 详情是 forward-auth 用户端点；agent 内部查询走 key-auth 需 APISIX 另行配置（当前未配）。前端任务列表/详情路径已从 `/tasks` 迁到 `/tasks`。

## 配置

```bash
APPTASK__RDBMS__URL=mysql+aiomysql://app_task:app-task@app-task-mysql:3306/app_task  # 独立 MySQL（schema 自建）
APPTASK__WEBUI__TOKEN=your-token     # 可选 master API 密钥（脚本/API 调 /api/*，等价 admin；非登录凭据）
APPTASK__WEBUI__SESSION_TTL_MINUTES=720  # 登录会话有效期（分钟）
APPTASK__TIMEZONE=Asia/Shanghai
# lua 段(可选执行器):timeout_seconds / max_idle_vm / max_source_len / http_timeout_seconds
```

## 启动

```bash
# 与主栈一起（apisix + app-task + app-task-mysql + backend）
docker compose --profile task up -d --build

# 独立启动（不拉起主栈：只起 app-task + 自有 MySQL）
cd app-task && docker compose up -d --build

# 本地
go run ./app-task   # 从项目根
```

启动后 WebUI 控制台在 `http://localhost:8001/`（默认账户 `admin` / `app-task-admin`，登录后进「账户」页改密）。

## 迁移(从出题执行器 → 纯调度器)

```sql
-- ① 建新表(自动,db.Migrate;存量库手动执行同构 DDL)
CREATE TABLE task (task_id VARCHAR(64) PRIMARY KEY, uid BIGINT NOT NULL, task_type VARCHAR(32) DEFAULT 'http' NOT NULL,
  payload JSON, executor_url VARCHAR(512), async TINYINT(1) NOT NULL DEFAULT 0,
  cron_expr VARCHAR(64), cron_next_task_id VARCHAR(64), trigger_time DATETIME NOT NULL,
  status VARCHAR(20) DEFAULT 'pending' NOT NULL, max_retry INT DEFAULT 0 NOT NULL,
  retry_count INT DEFAULT 0 NOT NULL, next_retry_at DATETIME, weight INT DEFAULT 1 NOT NULL,
  last_result TEXT, created_at DATETIME, updated_at DATETIME);
CREATE TABLE task_log (log_id VARCHAR(64) PRIMARY KEY, task_id VARCHAR(64) NOT NULL, trigger_at DATETIME NOT NULL,
  executor VARCHAR(512), request TEXT, response TEXT, status VARCHAR(16) NOT NULL,
  duration_ms BIGINT, error TEXT, created_at DATETIME);
-- ② 旧 task_quiz_task 数据:业务列并入 payload,再按新列映射(executor_url/async 由业务方补配)
-- ③ 旧 task_quiz_answer / task_quiz_notification / quiz_json:业务数据,归第三方 executor 侧
```
