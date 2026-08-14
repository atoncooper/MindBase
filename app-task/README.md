# app-task

MindBase **定时出题任务执行器**(Go,自写 DB 轮询调度,无 xxl-job/pyxxl)。

## 定位

`app-task/` 负责定时出题任务的**执行**:接收任务注册 -> DB 轮询调度 -> 到时调主 app 用纯 LLM 生成题目 -> HTML 邮件发给用户+抄送人 -> 接收用户答题 / 超时发未完成语录。

- **agent 在主 app**(`app/agent/task_quiz/`),不在 app-task
- ❌ 不 `import app/`;❌ 不接 AgentHarness / agent / rag / LangGraph
- ❌ 不依赖 xxl-job / pyxxl(已移除,改用内置 DB 轮询 scheduler)
- ✅ 共享主 app 同一 MySQL + MongoDB(`task_quiz_*` 表,schema 归主 app)
- ✅ 经 APISIX HTTP 调主 app 出题端点
- ✅ 独立进程、独立端口(8001)、独立配置、单二进制(Go distroless)

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
├── default.yaml               # 配置(嵌入二进制,APPTASK__ env 覆盖)
├── README.md
├── main.go                    # 入口:config + DB + Mongo + scheduler + worker + Gin + graceful shutdown
├── internal/
│   ├── config/config.go       # YAML + APPTASK__ env + godotenv
│   ├── db/db.go               # GORM MySQL(DSN 转换 aiomysql->pymysql)
│   ├── mongo/mongo.go         # mongo-driver
│   ├── model/model.go         # GORM 模型(task_quiz_task/answer/notification)
│   ├── repo/
│   │   ├── task.go            # CRUD + conditional_update 状态机 + list_due/list_overdue
│   │   ├── answer.go            # 读 task_quiz_answer（主 app 写入；app-task 只读供详情）
│   │   ├── notification.go    # queue scan + mark_sent/failed
│   │   └── quiz.go            # Mongo task_quiz_questions
│   ├── service/
│   │   ├── task_service.go    # register/execute/timeout（判题已移到主 app）
│   │   ├── app_client.go      # 调主 app /internal/quiz/generate-llm
│   │   ├── email.go           # html/template 渲染 + 入队
│   │   ├── scheduler.go       # DB 轮询调度(30s tick)
│   │   ├── notification_worker.go  # 邮件重试 worker(max 5)
│   │   ├── util.go            # 共享 helper
│   │   └── template/          # 邮件模板(Go html/template)
│   └── router/router.go       # Gin 路由 + handler + X-Uid
```

> APISIX 网关配置在项目根 `apisix/`（config.yaml + apisix.yaml + apisix.dev.yaml），与 `nginx/` 平级。

## 启动

### Docker(与主 app 一起)

```bash
docker compose --profile task up -d --build
```

启动的服务:apisix + app-task + backend + mysql + mongo + redis。

### 本地开发

```bash
# 从项目根
go run ./app-task
# 或构建单二进制
cd app-task && go build -o app-task . && ./app-task
```

> app-task 连主 app 同一 MySQL + Mongo(共享 `task_quiz_*` 表,schema 归主 app)。

## 配置

`app-task/default.yaml`(嵌入二进制)提供默认值;环境变量覆盖(前缀 `APPTASK__`,双下划线嵌套):

```bash
APPTASK__RDBMS__URL=mysql+aiomysql://user:pass@mysql:3306/mind_base  # 共享主 app MySQL
APPTASK__MONGO__URI=mongodb://admin:pass@mongo:27017/?authSource=admin
APPTASK__MONGO__DB_NAME=MindBase
APPTASK__APP__BASE_URL=http://apisix:9080        # 经 APISIX 调主 app
APPTASK__APP__CONSUMER_KEY=mindbase-internal-key  # APISIX key-auth
APPTASK__EMAIL__API_KEY=re_xxx                    # Resend
APPTASK__TIMEZONE=Asia/Shanghai
```

> app-task 不读主 `app/config/` 的 YAML,但读项目根 `.env`(`APPTASK__` 前缀变量 + 共享密钥,godotenv)。新增配置项须同步更新 `default.yaml`。

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/tasks/register` | 主 app agent 调用,注册任务(uid/prompt/trigger_time/cc_emails/incomplete_message) |
| GET | `/tasks/{task_id}` | 任务详情(task + quiz + answer),X-Uid 鉴权 |
| GET | `/tasks` | 用户任务列表,X-Uid 鉴权 |
| GET | `/health` | 健康检查 |

> ⚠️ `POST /tasks/{task_id}/answer`（答题提交）已由主 app 提供（判题/入库/状态流转
> 属业务逻辑），经 APISIX `/tasks/*/answer`（priority 100, forward-auth）转发到 backend。
> app-task 只负责调度执行与通知，不处理答题。

## 调度模型(自写,无 xxl-job)

- **DB 轮询**:`scheduler` goroutine 每 30s 扫描 `task_quiz_task` 表
  - `status='pending' AND trigger_time<=NOW()` -> `execute_quiz`
  - `status='sent' AND deadline<=NOW()` -> `check_timeout`
- **重启恢复**:基于 DB 状态,scheduler 启动时立即 tick 一次补执行过期任务,不丢
- **精度**:30s(出题场景够用)
- **deadline 字段**:`execute_quiz` 时设 `deadline = NOW() + quiz.answer_time_limit_seconds`,`check_timeout` 轮询 deadline

## 数据模型(共享主 app 同库,`task_quiz_*` 前缀)

- **MySQL**:`task_quiz_task`(任务+状态机 pending/sent/completed/overdue/failed + deadline)、`task_quiz_answer`、`task_quiz_notification`
- **Mongo**:`task_quiz_questions`(题目内容)
- schema 由主 app 管理(`app/models.py` + `app/system.sql`),app-task 只读写
- `xxl_job_id_a/b` 字段保留(legacy,不再使用)

## 可靠性

- **LLM structured output**:主 app 出题端点 `with_structured_output` + 重试 max 3
- **邮件可靠**:notification 表持久化 + 后台 worker 重试(max 5,指数退避)+ 崩溃恢复不丢邮件
- **状态机竞态**:`conditional_update`(`WHERE status=...`)防 completed/overdue 竞态
- **幂等**:execute_quiz/check_timeout 按 status 幂等(MySQL 状态机保证)

## 模块边界

- ✅ `router` -> `service` -> `repo`(同主 app 分层)
- ✅ 独立配置、独立日志、独立生命周期
- ✅ 共享主 app 同库(MySQL + Mongo,`task_quiz_*` 表)
- ✅ 经 APISIX HTTP 调主 app 出题端点
- ❌ **禁止反向依赖 `app/`**(不 import app.*)
- ❌ 禁止接入主应用的 AgentHarness / agent / rag / Milvus
- ❌ 禁止自带 agent / 用户交互(agent 在主 app)

## 规范

详见 `CLAUDE.md` §2.7「app-task 定时出题任务执行器」。
