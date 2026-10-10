# app-quiz 迁移（quiz 存储面 → Go）

> **范围：quiz 域中不写 AI 的纯存储面。** 生成（`/quiz/generate`、
> `/quiz/generate-from-summary`）与批改作答（`/quiz/submit`）的 **AI 编排**
> 2026-10-06 已迁 app-ts（落库仍经本服务 `/internal/quiz/*`）；task-quiz
> 作答（`/tasks/{task_id}/answer`）确定性判题已随二期迁入本服务。
> 状态：**✅ 已切流**（2026-10-06 Python 彻底退役；原「git revert + 删路由」
> 回滚路径随 Python 面删除失效，仅作历史记录）。

## 一、迁移映射

| 能力 | Python（已删） | app-quiz 端点 |
|---|---|---|
| 历史列表（含 stale 刷新） | `routers/quiz.py get_history` + `quiz_lifecycle` + `quiz_repository.list_history` | `GET /quiz/history` |
| 错题本 | `get_wrong_answers` + `quiz_repository.list_wrong_answers` | `GET /quiz/wrong-answers` |
| 训练数据导出（jsonl/csv/sft 流式） | `export_quiz_data` + `quiz_export.py` | `GET /quiz/export` |
| 题目集详情（include_answers） | `get_quiz`（含 data-lost 标记 → 410） | `GET /quiz/{quiz_uuid}` |
| 删除（两阶段：deleting → Mongo → SQL 事务） | `quiz_delete.py` | `DELETE /quiz/{quiz_uuid}` |
| 分享创建/轮换/撤销/状态 | `quiz_share_service.py` | `POST/DELETE/GET /quiz/{quiz_uuid}/share` |
| 公开分享页（免登录，60s 缓存） | `get_shared_quiz` | `GET /quiz/shared/{share_token}` |
| 生成 / 摘要生成 / 提交批改（AI 编排） | ~~`routers/quiz.py` 保留~~ ✅ 2026-10-06 已迁 app-ts（`quiz_ai_generate`/`quiz_ai_summary` priority 110、`quiz_ai` priority 100 → app-ts；落库经本服务 `/internal/quiz/*`） | app-ts `services/quiz-generation.ts` + `quiz-grading.ts` |

## 二、存储

- **同库接管**：bilirag 库 `quiz_sets` / `quiz_submissions` / `quiz_answers` /
  `quiz_questions`（CREATE-only + 守护测试禁 ALTER）。`quiz_questions` 是
  历史 MySQL 镜像表（题目正文早已迁 Mongo，无 DDL 在 system.sql；DDL 取自
  git 历史 ORM），错题本/导出查询仍 join 它，新建库时由 app-quiz 建表。
- **Mongo `quiz_questions`**：同集合同索引（app-quiz 启动 EnsureIndexes，
  不依赖 Python 后端在线）。
- **Redis 共享缓存**：公开分享 payload 键 `mind-base:quiz_share:{token}`、
  60s TTL，与 Python `app/infra/redis.py` 的 jset/jget 完全同键同格式；
  create/revoke 双侧都做旧 token 驱逐。Redis 不可用一律 fail-open 直读
  MySQL+Mongo。
- **过渡期双写**：Python 的 generate/submit 仍直写 quiz 表（对齐
  `task_quiz_*` 共享表先例）；二期把 Python 落库改为调用 app-quiz
  `/internal/quiz/*`（key-auth）后收回 schema 写权。

## 三、wire 契约

逐条复刻 Python 版：错误体 `{"detail": ...}`；datetime 双格式并存——
`str(datetime)` 空格分隔（history/detail 的 `created_at`）与 isoformat
无 Z（`submitted_at` / `shared_at` / `share_expires_at`）；公开分享响应带
`Cache-Control: public, max-age=60` + `Vary: Accept-Encoding`；导出流式
响应带 `Content-Disposition: attachment; filename=quiz_export_*.{fmt}`，
CSV 行结尾 CRLF（对齐 Python csv 默认 dialect）。

## 四、网关与部署

- APISIX：`upstream-app-quiz`（/health 检查）+ `quiz_user`（/quiz、/quiz/*，
  priority 50，宽验证 forward-auth，公开分享免登录可达）+ `quiz_ai`
  （/quiz/generate、/quiz/generate-from-summary、/quiz/submit，priority 100
  显式打回 Python backend）。
- compose：`app-quiz` 默认 profile，`127.0.0.1:8011` 调试口；`APPQUIZ__`
  env 前缀，共享 env：`MONGO__URI`、`REDIS__URL`、`RDBMS__URL`。

## 五、切流前验证清单

1. 同一账号分别打 Python（:8000）与 Go（:8011）的 `/quiz/history`、
   `/quiz/{uuid}`，diff 响应 JSON。
2. 分享全链路：create → 无痕访问 `/quiz/shared/{token}` → revoke 后立即
   404（Redis 双侧同键）。
3. 导出三格式内容 diff（重点 CSV 行结尾与 JSONL 转义）。
4. 删除两阶段：生成中删除 409；Mongo 断连时 503 且状态回滚。
