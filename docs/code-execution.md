# 代码执行记录回溯

> code agent 每次执行 `run_code`（含失败重试）都持久化到 MongoDB，支持从 admin 后台和 chat 历史回溯"当时跑了什么代码、stdout 是什么、产出了什么"。

## 背景

code agent 在 Daytona 临时沙箱里执行代码，沙箱执行完即删。若不持久化，执行细节随沙箱丢失，无法回溯。本方案在 `runtime_dispatch` 节点落库，完整保留代码 / stdout / 产物。

## 数据模型

MongoDB collection `code_executions`（`app/repository/code_execution_repository.py`）：

| 字段 | 说明 |
|------|------|
| `exec_id` | UUID4，主键 |
| `uid` | 用户 id |
| `chat_session_id` | 关联会话（MySQL `chat_sessions`） |
| `assistant_msg_id` | 关联 assistant 消息（MongoDB `chat_messages.msg_id`），消息级回溯 |
| `delegate_query` | 触发 code agent 的子查询 |
| `code` | 完整代码（不截断） |
| `language` | `python` / `javascript` / `typescript` |
| `stdout` | 完整 stdout（不截断） |
| `exit_code` | 0=成功，非 0=失败 |
| `latency_ms` | 执行耗时 |
| `error` | 失败时的错误信息 |
| `timeout` | 是否超时 |
| `artifacts` | 产物列表 `[{name, minio_key, url, content_type, size}]` |
| `created_at` | 时间戳 |

索引：`exec_id`(unique) / `assistant_msg_id+created_at` / `chat_session_id+created_at` / `uid+created_at`。

## 产物协议（图片等二进制）

沙箱即删，文件无法保留。code agent 的 prompt（`app/agent/code/prompts.py`）指示生成的代码用标记协议把产物以 base64 输出到 stdout：

```python
import base64
with open("heart.png", "rb") as f:
    print("<<ARTIFACT_START:heart.png>>" + base64.b64encode(f.read()).decode() + "<<ARTIFACT_END>>")
```

`run_code` 工具（`app/tools/code/run_code.py`）：
1. `_extract_artifacts(stdout)` 解析标记，base64 解码（单个上限 10MB，超出跳过）
2. `_upload_artifacts` 上传 MinIO（key=`code-artifacts/{uid}/{uuid}/{name}`），返回 presigned URL
3. 标记从 content 清理（替换为 `[已提取产物: name]`），避免 base64 污染 LLM context
4. artifacts 元数据经 `ToolMessage.additional_kwargs` 传到 `runtime_dispatch` 落库 + SSE

LLM 不遵守标记格式时，只是没产物（文本回溯仍有效）。MinIO 禁用时跳过产物，文本记录正常落库。

## 接口

### 用户接口（`app/routers/code_executions.py`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/chat/messages/{msg_id}/code-executions` | 某条 assistant 消息的执行记录列表（归属校验，跨用户 404） |
| GET | `/chat/messages/{msg_id}/code-executions/{exec_id}` | 单条详情（含完整 code/stdout/artifacts） |

### Admin 接口（`app/routers/admin_code_executions.py`，`require_admin`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/admin/code-executions` | 全局列表（按 uid/session_id/msg_id/时间筛选，newest first） |
| GET | `/admin/code-executions/{exec_id}` | 详情（admin scope，不校验归属） |
| DELETE | `/admin/code-executions/{exec_id}` | 删除记录 + MinIO 产物 |

> admin 接口当前暂挂主 FastAPI app，未来迁移到独立 app-admin 服务。

## SSE 产物事件

`agent_sse.py` 在流末尾（sources/done 前）发 `type:"artifact"` 帧，前端 `ChatPanel` 经 `chat-stream.ts` 的 `onArtifact` 回调累积到 message，`ChatMessage` 渲染图片（`content_type` 为 image 时 `<img>`，否则下载链接）。

## 配置依赖

- **MongoDB**：`code_executions` collection（`mongo.enabled=true`）
- **MinIO**：产物存储（`minio.enabled=true`，禁用则跳过产物）
- **Daytona**：代码沙箱（`daytona.enabled=true`）

## 回溯场景

1. **chat 历史展开**：用户点 assistant 消息 → 调 `GET /chat/messages/{msg_id}/code-executions` → 看代码 + stdout + 产物。
2. **admin 审计**：管理员在 web-admin（待建）→ `GET /admin/code-executions?uid=&since=` → 按用户/时间筛查执行记录，排查问题。
3. **产物查看**：artifacts 的 `url` 是 MinIO presigned URL，可直接访问。

## 已知限制

- 持久化是 best-effort：Mongo 故障时只 warning，不阻断 agent 主流程。
- 产物依赖 LLM 遵守标记协议；不遵守则无产物，文本记录仍有效。
- 标准 `logging`（run_code/delegate/code_agent）未桥接到 loguru，相关日志不进 `logs/app.log`（已知可观测性盲区）。
