# 文档索引

> 本目录按「读者 / 场景」组织：**项目是什么、能做什么**看根 [README](../README.md)；
> **开发规范与红线**以仓库根 `AGENTS.md`（本地维护，不入 git）为准，目录落位与测试见 [project-structure.md](project-structure.md)。新增/重命名文档时请同步登记本索引。

---

## 一、快速开始

| 文档 | 适合谁 | 内容 |
|---|---|---|
| [setup-guide.md](setup-guide.md) | 普通用户 / 运维 | ⭐ 用 Docker 直接跑起来：装 Docker → 拉代码 → 申请 API Key → 配 .env → 启动 → 验证 |
| [getting-started.md](getting-started.md) | 开发者 | 本地开发：前置依赖、克隆/安装、最小 .env、起后端与前端、验证全链路 |
| [architecture.md](architecture.md) | 所有人 | 系统架构总览：服务清单/端口、nginx → APISIX 路由、数据归属、配置体系、CI |
| [configuration.md](configuration.md) | 所有人 | 配置体系：各服务 YAML 入口、共享 `env`、Higress AI 网关、密钥清单 |
| [deployment.md](deployment.md) | DevOps / SRE | 生产部署：Docker、HTTPS、监控、备份与升级 |

## 二、按主题深入

### 2.1 架构与平台

| 文档 | 内容 |
|---|---|
| [architecture.md](architecture.md) | 服务拓扑、端口、网关路由、数据归属（本目录入口文档） |
| [configuration.md](configuration.md) | 分层配置与共享环境变量约定 |
| [service-key-auth.md](service-key-auth.md) | 服务间 API Key 体系：app-user（auth 路由）签发 + APISIX 校验、防串用、演进方向 |
| [client-compose.md](client-compose.md) | `docker-compose.client.yml` 客户端部署：与服务端 compose 的差异、裁剪与降级行为 |
| [deployment.md](deployment.md) | 生产部署、HTTPS（Caddy）、监控与备份 |

### 2.2 AI 与 Agent

| 文档 | 内容 |
|---|---|
| [academic-agent.md](academic-agent.md) | 网页端学术 Agent：项目/文献/稿件/证据工具、REST、数据模型、性能与运维、故障排查 |
| [code-execution.md](code-execution.md) | 代码执行（run_code）：沙箱边界、控制层调用链、结果与持久化、失败降级 |
| [mikro-orm.md](mikro-orm.md) | app-ts MongoDB 的 MikroORM 采用说明与分阶段迁移计划 |

### 2.3 业务服务（app-*）

| 文档 | 内容 |
|---|---|
| [app-task.md](app-task.md) | 定时出题任务：调度模型、数据表、WebUI、executor 对接、配置 |
| [app-content.md](app-content.md) | 内容域服务 app-content（笔记 / 测验 / 板存储三域合一）：端口、API、TLS、配置、域边界 |
| [app-board-mcp.md](app-board-mcp.md) | 思维导图/白板 MCP server：工具面、认证、限流、TLS、服务模式接入 |
| [app-pay.md](app-pay.md) | 交易/会员服务：订单状态机、支付渠道、审计、TLS、配置 |
| [app-admin.md](app-admin.md) | 统一管理后台：分享审核（封杀/解封/放行）、支付运营（订单/会员/权益事件/SKU/补偿开通/退款复核）、沙箱、统一账户与审计、部署 |
| [app-cloud.md](app-cloud.md) | 云盘服务：分块上传、配额记账、分享/回收站、向量化管道、多实例扩容 |
| [app-kg.md](app-kg.md) | 知识图谱：app-kg（gRPC 存储）+ app-ts（AI 编排）、proto 契约、已知取舍 |

### 2.4 内容能力

| 文档 | 内容 |
|---|---|
| [notes.md](notes.md) | 笔记系统：MySQL/Mongo 分离存储、锚点、修订、分享、Markdown 消毒 |
| [sharing.md](sharing.md) | 公开分享体系：分享链接域名链、设备证明、提取码、部署检查清单 |

> 桌面端（Tauri 2，全本地）已拆分为独立仓库 [atoncooper/mind-base-desktop](https://github.com/atoncooper/mind-base-desktop)，其文档在该仓库 `docs/` 维护；本仓不再包含桌面端源码与文档。

### 2.5 开发环境

| 文档 | 内容 |
|---|---|
| [vscode-setup.md](vscode-setup.md) | VS Code 多语言单仓配置：Java 自动构建、任务与工作区 |

## 三、项目介绍配套文档

根 README 只做项目介绍（是什么 / 能做什么 / 怎么开始）；下列文档承接具体展开：

| 文档 | 内容 |
|---|---|
| [features.md](features.md) | 功能全景：知识库问答、科研工作台与沙箱、KG、笔记、云盘、测验、会员、管理台 |
| [project-structure.md](project-structure.md) | 仓库目录、代码落位、依赖方向与测试矩阵 |
| [api.md](api.md) | API 概览：请求入口、鉴权、按域前缀、SSE 帧与错误约定 |
| [faq.md](faq.md) | 常见问题：运行环境、数据存储、AI 密钥、科研沙箱、管理台与运维 |

## 四、按问题找文档

| 我想知道 / 要做什么 | 先看 |
|---|---|
| 系统整体长什么样？端口、路由、数据归谁？ | [architecture.md](architecture.md) |
| 我克隆了仓库，怎么在本地跑起来？ | [getting-started.md](getting-started.md) |
| 我不会开发，只想用 Docker 跑起来 | [setup-guide.md](setup-guide.md) |
| 需要配哪些环境变量 / 怎么换模型或网关？ | [configuration.md](configuration.md) |
| 怎么部署到生产、怎么配 HTTPS？ | [deployment.md](deployment.md) |
| 服务间调用为什么要 API Key？怎么防串用？ | [service-key-auth.md](service-key-auth.md) |
| 学术 Agent / 科研项目 / 文献核验怎么工作？ | [academic-agent.md](academic-agent.md) |
| 代码执行和产物记录怎么存、怎么回放？ | [code-execution.md](code-execution.md) |
| 定时出题、内容域（笔记/测验/白板）、支付、云盘、KG 各服务怎么配？ | [app-task.md](app-task.md) / [app-content.md](app-content.md) / [app-pay.md](app-pay.md) / [app-cloud.md](app-cloud.md) / [app-kg.md](app-kg.md) |
| 笔记/分享的存储与防护？ | [notes.md](notes.md) / [sharing.md](sharing.md) |
| 桌面端怎么跑/怎么打包？ | 独立仓库 [atoncooper/mind-base-desktop](https://github.com/atoncooper/mind-base-desktop) |
| VS Code 里为什么总在构建 / 没有 Rust 补全？ | [vscode-setup.md](vscode-setup.md) |
| 历史迁移与切流过程（只读存档） | [archive/](archive/)（见下节） |

## 五、历史归档（archive/）

一次性事件的过程记录（退役/切流/迁移）：只读存档，不再随实现更新；现行规范以 AGENTS.md 与本目录其余文档为准。

| 文档 | 内容 |
|---|---|
| [python-decommission.md](archive/python-decommission.md) | Python backend 退役唯一记录：DoD、迁移归宿表、收尾清单、部署冒烟清单 |
| [app-ts-cutover.md](archive/app-ts-cutover.md) | 聊天域 + settings 切流（settings 现并入 app-user）：拓扑、上线步骤、冒烟、取舍 |
| [B 站获取域迁移（存档）](archive/) | 反爬、ASR、build 编排、事件桥（获取域现由 app-user 承载） |
| [app-note-migration.md](archive/app-note-migration.md) | 笔记域迁 Go（现并入 app-content）：存储零迁移、wire 契约、MCP |
| [app-quiz-migration.md](archive/app-quiz-migration.md) | quiz 存储域迁 Go（现并入 app-content）：同库接管、分享缓存、internal 面 |

---

## 维护约定

- 新增/删除/改名文档：同一 PR 内更新本索引，避免再出现指向不存在文件的链接。
- 索引只放「入口 + 一句话说明」；功能细节写进对应文档，不在本页重复，避免与正文漂移。
