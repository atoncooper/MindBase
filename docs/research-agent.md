# 网页端科研 Agent（research）现状说明

> 2026-11-17 ｜ 对应计划：[plan/1.0.21-AcademicResearch](../plan/1.0.21-AcademicResearch/1.0.21-AcademicResearch.md)
> 本文替代 docs/academic-agent.md 中已过时的「academic 子 agent」章节；工具/契约细节仍以代码为准。

## 一、定位

网页端科研能力 = **main agent 直接持有的学术工具组** + **科研工作台（frontendv2/research）** + **DAG 计划执行**。

- 不存在独立的 academic 子 agent：src/agent/manifest.ts 只有 note/code/quiz/board；main agent 在 config.academic.enabled=true 时直接获得 academic_* 工具（app-ts/src/agent/main/agent.ts）。
- 学术提示词已合并到 prompts/agents/main.md 的「科研任务 / 科研工作流与人工门禁」两节；旧 prompts/agents/academic.md 已删除。
- 项目上下文经 prompts/chat/academic-context.md 每轮注入（会话可绑定 academic_project_id）。

## 二、工具面

| 工具 | 作用 |
|---|---|
| academic_project | 项目 / 六阶段状态机 / 阶段计划 / 阶段建议 / brief |
| academic_literature | Crossref/OpenAlex/arXiv 检索、BibTeX/CSL 导入、去重、DOI 核验、BibTeX 导出 |
| academic_manuscript | 文档与章节读写、大纲、Markdown/LaTeX/Word 导出、Word 导入 |
| academic_evidence | 数据集与实验 run 记录（元数据、脚本 hash、产物元数据） |
| academic_experiment | 后台实验提交 / 查询 / 取消（需人工审批） |
| academic_validation | 引用、证据、可复现性校验（导出前门禁） |
| academic_analysis | 由 evidence 生成结果表，写 04_结果 / 覆盖「结果」章节 |
| research_approval | 创建/查看人工审批（AI 不能自批） |
| research_workspace | 学术空间 7 目录树、上传/列表/读取项目文件 |
| plan_and_run | 主 agent 专用 DAG 计划；科研模板带审批暂停节点 |

## 三、门禁矩阵（当前）

| 动作 | 门禁 | 实现 |
|---|---|---|
| 阶段推进 / 改状态 | 软门禁：提示词要求用户明确同意；工作台按钮二次确认 | 服务端不强制，事件审计 |
| 阶段 approved | 只能由用户确认（agent 不自行置位） | 提示词 + 工作台状态按钮 |
| 实验执行 | **硬门禁**：academic_experiment(submit) 必须有已批准实验审批 | tools/academic/experiment.ts |
| 项目内代码执行（run_code/sandbox_bash/sandbox_pwsh） | **硬门禁**：项目会话内需已批准实验，否则工具返回拦截提示 | tools/code/execution-guard.ts + container 注入 |
| 导出 Markdown/LaTeX/Word | **门禁**：默认先 academic_validation，未通过拒绝；force=true 可强制并写 export.forced 事件 | manuscript tool / academic service / manuscript-docx |
| DAG 实验节点 | **暂停**：requiresApproval 节点未批准时计划 status=paused，批准后 resume | agent/dag/runner.ts + /chat/plans/:runId/resume |
| 投稿 | **硬门禁**：POST /academic/documents/:id/submit 要求校验通过 + 消耗一次 submission 审批（一次一用），写 manuscript.submitted 事件 | 路由 academic.ts + manuscript tool submit + approval v2 |

## 三·五、阶段门禁与自动模式（W5）

- 每阶段有交付物门禁（ResearchStageGateService.evaluate）：topic=选题计划全完成；design=设计计划全完成且文献≥3；advise=建议已存且计划全完成；experiment=存在 succeeded run（无 evidence 依赖时退回计划全完成）；writing=至少一份 draft/revision 且非空章节≥3；submission=校验 pass（无 validation 依赖时退回计划全完成）。
- 自动模式 project.autoMode：
  - off：门禁只读，用户手动推进；
  - assist：可读取门禁/自动打勾计划任务，但阶段仍需用户确认；
  - auto：当前阶段门禁 ready 时自动把当前阶段置 submitted、下一阶段置 active（写 stage.updated auto=true 事件）；**approved 永远由用户确认**。
- 计划任务 autoRule：manuscript.section_saved / academic.run_recorded / literature.verified / validation.passed；满足时自动 done=true（doneSource=event），用户已勾选的任务不会被覆盖。
- 接口：GET /academic/projects/:id/gates（只读评估）、POST /academic/projects/:id/gates/sync（同步任务 + autoMode=auto 时推进）；前端概览 Tab 有门禁 checklist、「同步进度」按钮和自动模式选择。

## 三·六、科研规划与文献智能（M1）

- **项目研究信息**：researchQuestion / objectives / keywords / contributions / methodology / ethicsNote / venueRequirements / language / citationStyle；agent 用 academic_project(action=update) 维护，REST 用 PATCH。
- **下一步建议**：规则化 ResearchAdvisorService（不调用 LLM）根据门禁缺口、文献/稿件数量、实验 run、校验报告、截止日期给出最多 3 条 blocker/warning/info 建议；brief 自动追加，工作台概览 Tab 展示并可刷新；接口 GET /academic/projects/:id/next-actions。
- **文献智能**：条目支持 tags / notes / readingStatus / keywords；工具新增 get/update/remove/synthesize（Markdown 综述矩阵）；引用格式 plain/apa/ieee/gb7714（citation-format 服务，供导出/参考文献表复用）。
- **通知**：审批请求/决策与实验完成写入站内通知；GET /academic/notifications + 已读接口；工作台右上角铃铛（前端组件）。

## 三·七、参考文献与投稿包

- 文本 / Word 导出自动追加「参考文献」章节：按项目 citationStyle（plain/apa/ieee/gb7714）渲染项目文献库，已存在同名章节时不重复。
- 投稿包：GET /academic/documents/:id/package → zip（docx + md + tex + references.bib + README），要求校验通过并消耗一次 submission 审批。

## 三·八、版本、审稿回复与 Autopilot

- 文档版本：每次快照 version+1；支持按章节 diff 与回滚（回滚前自动快照当前状态，历史不可变）。
- 审稿回复：粘贴审稿意见 + 回应/修改说明，生成审稿回复信文档（response_letter）。
- Autopilot：项目级 off/assist/auto；assist 只发建议通知，auto 在门禁就绪时自动推进（approved 仍人工）；有每日动作预算与 stop/resume；后台定时 tick（默认 15 分钟），不调用 LLM、不提交实验；概览 Tab 可改模式/预算、立即检查、急停/恢复。
- 科研配额：分析/校验/导出/实验 four kinds，超限返回 429；实验提交先校验配额再消耗审批。
- API 并发：项目/章节写支持 If-Match；事件流支持 offset 分页与 SSE（/events/stream）。
- 观测：/agent/runtime 的 research.counters 输出校验/分析/导出/投稿/autopilot/SSE 计数；分析 Tab 支持 summary/compare 与 SVG 指标对比图。
- 动态 Tab 通过 SSE 实时更新；概览 Tab 支持导出项目备份 JSON（项目/文献/稿件/事件）。
- 项目删除：默认移入回收站（可恢复）；回收站内永久删除会级联清理通知/审批/实验/证据/版本/文献/稿件/事件/工作区/autopilot/planRuns。云盘文件不随元数据删除。

## 四、DAG 计划与审批暂停

- plan_and_run 的工具白名单由 app-ts/src/agent/dag/allowed-tools.ts 统一解析：基础配置 agent.plan.allowedTools + 学术工具包（academic_* / research_workspace / docx_inspect / vector_search），**不包含 run_code 与 sandbox_***（防止绕过实验审批）。
- 内置 template=research_paper 的 7 个节点：选题 → 文献 → 设计 → 实验（requiresApproval）→ 分析 → 写作 → 审查。
- 运行到实验节点：
  1. runner 调用 approvalGate；无已批准实验时创建 pending 审批并暂停；
  2. 计划 run 状态 = paused，节点保持 pending，note 带 approval_id；
  3. 用户在工作台「审批」Tab 批准；
  4. POST /chat/plans/:runId/resume（前端「计划」Tab 的「恢复执行」按钮）继续剩余节点。
- 计划运行落 Mongo（plan_runs），刷新/重启后可恢复；GET /chat/plans 支持项目过滤；运行中/暂停的计划可在「计划」Tab 取消（POST /chat/plans/:runId/cancel）。

### 实验执行硬化（W6）

- 队列：默认同时执行 2 个、未完成（排队+运行）上限 20 个（config academic.experiments）；超出直接拒绝提交，不消耗审批。
- 去重：同项目 + 同语言 + 同代码 hash 在 10 分钟窗口内重复提交会返回已有 experiment_id。
- 取消：排队中的实验可直接取消（不再等待调度）；运行中的取消会中断沙箱。
- 产物：沙箱 artifacts 元数据随 run 持久化，完成时尽力下载并回存 04_结果；stdout/stderr/experiment.json 仍归档。
- 回调：每个实验最多回调一次（持久化 callbackNotifiedAt，重启不重复），每用户每日回调次数有上限；实验生命周期事件写入项目动态。

## 五、推荐使用方式（L2 半自动）

1. 在工作台新建项目 → 对话里让 agent 生成阶段计划（academic_project(plan_set)）。
2. 文献：检索 → add/import → verify；写作：academic_manuscript 建文档/逐节保存。
3. 需要真实代码执行/实验时：让 agent 创建实验审批 → 用户批准 → agent 提交 academic_experiment，实验完成会自动回调继续分析。
4. 导出前让 agent 运行 academic_validation，修正缺失引用/未核验/无效 run 证据后再导出。
5. 阶段完成情况由用户在工作台确认（「概览」推进 / 勾选计划任务）。

## 六、常见问题

- **Agent 说需要审批**：到工作台「审批」Tab 批准实验；批准后重新让 agent 提交或恢复计划。
- **导出被拒绝**：按返回的缺失清单（缺失引用 / 未核验 / 无效 [[run:id]] / 无证据结果章节）修改，或用户明确知情后让 agent 用 force 强制导出（会写审计事件）。
- **DAG 计划卡在等待审批**：批准后点「计划」Tab 的「恢复执行」；仍未批准会再次暂停。
- **沙箱不可用**：sandbox.enabled=false 时 run_code 诚实返回「未配置」，不会伪造结果；启用见 docker compose --profile sandbox。
- **Mongo 不可达**：学术数据降级到内存（重启丢失），日志有 [BOOT] academic store: memory fallback，生产必须修复。

## 七、相关文档

- docs/research-ui-api.md：工作台 REST 契约。
- docs/research-workspace.md：学术空间目录。
- docs/manuscript-docx.md：Word 导入导出。
- docs/project-files.md：项目文件聚合。
