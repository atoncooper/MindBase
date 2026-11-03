# MikroORM（app-ts MongoDB）采用说明

> 状态：**试点已落地**（2026-11-02）；范围 = 学术 evidence 仓储（`academic_runs`），
> 其余 Mongo 适配器仍使用官方 `mongodb` 驱动，后续按本文分阶段迁移。

## 1. 结论

采用 **MikroORM 7**（`@mikro-orm/core` + `@mikro-orm/mongodb`，与 app-ts 的
`mongodb` v7 驱动同大版本），但**不做一次性全量重写**：

- MikroORM 只作为 `src/repository/mongo/` 内部实现细节，**不越过 repository 契约**；
- 服务/路由/工具层仍只 import `src/repository/<domain>.ts`，组合根决定实现；
- 首个试点：`academic_runs`（数据集 + 运行记录），与直接驱动实现**共享同一集合**；
- 初始化失败自动回退到原直接驱动；再失败回退 memory（原有策略不变）。

为什么不是 v6：v6 要求 Node >= 18，但依赖 `mongodb` 6.x，会在一个进程里引入两套
驱动/BSON；v7 要求 Node >= 22.17，与 app-ts Docker `node:22-alpine` 及
`mongodb@7` 对齐。因此 `package.json` engines 已提升到 `>=22.17.0`。

## 2. 配置

`app-ts/config/default.yaml`：

```yaml
mongo:
  uri: ${MONGO__URI}
  database: mind_base_ts
  timeoutMs: 5000
  # mikro = MikroORM（当前试点），driver = 直接 mongodb 驱动
  orm: ${MONGO__ORM:mikro}
```

回滚：`MONGO__ORM=driver`（无需改代码）。

## 3. 当前实现

```
src/repository/mongo/mikro/
├── entities.ts             # EntitySchema（无装饰器）：academic_runs 映射 + 两个复合索引
├── orm.ts                  # 懒初始化 MikroORM（implicitTransactions=false, ping + ensureIndexes）
└── academic-evidence.ts    # AcademicEvidenceRepository 的 MikroORM 实现
```

- **无装饰器**：使用 `EntitySchema`，不改 tsconfig（`experimentalDecorators`/metadata 均不需要）；
- **事务**：Mongo 单机（compose 默认）不支持事务，故 `implicitTransactions: false`；
- **索引**：与直接驱动实现一致：`{uid, projectId, createdAt}`、`{uid, projectId, kind}`；
- **并发**：每次操作 `orm.em.fork()`，不共享 EntityManager 的 identity map；
- **字段**：`_id` 映射为 `id`（string，兼容历史 UUID 文档）；`files/artifacts` 用 `json` 类型；
- **契约语义**：仍调用 `buildAcademicDataset/buildAcademicRun`，uid+projectId 过滤、newest-first 不变。

## 4. 分阶段迁移计划

| 阶段 | 范围 | 前置/验收 |
|---|---|---|
| 0（已完成） | 基础设施 + evidence 试点 + 元数据测试 | `tsc`、离线 vitest；Mongo 实机执行 1 次 |
| 1 | `academic`（projects/literature/documents/events，42KB 适配器） | 逐方法对照直接驱动；核对 upsert/findOneAndUpdate 语义；Mongo 集成测试 |
| 2 | chat store / session-docs / summaries、memory-store、agent-context | 会话写入路径回归；确认无事务依赖 |
| 3 | usage-ledger、vector-tasks、kg-*、skills、quiz-resume、task-quiz | 低风险列表类，最后切换 |
| 4 | 移除直接驱动适配器，统一 `MONGO__ORM` | 全量 Mongo 集成 + 回滚演练 |

迁移规则：

1. 先在现有直接驱动适配器旁新增 MikroORM 实现，保持同一集合/字段/索引；
2. 逐个 use-case 对照测试（memory 实现仍是契约基准，不能删）；
3. 组合根按 `config.mongo.orm` 选择；失败自动回退 driver；
4. 只有全部适配器迁移完成、真实 Mongo 集成测试通过后，才删除旧适配器。

## 5. 风险与注意事项

- **未实机验证**：本机 Docker daemon 未运行，MikroORM 连接/写入尚未对真实 Mongo 跑过；
  上线前必须用 `MONGO__URI` 跑一次 evidence CRUD（create/list/get、索引、排序、跨 uid 404）。
- **Node 版本**：MikroORM 7 需要 Node >= 22.17；本地与 Docker 均为 Node 22，但
  `package.json engines` 已提高，旧 Node 20 环境会 `EBADENGINE`。
- **Mongo 单机事务**：不要引入依赖事务的多文档写入；需要事务时先升级为副本集。
- **聚合/原生查询**：MikroORM 的 QueryBuilder 与直接驱动 aggregation 不完全等价；
  涉及 `$group/$lookup` 的仓储迁移前单独评估。
- **索引命名**：MikroORM 自动生成索引名；与旧集合已有索引若键相同会复用，不会重复。
- **性能**：每操作 fork EM 有少量开销；高频路径（chat 消息）迁移前做基准。
- **契约边界**：禁止在 services/tools 中 import MikroORM；只能在 `repository/mongo/` 内。
