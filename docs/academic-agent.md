# 网页端学术 Agent（academic）

> 状态：**Phase 1 + 1.5 + 2 已落地**（2026-11-01）；Phase 3 评估见 §十三；沙箱控制层见 §十五。
> 设计文档：`plan/1.0.17-WebAcademicAgent`、`plan/1.0.12-AcademicAgent`（本地维护，不入 git）
> 契约唯一来源：`app-ts/src/repository/academic.ts`

---

## 一、概述与定位

### 1.1 是什么

网页端（app-ts + frontendv2）的学术研究能力：一个经 `delegate_to_agent` 可达的 **academic 子 agent**，以及它使用的三组仓储化工具（科研项目 / 文献库 / 论文稿件）。目标是把桌面端 `AgentKind::Academic` + `AgentKind::Research` 的核心工作流带到服务端，**不复制**本地 Python 执行、SSH 与文件沙箱。

| 能力 | 承载 | 阶段 |
|---|---|---|
| 研究项目、六阶段状态机、阶段计划与指导建议 | `academic_project` + `academic_events` | Phase 1 |
| 文献检索（Crossref / OpenAlex / arXiv）、BibTeX·CSL 导入、DOI 核验、BibTeX 导出 | `academic_literature` + `auth/literature-client.ts` | Phase 1 / 1.5 批量导入与分页 |
| 论文稿件（开题报告 / 研究计划 / 初稿 / 修改稿 / 投稿信）、章节读写、大纲、Markdown·LaTeX 导出 | `academic_manuscript` | Phase 1 |
| 期刊要求查证、最新信息 | `web_search` / `fetch_webpage`（复用通用工具） | Phase 1 |
| 多步任务可见化、跨轮偏好 | `plan` / `save_memory`（复用通用工具） | Phase 1 |
| 科研工作台 UI、`/academic/*` REST | frontendv2 `/research` + 服务端编排 | Phase 2 |

### 1.2 定位：研究助手，不是代写者

系统提示词 `prompts/agents/academic.md` 把行为约束成四条不可协商的原则：

1. **研究助手而非代写者**：产出供用户判断、修改、负责的草稿与建议；署名、结论、数据与投稿决定由用户拍板。
2. **事实可溯**：文献只能来自工具检索或用户导入，数据只能来自用户提供或工具输出；任何"看起来合理"的数字都不允许生成。
3. **过程可见**：先确认项目与当前阶段再动手；多步任务先列计划，逐步汇报。
4. **人工门禁**：阶段推进必须用户明确同意；工具只执行 `stage_update`，不替用户批准或跳过前置阶段。

四种工作模式（提示词内置判定）：写作 / 审查 / 修改 / 精读理解。

### 1.3 与桌面端的关系

网页端按服务端形态裁剪，不是桌面端的打包移植：

| 桌面端（mind-base-desktop） | 网页端（app-ts） | 说明 |
|---|---|---|
| 本地 SQLite + 本地项目目录 | Mongo 自有库 `mind_base_ts` + 无本地文件系统 | 数据以 `uid` + `projectId` 隔离 |
| `academic_literature`（含 PDF 下载） | 检索 / 导入 / 核验 / 导出，**不下载 PDF** | 保留 DOI/URL，文件落盘由用户完成 |
| `academic_project`（桌面项目控制台） | 同名工具，`create` 为网页新增 | 无本地项目目录，项目纯元数据 |
| `academic_manuscript`（DOCX/PDF 导出） | Markdown / LaTeX 文本导出 | DOCX 依赖 Python，Phase 3 评估 |
| `academic_evidence`（数据集/脚本/run） | 不做 | 需要服务端受控执行与对象存储 |
| `academic_code`（项目文件读写） | 不做 | 网页没有项目目录沙箱 |
| 科研工作台 UI | Phase 2（`/research` 视图 + REST） | Phase 1 只经聊天可用 |

### 1.4 非目标（Phase 1.5 之前不做）

- 不做本地脚本执行、SSH、PDF 下载、DOCX 生成、多人协作与版本分支。
- 不在服务端保存文件：导出结果是文本，落盘由用户完成。
- 不自动推进阶段、不自动标注"已核验"、不生成实验数据或审稿意见。

---

## 二、架构

### 2.1 分层图

```text
┌──────────────────────────────────────────────────────────────────────┐
│ frontendv2 聊天视图（SSE 消费方；Phase 1.5 无学术专属 UI）           │
└───────────────┬──────────────────────────────────────────────────────┘
                │ POST /chat/stream（APISIX chat_ts → app-ts :8000）
┌───────────────▼──────────────────────────────────────────────────────┐
│ app-ts transport/http/routes/chat.ts                                  │
│   → services/chat → harness/AgentHarness → agent/orchestrator        │
│   → main agent（ReAct；工具面含 delegate_to_agent）                  │
└───────────────┬──────────────────────────────────────────────────────┘
                │ delegate_to_agent("academic", message)
                │ · 子 agent 不参与路由（main 是唯一路由目标）
┌───────────────▼──────────────────────────────────────────────────────┐
│ academic agent（ReAct；prompts/agents/academic.md）                   │
│   ├─ academic_project      项目 / 六阶段 / 计划 / 建议               │
│   ├─ academic_literature   检索 / 导入 / 入库 / 核验 / 导出          │
│   ├─ academic_manuscript   文档 / 章节 / 大纲 / Markdown·LaTeX 导出  │
│   ├─ web_search · fetch_webpage                                      │
│   └─ plan · save_memory                                              │
└───────────────┬──────────────────────────────────────────────────────┘
                │ tools 只 import 契约，不 import 具体适配器
┌───────────────▼──────────────────────────────────────────────────────┐
│ src/repository/academic.ts（契约 + 纯函数 helper；无 I/O）           │
│   ├─ src/repository/memory/academic.ts   内存实现（测试 / 降级）     │
│   └─ src/repository/mongo/academic.ts    Mongo 实现（mind_base_ts）  │
└──────────────────────────────────────────────────────────────────────┘
                │ 仅 academic_literature 触发外网
                ▼
   src/auth/literature-client.ts → Crossref / OpenAlex / arXiv
```

### 2.2 代码位置

| 位置 | 职责 |
|---|---|
| `src/agent/academic/agent.ts` | academic 子 agent 工厂：只声明身份、工具名单与提示词来源，循环/重试/SSE 由共享 `createReactAgent` 提供 |
| `src/agent/manifest.ts` | agent 花名册（名称 + 描述）唯一来源；`delegate_to_agent` 的可用列表自动跟随 |
| `src/tools/academic/{project,literature,manuscript}.ts` | 三组工具工厂；返回中文文本 + 结构化 artifact |
| `src/auth/literature-client.ts` | 学术域唯一出网边界：Crossref/OpenAlex/arXiv 检索 + DOI 核验，含进程内 TTL 缓存（search 5 分钟 / DOI 核验 1 小时） |
| `src/repository/academic.ts` | 四组仓储契约（项目 / 文献 / 文档 / 事件）+ 纯函数 helper（唯一语义来源） |
| `src/repository/memory/academic.ts` | 内存实现：测试替身 + Mongo 不可达时的降级 |
| `src/repository/mongo/academic.ts` | Mongo 适配器：持久化、索引、原子更新 |
| `src/bootstrap/container.ts` | 组合根：按 Mongo 可达性选仓储、注册工具、创建 agent、注册 lifecycle、关停释放 |
| `prompts/agents/academic.md` | 学术系统提示词（四模式 + 项目工作流 + 引用纪律 + 诚信红线） |
| `config/default.yaml` + `src/config/index.ts` | `academic.*` 配置段（开关 + 文献源） |
| `test/academic-*.test.ts` | 仓储 / 文献客户端 / 工具 / agent 接线的离线单测 |

### 2.3 一次学术委托的时序

1. 用户消息进入 `main` agent；LLM 判定属于学术任务后调用 `delegate_to_agent({ agent: "academic", message })`。
2. harness 以 `invokeReentrant` 运行 academic agent：**不取会话锁**（避免重入死锁），仍受熔断器约束；非流式，结果折叠为 `{ content, sources, failed }`。
3. academic agent 在独立 ReAct 循环里按需调用三组工具（以及 web/plan/memory），每次工具调用都带上 `ctx.uid`。
4. 工具执行：参数校验（zod）→ 仓储读写 / 文献网络调用 → 追加项目事件 → 收集 artifact → 返回给 LLM 的中文摘要文本。
5. 子 agent 产出最终回答；`delegate` 只把 `content`（超过 6000 字符截断）与 `sources` 回传主 agent。
6. 主 agent 基于子 agent 回答继续生成，必要时再委托（同一子 agent 单轮连续失败 2 次后短路，防止 token 空转）。
7. 主 agent 的最终回答与 sources/artifacts 在流尾按既有 SSE 协议发出。

### 2.4 SSE 帧如何承载

| 帧 | 学术任务中的表现 | 说明 |
|---|---|---|
| `route` | `agent: "main"` | academic 是委托子 agent，不是路由目标；新增子 agent 不改变路由提示词 |
| `delegate` | `start` / `done`，带 `active`（并发子 agent 数）与 `index`（本轮第几次委托） | 由主 agent 的 ReAct 循环在 `delegate_to_agent` 调用前后发出；**子 agent 自己的帧不转发**，只有这个括号 |
| `step` | 主 agent 视角的 `delegate_to_agent` 一步（`args` 预览含 agent + message 前 120 字符）与耗时 | 子 agent 内部工具调用不进入主会话 step 时间线 |
| `chunk` | 子 agent 最终文本作为工具结果回到主 agent，再由主 agent 的最终回答流式输出 | 长文本被 `delegate` 截断（6000 字符），完整导出需 Phase 2 UI |
| `artifact` | 已出现（P0 修复）：子 agent 的 artifact 现在合并进主会话 collector，随 `artifact` 帧下发 | 聊天前端目前只渲染 `quiz` / `quiz_grading` 两种 kind；`academic_*` 卡片待 Phase 2 渲染器接入（协议与数据已就绪） |
| `sources` | 子 agent 的 sources 会并入主会话流尾的 sources 帧 | 三组 academic 工具本身不产出 sources；联网工具可能产出 |
| `error` / `done` | 委托失败以 `[委托失败]` 前缀文本返回；会话级错误按全局协议处理 | 工具层预期失败都降级为文本，不抛穿 ReAct 循环 |

> 结论：Phase 1.5 的用户可见体验 = **delegate 状态 + 主 agent 的最终自然语言回答**；结构化 artifact 已产出但留给 Phase 2 前端。前端无需改动即可使用，未知帧/未知 artifact kind 按协议忽略。

### 2.5 身份、项目锚点与上下文

- **uid 边界**：所有工具从 `ToolRunContext` 读取 `ctx.uid`；`inputSchema` 中**没有** uid 字段，模型无法指定他人身份。仓储每个方法第一个参数都是 uid，跨 uid 读取视为 bug。
- **项目锚点**：文献与稿件都挂在 `projectId` 下；换会话不丢上下文，但也不允许跨项目混用。除 `academic_project(list/create)` 与 `academic_literature(search)` 外，所有 action 都需要 `projectId`。
- **子 agent 上下文**：经 `AgentContextBinding` 注入自己的近期上下文（`recentKeep` 条）与会话摘要；不继承 RAG 检索 scope。

---

## 三、工具参考

### 3.1 通用约定

- **返回形态**：工具返回中文文本（ReAct 循环读到的 tool result），同时向 `ctx.collector` 推送 `kind: "academic_project" | "academic_literature" | "academic_manuscript"` 的 artifact（Phase 2 消费）。
- **错误处理**：参数不合法、项目/文档不存在、外部服务失败都返回**可读中文指引**，不抛异常；模型可据此重试或追问用户。
- **无 uid 参数**：见 §2.5。
- **主要数量限制**：文献检索 `limit` 1–10（默认 5）；文献列表 `limit` 1–100（默认 30）；`tasks` 1–12；`sections` 1–30；`advice` ≤4000 字符；`reason` ≤300 字符；项目标题 ≤120；文档/章节标题 ≤200；文献标题 ≤500。
- **事件**：所有写操作都会追加一条项目事件（见 §3.5 表），事件流 append-only、newest-first。

### 3.2 `academic_project`

项目是学术任务的根聚合：一个六阶段状态机 + 各阶段计划/建议，文献与稿件以 `projectId` 关联。

| action | 必填 | 可选 | 行为与返回 |
|---|---|---|---|
| `list` | — | — | 列出当前 uid 的项目（标题/类型/当前阶段/截止/更新时间），按 updatedAt 倒序；无线索时提示 `create` |
| `create` | `title` | `paperType`（journal 缺省 / thesis / fund）、`field`、`targetJournal`、`deadline`（YYYY-MM-DD） | 新建项目，阶段机器从 `topic` 开始（topic=active，其余 locked）；返回 `project_id` 与下一步建议 |
| `brief` | `projectId` | — | 项目简报：阶段状态、**文献 N 篇 / 稿件 M 篇**（Phase 1.5 计数投影）、各阶段计划完成度、已保存建议、最近 5 条事件 |
| `stage_update` | `projectId`、`stage` | `status`（缺省 active；locked/active/submitted/approved/frozen）、`reason` | 推进/回退/更新阶段。**回退（目标阶段在流程中更早）必须给 reason**；同阶段同状态且无 reason 为幂等无操作；工具**不会**自动置 approved，也不会自动推进——approved 只能由用户在确认后显式要求 |
| `save_advice` | `projectId`、`stage`、`advice` | — | 保存该阶段指导建议（覆盖该阶段旧值，其他阶段不动） |
| `plan_get` | `projectId`、`stage` | — | 读取该阶段计划；空计划返回操作指引 |
| `plan_set` | `projectId`、`stage`、`tasks`（1–12 条字符串） | — | 写入该阶段计划。**按 title 合并**：同名任务保留原完成状态、原 id 与备注；新任务按位置生成 `t1…` 形式 id |

阶段顺序：`topic 选题 → design 研究设计 → advise 指导 → experiment 实验 → writing 写作 → submission 投稿`。
阶段状态中文标签：locked 未开始 / active 进行中 / submitted 待确认 / approved 已确认 / frozen 已冻结。

示例（模型侧参数，无 uid）：

```json
{"action":"create","title":"基于图神经网络的推荐系统综述","paperType":"journal","field":"推荐系统","targetJournal":"ACM TOIS","deadline":"2026-12-31"}
```

```json
{"action":"stage_update","projectId":"8f0c…","stage":"writing","status":"active"}
```

```json
{"action":"plan_set","projectId":"8f0c…","stage":"writing","tasks":["完成方法章节","补齐实验对比表","统一参考文献格式"]}
```

### 3.3 `academic_literature`

文献库是引用的事实来源。**search 返回的是未核验候选**，只有 `verify`（DOI 在 Crossref 命中且标题匹配）才把库内条目标为已核验；正文只允许引用库内 citeKey。

| action | 必填 | 可选 | 行为与返回 |
|---|---|---|---|
| `search` | `query` | `limit`（1–10，默认 5）、`source`（auto 缺省 / crossref / openalex / arxiv） | 检索候选，不需要 `projectId`；auto = Crossref 优先，异常或 0 命中回退 OpenAlex；返回标题/作者/年份/期刊/DOI/URL，全部标注未核验 |
| `list` | `projectId` | `limit`（1–100，默认 30） | 列出项目文献库前 N 篇（citeKey/标题/年份/核验状态）：先取总数，再在工具层截取前 N 篇渲染（仓储契约暂无 offset）；超出时末尾标注「共 X 篇，已显示前 N 篇（action=list limit 可调，范围 1-100）」 |
| `import` | `projectId`、`text` | — | 解析 BibTeX（`@type{…}`）或 CSL-JSON（数组 / `{"items":[…]}`），**一次批量入库**（Phase 1.5 `addMany`）：按 DOI 优先、title+year 兜底去重；重复项跳过并保留原核验状态；返回解析/新增/重复计数 |
| `add` | `projectId`、`title` | `authors`、`year`、`venue`、`doi`、`url` | 把用户确认的检索候选或用户给出的元数据加入库（source=manual）；不确定的字段留空，禁止编造；重复时返回已有条目并保持其核验状态 |
| `verify` | `projectId`、`ref`（文献 id / citeKey / DOI） | — | 先用库内 id/citeKey 解析，再回退 DOI 精确查；无 DOI 则说明无法在线核验；Crossref 404/未收录 → 保持未核验；网络失败 → 报错文案且状态不变；**DOI 命中但标题不一致 → 拒绝标记**（防止 DOI 抄错/张冠李戴）；通过后置 verified=true、写事件、返回 citeKey |
| `export_bibtex` | `projectId` | — | 导出项目全部文献为 BibTeX（`@article{citeKey,…}`，作者以 ` and ` 连接）；未核验条目在末尾提示 |

**去重规则**（契约 `literatureDedupeKey`，memory / Mongo 一致）：

1. DOI 存在 → 身份 = `doi:<归一化DOI>`（去 `https://doi.org/` 前缀、转小写）；
2. 否则身份 = `title:<去空白小写标题>|year:<年份>`；缺年份时两个无年份条目只有标题完全一致才算重复；
3. Mongo 把该身份持久化为 `dedupeKey` 字段并建索引；**批内重复以第一条为准**，结果按输入顺序返回。

**citeKey 生成**：优先用导入文本里的 citeKey；否则由第一作者姓氏 + 年份派生（`San Zhang, 2024 → zhang2024`），纯中文作者名回退 `anon`，无年份用 `nd`；项目内大小写不敏感去重，冲突加 `a…z` 后缀，极端情况回退时间后缀，保证总能返回一个 key。派生与唯一化由仓储在一次写内完成（写时索引 + 契约 helper `citeKeyBase` / `uniqueCiteKey`），**单条 add 不预读文献库**；批量导入复用同一份 `taken` 集合，逐条 key 解析为 O(1)。

**检索缓存**：`search` 与 `lookupDoi` 都走进程内 TTL 缓存——search 以（source、归一化 query、limit）为键缓存 5 分钟（容量 100），DOI 核验以归一化 DOI 为键缓存 1 小时（容量 200），完全相同的调用不会重复出网；只缓存成功结果（异常不缓存），空数组与「Crossref 未收录」的 null 也会缓存以避免重复空查询；命中返回的是副本，调用方修改不会污染缓存。

**未核验语义**：

- `verified=false` 表示"进入库但未证明"：可以用于读、可以标注后引用，但提示词要求显式标注"（未核验）"并提醒用户核对；
- 只有 `verify` 成功才写 `verified=true` 与 `verifiedAt`；
- Crossref 未收录、DOI 有误、服务不可用都必须如实说"未核验/未收录/暂时无法核验"，禁止说成已核验；
- 标题匹配是启发式（归一化后相等或互为子串），只用于**阻止**把明显不同的作品标成已核验，不能单独作为核验依据。

示例：

```json
{"action":"search","query":"graph neural network recommendation survey","limit":5,"source":"auto"}
```

```json
{"action":"import","projectId":"8f0c…","text":"@article{zhang2024,\n  title = {A Survey},\n  author = {San Zhang and Li Si},\n  year = {2024},\n  doi = {10.1145/1234567}\n}"}
```

```json
{"action":"verify","projectId":"8f0c…","ref":"10.1145/1234567"}
```

### 3.4 `academic_manuscript`

稿件按章节保存：文档属于项目，章节以稳定 `key` 作为 upsert 身份，标题改名不改变 key；导出只返回文本，不落盘。

| action | 必填 | 可选 | 行为与返回 |
|---|---|---|---|
| `create_document` | `projectId`、`title` | `kind`（缺省 draft；proposal 开题报告 / plan 研究计划 / draft 初稿 / revision 修改稿 / cover_letter 投稿信 / custom 自定义）、`sections` | 新建文档；不传 sections 时使用论文标准六章（摘要/引言/相关工作/方法/实验/结论）；key 缺失时由标题派生 |
| `documents` | `projectId` | — | 列出项目文档（document_id/类型/标题/章节数/字数/更新时间） |
| `list` | `projectId`、`documentId` | — | 列章节（key/标题/字数），按 order 升序 |
| `read` | `projectId`、`documentId`、`key` | — | 读某章节正文；key 不存在时返回现有 key 列表 |
| `save` | `projectId`、`documentId`、`title`、`content` | `key` | 写入/更新章节。key 解析顺序：显式 key → 同标题章节 → 由标题派生 → 位置兜底；更新保留原 order，新章节追加到末尾；正文不能为空 |
| `outline_update` | `projectId`、`documentId`、`sections` | — | 重排/改名/新增章节。逐项 upsert，**已有正文一律保留**（该 action 的 content 字段被忽略）；新章节 key 冲突自动加 `-2/-3` 后缀；未列出的旧章节不会被删除 |
| `export_markdown` | `projectId`、`documentId` | — | 拼 Markdown：`# 标题` + 每章 `## 章节`；空正文占位「（暂无正文）」 |
| `export_latex` | `projectId`、`documentId` | — | 拼最小可编译 LaTeX（xelatex + ctex）；标题/正文做 LaTeX 特殊字符转义 |

**章节 key 规则**：只允许 `[a-z0-9-_]`，≤50 字符；省略时由标题 slug 派生，纯中文标题 slug 为空 → 用确定性哈希回退（`s<hash36>`），保证同一标题重复保存命中同一章节。章节按 `(order, key)` 排序；order 允许有空洞。

**字数统计**：CJK 字符每个算 1，拉丁词每个算 1（混排分别累加）；用于进度展示，不是语言分词器。

示例：

```json
{"action":"create_document","projectId":"8f0c…","kind":"draft","title":"投稿初稿"}
```

```json
{"action":"save","projectId":"8f0c…","documentId":"a1b2…","title":"方法","content":"本节描述……"}
```

```json
{"action":"outline_update","projectId":"8f0c…","documentId":"a1b2…","sections":[{"key":"abstract","title":"摘要","order":0},{"key":"introduction","title":"引言","order":1},{"key":"method","title":"方法","order":2}]}
```

### 3.5 事件与 artifact 形状

| 事件 type | 触发 action | 关键 payload |
|---|---|---|
| `project.created` | project.create | title、paperType |
| `stage.updated` | project.stage_update | stage、status、previousStage、previousStatus、direction（advance/rewind）、reason? |
| `advice.saved` | project.save_advice | stage、advice |
| `plan.updated` | project.plan_set | stage、taskCount、replaced |
| `literature.imported` | literature.import | source、parsed、added、duplicates |
| `literature.added` | literature.add | citeKey、duplicate、source |
| `literature.verified` | literature.verify | citeKey、doi |
| `manuscript.document_created` | manuscript.create_document | documentId、kind、title、sectionCount |
| `manuscript.section_saved` | manuscript.save | documentId、key、title、wordCount |
| `manuscript.outline_updated` | manuscript.outline_update | documentId、sectionCount |

artifact（Phase 2 前端契约，形状稳定）：

| kind | data |
|---|---|
| `academic_project` | `{ action, project }` |
| `academic_literature` | search：`{ action, query, hits }`；list：`{ action, projectId, entries, total, limit }`（entries 只含当前页）；import：`{ action, projectId, source, added, duplicates }`；add：`{ action, projectId, entry, duplicate }`；verify：`{ action, projectId, entry }` 或 `{ action, projectId, hit }`；export_bibtex：`{ action, projectId, count, bibtex }` |
| `academic_manuscript` | `{ action, projectId, document }` / `{ action, projectId, documentId, document }` / `{ action, projectId, documentId, section }` / export：`{ action, projectId, documentId, title, content }` |

---

## 四、数据模型

### 4.1 集合与实体

Mongo 自有库 `mind_base_ts`（与 Python `mind_base` 无关），4 个集合；`_id` 镜像实体 id（UUID），`uid` 是所有查询的前缀。

| 集合 | 契约 | 实体 |
|---|---|---|
| `academic_projects` | `AcademicProjectRepository` | `AcademicProject` |
| `academic_literature` | `AcademicLiteratureRepository` | `AcademicLiteratureEntry` |
| `academic_documents` | `AcademicDocumentRepository` | `AcademicDocument`（内嵌 `sections[]`） |
| `academic_events` | `AcademicEventRepository` | `AcademicEvent`（append-only） |

### 4.2 字段表

**academic_projects**

| 字段 | 类型 | 说明 |
|---|---|---|
| `_id` / `id` | string | UUID |
| `uid` | string | 租户键；所有读写的过滤前缀 |
| `title` | string | 项目标题（≤120） |
| `paperType` | journal / thesis / fund | 成果类型，缺省 journal |
| `field` | string | 研究领域，缺省空串 |
| `targetJournal`? | string | 目标期刊/会议 |
| `deadline`? | string | YYYY-MM-DD |
| `stage` | AcademicStage | 当前聚焦阶段 |
| `stages` | Record<stage, { status, updatedAt, note? }> | 六阶段状态；note 记录门禁结果/返工原因 |
| `plans` | Partial<Record<stage, { id, title, done, note? }[]>> | 各阶段执行计划 |
| `advice` | Partial<Record<stage, string>> | 各阶段已保存建议 |
| `createdAt` / `updatedAt` | number | epoch ms；任何更新都会刷新 updatedAt |

**academic_literature**

| 字段 | 类型 | 说明 |
|---|---|---|
| `_id` / `id` | string | UUID |
| `uid` / `projectId` | string | 租户 + 项目作用域 |
| `citeKey` | string | 项目内唯一引用键（大小写不敏感），正文引用依据 |
| `title` | string | 标题（入库必需） |
| `authors` | string[] | 作者列表（可空） |
| `year`? / `venue`? | number / string | 年份、期刊会议 |
| `doi`? | string | **归一化存储**（去 doi.org 前缀、小写），与索引/去重一致 |
| `url`? / `abstract`? | string | 链接、摘要（尽力而为） |
| `source` | crossref/openalex/arxiv/manual/bibtex/csl | 来源，仅信息性，无分支行为 |
| `verified` | boolean | 仅 DOI/Crossref 核验通过后为 true |
| `verifiedAt`? | number | 与 verified 同生共死（撤销核验时删除） |
| `importedAt` | number | epoch ms（memory 实现单调递增） |
| `dedupeKey` | string | **Phase 1.5 新增持久字段**：`literatureDedupeKey` 的结果（DOI 身份或 title+year 组合身份），只用于存储层去重与索引，不在契约实体中暴露 |

**academic_documents**

| 字段 | 类型 | 说明 |
|---|---|---|
| `_id` / `id` | string | UUID |
| `uid` / `projectId` | string | 租户 + 项目作用域 |
| `kind` | proposal/plan/draft/revision/cover_letter/custom | 文档类型；持久值不可重命名 |
| `title` | string | 文档标题 |
| `sections` | { key, title, content, order, updatedAt }[] | 内嵌章节；所有读取按 (order, key) 排序 |
| `createdAt` / `updatedAt` | number | epoch ms |

**academic_events**

| 字段 | 类型 | 说明 |
|---|---|---|
| `_id` / `id` | string | UUID |
| `uid` / `projectId` | string | 租户 + 项目作用域 |
| `type` | string | 见 §3.5；类型字符串是持久数据，改名等于破坏历史 |
| `payload` | object | 小体积、JSON 可序列化；原样存储 |
| `actor` | user / agent | 事件来源 |
| `createdAt` | number | epoch ms；memory 实现单调递增 |
| — | — | append-only：没有 update/delete 路径 |

### 4.3 索引与查询路径

所有索引均以 `uid` 前缀，既是隔离手段也是避免全表扫描的关键。

| 集合 | 索引 | 服务的查询 |
|---|---|---|
| `academic_projects` | { uid: 1, updatedAt: -1 } | 项目列表（按更新时间倒序） |
| `academic_literature` | { uid: 1, projectId: 1, importedAt: -1 } | 文献列表（按导入时间倒序） |
| `academic_literature` | { uid: 1, projectId: 1, doi: 1 } | DOI 精确查询（`findByDoi`） |
| `academic_literature` | { uid: 1, projectId: 1, dedupeKey: 1 } | **Phase 1.5 新增**：add / addMany 去重判定的索引命中 |
| `academic_documents` | { uid: 1, projectId: 1, updatedAt: -1 } | 文档列表（更新时间倒序）/ 计数（{uid, projectId} 前缀） |
| `academic_events` | { uid: 1, projectId: 1, createdAt: -1 } | 事件流（newest-first，limit） |

> 索引在 `MongoAcademicStore.connect()` 里幂等创建（每次启动执行一次，重复启动成本可忽略）。**连接失败才降级内存**；索引 DDL 失败只记录 `[MONGO] academic index creation failed …`（error 级）并继续使用 Mongo——数据已持久化，查询仍正确、只是可能变慢，不能因为建索引失败把存储降级成内存。
>
> **历史数据兼容**：Phase 1 写入的文献行没有 `dedupeKey` 字段。Mongo `add` / `addMany` 在 `dedupeKey` 未命中时会再用归一化 DOI 做一次索引点查（`{uid, projectId, doi}`）兜底，因此带 DOI 的旧行仍能正确判重；既无 `dedupeKey` 又无 DOI 的旧行需要一次性回填（本功能发布前无存量数据，正常升级无需处理）。

### 4.4 不变量

1. **uid 隔离**：任何查询不带 uid 都是 bug；猜测的项目/文档 id 在别的租户下等价于"不存在"。
2. **DOI 归一化**：写入/查询/索引/去重全部使用 `normalizeDoi` 的结果，避免 `https://doi.org/10.1/ABC` 与 `10.1/abc` 被当成两篇。
3. **去重身份**：DOI 优先，其次归一化标题 + 年份；同一身份在项目内最多一条（Mongo 索引非唯一——见 §6.6 的竞态取舍）。
4. **citeKey 唯一**：项目内大小写不敏感唯一；以 a/b/c 后缀消解冲突，总有返回值。
5. **章节 key 稳定**：显式 key 优先；否则 slug / 确定性哈希派生；同一标题重复保存命中同一章节。
6. **核验状态不可伪造**：`verified=true` 只能由 `verify` 在 DOI 命中且标题匹配后写入；`verifiedAt` 与 verified 同生共死。
7. **时间戳**：memory 实现的 `importedAt` / `createdAt`（事件）严格单调递增（同一毫秒写入时 +1ms），保证同毫秒写入的排序确定；Mongo 侧以 `_id` 作为 tie-break。
8. **事件 append-only**：不更新、不去重；`listEvents` newest-first 且有读取上限（工具取 5 条）。

### 4.5 memory 降级实现

`MemoryAcademicStore` 与 Mongo 适配器语义一致（同一契约 + 同一批纯函数 helper），差异只在持久性与索引形态：

- 进程内、不持久：进程重启数据全部丢失，只用于测试与 Mongo 不可达时的降级；
- 读写 `structuredClone` 深拷贝：调用方持有的对象不会与存储状态互为别名；
- 写时索引：`dedupeKey → entryId`、`(uid, projectId) → { entryIds, citeKey→entryId, doi→entryId }`，add/addMany/count/findByDoi/按 citeKey 查询走 O(1) 索引；
- 列表/事件排序与 Mongo 保持一致（importedAt/createdAt 倒序 + 确定性 tie-break）。

---

## 五、配置

### 5.1 YAML（`app-ts/config/default.yaml`）

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `academic.enabled` | `true` | 总开关；false = 三组工具与 academic 子 agent 都不注册 |
| `academic.literature.crossrefBaseUrl` | `https://api.crossref.org` | Crossref REST 基址；同时是 DOI 核验的唯一权威源 |
| `academic.literature.openalexBaseUrl` | `https://api.openalex.org` | OpenAlex 基址；auto 检索在 Crossref 异常或 0 命中时回退 |
| `academic.literature.arxivBaseUrl` | `https://export.arxiv.org` | arXiv Atom 基址（仅预印本检索，不参与 DOI 核验） |
| `academic.literature.timeoutMs` | `15000` | 单次文献 HTTP 调用超时（独立预算，不受通用工具超时挤占） |
| `academic.literature.mailto` | `${ACADEMIC__LITERATURE__MAILTO:}`（空） | 礼貌池联系人；空 = 不附加 mailto 参数 |
| `academic.literature.maxResults` | `10` | 单次检索返回上限；客户端内部再钳制到 1–25 |

### 5.2 环境变量覆盖

配置加载顺序：`default.yaml` → `config.yaml`（可选）→ `local.yaml`（可选，gitignored）→ 环境变量（最高）。两条 env 通道：

1. **YAML 占位符**：值里写 `${VAR}` / `${VAR:默认}`，加载时从 `process.env` 展开；当前仅 `mailto` 使用该方式。
2. **通用覆盖**：按配置路径把每段 camelCase 转成 `SNAKE_UPPER`，用 `__` 连接，类型继承 YAML 值。例如：

```bash
ACADEMIC__ENABLED=false
ACADEMIC__LITERATURE__TIMEOUT_MS=8000
ACADEMIC__LITERATURE__MAX_RESULTS=15
ACADEMIC__LITERATURE__MAILTO=you@example.com
```

> 环境变量覆盖发生在占位符展开之后，因此 `ACADEMIC__LITERATURE__MAILTO` 两条通道都可用（效果一致）。

### 5.3 关闭后的行为

`academic.enabled=false` 时：

- 三组工具不注册、academic 子 agent 不创建、lifecycle 不注册（委托会返回"子 agent 不存在"）；
- 启动日志：`[BOOT] academic disabled — academic tools/agent not registered`；
- `agent/manifest.ts` 的花名册**不随环境变化**，所以 `delegate_to_agent` 的可用列表里仍会出现 academic，但实际委托会得到明确失败文案。这是刻意的"花名册静态、能力按开关裁剪"设计。

---

## 六、性能设计

### 6.1 批量导入：`addMany` 单次扫描

Phase 1 的 import 逐条调用 `add`，每条都要重新判定去重与 citeKey，复杂度约为 O(M·N)（M=导入条数，N=库内条数）。Phase 1.5 改为：

- 工具层把解析结果映射为 `AcademicLiteratureInput[]`，**只调用一次** `addMany`；
- 实现层一次解析项目身份索引：memory 在 O(M) 内完成整批判重；Mongo 用一次 `$in` 批查命中该批全部 `dedupeKey`（另加一次 citeKey 投影查询用于派生引用键），再以一次 `insertMany(ordered:false)` 写入——查询次数与 M 无关；
- 批内重复以第一条为准（后续重复返回第一条的已存在行，`duplicate=true`）；
- 结果保持输入顺序，新增/重复计数直接来自返回值，事件仍只写一条 `literature.imported`。

### 6.2 计数投影：`count` / `countDocuments`

项目简报需要"文献 N 篇 / 稿件 M 篇"，但**绝不能为此加载正文**。两个方法只做计数投影：

- Mongo：`countDocuments({ uid, projectId })`，命中 { uid, projectId, … } 索引前缀，不读行体；
- memory：写时索引直接给出条数，不克隆整库；
- brief 把 count 与事件读取并发发起（`Promise.all`），无论库多大都是常数级成本。

### 6.3 列表分页：文献库不再整库进 prompt

`academic_literature(list)` 增加 `limit`（1–100，默认 30）：

- 先 `count` 得总数，再 `list` 后由工具层切片，只渲染前 N 篇（仓储契约暂无 offset，Phase 2 REST 再补游标/offset）；
- 超出时末尾标注「共 X 篇，已显示前 N 篇（action=list limit 可调，范围 1-100）」；
- 收益：prompt token 从 O(N) 降到 O(limit)，大文献库（数百篇）不再挤爆上下文；总数仍准确；
- `search` 仍保持 1–10（默认 5）的候选规模，两类用途不混用。

### 6.4 文献检索 TTL 缓存

同一会话里反复检索同一个词、或对同一篇文献反复 verify 是常见模式。`auth/literature-client.ts` 在不引入依赖的前提下加了有界进程内缓存：

| 缓存 | 键 | TTL | 容量 | 说明 |
|---|---|---|---|---|
| search | source + 归一化 query + limit | 5 分钟 | 100（插入序淘汰最旧） | 只缓存成功结果；空数组也缓存，避免重复空查询 |
| lookupDoi | 归一化 DOI | 1 小时 | 200（插入序淘汰最旧） | 命中「未收录」（null）也缓存，避免反复打 Crossref 404 |

- 命中即返回**副本**（深拷贝 hit + authors 数组），调用方无法改坏缓存；
- 异常不缓存：网络失败后重试仍会真正出网，不会被错误结果粘住；
- 收益：重复检索/核验从「每次一次 HTTP」降为「命中零网络」，同时用容量上限保证内存有界；
- 代价：5 分钟/1 小时窗口内的上游更新不可见（属预期，见 §8 排查表）。

### 6.5 原子更新：`findOneAndUpdate`

Phase 1 的项目更新是"读-改-写 `replaceOne`"，两次往返且并发写会整行覆盖。Phase 1.5 改为单次 `findOneAndUpdate({ _id, uid }, { $set: … }, { returnDocument: "after" })`：

- 标量字段直接 `$set`；
- `stages` / `plans` / `advice` 按键生成点路径（`stages.<stage>`、`plans.<stage>`、`advice.<stage>`），因此某阶段的空数组/空字符串（`plans[stage] = []`、`advice[stage] = ""`）是显式清空而不是被忽略；
- 始终刷新 `updatedAt`；未命中（不存在或非本人）返回 null；
- 收益：1 次往返、原子性由 Mongo 单文档写保证，消除"读后写覆盖并发更新"的窗口。

### 6.6 去重索引与竞态取舍

- Mongo 文献文档持久化 `dedupeKey` 并建 { uid: 1, projectId: 1, dedupeKey: 1 } 索引，`add` 先 `findOne` 命中即返回 `duplicate`，否则插入；
- 该索引**非唯一**：单用户学术对话回合内是串行编辑，不会并发写同一项目；而唯一索引在历史数据/缺字段数据上可能建不起来，宁可极小概率出现重复行（可用 `remove` 清理）也不阻塞启动；
- memory 实现用 `dedupeKey → entryId` Map，行为与索引一致。

### 6.7 复杂度与收益

| 场景 | Phase 1 | Phase 1.5 | 关键手段 |
|---|---|---|---|
| 导入 M 篇（库 N 篇） | O(M·N) 判重 + M 次写入 | O(M) 判重 + 常数次查询 + 1 次批量写 | `addMany` |
| 项目 brief | 项目读 2 次 + 事件 5 条 | 同 + 2 次 O(1) 计数 | `count` / `countDocuments` |
| 文献列表（库 N 篇） | 整库 N 篇进 prompt | O(limit) 渲染 + O(1) 计数 | `limit` 1–100 |
| 项目更新 | 读 + replace（2 往返，可能丢并发写） | 1 次原子 `findOneAndUpdate` | 点路径 `$set` |
| 单条 add 判重（memory） | O(N) 线性扫描 | O(1) 索引命中 | 写时索引 |
| 事件流 | O(limit) 索引范围扫描 | 同 | { uid, projectId, createdAt } 索引 |
| 单条 add 读取（工具层） | 先整库 `list()` 再派生 citeKey（O(N) 行体读取） | 0 次预读，仓储写时索引派生 | 契约 helper + 仓储唯一化 |
| `findByDoi`（memory） | 项目内线性扫描 O(N) | O(1) DOI 索引命中 | doi→entryId 索引 |
| citeKey 唯一化（批量 M 篇） | 每条重建 taken 集合 O(M·N) | 批内复用一个 taken 集合 O(M + N) | `citeKeyBase` / `uniqueCiteKey` |

### 6.8 基准

测量环境：Windows + Node 20（tsx 直跑）、`MemoryAcademicStore`、单进程、N = 2000 条文献（每条唯一 DOI，库内初始为空）。数字为单次运行量级，用于回归对比，不作为容量承诺。

| 场景 | Phase 1.5 实测 | 换算 / 说明 |
|---|---|---|
| 批量导入 2000 篇（`addMany`） | **61 ms** | ≈ 32k 篇/秒；同一批数据用逐条 `add` 循环为 230 ms，批量路径快约 3.8× |
| 重复导入 2000 篇（全部已存在） | **16 ms** | O(1) 判重索引；不再读整库行体 |
| `count()`（库 2000 篇） | **0.001 ms/次** | 索引 size，与库规模无关 |
| `countDocuments()`（100 文档） | **0.0008 ms/次** | 索引 size |
| `listDocuments()`（项目 100 文档） | **0.77 ms/次** | 项目级索引 + 深拷贝，与跨租户文档量无关 |
| 项目更新（`update`） | **0.035 ms/次** | 单次内存合并；Mongo 侧为 1 次 `findOneAndUpdate`（无读-改-写） |

Mongo 侧（本机无实例，按查询次数核算而非墙钟）：批量导入 M 篇 = 1 次 `$in` 去重探针 + 1 次 citeKey 投影 + 1 次 `insertMany`（旧实现约 3M+1 次往返）；项目更新 = 1 次原子写；`count` / `countDocuments` = 1 次服务端计数。Mongo 真实延迟需在有 Mongo 的环境按 §9.1 补跑集成用例后回填。

---

## 七、运维手册

### 7.1 启动检查

`npx tsx src/index.ts` 启动后核对日志：

```text
[BOOT] prompts loaded ...（列表包含 agents/academic）
[BOOT] academic tools registered (store=mongodb|memory)
[MONGO] academic stores ready db=mind_base_ts        # store=mongodb 时出现
[BOOT] academic store: memory fallback (...)          # 降级时出现，含数据丢失告警
```

运行时接口自检：`/agent/runtime` 的 agents 列表包含 `academic`，registered_tools 包含 `academic_project / academic_literature / academic_manuscript`。

### 7.2 Mongo 不可达：降级与数据丢失风险

- `config.mongo.uri` 未配置、网络不通或 `ping` 失败时，组合根打印 `[BOOT] academic store: memory fallback (mongodb unreachable/unconfigured) — research data is lost on restart`，改用内存实现；
- 内存实现下功能完全可用（工具、agent、事件都正常），但**进程重启后所有项目/文献/文档/事件丢失**；这是显式降级，不是数据静默丢失；
- 排查顺序：`config.mongo.uri` / 账号权限 → `docker compose up -d mongo`（或外部 Mongo 连通性）→ 重启 app-ts → 日志出现 `[MONGO] academic stores ready` 与 `store=mongodb`；
- 生产环境必须监控该 warn 日志，出现即视为数据面故障。

### 7.3 集合备份与恢复

前提：`mongodump` / `mongorestore` 可用（Mongo 官方工具或容器内自带）。

```bash
# 备份学术集合（按前缀）
mongodump --uri="$MONGO_URI" --db mind_base_ts --out backup/mongo
mongorestore --uri="$MONGO_URI" --nsInclude='mind_base_ts.academic_*' backup/mongo

# 只恢复某集合
mongorestore --uri="$MONGO_URI" --nsInclude='mind_base_ts.academic_projects' backup/mongo
```

恢复注意：契约把 `_id` 与实体 id、`uid` 与租户绑死，跨环境恢复时保留 `uid` 才有意义；`academic_events` 是审计流，恢复旧备份会丢失其间新增事件，优先整库/整集合恢复并记录时间点。

### 7.4 启用 / 禁用

```bash
# 关闭（工具与 agent 都不注册）
ACADEMIC__ENABLED=false npx tsx src/index.ts
```

生产建议：在 `config/local.yaml` 或部署环境变量里设 `academic.enabled`，变更后重启进程（提示词与工具注册均在启动期完成）。

### 7.5 日志关键行

| 日志 | 含义 |
|---|---|
| `[BOOT] academic tools registered (store=mongodb)` | 工具注册成功，Mongo 持久化 |
| `[BOOT] academic tools registered (store=memory)` | 工具注册成功，**内存降级**（重启丢数据） |
| `[BOOT] academic store: memory fallback …` | 降级原因（uri 缺失 / 不可达），同时是数据丢失告警 |
| `[BOOT] academic disabled — academic tools/agent not registered` | 总开关关闭 |
| `[MONGO] academic stores ready db=mind_base_ts` | Mongo 连接 + 索引就绪 |
| `[MONGO] academic store connect failed: …` | 连接失败，即将降级 |
| `[MONGO] academic index creation failed …` | 索引 DDL 失败：仍使用 Mongo（数据安全、查询变慢），需修复索引/权限 |
| `[LITERATURE] source=crossref hits=N limit=M` | 检索源与命中数（OpenAlex/arXiv 同格式），排查"检索无结果"首要日志 |

### 7.6 外部依赖与礼貌池

- Crossref / OpenAlex / arXiv 均无鉴权；客户端发送可读 UA（`MindBase/1.0 (+https://mindbase.app)`），配置 `mailto` 时附加礼貌池联系人；
- 单次逻辑调用每个源最多一次请求（auto 模式最多两次），无自动重试、无内部限流；结果走进程内 TTL 缓存（search 5 分钟 / DOI 1 小时，见 §6.4），缓存命中不发请求；超时（`timeoutMs`）后失败即降级为工具文本，由模型决定是否重试；
- 外部站点不可用不影响项目/稿件功能（纯本地仓储），只影响检索与核验。

---

## 八、故障排查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| 委托报「子 agent "academic" 不存在」 | `academic.enabled=false`；或 agent 未注册（启动顺序/装配异常） | 查 `[BOOT] academic disabled`；确认为 true 后重启；`/agent/runtime` 应含 academic |
| `delegate_to_agent` 列表没有 academic | `agent/manifest.ts` 缺条目（花名册唯一来源） | 补 manifest 条目并重启；不要在前端硬编码 agent 列表 |
| 启动报 prompts 缺失 / 委托时提示词渲染失败 | `prompts/agents/academic.md` 缺失或路径改名 | 命名空间 = 相对 `prompts/` 去 `.md`，文件名必须是 `agents/academic.md`；重启后 `[BOOT] prompts loaded` 应包含它 |
| 检索无结果 | 关键词太窄/中文命中率低；Crossref 限流或故障（auto 已回退 OpenAlex） | 换更通用的英文关键词；查 `[LITERATURE] source=… hits=0`；arXiv 仅覆盖预印本 |
| `verify` 一直"未核验" | 文献无 DOI；DOI 未被 Crossref 收录；库内标题与 Crossref 不一致；网络失败 | 按返回文案处理：补 DOI、修正元数据后重试；**不要**手工改库或假装已核验 |
| `import` 报格式失败 | 文本既非 JSON（数组 / `{"items":[]}`）也非 `@type{…}` BibTeX；条目缺 title；括号不配对 | 检查来源是否完整；CSL 用 JSON 数组；BibTeX 至少含 title 字段 |
| Mongo fallback、重启后项目消失 | `config.mongo.uri` 未配置/不通/权限不足 | §7.2：修连接、重启、确认 `store=mongodb`；内存数据无法找回 |
| brief 没有文献/稿件数字 | 运行的是 Phase 1 代码（无 count 调用） | 升级到 Phase 1.5 并重启；确认 `count/countDocuments` 已装配 |
| `list` 只显示部分文献 | Phase 1.5 分页默认 30 | 属预期行为；用 `limit`（≤100）调整，末尾文案会显示总数 |
| 导出文本在回答里被截断 | `delegate` 回传上限 6000 字符 | 属预期：长导出建议分章节导出或等 Phase 2 科研视图直接取结构化结果 |
| Mongo 启动慢/索引报错 | 历史库与索引定义冲突（如唯一索引在重复数据上建不起来） | 索引均幂等创建；若手工建过同名冲突索引，先 `dropIndex` 再重启；本次 dedupeKey 索引刻意非唯一 |
| 同一检索短时间返回相同结果 / 新文献不出现 | 文献客户端 TTL 缓存（search 5 分钟、DOI 核验 1 小时） | 属预期；当前未提供手动失效接口，重启进程即可清空缓存 |

---

## 九、验收与测试

### 9.1 命令

```bash
cd app-ts

# 类型闸门
npm run typecheck        # = tsc --noEmit

# 学术域单测（离线，不依赖网关/Milvus/Mongo）
npx vitest run test/academic-repository.test.ts test/literature-client.test.ts test/academic-tools.test.ts test/academic-agent.test.ts

# 全量（提交前）
npm test
```

Mongo 集成用例在检测不到本地 Mongo 时自动整组 skip；需要真实验证仓储适配器时：

```bash
docker compose up -d mongo
cd app-ts && npx vitest run test/academic-repository.test.ts
```

### 9.2 覆盖范围

| 测试文件 | 覆盖 |
|---|---|
| `test/academic-repository.test.ts` | 契约纯函数（阶段初态 / DOI 归一化 / 去重键 / citeKey / slug / wordCount）+ 内存仓储全方法 + Mongo 集成（可 skip）+ 批量入库/计数/$set 语义 |
| `test/literature-client.test.ts` | Crossref/OpenAlex/arXiv 映射与降级、auto 回退、DOI 核验 404/异常语义、超时与 UA/mailto、limit 钳制 |
| `test/academic-tools.test.ts` | uid 边界、三工具全部 action、回退 reason 门禁、检索失败降级、去重/批量导入、核验通过/不一致/网络失败、artifact 与事件、文档与章节语义 |
| `test/academic-agent.test.ts` | 花名册条目、delegate 列表可见性、agent 工厂身份、系统提示词非空 |

### 9.3 手工冒烟（聊天内）

1. 新建项目 → 读 brief（应出现阶段、文献/稿件计数、事件）；
2. 检索文献 → add/import → list → verify → export_bibtex；
3. 新建文档（默认六章）→ save「方法」→ outline_update 调序（正文不丢）→ export_markdown / export_latex；
4. 让 agent 在未确认时"推进阶段"：应提示需要用户确认；回退无 reason 应被拒绝并说明原因。

---

## 十、已知边界与 Phase 2 路线

### 10.1 已知边界（Phase 1.5）

| 边界 | 说明 / 影响 |
|---|---|
| 无学术专属前端 | 聊天内可用；artifact 已产出但 Phase 1.5 不进入主会话 artifact 帧（§2.4） |
| 导出不落盘 | 只有 Markdown/LaTeX 文本；文件由用户保存 |
| 长文本回传截断 | `delegate` 上限 6000 字符，超长导出在聊天回答中被截断 |
| 无 DOCX/PDF 生成 | 依赖 Python，Phase 3 评估 |
| 无本地执行/数据证据链 | 不做脚本运行、数据集导入与结果复现 |
| 无并发编辑保护（REST 层） | 当前 agent 串行编辑；Phase 2 引入 REST/多端时需 If-Match 乐观并发 |
| 事件流无分页游标 | 只按 limit 取最新 N 条 |
| Mongo 降级即丢数据 | 内存实现仅用于测试/降级，生产必须保证 Mongo 可用 |
| Mongo 集成用例未在本机实跑 | 本机无 Mongo/docker daemon 未启动，9 个 Mongo 用例长期 skip（§9.1 有复跑命令）；$set 点路径、insertMany、旧行 DOI 兜底需在真实实例上验证一次 |
| 历史行无 dedupeKey（仅老数据） | 带 DOI 的旧行有 DOI 兜底；既无 dedupeKey 又无 DOI 的旧行需一次性回填（本功能发布前无存量） |

### 10.2 Phase 2 路线

1. **REST**：`/academic/projects`、`/academic/literature`、`/academic/documents`、`/academic/events`（uid 来自网关注入，服务层编排 + 事件），导出端点返回文本；
2. **科研视图**：`frontendv2/app/research`（项目列表 / 阶段条 / 文献库 / 写作台 / 动态流），请求统一走 `lib/api/academic.ts`，消费本文件 §3.5 的 artifact/事件形状；
3. **结构化输出**：AI 选刊、阶段计划生成（`buildPlatformLlm` + 网关计量，禁止散建客户端）；
4. **投稿包**：引用完整性检查、cover letter、BibTeX/LaTeX 打包下载（需对象存储与下载端点）；
5. **协作与并发**：REST 写入的乐观并发（If-Match）、事件流分页、软删除/回收站（按需）；
6. **可选增强**：delegate 链路透传子 agent artifact，让聊天内直接渲染学术卡片（协议向后兼容）。

> 完整验收标准与桌面端映射见 `plan/1.0.17-WebAcademicAgent` §十（Phase 1.5）与 §六（分期）（本地设计文档，不入 git）。

---

## 十一、REST API（Phase 2 后端）

> 实现：`app-ts/src/transport/http/routes/academic.ts`（路由）+ `src/services/academic.ts`（编排）+ `src/bootstrap/container.ts`（装配）。鉴权：APISIX `academic_ts` 路由 forward-auth 注入 `X-Uid`；缺少身份返回 401。所有 JSON 为 camelCase，错误体 `{ detail: string }`。

| 方法与路径 | 说明 |
|---|---|
| `GET /academic/projects` | 项目列表（含文献/稿件计数，按 updatedAt 倒序） |
| `POST /academic/projects` | 新建项目（title 必填；paperType/field/targetJournal/deadline 可选） |
| `GET /academic/projects/:id` | 项目详情（summary + plans + advice + 最近 10 条事件） |
| `PATCH /academic/projects/:id` | 更新元数据/阶段/计划/建议（按键合并；空数组/空串=清空） |
| `DELETE /academic/projects/:id` | 删除项目（不级联删除文献/文档/事件，见 §10.1） |
| `GET /academic/projects/:id/literature?limit&offset` | 文献分页（limit 1-100 默认 30；返回 entries + total） |
| `POST /academic/projects/:id/literature` | 单条入库（去重，返回 entry + duplicate） |
| `POST /academic/projects/:id/literature/:ref/verify` | DOI 核验（ref = id / citeKey / DOI；标题不一致不标记） |
| `DELETE /academic/projects/:id/literature/:ref` | 删除文献（ref 支持 id / citeKey / DOI） |
| `GET /academic/projects/:id/literature/export` | 导出 BibTeX 文本 |
| `GET /academic/literature/search?q&limit&source` | Crossref/OpenAlex/arXiv 检索（未核验候选） |
| `GET /academic/projects/:id/documents` | 文档列表（章节数/字数/更新时间） |
| `POST /academic/projects/:id/documents` | 新建文档（默认六章大纲） |
| `GET /academic/documents/:id` | 文档详情（含全部章节正文） |
| `POST /academic/documents/:id/sections` | 章节 upsert（key 省略时按标题匹配已有章节，否则派生） |
| `DELETE /academic/documents/:id/sections/:key` | 删除章节 |
| `GET /academic/documents/:id/export?format=markdown\|latex` | 导出文本（不落盘） |
| `GET /academic/projects/:id/events?limit` | 项目动态（limit 1-50 默认 20） |

**分页与上限**：文献 1-100、检索 1-10、事件 1-50；正文单章节上限 200k 字符；标题 200 字符。越界参数按钳制处理，非法枚举/格式返回 400 并给出可选值。

**网关**：`apisix/apisix.yaml` 与 `apisix.dev.yaml` 新增 `academic_ts`（`/academic`, `/academic/*`，priority 55，upstream app-ts，forward-auth → app-user（auth 路由），剥离客户端伪造的 X-Uid/X-Roles）。回滚 = 删除该路由（URI 将 404；Python 面已退役，无回落）。

**测试**：`test/academic-service.test.ts`（服务编排/校验/核验语义/导出）+ `test/academic-routes.test.ts`（uid 401、CRUD、错误映射、端到端工作流），均为离线用例。

---

## 十二、科研工作台前端（Phase 2）

> 位置：`frontendv2/app/research` + `frontendv2/components/research/*` + `frontendv2/lib/api/academic.ts`；入口在导航「更多 → 科研」。

**页面结构**

- 左侧 280px 项目列表：本地搜索（标题/领域/期刊）、新建项目弹窗、每项展示阶段状态徽标与文献/稿件计数；
- 右侧项目详情头：标题、类型/领域/目标期刊/截止日期 + 六阶段步骤条（当前阶段高亮，五种状态不同配色）；
- 四个 Tab：
  - **概览**：阶段状态卡（推进下一阶段 / 切换五种状态，均二次确认后才 PATCH）、执行计划勾选（PATCH plans）、阶段建议编辑保存（advice）、文献/稿件计数；
  - **文献库**：在线检索（q + source，命中为未核验候选）→「加入」、手动添加、分页（20/页 + 总数）、DOI 核验、删除确认、BibTeX 导出（复制/下载 .bib）；
  - **写作**：文档列表/新建（类型+标题，后端默认六章）、章节选择与正文编辑保存（按 key upsert）、删除章节、Markdown/LaTeX 导出（复制/下载）；
  - **动态**：事件流（时间倒序，中文事件标签 + actor + payload 摘要）。

**与聊天的联动（P0 修复）**

- 详情头「在对话中继续」→ `/chat?academic_project=<id>`；聊天页把 id 透传为请求体 `academic_project_id`，后端校验归属后把受控项目段落注入系统提示，聊天顶部显示「正在科研项目：<title>（阶段）」横幅与返回链接。
- 未带参数 / 项目被删 / 无权访问：静默降级为普通聊天（不阻断对话）；URL 参数即上下文绑定，去掉即恢复普通聊天。

**约定**

- 组件禁止直接 `fetch`：唯一请求入口是 `lib/api/academic.ts` 的 `academicApi`（内部 `request()` + `getAuthHeaders()`），已由 grep 守护（research 组件零 fetch）。
- 所有写操作成功后静默刷新「详情 + 项目摘要计数」，不打断当前 Tab 的本地编辑状态。
- 阶段推进只改目标阶段（不自动把旧阶段置 approved），与 agent 工具语义一致；人工门禁由确认弹窗承担。
- 错误统一展示 `{ detail }`；加载/空态/错误重试全覆盖；无新增第三方依赖。

**已验证 / 未验证**

- `frontendv2` `npx tsc --noEmit` → exit 0；后端 18 个端点由 `test/academic-routes.test.ts` 覆盖。
- 未启动浏览器 dev server / 未做真实网关联调：页面与后端契约通过类型 + 逐字段核对保证，联调需在完整 compose 栈（nginx → APISIX → app-ts）上做一次点击走查。
- 未提供项目删除入口（API 已就绪）、未做移动端专门适配（沿用现有响应式布局）。

---

## 十三、Phase 3 评估（证据层与导出）

完整评估见 `plan/1.0.17` §十二（本地设计文档，不入 git）。结论摘要：

- **不做** app-ts 进程内代码执行（多租户 RCE 面）；执行能力由独立沙箱控制层承载（见 §十五），app-ts 仅保留 `CodeExecutionPort` 边界。
- V1 证据层 = 数据集/实验记录**元数据** + 云盘文件引用 + DOCX/投稿包导出 + 引用一致性检查（导出前校验正文 citeKey 是否在库/已核验）。
- 若未来确需执行，另立独立沙箱 runner（容器隔离 + 队列 + 配额 + 审计），不挪用 app-ts 进程。

---

## 十四、P0 修复（2026-11-01）

本轮针对「委派链路丢帧 / 子 agent 上下文贫瘠 / 缺少项目上下文 / 步数预算」四项 P0 缺口做了修复：

### 14.1 委派帧传播

- `lifecycle.invokeReentrant` 现在除 `content + sources` 外还返回 `usage` / `artifacts` / `plan` / `interactions`；
- `delegate_to_agent` 把 artifacts、delegated usage、子 agent plan（仅当主回合尚无 plan）与交互合并进本轮 collector；
- 主循环尾部把 delegated usage 与主 agent usage 求和后发 `usage` 帧 → **计费/配额不再漏算委派子 agent 的 token**；
- 影响：quiz / academic 等子 agent 在委派期间产生的结构化产物不再丢失（前端 kind 渲染待补）。

### 14.2 子 agent 上下文（academic）

- 工具面新增 `vector_search`（可引用用户自己的视频/云盘知识库素材）；
- 每轮注入长期记忆召回（复用 `buildMemorySection`，与 main 一致）；
- 注入已安装 skills 索引（prompt-as-data，与 main 的 SKILLS_SECTION 一致）；
- 失败降级：记忆/技能注入失败只记日志，不影响回合。

### 14.3 科研项目上下文注入

- 聊天请求新增可选 `academic_project_id`（用户输入，按 `[A-Za-z0-9_-]` 过滤、64 字符上限）；
- ChatService 通过组合根注入的 resolver 解析项目（归属校验），渲染 `prompts/chat/academic-context.md` 受控段落到 extraSystem；项目不存在/无权限/存储降级 → 静默忽略，不影响回合；
- 前端：科研工作台详情头「在对话中继续」→ `/chat?academic_project=<id>`，聊天页把 id 透传到请求并显示「正在科研项目」横幅。

### 14.4 按 agent 的步数预算

- 新增配置 `agent.maxStepsByAgent`（未列出回落 `agent.maxSteps`）；
- 默认对齐桌面端：note 5 / code 4 / quiz 12 / board 6 / academic 12，main 仍为 10；
- `react.maxStepsFor(agentName)` 为唯一读取点。

### 14.5 验证

- 新增离线测试：`test/delegate-propagation.test.ts`（4 例）、`test/academic-chat-context.test.ts`（10 例）、`test/agent-steps.test.ts`（2 例）。
- `npx tsc --noEmit` 通过；全量 `npx vitest run` 全绿（见提交时结果）。

---

## 十五、沙箱控制层（app-sandbox，P0/M1）

> 设计文档：`plan/1.0.18-SandboxControlPlane`（本地维护，不入 git）。OpenSandbox 负责“沙箱怎么被创建/执行/删除”；app-sandbox 是产品控制层，负责“MindBase 怎么使用沙箱”。

**能力**

- 租约复用：`uid + project + purpose + specHash → lease`（TTL/复用/回收），避免一次执行创建一个沙箱；
- 配额：`academic_run` / `sandbox_concurrent` / `sandbox_cpu_seconds` / `sandbox_artifact_bytes` × free/vip/svip，接 app-pay 档位（60s 缓存、fail-open free）；
- 审计：uid/项目/镜像/耗时/exitCode/产物 hash/request_id，全生命周期落 `sandbox_audit`；
- 产物：M1 接口 + Fake；M2 execd 取文件 → MinIO + presign；
- 执行记录：app-ts `academic_evidence` 写 Mongo `academic_runs`（脚本 sha256/exitCode/产物/耗时）；
- 准入/超时/取消/sweeper：全局与每 uid 并发、有界队列（503/429）、exec 超时、租约 TTL、孤儿回收；
- 诚实降级：app-sandbox 不可达时 `run_code` 返回明确错误，不伪造执行结果。

**接口**：app-ts → APISIX `sandbox_internal`（`/internal/sandbox/*`，key-auth + 去前缀）→ app-sandbox :8017。
`POST /v1/executions`（202，uid 只认 X-Uid）、`GET /v1/executions/:id`、`GET .../events`（SSE）、`POST .../cancel`、`/internal/leases`、`/health /ready /metrics`。

**app-ts 集成**：`sandbox.enabled=true` 时 `HttpCodeExecution`（POST + 轮询；失败/超时/非 2xx → `sandboxAvailable=false` + 中文错误）；`run_code` 输出 execution_id/exit_code/产物摘要；学术 agent 工具面新增 `academic_evidence` + `run_code`。

**验证（M1）**：`app-go/app-sandbox` `go build/vet/test` 通过（56 pass + 1 skip：MySQL 用例需 `SANDBOX__TEST_DSN`）；测试统一位于 `app-go/app-sandbox/tests/`（black-box 包，不与源码同目录）；app-ts `tsc` 通过、全量 654 通过、启动日志 `run_code tool registered (store=stub)`。

**Docker 部署（最小 OpenSandbox）**：`deploy/docker/opensandbox/docker-compose.yml` 只起一个 lifecycle server（Docker runtime + Docker socket + SQLite），或 root compose `--profile sandbox` 同时起 opensandbox-server/app-sandbox；详见 [deploy/docker/opensandbox/README.md](../deploy/docker/opensandbox/README.md)。

**K8s 部署**：OpenSandbox 控制面/运行时的生产化安装包（dev/prod values、preflight、PDB、NetworkPolicy、ServiceMonitor、smoke Job、热池）+ `app-sandbox` 清单见 [deploy/k8s/40-sandbox](../deploy/k8s/40-sandbox/README.md) 与 [deploy/k8s/30-apps/app-sandbox.yaml](../deploy/k8s/30-apps/app-sandbox.yaml)。

**管理面板**：app-admin + frontend-admin 的 `/sandbox`（概览/执行/租约/配额/审计；viewer 只读，admin 可取消执行/强制回收），见 [docs/app-admin.md](app-admin.md) §沙箱管理；管理动作双审计（app-admin + sandbox_audit）。

**未验证**：OpenSandbox 真实适配（payload 按 specs TODO）、execd 文件/MinIO 产物、真实 MySQL DDL、远端 exec 取消、sweeper leader 选举、K8s runtime。

