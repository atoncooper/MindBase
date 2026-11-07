# MindBase

> 把收藏变成可检索、可问答、可产出的个人知识库。

MindBase 是一套**自托管的个人知识库与 AI 研究工作台**：把 B 站收藏、云盘文档这类碎片化素材，变成能检索、能追问、能引用、能用于写作与出题的结构化知识。

它的起点是一条完整的知识管道——同步收藏 → 语音转写（ASR）→ 文本切块与向量化 → 写入 Milvus → 多 agent 流式问答并给出引用来源。在管道之上，MindBase 继续长出知识图谱、笔记、题目练习、思维导图与白板、云盘，以及一条面向科研的完整工作流：项目管理、文献检索与核验、论文稿件撰写、分析脚本在隔离沙箱中执行。

整套系统可以完全跑在自己的机器或集群里：数据落在自己的数据库，模型请求经自己部署的 AI 网关出网，用户不需要配置任何 API Key。

**适合谁**：收藏夹里堆满「以后再看」的学习者、需要管理文献与写作的研究者、希望私有部署 AI 知识库的个人与团队。

---

## 核心能力

| 能力 | 说明 |
|------|------|
| **知识库问答** | ReAct agent 流式回答，按收藏夹 / 分 P / 云盘文档检索，答案带来源；子 agent 按任务类型分工（笔记、代码、学术、出题、思维导图） |
| **科研工作台** | 项目六阶段推进、Crossref / OpenAlex / arXiv 文献检索与 DOI 核验、BibTeX 与稿件导出、分析脚本在沙箱内真实执行 |
| **知识图谱与盲区** | 从转写稿抽取实体与关系（每条关系必须带原文引文，防幻觉），子图检索与证据回捞，按盲区一键出题 |
| **笔记 / 题目 / 思维导图** | Markdown 笔记与公开分享、按内容出题与批改、错题本与训练数据导出、思维导图与白板 |
| **云盘** | 5GB 分片直传、配额记账、提取码分享、文档解析与向量化，多实例就绪 |
| **会员与运营** | 会员档位驱动配额与排队权重；管理台承担分享审核、用户只读查询、审计与沙箱运维 |
| **桌面端** | [独立仓库 mind-base-desktop](https://github.com/atoncooper/mind-base-desktop)：Tauri 2 全本地应用，与 Web 后端零运行时依赖，数据只在本机 |
| **平台化底座** | 统一网关鉴权、AI 出网统一、配额与计量、健康检查与指标、Docker Compose 与 K8s 部署 |

功能细节与入口见 [docs/features.md](docs/features.md)。

---

## 架构一览

```text
浏览器 / 桌面端
   │
   ▼
nginx（TLS + 静态页 + 缓存）
   │
   ▼
APISIX（统一鉴权 / 路由 / 限流）
   │
   ├── app-ts         AI 域：chat / agent / RAG / 知识图谱编排 / 向量化 / 学术
   ├── app-go/*       各域权威服务：用户（认证/偏好/B站获取）/ 云盘 / 内容（笔记/测验/思维导图白板）/ 知识图谱存储 / 管理台
   ├── app-pay        交易与会员（可选）
   └── app-sandbox    沙箱控制层：租约 / 配额 / 审计 / 产物 / 准入
          │
          ▼
      OpenSandbox 运行时（隔离执行用户代码）
```

- **数据**：MySQL（业务元数据）、MongoDB（会话 / 笔记正文 / 学术数据）、Milvus（向量）、Neo4j（知识图谱）、Redis（限流 / 缓存 / 事件）、MinIO（文件对象）。
- **AI 出网**：LLM / Embedding / Rerank / ASR 统一经 **Higress AI 网关**，供应商密钥只在网关侧；网关侧用量回流到平台计量。
- **拆分原则**：AI 能力集中在 app-ts，领域数据由各自 Go / Java 服务独占写入，网关只做鉴权与路由——每个域只有一个写者，读多写少的服务可水平扩容。
- **技术栈**：Next.js 16 + React + Tailwind（前端）、Node 22 + Fastify（AI 域）、Go 1.25 + Gin（领域服务）、Java 21 + Spring Boot（交易）、Tauri 2（桌面端）。

完整的服务清单、端口、路由与数据归属见 [docs/architecture.md](docs/architecture.md)。

---

## 快速开始

### Docker（推荐首次体验）

```bash
git clone https://github.com/atoncooper/MindBase.git
cd MindBase
cp .env.example .env      # 至少填 AI_GATEWAY__API_KEY 与 APISIX_CONSUMER_KEY（见文件内注释）
docker compose up -d      # 默认 profile 即全栈
```

打开 <http://localhost:3000> 登录（B 站扫码 / 账号密码）。首次启动会拉取镜像并初始化数据库，耗时取决于网络。

可选能力按 profile 追加（先起全栈，再追加；单独指定 `--profile X` 只会启动该 profile 的服务）：

```bash
docker compose up -d                       # 已起全栈
# AI 能力必须追加网关：供应商密钥在 Higress 控制台 http://127.0.0.1:18081 配置
docker compose --profile ai up -d
docker compose --profile sandbox up -d     # 科研代码执行：沙箱控制层 + OpenSandbox
docker compose --profile pay up -d         # 会员 / 支付
# 或者一次起「全栈 + 全部可选组件」
docker compose --profile full up -d
```

逐步说明（依赖检查、密钥准备、Higress 控制台配置供应商、启动后验证）见 [docs/setup-guide.md](docs/setup-guide.md)；生产部署、HTTPS、监控与备份见 [docs/deployment.md](docs/deployment.md)。

### 本地开发

需要 Docker、Node.js ≥ 22.17、Go 1.25+（按需）。日常改 AI 域或前端时：容器跑全栈，本地热重载 `app-ts` 与 `frontendv2` 两个进程，并导出连接串与密钥（app-ts 不读 `.env`）；还需一个本地 `docker-compose.override.yml` 把 APISIX `9080` 映射到宿主，供前端 dev 代理与 app-ts 出站调用。

完整命令、override 示例、逐服务本地启动方式、测试与排错见 [docs/getting-started.md](docs/getting-started.md)。

---

## 文档

| 想了解 | 看这里 |
|--------|--------|
| 用 Docker 直接跑起来 | [docs/setup-guide.md](docs/setup-guide.md) |
| 本地开发环境与命令 | [docs/getting-started.md](docs/getting-started.md) |
| 系统组成、端口、路由、数据归属 | [docs/architecture.md](docs/architecture.md) |
| 功能全景与入口 | [docs/features.md](docs/features.md) |
| API 前缀、鉴权、SSE 与错误约定 | [docs/api.md](docs/api.md) |
| 目录结构、依赖方向、测试矩阵 | [docs/project-structure.md](docs/project-structure.md) |
| 配置项与密钥 | [docs/configuration.md](docs/configuration.md) |
| 生产部署与运维 | [docs/deployment.md](docs/deployment.md) |
| 科研工作台与学术 Agent | [docs/academic-agent.md](docs/academic-agent.md) |
| 管理台（分享审核 / 沙箱运维） | [docs/app-admin.md](docs/app-admin.md) |
| 常见问题 | [docs/faq.md](docs/faq.md) |

全部文档索引见 [docs/README.md](docs/README.md)；变更记录见 [CHANGELOG.md](CHANGELOG.md)。

---

## 项目状态

MindBase 处于活跃开发中。Python 后端已于 2026-10 退役，AI 域由 app-ts 承接（迁移记录见 [docs/archive/python-decommission.md](docs/archive/python-decommission.md)）。

近期重点：

- 科研工作台与学术 agent：项目管理、文献核验、稿件写作，以及聊天内项目上下文；
- 沙箱控制层：租约复用、档位配额、审计与产物，OpenSandbox 的 Docker / K8s 部署；
- 管理台：分享审核、受控预览、沙箱运维面板；
- 存储演进：MongoDB 访问逐步迁移到 MikroORM（见 [docs/mikro-orm.md](docs/mikro-orm.md)）。

已知边界（会随实现推进更新）：沙箱真实运行时与大规格镜像仍在验证；MikroORM 迁移覆盖部分仓储；浏览器端到端回归尚未全覆盖。

---

## 参与开发

- 开发规范、目录落位与测试矩阵见 [docs/project-structure.md](docs/project-structure.md)；
- 提交前请本地跑通对应测试（app-ts `npm run typecheck && npm test`、Go `go test ./...`、前端 `npm run lint`）；CI 按目录分服务执行；
- 提交信息格式：`[模块] type: 说明`；不要提交 `.env`、密钥或构建产物；
- 新增端点必须显式配置网关路由（APISIX 无兜底路由）。

---

## License

[MIT](LICENSE)
