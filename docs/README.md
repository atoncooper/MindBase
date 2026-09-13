# Documentation

| Document | Audience | Description |
|----------|----------|-------------|
| [architecture.md](architecture.md) | All | ⭐ 系统架构总览：服务清单/端口、nginx→APISIX 路由、数据归属、配置体系、CI |
| [setup-guide.md](setup-guide.md) | Users / Ops | 用 Docker 直接本地跑起来：装 Docker → 配置 → 启动 → 验证 → 开始用 |
| [getting-started.md](getting-started.md) | Developers | Local setup, project structure, workflow |
| [configuration.md](configuration.md) | All | Full YAML config reference, env vars, secrets |
| [deployment.md](deployment.md) | DevOps / SRE | Production deployment: Docker, HTTPS, monitoring, backup |
| [app-task.md](app-task.md) | Users / Ops | 定时出题任务：纯调度器、执行模型、WebUI、executor 对接、配置 |
| [app-board.md](app-board.md) | Developers / Ops | 思维导图/白板存储服务：API、乐观锁、TLS、配置 |
| [app-pay.md](app-pay.md) | Developers / Ops | 交易/会员服务：订单状态机、渠道、审计、TLS、配置 |
| [app-pay-admin.md](app-pay-admin.md) | Ops | 支付后台管理：查询、补偿开通、鉴权、TLS |
| [mind-base-desktop.md](mind-base-desktop.md) | Users / Developers | 桌面端（Tauri 2，全本地）：功能、运行、打包 |
| [notes.md](notes.md) | Developers | 笔记系统：分离存储、锚点、修订、分享、消毒 |
| [code-execution.md](code-execution.md) | Developers | Code Agent 代码执行：数据模型、产物协议、SSE 事件 |
| [quiz_harness.md](quiz_harness.md) | Developers | Quiz 离线质量评测 harness |
| [docker-deployment.md](docker-deployment.md) | DevOps | Legacy Docker Compose guide（已被 deployment.md 取代，仅存档） |

---

## Where to find

| Concern | Document |
|---------|----------|
| "系统整体长什么样？端口/路由/数据归属？" | [architecture.md](architecture.md) |
| "I cloned the repo, how do I run it?" | [getting-started.md](getting-started.md) |
| "我不会开发，只想用 Docker 跑起来" | [setup-guide.md](setup-guide.md) |
| "What env vars do I need?" | [configuration.md](configuration.md) |
| "How do I deploy to production?" | [deployment.md](deployment.md) |
| "How do I configure HTTPS?" | [deployment.md](deployment.md) |
| "How do I switch the LLM provider?" | [configuration.md](configuration.md) |
| "How do I change the chunk size?" | [configuration.md](configuration.md) |
| "app-task 是什么？怎么启动？" | [app-task.md](app-task.md) |
| "思维导图/白板数据怎么存的？" | [app-board.md](app-board.md) |
| "支付/会员服务怎么部署和配置？" | [app-pay.md](app-pay.md) |
| "支付后台怎么进？怎么补偿开通？" | [app-pay-admin.md](app-pay-admin.md) |
| "桌面端怎么跑？" | [mind-base-desktop.md](mind-base-desktop.md) |
