# app-kg —— KG 图存储服务（Go + gRPC）

> 知识图谱域的存储权威：Neo4j 全部 Cypher、`video.kg_status/kg_version` 记账两列唯一写者、
> 收藏夹 → bvids 解析（只读）。AI 抽取/编排完全在 app-ts，两者经 gRPC 通信（proto/kg/v1/kg.proto，21 个 RPC）。
> **gRPC 不进 APISIX**：app-ts → app-kg 内网直连（compose mind-base-net）。

## 端口

| 端口 | 协议 | 说明 |
|------|------|------|
| :8013 | gRPC | 记账（ResolveScope/BeginPage/MarkPageDone/…）+ 图写（UpsertEntities/LinkAppearances/…）+ 图读（Neighbors/FetchEvidence/Stats/…） |
| :8014 | HTTP | `/health` 探活（调试口仅回环） |

## 数据所有权

Neo4j（Entity/Video/RELATES/APPEARS_IN）；MySQL `video.kg_status`/`kg_version`（唯一写者）。
归一化契约：`name_lower` 与 `eid`（sha1 前 16 位）由 app-ts 计算后传入，app-kg 不做归一化
——graph 包守护测试钉死。实体向量在 Milvus `mind_base_ts.kg_entities`（app-ts 所有）。

## 运行

```bash
go run ./app-go/app-kg           # 依赖 Neo4j + MySQL
docker compose up -d app-kg      # compose profile ["", "kg", "full"]
```

契约：`proto/kg/v1/kg.proto`（Go 产物已提交）。规范详见 AGENTS.md §2.18、docs/app-kg.md。
