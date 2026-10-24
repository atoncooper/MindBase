# 云盘服务 app-cloud（Go，云盘权威）

> **范围**：B 站收藏知识库的云盘域——分块上传、文件夹、存储配额、百度式分享、
> 回收站、文档解析向量化管线、RAG 工作区。全部 Go + Gin + GORM 实现，
> schema 所有权自 Python backend 迁入（2026-09-25 cutover，2026-10-06 Python 删除）。
> 状态：**✅ 生产运行 + 多实例就绪**（2026-10-15 完成 ①–⑤ 分布式强化，详见
> [plan/1.0.13-AppCloud-MultiReplica](../plan/1.0.13-AppCloud-MultiReplica/1.0.13-AppCloud-MultiReplica.md)）。

## 一、架构与数据面

```
浏览器 ── /cloud/*（nginx auth_request → app-auth 验 token 注入 X-Uid）──► app-cloud :8007
   │ 5GB 上传绕 APISIX（避免网关 body-limit + buffering）
   ├─ 分块字节流：presigned URL ──► nginx /minio-proxy ──► MinIO drive-videos（app 层不在字节路径上）
   ├─ 预览/下载流：/cloud-stream（内部重写）→ MinIO，nginx video_cache 24h + Range
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
执行：MinIO 下载 → 解析（pdf/Office/md/html/text；扫描/加密件→not_supported）
      → 语义分块（600-900 字符 overlap 80-150）→ Higress embedding（text-embedding-v4, 1024 维）
      → Milvus 写入 → count 一致性校验（不符回滚防孤儿向量）→ done/failed
自愈：janitor 每分钟回收 >10min 的 stale claim（崩溃/被杀自恢复，幂等重跑）
```

- 视频语义：可上传/预览/播放，向量化依赖 Mongo 既有 ASR 文本（无自动 ASR 链路）
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
| 部署 | compose 无 container_name + 宿主端口池 8007-8009（`--scale app-cloud=N`）；nginx 变量 proxy_pass + resolver 10s 自动纳用；k8s 可直接调大 replicas；APISIX upstream 仍单 node（仅 /workspaces 兜底） |

## 七、配置与运行

- 配置唯一入口 `default.yaml`（嵌入二进制）+ `APPCLOUD__` env 覆盖；敏感项复用共享 env
  （`MINIO__*`/`REDIS__URL`/`MONGO__URI`/`AI_GATEWAY__*`/`MILVUS__*`/`APISIX_CONSUMER_KEY`）
- 本地：`go run ./app-go/app-cloud`（读项目根 .env）；compose profile `["", "cloud", "full"]`
- 扩容：`docker compose up -d --scale app-cloud=2`（宿主 8007/8008）；详见 [deployment.md](deployment.md)

## 八、红线

- ❌ Migrate 禁 ALTER/DROP（唯一例外：`cloud_shares` 1.0.16 审核/文件夹列组的**幂等 ALTER**，守护测试钉死白名单）；cloud 表 schema 变更由 app-cloud 侧发起
- ❌ embedding 模型/维度变更前必须全量重建 cloud_drive 集合
- ❌ backend（Python，已删）/其他服务只读 cloud 表；MinIO 云盘对象唯一写者 = app-cloud
- ❌ 提取码不得明文入库；分享访问 URL 必须短时效
- ❌ 新增 cloud_files 变更路径必须走 `repo.FileRepo` 事务方法（cloud_quota 计数一致性）
