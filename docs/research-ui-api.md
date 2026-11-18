# 科研工作台 UI 扩展 — REST 契约（2026-11-11）

> 目标：把 agent 侧已有、UI 缺失的能力补齐：实验 / 证据 / 校验 / 分析 / 学术空间 / DAG 计划历史 / 沙箱面板。
> 实现状态：2026-11-12 已全部落地（app-ts / app-sandbox / frontend 镜像已重建），并通过完整 compose 栈冒烟。
> 本文件是前后端唯一契约。所有路径经 APISIX（`academic_ts`、`chat_ts`）→ app-ts，uid 一律取网关注入的 `X-Uid`（缺失 = 401 `{ detail }`）。

## 0. 通用约定

- 响应错误：`{ detail: string }`；404 = 项目/记录不存在或不属于该 uid；403 = 跨用户访问；422 = 参数非法。
- 所有列表默认按时间倒序；`limit` 缺省 20，上限 100（超出按 100 钳制）。
- 现有 `GET /academic/projects/:projectId` 等 21 个端点保持不变。

## 1. 实验（academic_experiment）

`GET /academic/projects/:projectId/experiments?limit=20`
```ts
{ experiments: Array<{
  id: string; projectId: string; chatSessionId?: string; workspaceId?: string;
  title?: string; language: string; code: string; timeoutMs: number;
  status: "queued" | "running" | "succeeded" | "failed" | "interrupted" | "cancelled";
  exitCode?: number; stdoutPreview?: string; stderrPreview?: string; error?: string;
  createdAt: number; startedAt?: number; endedAt?: number;
}> }
```
`POST /academic/experiments/:experimentId/cancel` → `{ cancelled: boolean }`（不存在/非本人 404；已终态返回 `{ cancelled: false }`）

## 2. 证据（academic_evidence）

`GET /academic/projects/:projectId/evidence?limit=50&offset=0`
```ts
{
  datasets: Array<{ id; projectId; name; description?; source; files: Array<{ name; sizeBytes?; sha256?; url? }>; createdAt }>,
  runs: Array<{
    id; projectId; datasetId?; name; script?; scriptSha256?; language;
    executionId?; status: "succeeded" | "failed" | "timed_out" | "recorded";
    exitCode?; stdoutPreview?; stderrPreview?; artifacts: Array<{ name; sizeBytes?; sha256?; url? }>;
    cpuMillis?; startedAt?; finishedAt?; createdAt;
  }>
}
```
`GET /academic/projects/:projectId/evidence/runs/:runId` → `{ run }`（404 不存在/非本人）

## 3. 校验（academic_validation）

`POST /academic/projects/:projectId/validation` body `{ documentId?: string }`
```ts
{ report: {
  pass: boolean;
  citations: { total: number; missing: string[]; unverified: string[] };
  runs: { total: number; unreproducible: string[]; invalidRefs: string[] };
  results: { sections: string[]; withoutEvidenceRef: string[] };
  // 仅提示字段（不参与 pass）：正文含数字的章节 / 其中没有 [[run:id]] 的章节
  sectionsWithNumbers: string[];
  sectionsMissingRunRef: string[];
} }
```
（只读检查，无副作用；documentId 缺省 = 校验项目全部稿件。`invalidRefs` = 正文 `[[run:id]]` 指向不存在或非 succeeded 的运行，会使 `pass=false` 并阻断导出；数字提示只做警告。导出门禁：Markdown/LaTeX/DOCX 导出默认先跑本校验，未通过返回 409/拒绝文本；用户明确确认后可传 `force=true` 强制导出并写 `export.forced` 审计事件。）

## 4. 分析（academic_analysis）

`POST /academic/projects/:projectId/analysis/results` body `{ documentId?: string }`
```ts
{ markdown: string; uploadUuid?: string; folderId?: number }
```
（生成结果表 Markdown；会尽力上传到 `04_结果/results_summary.md`；传 documentId 时同时覆盖稿件「结果」章节）

## 5. 学术空间（research_workspace）

`GET /academic/projects/:projectId/workspace`
```ts
{ workspace: {
  workspaceId: string; title: string;
  project: { projectId: string; title: string; rootFolderId: number;
             folders: { plan: number; literature: number; data: number; code: number; results: number; manuscript: number; submission: number } }
} }
```
无空间 → 404 `{ detail: "项目还没有学术空间目录" }`

`POST /academic/projects/:projectId/workspace` → 幂等确保空间存在（内部 `ensureProject`，项目标题取 `academic.getProject`），返回同上；云盘不可用 → 503。

`GET /academic/projects/:projectId/workspace/files?kind=data&limit=50`
- kind ∈ `plan|literature|data|code|results|manuscript|submission`（缺省 data）
```ts
{ kind: string; folderId: number;
  files: Array<{ upload_uuid: string; name: string; size: number; mime_type: string; sha256?: string; createdAt?: number }> }
```
无空间 → 404。

## 6. DAG 计划历史（plan_and_run）

`GET /chat/plans?limit=20&chat_session_id=<optional>&project_id=<optional>`（uid 必须存在）
```ts
{ runs: Array<{
  runId: string; goal: string;
  status: "pending" | "running" | "paused" | "completed" | "failed" | "partial";
  chatSessionId: string;
  projectId?: string;  // 计划运行所属科研项目；普通对话没有
  createdAt: number; updatedAt: number; endedAt?: number;
  nodeCounts: { total: number; done: number; failed: number; skipped: number; running: number; pending: number };
}> }
```
- `project_id` 过滤：科研工作台「计划」Tab 传入当前项目 id；计划运行的 `projectId` 由该回合的 `academic_project_id`（科研工作台对话上下文）自动打标，LLM 不能指定；
- 历史旧计划（`projectId` 缺失）只在不过滤时返回，不会出现在项目过滤结果里；
- 失败的 `project_id`（非 `[A-Za-z0-9_-]{1,64}`）按“未过滤”处理，不返回 400。

详情复用现有 `GET /chat/plans/:runId`（返回 `{ runId, status, chat_session_id, updated_at, plan }`，plan 为 DAG 快照）。

**审批暂停（2026-11-17，plan/1.0.21 §四）**：科研模板中的实验节点带 `requiresApproval: true`；运行到该节点时计划进入 `status: "paused"`，节点保持 `pending` 并在 note 中给出 `approval_id`。用户在审批 Tab 批准后调用 `POST /chat/plans/:runId/resume` 继续；响应 `{ runId, ok, paused, approvalId?, failed, skipped, outputs }`，仍未批准时再次返回 `paused: true`。

**取消（2026-11-17，W1/计划取消）**：`POST /chat/plans/:runId/cancel` 取消 `pending/running/paused` 的计划运行；运行中会中断当前节点，返回 `{ runId, cancelled: true }`；终态/不存在返回 404/409。

## 7. 沙箱面板（run_code）

**app-sandbox（新增，内部面，app-ts 调用）**

`GET /v1/executions?limit=20`（需 X-API-Key + X-Uid；只返回该 uid 的执行）
```ts
{ executions: Array<{
  executionId; leaseId; projectId?; purpose?; language; status;
  timeoutMs; stdoutPreview?; stderrPreview?; stdoutBytes?; stderrBytes?;
  errorCode?; createdAt; startedAt?; finishedAt?; durationMs?; exitCode?; done: boolean;
  artifacts: Array<{ name; size?; url? }>  // 沿用现有 executionPayload.artifacts 形状
}> }
```

**app-ts（对前端，经 chat_ts）**

`GET /chat/sandbox/executions?limit=20` → `{ enabled: boolean; executions: SandboxExecutionPayload[] }`
- `sandbox.enabled=false` 时返回 `200 { enabled: false, executions: [] }`（不报错）；
- 上游 app-sandbox 不可达 → 503 `{ detail: "沙箱服务暂不可用" }`；
- 字段与 app-sandbox 的 executionPayload 一致（见上）。

`POST /chat/sandbox/executions/:id/cancel` → `{ cancelled: true }`；未启用 503；上游 404 透传 `{ detail }`。
`GET /chat/sandbox/executions/:id`（可选，面板展开详情用）→ `{ execution }`。

## 8. 前端落地要求

- 科研工作台新增 Tab：**实验 / 证据 / 校验 / 分析 / 空间 / 计划**（现有 概览/文献库/写作/审批/动态 保留）。Tab 条允许换行（flex-wrap）。
- 请求一律走 `frontendv2/lib/api/`（`academic.ts` 扩展、新增 `sandbox.ts`），组件禁止直接 fetch。
- 沙箱独立页面 `/sandbox`，导航「更多」新增「沙箱」入口。
- 加载/空态/错误重试沿用 `components/research/research-ui.tsx` 的 `LoadingBlock / EmptyState / ErrorBanner / SurfaceCard`。

## 9. 导出 / 提交门禁（2026-11-17，P0）

**导出（Markdown / LaTeX / Word）**
- 默认先运行学术校验；未通过 → 409（文本导出）或拒绝文本（agent 工具），不生成导出内容。
- 明确知情后可传 `force=true`（query/body/工具参数）强制导出，写入 `academic_events: export.forced` 审计事件。
- 端点：`GET /academic/documents/:id/export?format=markdown|latex&force=`；`GET|POST /academic/documents/:id/export/docx`（`force=`）。

**提交（submission）**
- `POST /academic/documents/:id/submit`：要求（1）校验 pass；（2）消耗一次已批准的 `kind=submission` 审批（一次一用）；成功后把投稿 Word 回存 05_论文并写 `manuscript.submitted` 事件。
- 审批在科研工作台「审批」Tab 申请/批准；未批准 → 409/422 `{ detail }`。
- 不引入新第三方依赖；不使用玻璃拟态/强渐变（项目视觉规范）。

## 10. 阶段门禁与自动模式（2026-11-17，W5）

`GET /academic/projects/:projectId/gates`（只读，不写库）
```ts
{ stage: string; report: Array<{
    stage: string; status: "locked"|"active"|"submitted"|"approved"|"frozen";
    ready: boolean; missing: string[]; doneCount: number; taskCount: number;
}> }
```

`POST /academic/projects/:projectId/gates/sync`（同步计划任务 + autoMode=auto 时推进）
```ts
{ sync: Array<{ stage: string; id: string; title: string }>;   // 本次自动打勾的任务
  advanced: { advanced: boolean; from?: string; to?: string; reason?: string };
  report: Array<{ stage: string; status: string; ready: boolean; missing: string[]; doneCount: number; taskCount: number }> }
```
- 项目 `autoMode`（off/assist/auto）通过 `PATCH /academic/projects/:id` 修改；auto 只把当前阶段自动置 submitted、下一阶段置 active，approved 永远由用户确认。
- 任务 `autoRule`（manuscript.section_saved / academic.run_recorded / literature.verified / validation.passed）由 sync 求值；用户已 done 的任务不会被覆盖。
- 概览 Tab 展示每阶段门禁 checklist、自动模式选择与「同步进度」按钮。


## 11. M1 科研规划与文献元数据（2026-11-17）

- 项目 PATCH/create 新增字段：`researchQuestion`、`objectives[]`、`keywords[]`、`contributions[]`、`methodology`、`ethicsNote`、`venueRequirements`、`language: "zh"|"en"`、`citationStyle: "plain"|"apa"|"ieee"|"gb7714"`。
- `GET /academic/projects/:id/next-actions` → `{ stage, suggestions: [{ id, title, reason, action, severity: "blocker"|"warning"|"info" }] }`（规则化研究顾问，不调用 LLM）。
- `PATCH /academic/projects/:id/literature/:ref` body `{ tags?, notes?, readingStatus?: "unread"|"reading"|"read", keywords? }` → `{ entry }`；ref=id/citeKey/DOI；身份字段（title/doi/citeKey）不可改。
- 文献条目新增 `tags/notes/readingStatus/keywords` 字段；agent 工具新增 literature 的 get/update/remove/synthesize（综述矩阵）。

## 12. 站内通知（M3，2026-11-17）

- `GET /academic/notifications?limit=20&unread=1` → `{ notifications: Array<{ id, projectId, type, title, body?, link?, readAt?, createdAt }>, unreadCount }`（uid 维度，未读计数不受 limit 影响）。
- `POST /academic/notifications/:id/read` → `{ read: true }`；不存在/非本人 404。
- 触发点：审批请求/决策（workbench）、后台实验完成（runner callback）；通知为 best-effort，存储故障不影响主流程。

## 13. 参考文献与投稿包（2026-11-18）

- Markdown / LaTeX / Word 导出会自动追加「参考文献」章节：按项目 citationStyle（plain/apa/ieee/gb7714）渲染项目文献库；已有同名章节不重复追加。
- `GET /academic/documents/:id/package`：生成投稿包 zip（manuscript.docx / manuscript.md / manuscript.tex / references.bib / README.txt）。要求校验通过，并消耗一次已批准的 submission 审批；未通过 409，审批缺失 422。

## 14. 版本 / 审稿回复 / Autopilot / 平台化（2026-11-18）

**文档版本**
- `GET /academic/documents/:id/versions` → `{ versions }`（version 升序）。
- `GET /academic/documents/:id/versions/:version/diff?to=` → 按章节 key 的增删行统计与示例行；to 缺省=当前文档。
- `POST /academic/documents/:id/versions/:version/restore` → 先快照当前状态再恢复；响应含 document/snapshot/restoredFrom。
- `POST /academic/documents/:id/review-response` body `{ items: [{ comment, response, change? }] }` → 新建审稿回复信文档（kind=response_letter）。

**Autopilot**
- `GET/PATCH /academic/projects/:id/autopilot`：mode off/assist/auto、maxActionsPerDay（1-100）、stop/resume。
- `POST .../autopilot/tick`：assist 只发建议通知；auto 先跑门禁同步/自动推进再通知；不调用 LLM、不写 approved、不提交实验。

**平台化**
- PATCH 项目 / POST 章节支持 `If-Match: <updatedAt ms>`，版本不一致返回 409。
- `GET /academic/projects/:id/events?limit=&offset=` 支持分页（倒序）。
- `GET /academic/projects/:id/events/stream`：SSE 事件流（2s 轮询增量推送 + 15s 心跳），前端动态 Tab 已用 EventSource 订阅。
- `GET /academic/projects/:id/export`：项目备份 JSON（项目/文献/稿件/事件审计导出），概览 Tab「导出 JSON」。
- `DELETE /academic/projects/:id`：移入回收站（软删除，返回 `{deleted, archived, archivedAt}`）；默认列表不再返回。
- `GET /academic/projects?archived=only|all`：回收站列表 / 全部项目。
- `POST /academic/projects/:id/restore`：恢复项目。
- `DELETE /academic/projects/:id/purge`：永久删除，级联清理通知/审批/实验/证据/版本/文献/稿件/事件/工作区/autopilot/planRuns 后删除项目行；失败返回 500 与已完成计数。
- `GET /agent/runtime` 的 `research.counters`：validation_pass/fail、analysis_summary/compare、export_text/docx、submission、package、autopilot_tick、events_stream_open 等计数。
- 科研配额：academic_analysis / academic_validation / academic_export / academic_experiment，超限 429 `{ detail }`。
- 全链路评测：`test/research-eval.test.ts` 覆盖创建项目→计划→文献核验→实验证据→稿件→校验→导出→门禁/建议。