# 科研/写作：项目文件列表 + 点击预览（契约）

> 实现状态（2026-11-12）：已落地 —— app-ts `GET /academic/projects/:id/files`（`ManuscriptDocxService.listProjectFiles`）、前端 `ProjectFilesPanel`（空间/写作 Tab + 点击预览/下载）、app-cloud 预览按需抽取（未处理 docx/md/pdf 也能预览）。
>
> 目标（2026-11-12，用户反馈）：
> 1. **AI 生成的文件（Word/Markdown/结果表/日志等）在科研界面看不到** —— 需要按项目聚合展示（含 agent 写到 `05_论文` / `04_结果` / `02_数据` 等目录的文件，以及写作文档的原始上传/回存文件）。
> 2. 写作不再以“把 Markdown/LaTeX 文本弹窗展示”为主：**以文件为中心**——列表里点文件 → 预览内容（文本/Word 提取文本/图片/PDF），可下载；导出仍然生成文件。

## 1. 后端：项目文件列表（app-ts）

`GET /academic/projects/:projectId/files`（uid 必填；项目不存在/非本人 404）

```ts
{
  workspace:
    | { exists: false }
    | { exists: true; workspaceId: string; title: string;
        folders: Array<{ kind: string; label: string; folderId: number }> };  // kind: plan|literature|data|code|results|manuscript|submission
  files: Array<{
    uploadUuid: string;
    name: string;
    size: number;
    mimeType: string;
    createdAt?: number;
    origin: "workspace" | "document-source" | "document-export";
    /** workspace 文件才有 */
    folderKind?: string;
    folderLabel?: string;   // 00_课题与计划 … 06_投稿
    /** 写作文档来源/回存才有 */
    documentId?: string;
    documentTitle?: string;
  }>
}
```

规则：
- 项目有学术空间（research_workspaces 有映射）时，遍历 7 个目录（00_课题与计划/01_文献/02_数据/03_代码与实验/04_结果/05_论文/06_投稿）调 `ResearchWorkspaceService.listFiles` 汇总；单目录失败不阻塞其他目录（该目录文件缺失，整体仍 200）。
- 无论有无空间，都补上项目写作文档的 `source`（原始上传稿）与 `lastExport`（回存稿），origin 分别 `document-source` / `document-export`，带 documentId/documentTitle。
- 按 uploadUuid 去重（先 workspace，后文档），files 顺序：目录顺序 → 目录内按 createdAt 倒序 → 文档条目。
- 无空间时 `workspace.exists=false`，files 仍返回文档条目。
- 云盘不可用且项目有空间 → 503 `{detail:"云盘服务暂不可用，无法读取项目文件"}`（前端提示重试）。
- 实现位置：`ManuscriptDocxService` 增加 `listProjectFiles(uid, projectId)`（已有 documents/projects/workspace/cloud 依赖），`routes/academic.ts` 用已有 `manuscriptDocx` 依赖注册该路由。
- 测试：app-ts/test 路由/服务测试（无空间仅有文档条目、有空间聚合+目录失败容错、去重、404、云盘不可用 503）。

## 2. 前端：文件列表 + 预览

### 2.1 API
`frontendv2/lib/api/academic.ts`：
- 类型 `AcademicProjectFile` / `AcademicProjectFiles`（含 workspace 联合类型）
- `academicApi.listProjectFiles(projectId)`

### 2.2 新组件 `components/research/project-files-panel.tsx`
- 入参：`{ projectId: string; filter?: "manuscript" }`（filter=manuscript 时只显示 `folderKind=manuscript` 或 origin=document-* 的条目）。
- 按 `folderLabel`/origin 分组展示（有空间的目录顺序、文档来源/回存单独一组）；每行：文件类型图标（可用 lucide FileText/FileImage 等）、文件名、大小、时间、下载按钮。
- 点击文件 → 预览弹层：
  - 文本类（md/txt/latex/json/csv/log）与 docx/pdf 等：调用 `cloudApi.getDocumentPreview(uploadUuid, { offset: 0, limit: 5000 })`（app-cloud 已实现 docx 等文本提取），展示 `preview` 文本（`whitespace-pre-wrap` 滚动区）；`hasMore` 时「加载更多」按 nextOffset 继续。
  - 图片：`cloudApi.getRawFile(uuid)` → 在弹层内 `<img>`（presigned URL）。
  - PDF：raw URL 用 `<iframe>` 或「新窗口打开」。
  - 其他/失败：展示文件元信息 + 下载按钮。
  - 弹层底部：`下载原文件`（getRawFile → window.open）、关闭。
- 空态/加载/错误重试复用 research-ui 组件；组件禁止直接 fetch（走 cloudApi / academicApi）。
- 无学术空间时：顶部提示「本项目还没有学术空间目录（AI 生成文件会存到 05_论文/04_结果 等目录）」+「创建学术空间」按钮（POST workspace），成功后刷新。

### 2.3 接入

> 2026-11-12 更新：写作 Tab 已按用户要求改为**纯文件列表**（去掉章节/Markdown 编辑器）；点击文件在新标签页打开 `/research/file?uploadUuid=…&name=…`（PDF 内嵌、图片直显、Word/Office/文本用抽取文本预览 + 下载）。
- `workspace-tab.tsx`（空间 Tab）：改为使用 `ProjectFilesPanel`（保留创建空间入口），去掉只按目录点开列表的旧交互（可保留目录统计作为标题分组）。
- `writing-tab.tsx`（写作 Tab）：
  - 增加「项目文件」区块：`<ProjectFilesPanel projectId filter="manuscript" />`，列出 05_论文 下 AI 生成/回存的 Word 与写作文档的来源/回存文件，点开即可预览。
  - 现有 Markdown/LaTeX 导出**不再弹窗展示原文**：点击直接下载文件（`.md`/`.tex`），保留按钮；删除旧的导出文本弹窗（min 改动）。
  - 保留 Word 导入/导出/保存到云盘。

## 3. 验收
- app-ts `npm run typecheck` + 新增测试通过；frontend `npx tsc --noEmit` 通过。
- 运行态：项目有空间且 05_论文 有 docx → `GET /academic/projects/:id/files` 返回该文件（origin=workspace, folderKind=manuscript）；前端写作页可见、点击可预览（docx 提取文本）/下载；无空间项目返回文档来源条目且提示创建空间。
