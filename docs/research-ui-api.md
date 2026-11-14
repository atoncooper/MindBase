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
  runs: { total: number; unreproducible: string[] };
  results: { sections: string[]; withoutEvidenceRef: string[] };
} }
```
（只读检查，无副作用；documentId 缺省 = 校验项目全部稿件）

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
  status: "pending" | "running" | "completed" | "failed" | "partial";
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
- 不引入新第三方依赖；不使用玻璃拟态/强渐变（项目视觉规范）。
