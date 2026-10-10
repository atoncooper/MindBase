# KG（知识点/知识图谱）——app-ts + app-kg(gRPC) 重建

> **范围**：KG 域按「AI 进 app-ts、存储进 app-go、通信走 gRPC」拆分重建。
> 状态：**✅ 已切流**（2026-10-06 Python 彻底退役，Python `services/kg/*`、
> `/knowledge/kg/*`、`kg_search` 工具与 blindspot Python 实现已随 `app/` 删除；
> 过渡期双写结束——Neo4j/`video.kg_*` 唯一写者 = app-kg，实体向量唯一集合 =
> `mind_base_ts.kg_entities`）。

## 一、架构与分工

```
app-ts (Fastify, AI)                                app-kg (Go, gRPC :8013)
├─ HTTP /knowledge/kg/*（镜像 Python 契约）            ├─ Neo4j 全部 Cypher
├─ kg_search tool（main agent）                       │  (Entity/Video/RELATES/APPEARS_IN)
├─ build 编排（Mongo mind_base_ts.kg_builds）          ├─ MySQL video.kg_status/kg_version
├─ 抽取 generateObject(zod) purpose="kg"              │  （唯一写者，两列）
├─ resolver：eid=sha1(name_lower)[:16]（唯一实现）      └─ 收藏夹→bvids 解析（只读
├─ 实体向量 Milvus mind_base_ts.kg_entities                collection/favorite_folders）
├─ ASR 正文源：Mongo mind_base.asr_documents（跨库只读）
└─ gRPC ──────────────────────────────────────────► proto/kg/v1/kg.proto
```

- **gRPC 不进 APISIX**：app-ts → app-kg 内网直连（compose `mind-base-net`），
  对齐 backend → app-board-mcp 内网先例；宿主回环 127.0.0.1:8013 供 grpcurl 调试。
- **归一化单一实现**：`name_lower`（小写+空白折叠）与 `eid`（sha1 hex 前 16 位）
  由调用方（app-ts resolver）计算后传入，app-kg 不做归一化
  ——graph 包守护测试钉死该契约。
- ~~**过渡期双写**~~（已结束）：Python `KgGraphRepository` 曾与 app-kg 写同一
  Neo4j（同 schema、确定性 eid、merge 键 name_lower/bvid → 幂等兼容）；
  2026-10-06 Python 侧删除后 app-kg 成为唯一写者。

## 二、app-go/app-kg（8013 gRPC + 8014 HTTP /health）

- **RPC 面**（proto/kg/v1/kg.proto，21 个）：记账 ResolveScope /
  SelectPendingPages / BeginPage / MarkPageDone / MarkPageFailed /
  CountPendingPages；图写 UpsertEntities / LinkAppearances / UpsertRelations /
  DeletePageEvidence / DeleteVideo / ClearAll；图读 Neighbors / FetchEvidence
  （带 page_title join）/ RelationsAmong / EntitiesByEids / EntityExposure /
  EntityAppearances / TopEntities / EdgesAmong / Stats。
- **红线**：
  - ❌ 对 `video` 表只写 `kg_status`/`kg_version` 两列（镜像 app-bili「禁写 kg* 列」）
  - ❌ 对 `collection`/`favorite_folders` 只读；不建任何表、无任何 DDL
  - ❌ 不做任何 LLM/embedding 调用（纯数据面）
  - ❌ 归一化/哈希不落在本服务（调用方传入 name_lower/eid）
- **生成产物提交进仓库**（`internal/kgpb`）：CI 无 protoc 依赖；proto 变更时本地
  `protoc --go_out=app-go/app-kg --go_opt=module=app-kg … proto/kg/v1/kg.proto`
  重新生成。
- compose `app-kg`（profiles ["", "kg", "full"]，depends_on mysql+neo4j healthy）；
  env：`APPKG__RDBMS__URL` + 共享 `KG__URI`/`KG__PASSWORD`(NEO4J_PASSWORD)。

## 三、app-ts 增量

| 组件 | 位置 | 说明 |
|---|---|---|
| resolver | `src/kg/resolver.ts` | 移植 resolver.py：normalizeName/eidForName（sha1 utf-8 与 Python 字节兼容）、类型别名表、quote≥8 防幻觉、自环剔除、上限 30/40、stub 补全 |
| extractor | `src/kg/extractor.ts` | generateObject + zod，purpose="kg"、temperature=0、maxRetries=2、maxTextChars 截断；prompt 外置 `prompts/kg-extract.md` |
| gRPC 传输 | `src/grpc/client.ts` | 通用 gRPC 客户端基础设施（对齐 `src/mcp/client.ts` 先例）：运行时 proto 加载、channel、deadline、ServiceError 归一化——协议客户端独立成层，repository 不碰传输 |
| 图仓储 | `src/repository/kg-graph.ts` + `grpc/` + `memory/` | 接口 + **纯消息↔领域映射**（传输全部委托 src/grpc）+ 测试/降级 stub |
| 实体向量 | `src/repository/kg-entity-index.ts` | 独立 MilvusClient（同 Python 模式）：mind_base_ts.kg_entities，IVF_FLAT COSINE nlist=128/nprobe=16，dim 探测 + 失配自愈，delete-then-insert upsert |
| ASR 源 | `src/repository/mongo/kg-sources.ts` | 跨库只读 mind_base.asr_documents（源数据归 bili 域） |
| 任务态 | `src/repository/mongo/kg-builds.ts` | mind_base_ts.kg_builds（**不写** Python async_tasks 表）；per-uid 单活跃守卫（Python 是进程内全局单任务，语义收严） |
| 编排 | `src/kg/service.ts` | startBuild/run/processPage 七阶段（幂等检查→正文→delete-before-write→抽取→校验→写图→实体向量 best-effort→done）；单页失败隔离；completion promise 供测试 |
| 检索 | `src/kg/retriever.ts` + `src/tools/chat/kg-search.ts` | 实体链接(≥0.55, top5)→BFS(maxHops=2)→evidence→实体卡片文案 + sources（与 vector_search 同构，Source 增 pageIndex 字段）；降级文案与 Python 一致 |
| HTTP | `src/transport/http/routes/kg.ts` | /knowledge/kg/{build,active,status/:id,stats,subgraph} 镜像 Python 契约（前端 kgApi 零改动） |
| 装配 | `src/index.ts` | `kg.enabled && kgGrpc.enabled` 双门控；app-kg 不可达 → Memory 降级但打警告（数据不落盘）；main agent toolNames 按需加 kg_search + prompts/main.md 注入 `KG_SEARCH_SECTION` |

## 四、已知取舍（有意决策，非遗漏）

1. **mind_base_ts.kg_entities 与 Python mind_base.kg_entities 互不相通**（用户确认）：
   Python blindspot 的语义归因随旧集合陈旧而降级（其有向量回落路径）；app-ts 切流
   时无数据迁移，build 增量重建即灌满。
2. **build 任务态不进 MySQL async_tasks**：app-ts 用自有 Mongo 集合；Python 侧
   async_tasks 的 kg_extract 行在切流后自然废弃。
3. **Python 的 DELETE /knowledge/video/{bvid} 仍直删 Neo4j**：过渡期共享库所以成立；
   app-ts 切流时该端点需改调 app-kg `DeleteVideo`（或路由级联到 app-ts）。
4. **per-uid 单活跃任务**（Python 为进程内全局单任务）：多实例部署语义正确性前提。

## 五、联调清单

1. 起 mysql + neo4j + app-kg（`docker compose --profile kg up -d app-kg`），app-ts
   `kgGrpc.target` 指向 127.0.0.1:8013（本机）或 app-kg:8013（compose）。
2. grpcurl 探活：`grpcurl -plaintext 127.0.0.1:8013 list`（reflection 已开）。
3. app-ts `POST /knowledge/kg/build` → 轮询 status → `kg_builds` 记录 done；
   `video.kg_status='done'` 且 Neo4j 出现 Entity/RELATES/APPEARS_IN。
4. kg_search 工具冒烟（chat 内问 "X 和 Y 有什么关系"）；/knowledge/kg/subgraph
   与前端 graph 视图字段 diff。
5. 与 Python 侧同库互读：Python blindspot `/blindspot/map` 能看到 app-ts 灌的实体
   （前提：mind_base.kg_entities 仍需 Python build 维护——见取舍 1）。
