# 云盘服务 app-cloud（Go，云盘权威）

> **范围**：B 站收藏知识库的云盘域——分块上传、文件夹、存储配额、百度式分享、
> 回收站、文档解析/OCR 向量化管线、AI 摘要、语义检索、RAG 工作区。全部 Go + Gin + GORM 实现，
> schema 所有权自 Python backend 迁入（2026-09-25 cutover，2026-10-06 Python 删除）。
> 状态：**✅ 生产运行 + 多实例就绪**（2026-10-15 完成 ①–⑤ 分布式强化，详见
> `plan/1.0.13-AppCloud-MultiReplica/1.0.13-AppCloud-MultiReplica.md`，本地设计文档，不入 git）。

## 一、架构与数据面

```
浏览器 ── /cloud/*（OpenResty → APISIX forward-auth 注入 X-Uid）──► app-cloud :8007
   │ 5GB 上传绕 APISIX（避免网关 body-limit + buffering）
   ├─ 分块字节流：presigned URL ──► OpenResty /minio-proxy ──► MinIO drive-videos（app 层不在字节路径上）
   ├─ 预览/下载流：/cloud-stream（内部重写）→ MinIO，OpenResty video_cache 24h + Range
   ├─ HLS：/hls/{uid}/{uuid}/{version}/...（HttpOnly cookie → OpenResty 本地校验 → MinIO hls_cache），字节不经 app-cloud
   └─ 状态通知：Redis `cloud:status` Pub/Sub → backend WS bridge → 前端

APISIX：/cloud/* 兜底路由 + /workspaces/*（直连 app-cloud，upstream 单 node）
```

- 身份 = 网关注入 `X-Uid`（客户端伪造被覆盖）；缺失/非法 → 401
- 存储：MySQL bilirag（`cloud_files`/`cloud_folders`/`cloud_shares`/`workspaces`/`workspace_bindings`
  + 新表 `cloud_vector_tasks`/`cloud_quota`）、MinIO（`{uid}/{upload_uuid}/file{ext}`）、
  Mongo（`cloud_drive_documents` 解析全文 + ASR 预览）、Milvus `cloud_drive` 集合

## 二、上传生命周期

```
init（POST /cloud/upload/init）
  ├─ mime 白名单 + ≤5GB 校验
  ├─ 配额原子预留（Redis Lua：used+pending+fileSize ≤ tier quota，一次脚本完成）
  ├─ MinIO CreateMultipartUpload + 全量分块 presigned（10MB/块）
  └─ 会话 meta 入 Redis（TTL 1h）+ 心跳（TTL 5min）
PUT 分块（浏览器直传 MinIO） → complete（POST /cloud/upload/{uuid}/complete）
  ├─ MinIO CompleteMultipartUpload → cloud_files 行落库（事务内 cloud_quota 计数 +size）
  ├─ pending 预销账 → 入队 cloud_vector_tasks（outbox）
  └─ 断点续传：resume 重发 presigned；心跳断供 5min → 会话自然过期
```

## 三、配额记账模型

| 组成 | 机制 |
|------|------|
| tier 来源 | app-pay `/internal/pay/membership/{uid}`（APISIX key-auth），60s 进程缓存；查询失败 **fail-closed 回落 free**（pay 故障不断上传，只压容量） |
| 权威账本 | MySQL SUM(`cloud_files`，active) —— 对账的最终依据 |
| 快速路径 | `cloud_quota` 计数表（O(1) 读）：Create/SoftDelete/Restore/文件夹级联**同事务增减**；行缺失懒引导；每日对账发现漂移自动改写为 SUM 并 WARN |
| 在途预留 | init 时 Redis Lua **原子** check-and-reserve（`mind-base:cloud:pending:{uid}` hash，TTL 同会话窗口）；并行 init 不再竞态；complete/abort/超期自清理 |
| 对账 | `GET /internal/cloud/reconcile?uid=`（loopback）：按用户前缀 listing MinIO vs DB，漂移告警不自动改账 |

## 四、分享 / 回收站

- **分享**：token（urlsafe 32B 防枚举）+ 提取码（AES-GCM 密文，无密钥降级 SHA-256+pepper）+
  有效期 + 下载上限 + view/download 计数；访问发放 15 分钟短时效 presigned URL；
  **下载上限 = 条件原子自增**（`WHERE max_downloads IS NULL OR download_count < max_downloads`，
  并发不超限）；无效/过期/撤销/超限统一 404（防状态枚举）
- **合规警告**：创建分享（文件/文件夹）必须 `legalAck: true`，否则 **422**「请先阅读并同意分享规范」。
- **文件夹分享**：`POST /cloud/folders/:id/share`；公开页 `GET /cloud/s/{token}` 返回 `targetType`，folder 时附
  `folderName` + `files[]`（`fileId/name/size/mimeType/path`，递归上限 2000、超出 `truncated: true`）；
  `POST /cloud/s/{token}/access` 增加 `fileId`（必须属于该文件夹树，否则统一 404）。文件夹 force 删除 → 联动 revoke。
- **审核（先分享后审核）**：`cloud_shares` 新增 `target_type/folder_id/legal_ack/moderation_status/reason/time/by`
  （app-cloud Migrate 跑**幂等 ALTER**，守护测试 pin 白名单）；`ResolveShare` 对 `banned` 与 `is_revoked` 同等 404；
  审核写入方 = app-admin（[app-admin.md](app-admin.md)），app-cloud 不提供审核端点。
- **保存到我的云盘（引用，非复制）**：新表 `cloud_refs` + `POST /cloud/refs`（token+提取码校验、folder 分享镜像建文件夹、
  同 uid+share+source 幂等、上限 2000 → 422；不做 attest）、`GET /cloud/refs?folderId=`、`DELETE /cloud/refs/:id`、
  `GET /cloud/refs/:id/raw?download=`（经原对象 presign，失效统一 404「引用已失效」并落 `status=dead`）。
  **引用不复制对象、不计配额**。
- **回收站**：删除=仅软删（MinIO/Mongo/Milvus 保留）；恢复/彻底删除/清空端点；
  sweeper 每小时物理清理超 30 天对象（三存储级联 + 硬删行），**Redis 租约跨副本单执行**

## 五、向量化管道（Go 原生）

`cloud_vector_tasks` outbox + 有界 worker pool（每实例 `pipeline.workers`，默认 4 / 上限 32）：

```
入队：上传完成钩子 / POST process / reprocess → upsert 任务行（只重置非 processing 行）
认领：SELECT … FOR UPDATE SKIP LOCKED（任意副本并发安全）→ processing
执行：MinIO 下载 → 解析（pdf/Office/md/html/text；图片/截图/扫描 PDF 走 vision OCR；
      加密/确实无文字件→not_supported）
      → 语义分块（600-900 字符 overlap 80-150）→ Higress embedding（text-embedding-v4, 1024 维）
      → Milvus 写入 → count 一致性校验（不符回滚防孤儿向量）→ done/failed
自愈：janitor 每分钟回收 >10min 的 stale claim（崩溃/被杀自恢复，幂等重跑）
```

- 视频语义：可上传/预览/播放，向量化依赖 Mongo 既有 ASR 文本（**云盘尚无自动 ASR 链路**；后续补齐
  视频转写后才能进入摘要/检索）。
- **图片/截图/扫描 PDF**：vision OCR（默认模型 `z-ai/glm-5.3-flash`，复用 embedding 的网关连接）；
  扫描 PDF 用 pdfcpu 提取页内嵌图片逐张 OCR，限制页数（默认 20）/图片数（40）/单图大小（10MiB）；
  OCR 成功正文照常写入 Mongo/Milvus，`doc_parser=source=ocr`。
- **L1 摘要**：每篇文档生成 overview/topics/entities/key_points/todos/answers_questions 并持久化；
  `GET /cloud/video/{uuid}/summary` 返回 available/stale/model/summary，文档更新后 content_hash
  不一致会标记 stale。默认模型 `z-ai/glm-5.3-flash`（配置 `pipeline.summary.model`）。
- **语义检索与相似文件**：`GET /cloud/search/semantic?q=&folderId=&limit=`（文件夹子树范围）、
  `GET /cloud/video/{uuid}/similar?limit=`；基于 cloud_drive 向量按 upload_uuid 聚合去重；
  向量/embedding 不可用返回 503，不影响原文件名搜索 `GET /cloud/search`。
- **M2M（app-ts）**：`GET /internal/cloud/summary`、`/internal/cloud/similar`，用
  `internal.api_key`（compose 复用 APISIX_CONSUMER_KEY）鉴权；app-ts 的 `cloud_doc_summary`
  工具经此读取摘要，uid 由服务端会话注入，LLM 不能指定 uid。
- **KG 云盘文档读取（M2M，2026-11-05）**：`GET /internal/cloud/kg/documents?uid=&limit=&cursor=`
  分页列出该用户已解析正文的文档（只回 upload_uuid/title/content_hash/size_chars，按
  upload_uuid ASC + cursor，limit 1..100 缺省 50）与
  `GET /internal/cloud/kg/document?uid=&upload_uuid=` 读取正文（按字符截断 200k，size_chars
  为全文长度）。供 app-ts 构建云盘知识点；同样走 internal.api_key + uid 校验，无能力门
  （Mongo 未启用时列表为空页、详情 404）。历史文档 size_chars 可能为 0（重新解析后补齐）。
- **M2M 文件夹（2026-11-25，agent/ 目录）**：`GET /internal/cloud/folders?uid=&parent_id=`
  单层列出该用户云盘目录（`parent_id` 缺省=根；返回 `{"items":[{id,name,parent_id}]}`，按 name 排序）。
  app-user 建号时据此 find-or-create 默认目录 `agent/`，app-ts 的 Office 导出把产物写进去；
  与 `POST /internal/cloud/folders`、`/internal/cloud/files` 共用 internal.api_key + uid 鉴权。
- **文件级 AI**：云盘详情页展示摘要/AI 标签/关键点/待办/可回答问题与相似文件；「问这份文件」进入
  `/chat?upload_uuid=<uuid>`，聊天只以该文件为检索范围；聊天来源支持 uploadUuid 深链回云盘详情。
- **配置**：`pipeline.ocr.*`（enabled/model/max_image_bytes/max_pdf_pages/max_images/timeout_seconds；
  OCR 与摘要/embedding 共用 Higress 网关连接，没有独立的 base_url/api_key）、
  `pipeline.summary.model`、`internal.api_key`。
- **红线**：embedding 模型/维度变更 = `cloud_drive` 全量重建（启动 schema 守护会拒绝服务）
- **启动容错（2026-10）**：Milvus 连接失败不再无限阻塞启动——10s 有界拨号后**降级**（上传标记 not_supported，日志 ERROR 响亮告警）；但 **schema 形状漂移（缺字段/dim 不符）仍然 fail loud 退出**（防检索被污染）。Mongo 不可用依旧优雅降级。

## 六、多实例强化（2026-10，①–⑤）

| 机制 | 语义 |
|------|------|
| ① 后台任务租约 | `internal/joblock`：sweeper/每日对账 Redis SetNX 单副本执行（token CAS 释放，崩溃 ≤15min 自愈；Redis 不可用降级单实例语义并告警） |
| ② 管道 outbox | 无界 goroutine → 持久队列 + 有界池；崩溃任务 ≤10min 自恢复 |
| ③a 配额原子预留 | 见 §三；Redis 不可用降级 legacy 检查 |
| ③b 计数表 | 每请求 SUM → O(1) 计数；对账自愈 |
| ④ 下载上限原子化 | 见 §四 |
| 部署 | compose 无 container_name + 宿主端口池 8007-8009（`--scale app-cloud=N`）；OpenResty 变量 proxy_pass + resolver 10s 自动纳用；k8s 可直接调大 replicas；APISIX upstream 仍单 node（仅 /workspaces 兜底） |

## 七、配置与运行

- 配置唯一入口 `default.yaml`（嵌入二进制）+ `APPCLOUD__` env 覆盖；**HLS 例外**：
  `hls:` 段只读 YAML（调优项走配置文件，不提供 `APPCLOUD__HLS__*` 覆盖）。OCR/摘要模型默认
  `z-ai/glm-5.3-flash`（需在 Higress 可路由）；敏感项复用共享 env
  （`MINIO__*`/`REDIS__URL`/`MONGO__URI`/`AI_GATEWAY__*`/`MILVUS__*`/`APISIX_CONSUMER_KEY`）
- 本地：`go run ./app-go/app-cloud`（读项目根 .env）；compose profile `["", "cloud", "full"]`
- 扩容：`docker compose up -d --scale app-cloud=2`（宿主 8007/8008）；详见 [deployment.md](deployment.md)

## HLS 异步打包（2026-11 可靠性强化）

上传完成后 app-cloud 把视频交给 Redis 队列里的 ffmpeg worker，产物是
`hls/{uid}/{uuid}/{version}/`（`index.m3u8` + `seg-*.ts`）。播放链路是
**浏览器 → OpenResty（校验 hls_token cookie）→ MinIO**，字节不经 app-cloud。

- **幂等入队**：client complete / MinIO bucket 通知 / 内部上传三处都会触发，
  以 `SET NX cloud:hls:job:{uuid}` 去重；已 ready 的文件不会被重复转码。
- **可靠消费**：`BLMOVE queue → processing` + 每文件租约（`SET NX EX`），
  多实例/多 worker 同一视频只会有一个转换；worker 崩溃由 janitor 重新入队。
- **有限重试**：下载/上传类瞬时失败按 30s→60s→…（上限 10min）指数退避，
  `hls.max_attempts`（默认 3）次后置 failed；ffmpeg 失败是确定性的，不自动重试，
  但用户可手动重试（`POST /cloud/video/{uuid}/hls/retry`）。
- **版本化产物**：每次转换写到新版本目录，全部对象上传完成后才切换 status；
  旧版本在播放令牌全部过期后才由 GC 清理，正在播放的旧版本不受影响。
- **状态/进度**：`GET /cloud/video/{uuid}/hls` 未 ready 时返回
  `status/progress/attempts/retryable`，前端轮询并显示「正在转码」，失败时提供重试。
- **清理联动**：软删除（进回收站）立即吊销该文件所有播放令牌；物理删除
  （回收站 purge / 定时 sweeper）删除 HLS 全部对象、Redis 状态与令牌，并留
  tombstone 防止进行中的 worker 回写。
- **预探测**：转换前 `ffprobe` 读 stream/format，决定 remux / 只重编音频 /
  整段转码；image-only、无视频流、损坏文件直接 `unsupported`/failed，不浪费
  ffmpeg；`hls.probe` 可指定二进制，缺失时退回 copy-first 兜底。
- **ABR**：`hls.rendition_heights`（默认 360/720/1080，按源高度裁剪）生成
  `{height}p/index.m3u8` 与 `master.m3u8`；H.264 源的最高档直接 remux，其余档
  缩放重编；master 的 BANDWIDTH 由实际分片字节数/时长推导。
- **缩略图**：可选生成 `cover.jpg`（播放器 poster）、`thumbs/thumb-*.jpg`
  （最多 10 张）与 `sprite.jpg`（5×2 雪碧图，列表 hover / 进度条预览），
  失败不影响视频可播；`cover.jpg` 随 ready 响应的 `posterUrl` 返回。
- **旋转/像素格式**：探测到 display matrix 旋转或 10-bit/非 yuv420p 像素格式时
  强制转码（TS copy 会丢旋转元数据、浏览器也解不了 10-bit），避免"能打包但播不了"。
- **令牌绑定**：`hls_token`（Redis 能力令牌）+ `hls_ctx`（稳定浏览器绑定
  cookie）双 cookie，Lua 校验二者匹配；token 泄露但无 cookie 不可重放，
  多标签页共享同一 bind 值不会互相踢下线。
- **指标**：`appcloud_hls_jobs_total{result}`、`appcloud_hls_processing_seconds`、
  `appcloud_hls_queue_depth`、`appcloud_hls_tokens_minted_total`。
- **代码结构**：HTTP 层 `internal/router/cloud_hls.go`；service 层按职责拆分——
  `hls.go`（生命周期/共享工具）、`hls_types.go`（类型/常量）、`hls_queue.go`
  （入队/worker/租约/重试）、`hls_janitor.go`（重试提升/崩溃回收/版本 GC）、
  `hls_plan.go`（ffprobe 预探测 + ABR 决策）、`hls_packaging.go`（渲染/上传/缩略图）、
  `hls_state.go`（Redis 状态与 GC 记录）、`hls_playback.go`（播放令牌/令牌吊销/资产删除）。
- **MinIO 匿名读收敛**：bucket policy 只对 `hls/*` 且 `aws:SourceIp` 命中
  `hls.allowed_source_cidrs`（默认 RFC1918，即 OpenResty 私网）的请求生效；
  启动时替换旧的无条件 hls 语句（其他策略保留）。填 `["0.0.0.0/0"]` 可退回
  旧行为；MinIO 需支持 `IpAddress` 条件（2021+）。

## 八、红线

- ❌ Migrate 禁 ALTER/DROP（唯一例外：`cloud_shares` 1.0.16 审核/文件夹列组的**幂等 ALTER**，守护测试钉死白名单）；cloud 表 schema 变更由 app-cloud 侧发起
- ❌ embedding 模型/维度变更前必须全量重建 cloud_drive 集合
- ❌ backend（Python，已删）/其他服务只读 cloud 表；MinIO 云盘对象唯一写者 = app-cloud
- ❌ 提取码不得明文入库；分享访问 URL 必须短时效
- ❌ 新增 cloud_files 变更路径必须走 `repo.FileRepo` 事务方法（cloud_quota 计数一致性）
## 配额结算与 MinIO 回调（2026-11-16）

| 阶段 | 行为 | `cloud_quota.used_bytes` |
|---|---|---|
| `init` | Redis Lua 原子校验 `used + pending + fileSize ≤ quota` 并登记 pending 预留（**不是扣费**；`/cloud/quota` 的 `pending` 可见） | 不变 |
| 分块 PUT | 预签名直传 edge（OpenResty Lua 校验会话）→ MinIO，字节流不经过 app-cloud/APISIX | 不变 |
| `complete`（前端回调） | MinIO `CompleteMultipartUpload` + `StatObject` 实际大小校验 → 幂等结算：`cloud_files` 行 + `cloud_quota` 同事务 +1 次、删会话/预留 | +fileSize（仅一次） |
| MinIO Webhook（`s3:ObjectCreated:CompleteMultipartUpload`） | app-cloud 启动时给桶安装通知规则（`APPCLOUD__MINIO__WEBHOOK_ARN`）；客户端漏调 complete / MinIO 成功但 DB 写失败时由事件兜底结算，与 `complete` 共用同一个幂等事务（唯一 `upload_uuid`） | +fileSize（仅一次） |
| 失败/abort/会话过期 | 删除预留；未完成分片由 MinIO `ABORT_INCOMPLETE_MULTIPART_UPLOAD_DAYS=1` 清理 | 不变 |
| 每日对账 | 修复 `cloud_quota` 计数漂移；A 类孤儿（对象有、DB 无行）超过 `grace_hours`（默认 48h）→ **自动删除并审计**（`auto_delete=true` 默认）；可设 false 改报告-only | 自愈 |

- Webhook 端点：`POST /internal/cloud/minio/events`，`Authorization: Bearer <MINIO_EVENT_TOKEN>`，空 token 即 503（fail closed）；MinIO 通过 ca-bundle 信任 app-cloud 的 dev CA。
- 幂等性：`cloud_files.upload_uuid` 唯一索引 + `INSERT … ON DUPLICATE KEY DO NOTHING`；重复事件/重复 complete 不再加配额（`appcloud_upload_complete_total{result=duplicate|already_settled|event_duplicate}` 可观测）。
- 已知取舍：事件兜底依赖 Redis 上传会话（1h TTL）取 `mime/folder/文件名`；会话已过期的事件只记 orphan，由每日对账在宽限期后删除对象（不扣费）。
## 孤儿对象治理：分片 ZSET 截止队列 + sweeper（2026-11-16）

### 主机制：每个上传一个 deadline，分 64 个 ZSET 分片

| 时机 | 行为 |
|---|---|
| `init` | `ZADD upload:deadline:<shard> score=<deadline_ms> member=<uid>:<upload_uuid>`（shard = uid % 64，默认 deadline = now + 1h） |
| `heartbeat` / `resume` | 更新同一 member 的 score（续期；活跃上传不会被回收） |
| `complete` 成功 / MinIO Webhook 结算成功 | `ZREM` 该 member（结算后不再被回收） |
| 每 5s（sweeper，每个副本都跑） | 每分片：Lua 原子 claim（`deadline -> processing`，processing 带 60s 可见性超时）+ 批量处理 + ack；处理失败的留在 processing，超时后自动 requeue |

单上传到期核对（只处理该 uid+uuid 前缀）：

1. `cloud_files` 已有行（迟到结算）→ 只清理 Redis 会话，不删对象；
2. 无行 + MinIO 有对象：
   - 对象 `LastModified` 在 recent-guard（默认 300s）内 → **不删**，把 deadline 延后（避免与正在进行的 complete 竞态）；
   - 对象较旧 → **批量 `RemoveObjects` 删除**（A 类孤儿：MinIO 有、DB 无）；
3. 无行 + 无已完成对象（只传了分片）→ 释放 Redis 会话与 `pending` 配额预留。

多副本安全：claim 是 Lua 原子脚本（单赢家），处理失败/进程崩溃由 processing 可见性超时 requeue；Durable：ZSET 在 Redis AOF 里，重启不丢。

日志/指标：

    [UPLOAD_SWEEPER] started interval=5s batch=200 visibility=1m0s shards=64
    [UPLOAD_SWEEPER] recent object detected, cleanup postponed uid=… guard=5m0s
    [UPLOAD_SWEEPER] orphan objects deleted (MinIO has them, DB has no row) uid=… objects_deleted=1
    [UPLOAD_SWEEPER] expired upload had no completed object uid=… upload_uuid=…

- `appcloud_upload_sweep_total{result=deleted|no_object|already_settled|rescheduled|error}`
- `appcloud_upload_sweep_objects_deleted_total`、`appcloud_upload_deadline_due`（积压量）

### 配置（`upload.sweep_*` / `APPCLOUD__UPLOAD__SWEEP_*`）

| 配置 | 默认 | 说明 |
|---|---|---|
| `sweep_interval_seconds` | 5 | sweeper 周期 |
| `sweep_batch` | 200 | 每次每分片最多领取的到期 member 数 |
| `sweep_visibility_seconds` | 60 | processing 可见性超时（崩溃/失败后 requeue 延迟） |
| `sweep_recent_guard_seconds` | 300 | 该窗口内修改过的对象不删，改为延后（防 complete 竞态） |

### 兜底

- 每日对账仍保留（默认 `auto_delete=true`、`grace_hours=48`），用于 Redis 数据丢失等极端场景；
- 管理端点/脚本（`GET/POST /internal/cloud/orphans*`、`scripts/cloud-orphans.sh`）用于排查与提前清理；
- B 类（DB 有行、对象无）仍只报告，人工核查。

### Redis 持久化

- `--appendonly yes --appendfsync everysec` + `--maxmemory 1gb --maxmemory-policy noeviction`：deadline 队列、上传会话、pending 台账重启不丢（实测 set→restart→get 保持）。

## 批量多选（批量删除 / 批量分享 / 回收站批量恢复与彻底删除，2026-11）

云盘多选（列表 / 网格 / 回收站）的选择状态由前端 `frontendv2/components/cloud-drive/` 维护；
后端新增三个**有界批量端点**（与单文件端点同 `/cloud` 组、同 X-Uid 网关鉴权；
APISIX/nginx 已按 `/cloud/*` 前缀转发，**无需网关改动**）：

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/cloud/videos/batch-delete` | 批量移入回收站（软删除；语义 = `DELETE /cloud/video/{uuid}`） |
| POST | `/cloud/trash/batch-restore` | 批量恢复（语义 = `POST /cloud/trash/{uuid}/restore`） |
| POST | `/cloud/trash/batch-purge` | 批量彻底删除（语义 = `DELETE /cloud/trash/{uuid}`：MinIO+HLS+Mongo+Milvus+DB 行） |

- 请求体 `{"uuids":["<upload_uuid>", ...]}`：去空白 / 去重（保序）后 1–200 项（`service.MaxBatchItems`），
  单个标识 ≤ 64 字符；空 / 超限 / 非法标识 → **422 + 中文 detail**（校验在任何存储访问之前完成）。
- 响应统一 `{succeeded, failed, results:[{upload_uuid, ok, detail?}]}`：逐项隔离失败，`results` 顺序与请求
  一致；「文件不存在 / 不属于当前账号」合并为同一中文原因（归属校验由 uid 作用域仓储查询保证）。
- 批量删除成功后与单文件删除一致：撤销该文件全部 HLS 播放令牌与全部分享；批量恢复回补配额；批量彻底删除
  走 `PurgeService`（三存储物理清理 + 硬删行，单项失败保留行由 sweeper 重试）。
- 逐项为 N 次受 uid 约束的仓储调用（上限 200，避免单个大事务），**不做静默截断**；单文件端点全部保留。

- **多选分享不新增后端端点**：`cloud_shares` 仍是「每文件一行」，前端 `cloudApi.createShares` 顺序调用
  `POST /cloud/video/{uuid}/share`（同一提取码 / 有效期 / 下载上限 / 两个合规 ack），弹窗逐文件展示链接与
  失败原因，支持复制单个、复制全部、单项重试；合规闸门与单文件分享完全一致。

前端行为：列表行 / 网格卡片复选框（点击不打开预览）、ctrl/cmd 切换、shift 在**当前可见有序项**上连选、
工具栏「全选 / 取消全选 + 已选 N 项 + 清空」；行点击仍打开预览/详情（引用条目 `cloud_refs` 的预览行为
不受影响）；换文件夹、排序、搜索模式或关键词、进入/退出回收站、列表刷新都会清空选择；回收站同样支持
多选恢复 / 多选彻底删除（均有确认弹窗）。守护测试：`app-go/app-cloud/tests/batch_test.go`。

## 播放语义与性能（2026-11-28）

> 本节由播放性能专项补充，说明 HLS 从「播放前置条件」降级为「渐进增强」后的
> 后端契约；原有 HLS 可靠性章节仍然有效。

### 状态语义（GET /cloud/video/{uuid}/hls）

| status | 含义 | 客户端应做 |
|------|------|-----------|
| `ready` | 产物已发布，返回 `playlistUrl`/`posterUrl` | 可切 HLS（原画仍可播） |
| `queued` | 已入队或正在排队 | 先播原画，轮询等待 |
| `processing` | ffmpeg 打包中 | 先播原画，轮询等待 |
| `failed` | 终态失败（可 `POST .../hls/retry` 手动重试） | 继续播原画 + 重试入口 |
| `unsupported` | 源不可打包（无视频流/损坏/图片） | 播原画，不再轮询 |
| `not_started` | **从未入队**且懒入队被关闭 | 播原画（不是转码中） |
| `unknown` | Redis 读失败，状态不可知 | 播原画，稍后可重试 |
| `disabled` | `hls.enabled: false` | 播原画 |

### 懒入队（`hls.lazy_enqueue`，默认 true）

- 旧问题：入队只发生在客户端 complete / MinIO 事件 webhook；HLS 上线前的老文件、
  webhook 未触发的上传、状态 TTL 过期的文件在 Redis 里**没有任何状态**，而旧代码
  把空状态当成 `processing`，前端因此显示永久「转码中」阻塞页（实测线上库 10001
  个有效视频只有 9 个有 HLS 状态 → 99.9% 的视频打开即无限转圈）。
- 现在 GET /hls 对「无状态」视频懒入队一次（`SET NX cloud:hls:job:{uuid}` 去重，
  重复 GET 不会重复转码），并返回 `queued`；`failed` 只在 retryable、尝试次数未耗尽
  且距上次尝试超过 10 分钟时自动重试（防坏文件转码风暴）。关闭开关后返回
  `not_started`，绝不伪造 `processing`。
- `/cloud/video/{uuid}/hls/retry` 语义不变（强制重试，清空尝试计数）。

### 状态 TTL 与重打包

- `cloud:hls:status:*` TTL 由 7 天改为 **30 天**，并在每次成功签发播放描述符时
  `EXPIRE` 续期（滑动过期）：常用视频不会被反复重新转码；长期无人观看的文件状态
  过期后，下次打开按懒入队重新打包（产物对象仍在 MinIO，但需要一次重转码）。

### 前端配合（frontendv2/components/cloud-drive/）

- `file-viewer.tsx`：视频立即播原画（MP4 progressive/Range），HLS 就绪只在
  播放尚未真正开始（<3s）时自动切换；已开始播放则显示非阻塞 chip「高清版已就绪，
  切换」并从当前位置续播。转码中/失败只显示小 chip，永不阻塞、永不降级原画。
- `use-hls-playback.ts`：仅对 `queued`/`processing` 轮询（退避至 15s），终态停止。
- `media-url.ts`：仅当页面 origin 与预签名 URL 一致时转相对路径；本地 `next dev`
  （:3000）没有媒体 rewrite，保持绝对 edge URL 直连（避免 Next 代理慢/404）。

### 实测（2026-11-28，本机 docker 栈）

- 无状态视频 `GET /hls`：修复前返回 `processing` + progress=10（永久等待）；修复后
  返回 `queued` 并真实入队，响应 25–45 ms。
- HLS（已 ready 的 1.1 GB 视频）：修复令牌库后 master playlist 200 ~30–100 ms、
  媒体 playlist 42 ms、首个 360p 分片 46 ms（≈0.14 s 到首帧）。
- 原画 Range 播放吞吐见 `docs/openresty-edge.md` §10（edge 0.9–5.2 MB/s → 38–94 MB/s）。
- 后台转码耗时与小节无关：长视频仍是分钟级，但不再阻塞首帧。