# app-cloud —— 云盘服务（Go + Gin，云盘权威）

> 云盘域唯一权威：分块上传（10MB 分片 presigned multipart + 心跳 + 断点续传）、文件夹树、
> 存储配额、百度式分享（提取码/有效期/下载上限）、回收站、搜索、RAG 工作区，
> Go 原生文档解析/OCR 向量化管线（PDF/Office/md/html/text + 图片/截图/扫描 PDF OCR → 语义分块
> → Higress embedding → Milvus cloud_drive + Mongo 全文），以及 AI 摘要、语义检索、相似文件。
> **多实例就绪**（2026-10-15 完成 ①–⑤ 分布式强化）。

## 端口与路由（:8007）

| 路由 | 说明 |
|------|------|
| `/cloud/*` | 用户面：上传 init/heartbeat/complete/resume、文件夹、文件详情/预览/处理、配额、文件名/语义搜索、AI 摘要、相似文件、回收站、分享 owner 面（nginx /cloud/ 直连，auth_request 注入 X-Uid） |
| `/cloud/s/{token}` | 公开分享页数据面（免登录；attest 设备证明 + access 提取码校验） |
| `/workspaces/*` | RAG 工作区 CRUD/绑定/文件展开（APISIX 兜底路由） |
| `/internal/cloud/{summary,similar}` | app-ts M2M（`internal.api_key` = APISIX_CONSUMER_KEY；uid 显式传入） |
| `/internal/cloud/reconcile?uid=` | 对账（loopback，仅运维） |
| `/metrics` | Prometheus 指标（HTTP 黄金信号 / 上传完成结果 / 配额预留结果 / 管线队列 / 租约竞争；集群内可达，nginx 不路由） |
| `/health` | 探活 |

## 数据所有权（共享 bilirag MySQL + MinIO/Mongo/Milvus）

MySQL：`cloud_files` / `cloud_folders` / `cloud_shares` / `workspaces` / `workspace_bindings`
+ 新表 `cloud_vector_tasks`（向量化 outbox）/ `cloud_refs`（保存到我的云盘引用，1.0.16）/
`cloud_quota`（用量计数，O(1) 配额读）——
服务启动 `db.Migrate` 自建（CREATE IF NOT EXISTS；`cloud_shares` 另有一组**幂等 ALTER**：
查 information_schema 列不存在才 ADD COLUMN，守护测试 pin 死这组 ALTER 白名单）。
MinIO `drive-videos`（`{uid}/{upload_uuid}/file{ext}`，唯一写者）；Mongo 解析全文；Milvus `cloud_drive`。

## 分享合规与引用（plan/1.0.16）

- **合规警告（legalAck）**：创建分享（文件/文件夹）必须 `legalAck: true`，否则 **422**「请先阅读并同意分享规范」——后端强制，前端弹 Modal 兜底。
- **文件夹分享**：`POST /cloud/folders/:id/share` / `GET /cloud/folders/:id/shares`；公开页 `GET /cloud/s/{token}` 返回 `targetType`，folder 时附 `folderName` + `files[]`（`fileId/name/size/mimeType/path`，递归上限 2000、超出 `truncated: true`）；`POST /cloud/s/{token}/access` 增加 `fileId`（必须属于该文件夹树，否则统一 404）。文件夹 force 删除 → `RevokeAllForFolder` 联动 revoke。
- **审核联动**：`cloud_shares` 新增 `moderation_status/reason/time/by`（app-admin 直写）；`ResolveShare` 对 `banned` 与 revoked 同等统一 404，属主列表可见审核三元组。
- **保存到我的云盘（引用）**：新表 `cloud_refs` + `POST /cloud/refs`（token+code 校验、folder 分享镜像建文件夹、幂等、2000 上限 422）、`GET /cloud/refs?folderId=`、`DELETE /cloud/refs/:id`、`GET /cloud/refs/:id/raw?download=`（经原对象 presign，复用 BuildAccess 的 disposition/XSS 政策；失效 → 404「引用已失效」并落 dead）。引用**不复制对象、不计配额**。

## 多实例语义（对比旧单实例行为的四点增强）

1. **后台任务**（回收站清理 / 每日对账）：Redis SetNX 租约（`internal/joblock`）跨副本单执行
2. **向量化**：`cloud_vector_tasks` outbox + 有界 worker pool（`pipeline.workers`，默认 4/实例），
   `FOR UPDATE SKIP LOCKED` 认领 + stale 自愈——崩溃任务 ≤10min 自动重跑（幂等）
3. **配额**：init 即 Redis Lua 原子预留（并行 init 不超卖）；`cloud_quota` 计数 O(1) 读，
   每日对账以 SUM 为权威自愈
4. **分享下载上限**：条件原子自增，并发不越限
5. **配额防绕过**：complete 后 StatObject 校验实际落盘大小（声明≠实际 → 删对象、释放预留、拒绝入库）；
   预留成功后复检 used+pending，超额回滚（关闭并发 complete 的 stale 快照窗口）
6. **长上传会话**：心跳同时续传 upload meta TTL 与 pending 账本时间戳——慢链路大文件超过 1h 不再死亡；
   心跳值含属主校验（JSON {upload_uuid, uid}）
7. **分享 attest 密钥共享**：挑战/票据是无状态 HMAC，多副本必须共享 `attest.secret`
   （env `APPCLOUD__ATTEST__SECRET` / compose `APP_CLOUD_ATTEST_SECRET`；留空=进程随机密钥，仅单副本可用）

扩容：`docker compose up -d --scale app-cloud=N`（宿主端口池 8007-8009）；nginx resolver 自动纳用。

## 运行

```bash
go run ./app-go/app-cloud        # 依赖 MySQL + MinIO（必需）；Redis（上传会话）/Mongo/Milvus 按功能
docker compose up -d app-cloud
```

配置入口 `default.yaml`（`APPCLOUD__` env 覆盖；`quota.*` tier→容量、`pipeline.workers` 池大小）。

## HLS（异步打包，播放不经过 app-cloud）

- 上传完成后 app-cloud 将任务放入 Redis 队列，后台 worker 用 ffmpeg 生成
  `hls/{uid}/{uploadUuid}/{version}/index.m3u8 + seg-*.ts` 写入 MinIO；
- 入队幂等（`SET NX` 去重 + ready 跳过）；worker 用 `BLMOVE queue → processing`
  加每文件租约消费，崩溃可被 janitor 重新入队，瞬时失败按指数退避重试
  （`hls.max_attempts`，ffmpeg 失败不自动重试）；
- 每次转换写新版本目录，全部对象上传完成后才切换 status，正在播放的旧版本
  在令牌过期后才回收，不会出现新旧分片混播；
- `GET /cloud/video/{uuid}/hls` 校验属主和打包状态，未 ready 时返回
  `status/progress/attempts/retryable`；成功时设置 **HttpOnly hls_token cookie**
  并返回 `/hls/{uid}/{uploadUuid}/{version}/index.m3u8`。失败可
  `POST /cloud/video/{uuid}/hls/retry` 手动重试；
- 播放链路是 **浏览器 -> OpenResty -> MinIO**，OpenResty 用 cookie 查 Redis
  校验 token（token 绑定版本路径），按 MinIO 对象路径缓存；字节不经过 app-cloud；
- 转换前用 **ffprobe 预探测**：无视频流/图片/损坏文件直接标 `unsupported`/失败；
  H.264+AAC 走 remux，H.264+其他音频只重编音频，其他编码整段转码；
- **ABR**：按 `hls.rendition_heights`（默认 360/720/1080，不超过源高度）生成多档
  `{height}p/index.m3u8` + `master.m3u8`，BANDWIDTH 由实际分片字节数推导；
- **缩略图**：同一次任务生成 `cover.jpg`（播放器 poster）与最多 10 张
  `thumbs/thumb-*.jpg`（列表/进度条预览）；
- 播放令牌绑定会话：`hls_token`（Redis 能力令牌）+ `hls_ctx`（稳定浏览器绑定
  cookie，多标签共享，换 token 不失效），Lua 两个都校验；
- 软删除即吊销播放令牌；物理删除（回收站 purge / sweeper）删除 HLS 对象、
  Redis 状态与令牌；
- MinIO 匿名读只对 `hls/*` 且仅允许 `hls.allowed_source_cidrs`（默认 RFC1918
  私网，即 OpenResty 所在网络）来源，旧的无条件策略在启动时被替换；
- 配置全部在 `default.yaml` 的 `hls:` 段（YAML 为唯一来源，**不读取**
  `APPCLOUD__HLS__*` 环境变量）；生产镜像包含 ffmpeg/ffprobe。

## 文档

- 服务详解：[docs/app-cloud.md](../../docs/app-cloud.md)（架构图 / 上传生命周期 / 配额记账模型 / 红线）
- 多实例设计：[plan/1.0.13-AppCloud-MultiReplica](../../plan/1.0.13-AppCloud-MultiReplica/1.0.13-AppCloud-MultiReplica.md)
- 分布式演进：[plan/1.0.14-AppCloud-Distributed](../../plan/1.0.14-AppCloud-Distributed/1.0.14-AppCloud-Distributed.md)（存储层 HA 路线 / 一致性矩阵 / 触发条件）
- 压测脚本（JMeter）：[jmeter/README.md](jmeter/README.md)
- 规范：AGENTS.md §2.14


## 头像对象存储（app-user M2M）

- `POST /internal/cloud/avatar?uid=`：app-user 上传头像原始字节（`Content-Type: image/png|jpeg|webp`，≤2MB），MinIO key = `avatars/{uid}/{random}.{ext}`；
- `GET /internal/cloud/avatar?uid=&key=`：app-user 公开 `/avatar/file/*` 代理读取；
- 两者均走 `/internal/cloud` 的 apikey + `?uid=` 守卫；MinIO 凭据只存在于 app-cloud。