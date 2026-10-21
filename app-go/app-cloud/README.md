# app-cloud —— 云盘服务（Go + Gin，云盘权威）

> 云盘域唯一权威：分块上传（10MB 分片 presigned multipart + 心跳 + 断点续传）、文件夹树、
> 存储配额、百度式分享（提取码/有效期/下载上限）、回收站、搜索、RAG 工作区，
> 以及 Go 原生文档解析向量化管线（PDF/Office/md/html/text → 语义分块 → Higress embedding
> → Milvus cloud_drive + Mongo 全文）。**多实例就绪**（2026-10-15 完成 ①–⑤ 分布式强化）。

## 端口与路由（:8007）

| 路由 | 说明 |
|------|------|
| `/cloud/*` | 用户面：上传 init/heartbeat/complete/resume、文件夹、文件详情/预览/处理、配额、搜索、回收站、分享 owner 面（nginx /cloud/ 直连，auth_request 注入 X-Uid） |
| `/cloud/s/{token}` | 公开分享页数据面（免登录；attest 设备证明 + access 提取码校验） |
| `/workspaces/*` | RAG 工作区 CRUD/绑定/文件展开（APISIX 兜底路由） |
| `/internal/cloud/reconcile?uid=` | 对账（loopback，仅运维） |
| `/metrics` | Prometheus 指标（HTTP 黄金信号 / 上传完成结果 / 配额预留结果 / 管线队列 / 租约竞争；集群内可达，nginx 不路由） |
| `/health` | 探活 |

## 数据所有权（共享 bilirag MySQL + MinIO/Mongo/Milvus）

MySQL：`cloud_files` / `cloud_folders` / `cloud_shares` / `workspaces` / `workspace_bindings`
+ 新表 `cloud_vector_tasks`（向量化 outbox）/ `cloud_quota`（用量计数，O(1) 配额读）——
服务启动 `db.Migrate` 自建（CREATE IF NOT EXISTS，守护测试禁 ALTER）。
MinIO `drive-videos`（`{uid}/{upload_uuid}/file{ext}`，唯一写者）；Mongo 解析全文；Milvus `cloud_drive`。

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

## 文档

- 服务详解：[docs/app-cloud.md](../../docs/app-cloud.md)（架构图 / 上传生命周期 / 配额记账模型 / 红线）
- 多实例设计：[plan/1.0.13-AppCloud-MultiReplica](../../plan/1.0.13-AppCloud-MultiReplica/1.0.13-AppCloud-MultiReplica.md)
- 分布式演进：[plan/1.0.14-AppCloud-Distributed](../../plan/1.0.14-AppCloud-Distributed/1.0.14-AppCloud-Distributed.md)（存储层 HA 路线 / 一致性矩阵 / 触发条件）
- 规范：AGENTS.md §2.14
