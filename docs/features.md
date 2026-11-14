# 功能全景

> 本文按「用户能做什么」介绍 MindBase 的完整能力面：入口、能力边界、数据落在哪里。
> 系统组成、端口与请求路由见 [architecture.md](architecture.md)；每个功能的实现细节在各专项文档中维护（文末有索引）。

MindBase 的能力围绕三条主线：

1. **把收藏变成知识** —— B 站收藏 / 云盘文档 → ASR → 向量化 → 检索问答 → 知识图谱；
2. **把知识用于产出** —— 笔记、题目、科研论文、思维导图与白板；
3. **把产出管起来** —— 云盘、公开分享、审核、会员与配额、管理台。

各功能入口统一在顶部导航栏（`frontendv2/lib/nav-config.ts`）：主栏为高频工作流，低频模块收在「更多」，设置与个人中心在右侧账户区。

---

## 1. 对话与多 Agent 协作

**入口**：导航「对话」（`/chat`）

- **主 agent**（main）：知识库问答，ReAct 循环 + 工具调用，边检索边作答。
- **子 agent**（经 `delegate_to_agent` 触达，花名册唯一来源 `app-ts/src/agent/manifest.ts`）：
  - `note`：把对话/给定内容整理成结构化 Markdown 笔记并入库；
  - `code`：写代码、解释与调试；沙箱可用时实际运行验证；
  - `academic`：科研项目、文献检索/核验、论文稿件读写（见 §4）；
  - `quiz`：按主题/大纲出题与批改；
  - `board`：经 MCP 操作思维导图与白板。
- **流式 SSE**：`route` / `reasoning` / `chunk` / `step` / `sources` / `plan` / `artifact` / `interact` / `usage` / `done` / `error`，前端由 `frontendv2/lib/chat-stream.ts` 解析。
- **富内容渲染**：前端原生渲染回答中的 `mermaid` 代码块（时序图 / 状态机 / 类图 / ER 图等）；可缩放拖拽的复杂交互图（架构图 / 链路图）走 `render_diagram`，统计数据对比 / 趋势 / 占比走 `render_chart`（柱状 / 折线 / 饼图），2-4 个方案选型走 `render_comparison`（优缺点 + 属性 + 推荐结论），函数图像走 `render_plot`；产物均可全屏、可查看模型原始数据，刷新后仍保留。
- **生成文件卡片**：对话中生成/导出的文件（沙箱产物、Word 回存云盘等）以文件卡展示——文件类型品牌色图标、文件名、动作与说明、`+N/−N` 改动量、图片 HoverCard 预览，以及打开 / 下载 / 复制菜单；旧历史文件产物也统一成同一张卡片。
- **思考与工具调用 UI**：思考过程与工具调用采用 AI 风格折叠组件（shadcn/Radix `Collapsible`，交互模式参考 Vercel AI Elements Reasoning/Tool）：流式 shimmer、耗时汇总、工具卡实时状态 / 参数 / 结果 / 来源分区，运行中的工具默认展开。
- **生成中排队**：AI 生成过程中输入框仍可继续输入，Enter（或排队按钮）把消息加入 FIFO 队列（最多 5 条、可取消），当前轮 done / error / stop 后自动发送队首；切换会话或新建对话会清空队列。
- **工具面**：`vector_search`、`kg_search`、`list_videos`、`get_video_summaries`、`run_code`、`run_skill_code`、`web_search`、`fetch_webpage`、`plan`、`save_memory`、`academic_*` 等（以工具注册表为准）；`kg_search` 仅在 Neo4j 可用时注册。
- **会话能力**：历史列表、自动标题、token 预算触发的上下文压缩、会话总结、长期记忆召回、技能索引注入；新建对话是**草稿态**——发出第一条消息前不在服务端落库（点「开启新对话」只会清掉当前空会话），因此不会在侧栏堆出空对话。
- **成本与公平**：会员档位加权排队（admission），委派子 agent 的 token 计入本轮用量。
- **科研上下文**：从科研工作台点「在对话中继续」会新建一个**绑定该项目的会话**（侧栏「开启新对话」右侧箭头也可选择绑定）；绑定随会话持久化，重开历史会话仍保留；后端校验归属后注入受控项目段落，聊天顶部显示「正在科研项目」横幅。

**数据**：聊天会话/消息、总结、记忆在 MongoDB `mind_base_ts`；向量在 Milvus。

---

## 2. 收藏夹与知识构建

**入口**：导航「收藏夹」（`/favorites`）

- 扫码登录 B 站，同步收藏夹与视频列表；按分 P 查看元数据、ASR 正文与向量化状态。
- **处理链路**：同步 → 音频下载 / 字幕抓取 → ASR 转写（正文存 Mongo `asr_documents`）→ 切块 + embedding → 写入 Milvus；ASR 与向量化解耦，可分别重跑。
- **知识图谱构建面板**：一键从转写稿抽取实体与关系（幂等，内容未变自动跳过），展示实体/关系/证据/覆盖视频与构建进度；Neo4j 不可用时自动降级为不可用态，不影响其他功能。
- 后台事件桥：`bili:page_ready` → 自动触发向量化。

**服务边界**：获取域权威在 **app-user（bili 路由）**，AI 侧向量化与检索在 **app-ts**。

---

## 3. 知识图谱与知识盲区

**入口**：导航「更多 → 知识图谱」（`/graph`）、「更多 → 知识盲区」（`/blindspot`）

- **图谱**：构建 = 已转写分 P → LLM 结构化抽取（每条关系必须携带原文引文）→ 引文校验防幻觉 → 写 Neo4j + 实体向量入 Milvus；查询 = 实体链接 → 子图多跳扩展 → 证据回捞（按用户收藏范围过滤）。
- **可视化**：力导向图浏览实体/关系/证据。
- **盲区图**：结合图谱与答题数据定位知识盲区，支持对盲区一键出题。
- **唯一写者**：Neo4j 只由 **app-kg** 写入（app-ts 经 gRPC 调用）。

---

## 4. 科研工作台与学术 Agent

**入口**：导航「科研」（`/research`）

- **三段式工作台**：左侧项目列表（本地搜索、新建、阶段徽标、文献/稿件计数）；右侧项目详情（标题/类型/领域/目标期刊/截止日期 + 六阶段步骤条）；Tabs：
  - **概览**：阶段推进与状态切换（二次确认）、执行计划勾选、阶段建议编辑；
  - **文献库**：Crossref / OpenAlex / arXiv 在线检索 → 加入项目、手动添加、分页、DOI 核验、删除、BibTeX 导出；
  - **写作**：文档列表与新建（后端默认六章）、章节正文编辑保存、Markdown/LaTeX 导出、Word 导入/导出与版式细节（docx_inspect）；
  - **计划**：顶部「阶段执行计划」只读展示 agent/概览保存的各阶段任务与建议；下方「计划运行」为 `plan_and_run` 的 DAG 执行记录（自动归属本项目）；
  - **实验 / 证据 / 验证 / 分析 / 空间 / 审批 / 动态**：实验执行与证据、导出前校验、分析产物、项目文件中心、审批流与事件流。
- **学术 agent**（聊天内可达）：写 / 审 / 改 / 理解四种模式；工具 `academic_project`（阶段、计划、建议）、`academic_literature`（检索、加入、核验、导出）、`academic_manuscript`（章节读写）、`docx_inspect`（Word 版式细节：字体字号/表格合并/页边距/页眉页脚）、`academic_evidence`（数据集/实验记录/执行记录）、`run_code`（沙箱内跑分析脚本）、`vector_search`（引用自有知识库素材）。
- **科研计划生成**：对话里让学术 agent「生成科研计划/研究计划」时，它用 `academic_project(action=plan_set, stages=[…])` 一次写入多个阶段的执行计划（每阶段 3-6 条任务，二次写入保留已完成状态），保存后出现在「概览 → 阶段执行计划」与「计划 Tab」；需要把计划拆成可执行 DAG 时走 `plan_and_run`（计划 Tab 的「计划运行」）。
- **引用纪律**：文献必须来自检索结果或核验过的 DOI，标题不一致不标记为已核验；正文引用以 citeKey 关联文献库。
- **REST 面**：`/academic/*`（项目、文献、文档/章节、导出、事件），数据在 `mind_base_ts.academic_*`。

详见 [academic-agent.md](academic-agent.md)。

---

## 5. 代码执行与沙箱控制层

**入口**：无独立页面 —— `code` / `academic` agent 的 `run_code` 工具；管理台「沙箱」页（`/sandbox`）。

- **分层**：OpenSandbox 负责「沙箱怎么被创建 / 执行 / 删除」；**app-sandbox**（Go）是产品控制层，负责「MindBase 怎么使用沙箱」。
- **控制层能力**：
  - **租约复用**：`uid + project + purpose + specHash → lease`，TTL 到期回收，避免一次执行创建一个沙箱；
  - **配额**：按会员档位限流（见下表），接 app-pay 档位（60s 缓存、fail-open free）；
  - **审计**：uid / 项目 / 镜像 / 耗时 / exitCode / 产物 hash / request_id 全生命周期落 `sandbox_audit`；
  - **产物**：执行产物登记元数据与对象存储引用（MinIO + 预签名）；
  - **准入与回收**：全局与每 uid 并发上限、有界队列（503/429）、执行超时、租约 TTL、孤儿 sweeper；
  - **诚实降级**：app-sandbox 不可达时 `run_code` 返回明确错误，绝不伪造执行结果。
- **档位配额**（默认值，见 `app-go/app-sandbox/default.yaml`）：

| 配额 kind | free | vip | svip |
|-----------|------|-----|------|
| `academic_run`（每日执行次数） | 20 | 200 | 600 |
| `sandbox_concurrent`（并发沙箱数） | 1 | 3 | 5 |
| `sandbox_cpu_seconds`（每日 CPU 秒） | 300 | 3600 | 10800 |
| `sandbox_artifact_bytes`（产物总量） | 50 MB | 500 MB | 2 GB |

- **接口**：app-ts → APISIX `sandbox_internal`（`/internal/sandbox/*`，key-auth + 去前缀）→ app-sandbox :8017；管理面 `/internal/admin/*` 仅由 app-admin 调用。
- **部署**：单机最小方案见 [deploy/docker/opensandbox](../deploy/docker/opensandbox/README.md)；生产 K8s（OpenSandbox 控制面/运行时 + 热池 + 网络策略）见 [deploy/k8s/40-sandbox](../deploy/k8s/40-sandbox/README.md)。

---

## 6. 笔记

**入口**：导航「笔记」（`/notes`）

- Markdown 编辑器、锚点定位、修订历史、软删除。
- **公开分享**：免登录只读，服务端二次消毒（剥除脚本/危险 URL）。
- **生成入口**：云盘文档一键转笔记（note agent 整理）、对话整理笔记。
- **存储**：元数据 MySQL（`notes` / `note_anchors` / `note_shares`），正文与修订 MongoDB；服务权威在 **app-content（note 面）**。

详见 [notes.md](notes.md)。

---

## 7. 题目练习与定时出题

**入口**：导航「题目练习」（`/quiz`）、「定时出题」（`/task-quiz`）

- **出题**：按收藏夹 / 分 P / 会话总结 / 自定义大纲生成题目（LLM 结构化输出，含解析与来源）；提交批改、历史回看、错题本、训练数据导出（JSONL / CSV / SFT）、分享。
- **定时出题**：用对话定义「到某时间出一道题」，系统按北京时间在合理时段内随机触发；到点生成题目并邮件发送（可抄送），限时答题，超时未答发送提醒。
- **实现分工**：出题/批改 AI 在 **app-ts**；题目存储与分享在 **app-content（quiz 面）**；调度与邮件投递由独立仓库 [atoncooper/app-task](https://github.com/atoncooper/app-task) 承担。

---

## 8. 思维导图 / 白板

**入口**：导航「思维导图」（`/mindmap`）

- Drive 风格板列表 + 完整编辑器（simple-mind-map），800ms 防抖自动保存 + Ctrl+S。
- 白板（Excalidraw）存储契约就绪。
- **存储**：MySQL 元数据 + MongoDB 正文，**app-content（board 面）** 服务权威，`If-Match` 乐观并发锁。
- **Agent 操作**：board agent 经 `app-content-mcp`（内容域 MCP）创建/查询/更新板子。

详见 [app-content.md](app-content.md) / [app-content-mcp.md](app-content-mcp.md)。

---

## 9. 云盘

**入口**：导航「云盘」（`/cloud-drive`）

- 文件夹树、分片直传（单文件最大 5GB）、文件名/语义搜索、排序、批量处理、配额用量条、回收站（软删 30 天）。
- **处理管道**：上传后异步解析（pdf/docx/doc/html/md/txt + 图片/截图/扫描 PDF vision OCR）→ 切块向量化 → 可检索；状态 `pending → processing → done/failed/not_supported`。
- **AI 能力**：每篇文档生成摘要/AI 标签/关键点/待办/可回答问题；详情页展示摘要与相似文件，可「问这份文件」进入限定范围的对话；语义检索支持当前文件夹范围；聊天来源可深链回云盘文件，agent 可用 `cloud_doc_summary` 读取摘要。
- **科研项目文件只读入口**：云盘侧栏「科研项目文件」→ 选择科研项目 → 只读查看 `00_课题与计划 … 06_投稿` 与写作文档来源/回存文件（预览/下载）。科研工作台自动维护的原始目录仍不在云盘侧栏展示，避免在普通云盘里误改名/移动/删除导致工作区目录映射失效。
- **配额**：免费 10GB / VIP / SVIP，档位来自 app-pay；初始化即原子预留，不超卖。
- **分享**：提取码 / 有效期 / 下载上限 / 短时效直链，免登录访问页；合规确认 + 文件夹分享 +「保存到我的云盘」（引用，不复制对象、不计配额）。
- **多实例就绪**：outbox 任务队列 + 原子配额预留 + 租约锁后台任务。

详见 [app-cloud.md](app-cloud.md)。

---

## 10. 公开分享与审核

- **分享面**：笔记、云盘文件/文件夹、测验套题均可生成公开链接（域名策略、设备证明、提取码、有效期）。
- **审核后置**：分享创建后进入待审核列表，管理员可放行 / 封杀 / 解封（封杀原因必填并审计）；`banned` 与已撤销同等公开 404，引用面同步失效。
- **受控预览**：用户在分享时单独确认「管理员可依法查看分享内容用于审核」；管理员仅可内联预览分享内文件（短时效 URL、无下载），每次查看落审计。
- **管理台**：分享审核 + 用户只读 + 审计日志（见 §14）。

详见 [sharing.md](sharing.md) / [app-admin.md](app-admin.md)。

---

## 11. 技能

**入口**：导航「更多 → 技能商店」（`/skills`）

- 技能包安装/卸载（zip 存 MinIO，元数据存 Mongo），技能商店（GitHub topic `mindbase-skill`，默认关闭）。
- 技能索引注入 agent 提示词（prompt-as-data）；`run_skill_code` 在沙箱执行技能代码。

---

## 12. 会员与支付

**入口**：导航「更多 → 会员中心」（`/membership`）

- **app-pay**（Java Spring Boot）：SKU / 订单 / 支付宝当面付 / 会员态 / 退款逆向，全链路 HTTPS + 资金审计；订单状态机条件更新、回调幂等、多实例 job 租约互斥。
- **档位驱动**：`free / vip / svip` 决定聊天排队权重、各类配额与云盘容量上限；档位不降级（有效期内 SVIP 不被 VIP 覆盖）。
- **运营后台**：统一管理台 app-admin（`http://127.0.0.1:3001`）的「支付运营」：订单/会员/权益事件/SKU 只读查询 + 会员补偿开通（`reason` 必填并三留痕）+ 退款复核（admin only，未配置 ops key 时隐藏）。

详见 [app-pay.md](app-pay.md) / [app-admin.md](app-admin.md)。

---

## 13. 桌面端

**位置**：独立仓库 [atoncooper/mind-base-desktop](https://github.com/atoncooper/mind-base-desktop)（Tauri 2 + React 19，Windows / macOS / Linux）

- 与 Web 后端**无运行时依赖**，数据全部在本机 SQLite。
- 能力：聊天 agent（结构化交互、产物卡片、后台任务、联网搜索）、B 站知识库与混合检索、思维导图/白板、Quiz、笔记、简历/幻灯片 agent、科研工作台与学术 agent + 记忆架构。

详见该仓库的 README 与 `docs/`（本仓不再维护桌面端源码与文档）。

---

## 14. 管理台

**入口**：本地回环 `http://127.0.0.1:3001`（Compose `app-admin`）；默认账号 `admin`，首登强制改密。

组成：**app-admin-api**（Go，:8016，直连共享 MySQL）+ **frontend-admin**（Vite + React + antd）。

- **分享审核**：待审核 / 已放行 / 已封杀筛选，详情抽屉（元数据 + 分享内文件 + 受控预览入口），封杀/解封/放行。
- **用户只读**：uid / email / phone / nickname / status / RBAC 角色；查询自动识别 UID / 手机号 / 邮箱。
- **审计**：操作中文标签 + 详情格式化 + 按动作深链。
- **沙箱管理**：概览、执行、租约、配额、审计；viewer 只读，admin 可取消执行 / 强制回收；管理动作双审计。

详见 [app-admin.md](app-admin.md)。

---

## 15. 平台横切能力

- **统一入口与鉴权**：nginx（TLS + 静态页 + 缓存）→ APISIX（forward-auth / key-auth / 路由 / 限流）；下游服务信任网关注入的 `X-Uid` / `X-Roles`，不自验会话（见 [api.md](api.md)）。
- **AI 出网**：LLM / Embedding / Rerank / ASR 统一经 **Higress AI 网关**，供应商密钥只在网关侧，用户无需配置任何 Key；网关侧计量回流到平台账单。
- **配额与计费**：app-ts 的 `QuotaService` 覆盖 chat、图片、出题、批改、OCR、KG 构建、向量化、板子、定时出题等 kind 的档位限额；沙箱配额在 app-sandbox。
- **可观测**：各服务 `/health`（部分含 `/ready`、`/metrics`）；app-sandbox、app-admin 等提供 Prometheus 指标；SSE 流带 `usage` 帧。
- **数据归属**：每个域只有唯一写者，明细见 [architecture.md](architecture.md)「数据归属」。
- **配置体系**：各服务独立 YAML + 项目根 `.env`（只放密钥/连接串），见 [configuration.md](configuration.md)。

---

## 相关文档

- [系统架构总览](architecture.md) —— 服务清单、端口、路由、数据归属
- [API 概览](api.md) —— 鉴权、前缀、SSE 帧、错误约定
- [科研工作台与学术 Agent](academic-agent.md)
- [管理台](app-admin.md) / [MikroORM](mikro-orm.md)
- [本地开发](getting-started.md) / [Docker 快速上手](setup-guide.md) / [生产部署](deployment.md)
- [常见问题](faq.md)
