# app-bili —— B 站数据获取服务（Go + Gin）

> B 站数据域唯一权威：收藏夹同步/整理、视频与播放器信息、音频/字幕获取、
> DashScope ASR 转写落库、知识库 build 编排（同步 + ASR）。只获取不向量化——
> AI 域在 app-ts，经 Redis `bili:page_ready` 事件触发向量化。镜像含静态 ffmpeg。

## 端口与路由（:8010）

| 路由 | 说明 |
|------|------|
| `/favorites/v2` | 收藏夹列表 / 分页视频 |
| `/favorites/organize` | 收藏夹整理（预览/执行/清理无效） |
| `/knowledge` | 知识库 build 编排（同步 + ASR） |
| `/asr` | ASR 转写（DashScope，经 Higress 网关原生透传） |
| `/internal/bili/*` | M2M 只读（scope/owns，供 app-ts 知识域校验；apikey = APISIX_CONSUMER_KEY） |
| `/health` | 探活 |

## 数据所有权（共享 bilirag MySQL）

`collection`（收藏夹同步元数据）/ `favorite_folders` / `video`（分P 维度，
ASR 态 `is_processed`）/ `video_versions` / `async_tasks`。
ASR 正文在 Mongo `mind_base.asr_documents`（app-ts 跨库只读）。

## 运行

```bash
go run ./app-go/app-bili         # 须出公网访问 B 站与 DashScope（经 Higress）
docker compose up -d app-bili
```

配置入口 `default.yaml`（`APPBILI__` env 覆盖）。规范详见 AGENTS.md §2.16、docs/archive/app-bili-migration.md。
