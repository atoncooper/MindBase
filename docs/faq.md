# 常见问题

> 按主题归类。环境搭建见 [getting-started.md](getting-started.md)，架构与端口见 [architecture.md](architecture.md)，配置项见 [configuration.md](configuration.md)。

---

## 运行环境

**Q：本地开发最少要装什么？**

Docker（Compose v2）、Node.js ≥ 22.17（app-ts 与前端）、Go 1.24+（Go 服务；只跑 app-ts 则不需要）、Git。跑 ASR 需要 ffmpeg；跑 app-pay 需要 Java 21。完整步骤见 [getting-started.md](getting-started.md)。

**Q：最小可运行集是什么？**

一条常见路径：`docker compose up -d mysql mongo redis minio` 起依赖，然后本地跑 `app-ts`（`npm run dev`）与 `frontendv2`（`npm run dev`），前端 dev server 会把 API 转发到 APISIX。需要网关时再起 `apisix` / `nginx`；需要向量检索时起 `milvus`。

**Q：端口被占用怎么办？**

宿主端口由 `.env` 控制（如 `FRONTEND_PORT` / `MYSQL_PORT` / `MONGO_PORT` / `APP_TASK_PORT`），改后重建对应容器。各服务容器端口固定，宿主映射是可配的。

**Q：改了 `.env` 为什么不生效？**

compose 的 `env_file` 只在容器创建时注入，需要 `docker compose up -d --force-recreate <服务>`；本地直跑的服务从工作目录向上读项目根 `.env`，重启进程即可。

---

## 数据与存储

**Q：MySQL 是必须的吗？**

是。结构化数据（用户、收藏夹、笔记元数据、测验、云盘、订单等）都在 MySQL；默认 YAML 不提供 SQLite 兜底，需配置 `RDBMS__URL`。compose 会自动起库并注入连接串。

**Q：MongoDB 是必须的吗？**

持久化能力（聊天会话与消息、笔记正文与修订、学术项目/文献/稿件、ASR 正文、板正文）都在 MongoDB。未连接时相关能力降级或用内存实现，重启即丢，不适合长期运行。

**Q：Milvus / Neo4j 可以不起吗？**

可以。Milvus 不可用时向量检索与向量化降级（以启动日志为准）；Neo4j 不可用时知识图谱能力整体降级：`kg_search` 不注册、图谱面板显示不可用，其余功能不受影响。

**Q：MinIO 是必须的吗？**

云盘文件、技能包 zip、自定义壁纸存 MinIO。未启用时壁纸仍可用预设图，云盘功能降级。

**Q：Redis 是必须的吗？**

限流、验证码、quiz 配额、分享缓存、`bili:page_ready` 事件桥依赖 Redis。不可用时相关旁路能力降级，核心问答仍可用。

**Q：MikroORM 是什么？什么时候用？**

MongoDB 访问在 app-ts 侧有两种实现：官方驱动与 MikroORM（当前试点 = 学术 evidence 仓储，集合 `academic_runs`）。由 `mongo.orm` 配置切换（默认 `mikro`，异常时回退官方驱动）。新增仓储不必强制迁移，详见 [mikro-orm.md](mikro-orm.md)。

**Q：数据怎么备份？**

MySQL 用 `mysqldump`（业务库 `mind_base`、`mind_base_ts` 相关集合在 Mongo、交易库 `app_pay`、任务库 `app_task`）；Mongo 用 `mongodump`；MinIO 用 `mc mirror`；Neo4j 用 `neo4j-admin database dump`。学术集合可按前缀备份，命令见 [academic-agent.md](academic-agent.md)。

---

## AI 与密钥

**Q：需要自己配置 LLM API Key 吗？**

不需要。平台代发起的 LLM / Embedding / Rerank / ASR 请求统一经 **Higress AI 网关**出网，供应商密钥只配置在网关控制台，不进入 `.env`、也不下发给前端。自建部署需先在网关侧录入供应商凭证（见 [configuration.md](configuration.md)）。

**Q：怎么换模型或加供应商？**

在 Higress 控制台改路由与供应商，应用侧不改代码。注意：**更换 embedding 模型后必须清空 Milvus 全量重建**，不同模型向量空间不兼容。

**Q：用量/账单在哪看？**

平台侧按 uid 记录调用量与日账单（单价快照），网关侧另有网关用量上报；会员档位同时决定配额与排队权重。沙箱用量在 app-sandbox 的配额与审计中。

---

## 科研与沙箱

**Q：学术 agent 的 `run_code` 为什么不可用？**

它依赖沙箱链路：`sandbox.enabled=true` + app-sandbox 控制层 + OpenSandbox 运行时。任一不可达时工具返回明确的中文错误（诚实降级，不会伪造执行结果）。最小部署见 [deploy/docker/opensandbox](../deploy/docker/opensandbox/README.md)。

**Q：沙箱有配额吗？**

有，按会员档位：每日执行次数、并发沙箱数、每日 CPU 秒、产物总量四类（free / vip / svip 限额见 [features.md](features.md) §5 与 `app-go/app-sandbox/default.yaml`）。超限返回 429，忙时返回 503。

**Q：文献检索需要 API Key 吗？**

不需要。Crossref / OpenAlex / arXiv 使用公开接口，服务端带 TTL 缓存（检索 5 分钟、DOI 核验 1 小时）；需要服务器能出网。

**Q：沙箱不可用会影响聊天吗？**

不会。只有 `run_code` 与依赖它的能力不可用；聊天、检索、笔记、文献管理等其余工具正常。

---

## 功能

**Q：知识图谱必须装 Neo4j 吗？**

构建与检索都依赖 Neo4j（compose 已内置，默认 profile 自动拉起）。未连接时自动降级，不影响其他功能。

**Q：思维导图 / 白板数据存哪里？**

元数据在 MySQL `board` 表，正文在 Mongo `board_documents`，由 app-content（board 面）管理（经 APISIX `/board/*`，`If-Match` 乐观锁）。详见 [app-content.md](app-content.md)。

**Q：支付 / 会员是必装的吗？**

不是。app-pay 在 `--profile pay` / `--profile full` 才启动；不启动时会员能力缺失，配额按 free 档位处理，知识库主流程不受影响。

**Q：桌面端和 Web 后端是什么关系？**

相互独立。桌面端已拆分为独立仓库 [atoncooper/mind-base-desktop](https://github.com/atoncooper/mind-base-desktop)：完全本地（SQLite），不依赖 Web 后端；Web 端的学术 agent、科研工作台与桌面端同源演进，但运行形态与数据互不相通。

---

## 管理台与运维

**Q：管理台怎么进？默认账号是什么？**

本地回环 `http://127.0.0.1:3001`（Compose `app-admin`），默认 `admin` / `app-admin`，**首次登录强制改密**。生产务必修改默认凭据并限制访问来源。详见 [app-admin.md](app-admin.md)。

**Q：管理台里支付运营页打不开 / 退款复核不见了？**

支付运营依赖 `app-pay` 库：未起 `--profile pay`（或 `app-pay-mysql`）时 `/api/pay/*` 返回 503「支付管理未配置」，其余后台功能不受影响。退款复核还需 `.env` 的 `PAY_OPS_KEY`（注入 app-admin-api 的 `APPADMIN__PAY__OPS__KEY`）；未配置时该页整组 404 隐藏。详见 [app-admin.md](app-admin.md)。

**Q：管理台登录 502 / 页面能开但接口失败？**

UI 的 `/api` 由 Nginx 同源代理到 app-admin-api；若代理地址被静态缓存（容器重建后 IP 变化），会 502。现配置使用 Docker DNS 动态解析（`set $admin_api ...`），重建后仍异常时确认 `app-admin-api` 容器健康并重启 `app-admin`。

**Q：沙箱管理页看不到数据？**

app-admin 不直连 `sandbox_*` 表，数据全部经 app-sandbox `/internal/admin/*`；未配置（`APPADMIN__SANDBOX_ADMIN__BASE_URL` 等）时页面提示未配置（503），上游 5xx / 不可达收敛为 502。先在管理台「概览」确认控制层可达。

**Q：怎么扩容 / 跑多实例？**

无状态服务（app-ts / 多数 Go 服务 / 前端）可多副本，前提是共享存储已就绪：MySQL / Mongo / Redis / Milvus 外置，后台任务用租约锁（app-cloud outbox、app-pay job lock、app-sandbox sweeper）避免重复执行。云盘扩容细节见 [app-cloud.md](app-cloud.md)；K8s 清单见 [deploy/k8s](../deploy/k8s/README.md)。

---

## 开发

**Q：测试怎么跑？**

见 [project-structure.md](project-structure.md)「测试矩阵」：app-ts `npm run typecheck && npm test`；Go 服务 `go test ./...`；前端 `npm run lint && npx tsc --noEmit`；管理台 `pnpm build`。

**Q：新增端点要改哪些地方？**

app-ts 内：`transport/http/routes/<域>.ts` + `server.ts` 注册；网关：`apisix/apisix.yaml.template` 与 `apisix.dev.yaml.template` **必须显式加路由**（APISIX 无 catch_all；启动时渲染）；如涉及页面 / 大文件再改 `nginx/`；前端只经 `lib/api/`。详见 [project-structure.md](project-structure.md)「新增代码落位」。

**Q：为什么 README 里没有目录树和接口表？**

根 README 只做项目介绍（是什么、能做什么、怎么开始）；结构与接口分别在 [project-structure.md](project-structure.md) 与 [api.md](api.md) 维护，避免两处漂移。
