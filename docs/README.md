# Documentation

| Document | Audience | Description |
|----------|----------|-------------|
| [architecture.md](architecture.md) | All | ⭐ 系统架构总览：服务清单/端口、nginx→APISIX 路由、数据归属、配置体系、CI |
| [setup-guide.md](setup-guide.md) | Users / Ops | 用 Docker 直接本地跑起来：装 Docker → 配置 → 启动 → 验证 → 开始用 |
| [getting-started.md](getting-started.md) | Developers | Local setup, project structure, workflow |
| [configuration.md](configuration.md) | All | 多服务配置体系：各服务 YAML 入口、共享 env、Higress AI 网关、密钥清单 |
| [deployment.md](deployment.md) | DevOps / SRE | Production deployment: Docker, HTTPS, monitoring, backup |
| [app-kg.md](app-kg.md) | Developers | KG 存储服务（Go + gRPC）：Neo4j、记账、proto 契约 |
| [service-key-auth.md](service-key-auth.md) | Developers / Ops | 服务间 key-auth 体系：路由、密钥、问题与演进方向 |
| [app-task.md](app-task.md) | Users / Ops | 定时出题任务：纯调度器、执行模型、WebUI、executor 对接、配置 |
| [app-board.md](app-board.md) | Developers / Ops | 思维导图/白板存储服务：API、乐观锁、TLS、配置 |
| [app-pay.md](app-pay.md) | Developers / Ops | 交易/会员服务：订单状态机、渠道、审计、TLS、配置 |
| [app-pay-admin.md](app-pay-admin.md) | Ops | 支付后台管理：查询、补偿开通、鉴权、TLS |
| [app-admin.md](app-admin.md) | Ops | 分享审核后台：封杀/解封/放行、用户只读、审计、部署 |
| [app-cloud.md](app-cloud.md) | Developers / Ops | 云盘服务：分块上传、配额记账、分享、回收站、向量化管道、多实例扩容 |
| [mind-base-desktop.md](mind-base-desktop.md) | Users / Developers | 桌面端（Tauri 2，全本地）：功能、运行、打包 |
| [notes.md](notes.md) | Developers | 笔记系统：分离存储、锚点、修订、分享、消毒 |
| [code-execution.md](code-execution.md) | Developers | Code Agent 代码执行：数据模型、产物协议、SSE 事件 |
| [docker-deployment.md](docker-deployment.md) | DevOps | Legacy Docker Compose guide（已被 deployment.md 取代，仅存档） |

---

## Where to find

| Concern | Document |
|---------|----------|
| "系统整体长什么样？端口/路由/数据归属？" | [architecture.md](architecture.md) |
| "Python backend 去哪了？某端点现在谁承接？" | [archive/python-decommission.md](archive/python-decommission.md) + [architecture.md](architecture.md) |
| "I cloned the repo, how do I run it?" | [getting-started.md](getting-started.md) |
| "我不会开发，只想用 Docker 跑起来" | [setup-guide.md](setup-guide.md) |
| "What env vars do I need?" | [configuration.md](configuration.md) |
| "How do I deploy to production?" | [deployment.md](deployment.md) |
| "How do I configure HTTPS?" | [deployment.md](deployment.md) |
| "How do I switch the LLM provider?" | [configuration.md](configuration.md) |
| "前端 API 层怎么组织？某域调哪个服务？" | [frontendv2/lib/api/README.md](../frontendv2/lib/api/README.md) |
| "聊天域/向量域怎么切到 app-ts 的？" | [archive/app-ts-cutover.md](archive/app-ts-cutover.md) |
| "app-task 是什么？怎么启动？" | [app-task.md](app-task.md) |
| "思维导图/白板数据怎么存的？" | [app-board.md](app-board.md) |
| "支付/会员服务怎么部署和配置？" | [app-pay.md](app-pay.md) |
| "支付后台怎么进？怎么补偿开通？" | [app-pay-admin.md](app-pay-admin.md) |
| "分享被举报怎么封杀？admin 后台怎么进？" | [app-admin.md](app-admin.md) |
| "KG 存储与 gRPC 契约？" | [app-kg.md](app-kg.md) |
| "云盘配额怎么记账？怎么横向扩容？" | [app-cloud.md](app-cloud.md) |
| "桌面端怎么跑？" | [mind-base-desktop.md](mind-base-desktop.md) |

---

## 历史归档（archive/）

一次性事件的过程记录（退役/切流/迁移）：只读存档，不再随实现更新；
现行规范以 AGENTS.md 与 docs/ 其余文档为准。

| Document | Description |
|----------|-------------|
| [python-decommission.md](archive/python-decommission.md) | Python backend 退役唯一记录：DoD、迁移归宿表、收尾清单、部署冒烟清单 |
| [app-ts-cutover.md](archive/app-ts-cutover.md) | 聊天域 + settings 切流 app-ts/app-settings：拓扑、上线步骤、冒烟、取舍 |
| [app-bili-migration.md](archive/app-bili-migration.md) | B 站获取域迁 app-bili：反爬、ASR、build 编排、事件桥 |
| [app-note-migration.md](archive/app-note-migration.md) | 笔记域迁 app-note：存储零迁移、wire 契约、MCP |
| [app-quiz-migration.md](archive/app-quiz-migration.md) | quiz 存储域迁 app-quiz：同库接管、分享缓存、internal 面 |
