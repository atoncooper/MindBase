# app-kg —— KG 图存储服务（Go + gRPC）

> 知识图谱域的存储权威：Neo4j 全部 Cypher、`video.kg_status/kg_version` 记账两列唯一写者、
> 收藏夹 → bvids 解析（只读）、云盘文档知识点证据（CloudDoc 源节点）。AI 抽取/编排完全在 app-ts，
> 两者经 gRPC 通信（proto/kg/v1/kg.proto，24 个 RPC）。
> **gRPC 不进 APISIX**：app-ts → app-kg 内网直连（compose mind-base-net）。

## 端口

| 端口 | 协议 | 说明 |
|------|------|------|
| :8013 | gRPC | 记账（ResolveScope/BeginPage/MarkPageDone/…）+ 图写（UpsertEntities/LinkAppearances/UpsertRelations/…）+ 云盘知识点（LinkCloudDocAppearances/DeleteCloudDocAppearances/FetchCloudDocEvidence）+ 图读（Neighbors/FetchEvidence/Stats/…） |
| :8014 | HTTP | `/health` 探活 + `/internal/kg/cloud-doc/*`（app-cloud 内部 JSON 路由；调试口仅回环） |

## 数据所有权

Neo4j（Entity/Video/CloudDoc/RELATES/APPEARS_IN）；MySQL `video.kg_status`/`kg_version`（唯一写者）。
知识点有两个来源、共用同一张 Entity/RELATES 图：收藏夹视频分P（证据边指向 `(:Video {bvid})`）
与云盘文档（证据边指向 `(:CloudDoc {uid, upload_uuid, title, content_hash})`，节点复用云盘 L1 路由图）。
归一化契约：`name_lower` 与 `eid`（sha1 前 16 位）由 app-ts 计算后传入，app-kg 不做归一化
——tests 包守护测试钉死。实体向量在 Milvus `mind_base_ts.kg_entities`（app-ts 所有）。

## 包结构（infra → repo → service → transport）

| 包 | 职责 |
|----|------|
| `internal/infra/{mysql,neo4j}` | 数据库初始化与连接配置（DSN/连接池、driver 生命周期、唯一约束、Ping；零业务、零查询） |
| `internal/repo/{mysql,neo4j}` | 数据库操作：SQL / Cypher（`video.kg_*` 记账、scope 解析、图增删查、cloud-doc 路由图、云盘知识点证据 `cloud_kg.go`） |
| `internal/service` | 业务规则：记账状态机、证据 title join、stats 组合、入参校验（不碰驱动/协议） |
| `internal/transport/{grpc,http}` | 协议边界：proto ↔ service 映射（gRPC）、健康检查 + cloud-doc JSON（HTTP） |
| `internal/config` | YAML/env 唯一入口（嵌入 infra 的连接配置结构） |
| `tests/` | **全部 Go 测试的独立 tests 包**（不与被测包混放）：分层依赖方向守护、Cypher/SQL 契约守护、config 映射、service 校验、transport 错误映射 |

## 运行

```bash
go run ./app-go/app-kg           # 依赖 Neo4j + MySQL
docker compose up -d app-kg      # compose profile ["", "kg", "full"]
go test ./tests                  # 全部 Go 测试在独立 tests 包（结构守护 + 契约测试，无需真实 DB）
```

契约：`proto/kg/v1/kg.proto`（Go 产物已提交）。规范详见 AGENTS.md §2.18、docs/app-kg.md。