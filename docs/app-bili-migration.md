# app-bili 数据获取域迁移（app/ → app-go/app-bili）

> 2026-10-04。规范见 [AGENTS.md §2.16](../AGENTS.md)；本文是实施记录 + 切流/回滚手册。

## 1. 迁移了什么

| 组件 | 迁移前（Python） | 迁移后 |
|------|----------------|--------|
| 收藏夹 v2（列表/同步/分页/选中/删除） | `routers/favorites_v2.py` + `services/favorite/` | app-bili `/favorites/v2/*` |
| 收藏整理（preview/execute/clean，B 站写操作） | `routers/favorites.py` v1 | app-bili `/favorites/organize/*`（uid 凭据，不再依赖 session_id） |
| 知识库 build 编排（同步+ASR） | `services/knowledge_build/` | app-bili `/knowledge/build*|folders/sync` |
| 单分 P ASR（content/create/update/reasr/status/versions） | `routers/asr.py` + `services/asr_page_service.py` | app-bili `/asr/*` |
| B 站客户端（收藏夹/view/player/playurl/字幕） | `services/bilibili.py` | `internal/bili`（强化反爬） |
| WBI 签名 | `services/wbi.py` | `internal/bili/wbi.go`（fixture 单测钉死） |
| 音频下载/探测/ffmpeg 转码切块 | `services/content_fetcher.py` | `internal/asr` |
| DashScope ASR | `services/asr.py`（SDK 实时+离线双路径） | `internal/asr/dashscope.go`（统一 REST 离线 Transcription） |
| 状态机 | `video`/`video_versions`/`async_tasks`/`collection`/`favorite_folders` 写路径 | app-bili（schema 所有权随迁） |

**不迁（AI 域）**：`services/rag/*`、Milvus、`/vec/page/*`、`/knowledge/stats|clear|video/{bvid}|folders/status`、kg。边界：app-bili 只写 `video.is_processed/version/content_source`，`is_vectorized*`/`kg*` 列禁写。（2026-10-06 更新：上述 AI 域已整体迁 app-ts，`bili:page_ready` 事件触发 app-ts `VideoVectorizerService` 自动向量化；`video.is_vectorized*` 列自此陈旧不再消费。）

**Python 保留 `bilibili.py`/`wbi.py`**：扫码登录回滚余量（routers/auth.py）与 legacy favorites 仍依赖；不做重获取（下载/ASR/编排已全删）。

## 2. 反爬强化（相对 Python 版的增量）

1. **设备指纹完整化**：`/x/frontend/finger/spi` 获取 buvid3/buvid4 + GenWebTicket bili_ticket，进程级缓存，全部请求携带（Python 版完全没有；注意路径是 `frontend/finger`，曾误写 `frontend-finger` 导致 404 HTML → 指纹步骤全卡）。
2. **风控自适应退避**：HTTP 412 / 352 / `code:-352` 识别 → 指数退避 + 抖动（base 1.5s，最多 4 次）+ WBI 密钥强制刷新。
3. **web 级请求节奏**：翻页 0.3-0.8s、视频间 1.5-4s 随机停顿；per-uid 单例 build（同 SESSDATA 并发会 RST 的实测约束）。
4. **可选静态代理**：`APPBILI__BILI__PROXY`。
5. **合法边界**：只同步用户自己 cookie 的自己收藏夹；不做全站抓取、不做账号池。

## 3. 跨服务协议

- **ASR 委托**：Python `vector_page_service._run_asr` → `POST {app_bili}/asr/create`（X-Uid 头）→ 轮询 `/asr/status/{task_id}`。
- **向量化触发**：app-bili 每页 ASR 完成 → Redis `bili:page_ready` → Python `services/bili_event_bridge.py` → 进程内调 `VectorPageService.create_task`。
- **任务进度**：Redis `bili:tasks` → 桥 → `ws_registry.broadcast_task_update` → 前端 `/ws/tasks`（前端零改动）。
- **配置**：`app/config/default.yaml` 新增 `app_bili.base_url`。

## 4. 上线步骤

1. CI 构建推送 `atoncooper/mind-base-app-bili:latest`（或 `docker compose build app-bili`）。
2. `docker compose up -d app-bili`；`curl 127.0.0.1:8010/health` 200。
3. 兼容性验证（切流前）：同一账号分别打 Python（:8000）与 Go（:8010）的 `/favorites/v2/list`、`/asr/content`，diff 响应；小规模 build 冒烟（选一个小收藏夹），确认 ASR 落 Mongo、`bili:page_ready` 触发向量化、WS 收到进度。
4. APISIX reload 生效 `bili_user` 路由（uris 显式：/favorites*、/asr*、/knowledge/build*、/knowledge/folders/sync；/knowledge 其余、/vec/* 不受影响）。
5. 观察期后清理（见 §5）。

## 5. 回滚与清理

- **回滚**：原计划「删除 APISIX `bili_user` 路由回落 catch_all → Python」已随 2026-10-06 Python 彻底退役失效（catch_all 与 Python 面均已删）；现在回滚只能 `git revert`。数据层零迁移，双向兼容。
- **清理（已完成，本 PR 内）**：routers/asr.py、knowledge.py build/sync 端点、favorites_v2.py 五端点、services/{asr,content_fetcher,asr_page_service}.py、favorite/、knowledge_build 编排、test_asr_api.py。
- **后续可选**：cookie 自动刷新（refresh_token 已在 user_oauth；B 站 refresh 可能触发验证码，v1 仅告警）；实时 Recognition WebSocket（短音频延迟优化）；代理池。

## 6. 测试基线

- Go：`cd app-go/app-bili && go test ./...`（WBI/BV fixture、AES 往返、guard 测试）。
- Python：`pytest app/test/agents/ app/test/services/test_note_conversion.py -q`（105 用例）。
- CI：ci-app-bili.yml + docker-build 矩阵条目。
- 真实栈冒烟（上线时执行，见 §4 步骤 3）。
