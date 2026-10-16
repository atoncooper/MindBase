# app-quiz —— 测验存储服务（Go + Gin）

> quiz 存储域唯一权威：历史 / 错题本 / 导出 / 分享、用户答题提交 + **确定性判题**、
> 题目内容持久化。AI 出题/批改的编排层在 app-ts（经 APISIX `quiz_ai` 路由回打本服务落库）。

## 端口与路由（:8011）

| 路由 | 说明 |
|------|------|
| `/quiz/*` | 用户面：历史 / 详情 / 删除 / 错题本 / 导出 / 分享 |
| `/tasks/*` | 答题提交（`/tasks/{task_id}/answer` 确定性判题）+ 业务详情（app-task 调度视图协作） |
| `/internal/quiz/*` | M2M：app-quiz-mcp（Agent 工具落库）+ app-ts 出题编排写入；apikey 守卫 |
| `/health` | 探活 |

## 数据所有权（共享 bilirag MySQL + Mongo）

`quiz*` 表（题目/答案/错题）；Mongo `task_quiz_questions`（题目内容，
与 app-task 调度域共享同库）。分享缓存语义见 docs/app-quiz-migration.md。

## 运行

```bash
go run ./app-go/app-quiz
docker compose up -d app-quiz
```

配置入口 `default.yaml`（`APPQUIZ__` env 覆盖）。规范详见 AGENTS.md §2.17、docs/app-quiz-migration.md。
