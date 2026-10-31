# MindBase Desktop 0.1.16

> 桌面端「Agent 协同 + 学术工作流」版本：主 agent 可创建/调度子代理，学术 agent 真正能查文献、管项目、写稿件、跑数据；长任务与 token 统计、实时会话恢复、重新生成等体验一并补齐。

## ✨ 新功能

### 🤝 Agent 协同
- 科研 agent 纳入主 agent 调度：delegate_to_agent 新增 research 目标；主 agent 对用户透明，聊天中不再暴露主 agent 身份。
- 两层委托：academic / research 子代理可再委托 search / memory，孙代理不能再委托，支持学术写作时临时查文档、查历史。
- 主 agent 自建 agent：新增 create_agent / list_agents 工具与 custom_agents 表，按名字 + 角色提示词持久化自定义子代理；同名覆盖、保留内置名、之后可反复 delegate。
- 运行记录：新增 AgentRun 事件（agent / 成败 / 耗时 / 步数 / token），按 agent 聚合显示在助手消息底部；后台任务 TaskView 增加 token 用量。

### 🔬 学术能力（实际动手，不再只是嘴上说）
- 文献：academic_literature 支持 Crossref 检索、项目文献列表、BibTeX / CSL 导入、BibTeX 导出、单条 DOI/标题核验、PDF 下载（开放获取存本地，付费墙回退在线地址）；文献页新增下载/预览与在线按钮。
- 项目：academic_project 支持项目列表、项目简报、阶段流转、把阶段建议/决策显式保存到控制台（save_advice）；不再把每条聊天回答自动写成建议。
- 稿件：academic_manuscript 支持章节列表 / 读取 / 写入，正文落 research/<project>/manuscript/sections/*.md。
- 数据与实验：academic_evidence 支持数据集列表、CSV/XLSX 导入（归档 + MD5 + Python 画像）、Python 分析脚本执行（120s 超时，输出落 analysis/outputs）、实验记录登记/列表。
- 科研控制台升级：research_ask 从单次 completion 升级为 ReAct（带工具 + 项目简报 + 阶段指引 + 最近对话）；概览页新增内联提问框与最新 AI 建议，建议真正落库并回填。
- 引用纪律：科研上下文只引用项目已登记文献/数据/实验/产物，无关知识库素材不得引用；主聊天新增学术工具，优先项目文献与 web_search。

### ⚙️ 长任务与 Token 统计
- 自动化任务：automation_start/status/log_search/log_read/kill/retry/due/list 八个工具；日志按任务/日期/run 分区落盘，DB 只存任务、运行、日志段指针与报告；应用重启把遗留 running/pending 标记 interrupted。
- Token 账本：新增 llm_usage 表，逐回合记录输入/输出/缓存命中/合计；UsageTotals 支持按天/模型/会话聚合；新增 usage_stats 工具。
- 缓存命中字段：兼容 DeepSeek prompt_cache_hit_tokens、OpenAI prompt_tokens_details.cached_tokens、Anthropic cache_read_input_tokens。
- 对话输入框下方新增居中会话用量条：轮次 · 步数 · 会话 token · 缓存命中率；每条回答底部保留本轮 token 脚注。

### 💬 对话体验
- 实时状态恢复：后端 chat_live_state 持有进行中回合快照（步骤 / 增量正文 / 计划 / 当前子代理），切会话、切视图、刷新页面回来可继续看到实时动态；结束后自动回填历史。
- 重新生成：最后一条已完成回答新增「重新生成」，后端替换旧助手消息且不重复写入用户问题；失败重试同样走替换路径。
- DSML 兜底：部分 OpenAI 兼容网关把 DeepSeek 原生工具调用当文本返回，新增解析层（兼容全角/双竖线变体），转成标准 tool_calls 执行并剥离标记。
- OpenCode 修复：所有 OpenCode 系提供方自动携带 x-opencode-session（对话级稳定）+ 自有 UA，修复 MissingSessionID 400；embedding 走 opencode 时同样处理。

### 🧪 工程与测试
- Rust 分包：新增 toolkit（进程/shell/git/gh）、sandbox（AppContainer/bwrap/seatbelt）、automation（supervisor/日志分区/报告调度）三个包，agent 层只做薄适配。
- 测试分层：所有测试迁入 src-tauri/tests（toolkit / sandbox / agent / automation / infra / knowledge / workspace 分包），common/ 共享辅助、testing.rs 提供测试 API。
- VS Code：rust-analyzer.linkedProjects 指向 Cargo workspace；根工作区关闭 Java 自动 import/autobuild、CMake 打开即配置；新增 tasks / extensions / app-pay 工作区；排除 target/node_modules 等大目录。

## 🛠 修复
- 科研上下文此前把每条回答自动写入控制台建议——改为只有 AI 显式调用 save_advice 才保存；文献导入等操作只进文献库。
- 文献导入后前端不刷新：学术工具步骤触发 research-data 事件，科研工作台自动重载当前 tab。
- 聊天中仍显示主 agent 名字；切走后实时进度丢失、pending 消息被误标 completed；恢复空间为空时显示空态首页等问题。
- API 设置页长 provider / 模型 / key 溢出、文本域高度与卡片行距问题。
- infra/logging.rs 的 Level::Debug 未使用告警（显式豁免并注明预留）。

## 🧪 质量验证
- cargo test --locked：356 tests / 0 failed / 4 ignored（单测 288：285 passed / 3 ignored；tests/ 68：67 passed + 1 ignored）。
- cargo check --all-targets --locked 通过，无 warning；npm run build（tsc + vite）通过。

## 📦 版本与升级
- 桌面端版本 0.1.15 → 0.1.16（package.json / package-lock.json / tauri.conf.json / Cargo.toml / Cargo.lock）。
- 直接覆盖安装，本地数据与配置兼容；新增表（llm_usage、custom_agents、automation_*）均使用 CREATE TABLE IF NOT EXISTS 自动创建，无需手动迁移。
- 文献 PDF 存在 research/<project>/literature/pdfs/；自动化任务日志存在 <data_dir>/logs/exec/ 与 automation/<task>/<日期>/。

## ⚠️ 已知限制
- 应用内暂未内嵌 PDF 渲染：下载后调用系统默认阅读器，付费墙文献回退浏览器在线预览。
- 嵌套委托（academic → search/memory）暂不单独上报 AgentRun 事件，token 会计入父级调用汇总。
- 科研控制台 research_ask 仍为非流式（等完整结果），暂不展示逐字输出。
- DSML 解析为启发式兜底；标准 OpenAI tool_calls / Anthropic 工具调用仍是首选路径。
- macOS 构建仍为 Beta。

**完整变更**：CHANGELOG.md（0.1.16 段）与本次 PR。
