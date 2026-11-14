# 写作：Word 导出 / 上传已有稿完善后回存云盘（契约）

> 目标（2026-11-12）：
> 1. 写作 Tab 支持导出 **Word (.docx)**（不再只有 Markdown/LaTeX 文本）；
> 2. 支持**上传已有格式的 Word 稿**：解析成章节 → agent/用户完善 → 回存为 .docx 到 MinIO（项目云盘 `05_论文`），用户直接下载/继续改，而不是在写作页重新生成另一种格式。
>
> 本文是前后端唯一契约；实现不得新增 npm 依赖（用已有 jszip / mammoth / linkedom）。
>
> 实现状态（2026-11-12）：已落地（解析 `src/doc-parser/docx.ts` + 生成 `src/services/docx-writer.ts` + `manuscript-docx.ts` + 三个端点 + `academic_manuscript(export_docx)` + 写作 Tab 三个按钮），并通过 app-ts typecheck、12 例单测与运行态冒烟。

## 0. 通用

- 所有端点经 APISIX → app-ts，uid 取 `X-Uid`（缺失 401 `{detail}`）。
- app-ts 内部用 `AppCloudClient`（app-cloud M2M）+ `ResearchWorkspaceService`（项目空间/目录映射）：
  - 上传：`ResearchWorkspaceService.uploadFile(uid, projectId, "manuscript", name, bytes, mime)`
  - 下载：`AppCloudClient.downloadFile(uid, uploadUuid)`
  - 若项目还没有学术空间：先 `ensureProject(uid, projectId, project.title)`（自动建 00~06 目录）；云盘不可用 → 503。
- Word 生成：JSZip 手写 OOXML；有 source（上传的原始 .docx）时**复用原文档包**（styles/theme/页眉页脚/页面设置保留），只替换 `word/document.xml` 正文；无 source 时用标准样式生成。
- 分层：docx **解析**统一在 `src/doc-parser/docx.ts`（mammoth + linkedom，与聊天附件/测验的文档解析同一层；`parseDocxSections` 供手稿导入按标题切章，`parseDocxText` 供纯文本抽取），OOXML **生成**在 `src/services/docx-writer.ts`；`manuscript-docx.ts` 只做云盘/模板/账本编排。

## 1. 数据模型扩展（AcademicDocument）

```ts
export interface AcademicDocumentSource {
  uploadUuid: string;   // 用户上传的原始 Word
  fileName: string;
  mimeType: string;
  folderId?: number;    // 05_论文 目录 id
}
export interface AcademicDocumentExport {
  uploadUuid: string;   // 回存的 Word（MinIO/云盘）
  fileName: string;
  folderId?: number;
  createdAt: number;
}
// AcademicDocument 增加可选字段：
source?: AcademicDocumentSource;
lastExport?: AcademicDocumentExport;
```
- repository `createDocument` 支持 `source`；`updateDocument` patch 支持 `source?` / `lastExport?`（memory + mongo 同步实现）。
- 现有 `GET /academic/projects/:id/documents`、`GET /academic/documents/:id` 的 document 对象自动带上这两个可选字段（无需改 wire 形状）。

## 2. 端点

### 2.1 导入已有 Word

`POST /academic/projects/:projectId/documents/import`（multipart，字段 `file`；可选表单字段 `title`、`kind`）
- 仅接受 `.docx`（mime `application/vnd.openxmlformats-officedocument.wordprocessingml.document` 或扩展名），≤ 20MB；否则 422。
- 流程：校验项目归属 → ensure 项目学术空间 → 上传原文件到 `05_论文` → mammoth 解析段落/标题 → 创建 document：
  - `title` = 传入 title / 文档首个一级标题 / 文件名去扩展名
  - `kind` = 传入 / 默认 `draft`
  - `sections` = 按标题切分（无标题则整篇一个「正文」章节；标题层级 h1/h2/h3 都作为章节边界，正文段落按 \n 拼接）
  - `source` = { uploadUuid, fileName, mimeType, folderId }
- 200：`{ document: AcademicDocument, source: AcademicDocumentSource }`
- 其他：404 项目不存在/无权；503 云盘不可用。

### 2.2 导出 Word（直接下载，不落云盘）

`GET /academic/documents/:documentId/export/docx`
- 200：二进制 `application/vnd.openxmlformats-officedocument.wordprocessingml.document`，
  `Content-Disposition: attachment; filename*=UTF-8''<urlencoded title>.docx`
- 404：文档不存在/无权。

### 2.3 回存 Word 到云盘（用户可下载/继续修改）

`POST /academic/documents/:documentId/export/docx`
- 生成 Word（同 2.2，有 source 则保留原格式）→ 上传到项目 `05_论文`（文件名 `<title>_<yyyyMMddHHmm>.docx`，重名自动加序号）→ 更新 `lastExport`。
- 200：`{ uploadUuid: string; fileName: string; folderId: number; createdAt: number }`
- 404 / 503 同上。
- 前端下载：`GET /cloud/video/:uploadUuid/raw` → `{ url }`（presigned）后在浏览器打开。

### 2.4 agent 工具（academic_manuscript）

新增 action `export_docx`（参数 projectId + documentId）：
- 调用 2.3，返回中文文本（文件名、uploadUuid、提示「可在写作页下载」）+ 复用 manuscript artifact。

action `import_docx`（参数 projectId + 来源二选一）：
- `uploadUuid`：项目云盘里已有的 .docx（调用 2.5，不重复上传）；
- `sessionDocument`：本会话上传的 Word 文件名或会话文档 id（见 2.6，原件直接从附件存储读回）；
- 两者都走同一导入流程（原件存入项目云盘 `05_论文` 并成为导出模板），失败以中文提示返回而不是抛错。

### 2.6 会话上传的 Word 直接导入（不需要用户重新上传）

用户随对话上传的 Word（`POST /chat/documents`）解析后，**原件**保留在对象存储 `chat-files/{sessionId}/*`，会话文档元数据记在 Mongo `session_documents.key`。因此 agent 可以直接把对话里上传的稿子当模板导入：

- `academic_manuscript(action=import_docx, projectId, sessionDocument=<文件名或会话文档 id>)`
  - 通过 `ChatImageStorage.getBytes` 读回原件 → 走 §2.1 的导入流程：原件写入项目云盘 `05_论文`，成为 `document.source` 与后续导出模板；
  - 原件未留存（上传时附件存储未启用 / 旧数据 / 对象已清理）时返回可恢复提示：用写作页「导入 Word」重新上传，或以 `uploadUuid` 导入云盘文件；
  - 未收到任何来源（既无 `uploadUuid` 也无 `sessionDocument`）时，列出本会话的 Word 上传（文件名 + 文档 id）供模型选择。

### 2.7 Word 版式细节解析（二级 AI 工具 docx_inspect）

一级解析在服务侧：`parseDocxSections`（mammoth）只抽标题 + 正文，用于手稿导入/切章，所有普通"读 Word"请求都走它。

当用户要看/还原**版式本身**时（表格结构、字体字号、段落样式、页边距/纸张、页眉页脚、文档属性），调用二级工具 `docx_inspect`：

- 参数：`source`（session|cloud，可省略自动推断）、`sessionDocument`（会话上传 Word 的文件名或文档 id）或 `uploadUuid`（项目云盘文件）、`focus`（page/styles/fonts/paragraphs/tables/headers/metadata）、`maxTables`、`maxParagraphs`；
- 返回中文文本摘要（≤6000 字）：纸张/页边距/分栏、默认字体与样式表、段落与 run 级格式、表格跨列/纵向合并/底纹、页眉页脚、core 属性；解析只读、不改文件、不出 artifact；
- 实现：`app-ts/src/doc-parser/docx-detail.ts`（纯 OOXML 扫描，无新依赖、zip-bomb/节点/数组上限）+ `src/services/docx-inspect.ts`（会话文档/云盘取原件与错误 guidance）+ `src/tools/docx/inspect.ts`（工具参数校验）。

## 3. 前端（写作 Tab）

- `frontendv2/lib/api/academic.ts` 新增：
  - `importDocumentDocx(projectId, file, opts?)` → FormData POST（**不要设置 Content-Type**，让浏览器带 boundary）
  - `downloadDocumentDocx(documentId)` → `fetch` 返回 Blob（走 request 层时注意二进制；可用 requestRaw/直接 fetch + getAuthHeaders）
  - `saveDocumentDocx(documentId)` → POST，返回 `{uploadUuid,fileName,folderId,createdAt}`
  - 类型扩展：`AcademicDocumentSource` / `AcademicDocumentExport`，`AcademicDocumentSummary/Detail` 增加可选字段
- `frontendv2/components/research/writing-tab.tsx`：
  - 工具栏：`导入 Word`（hidden file input accept=.docx）、`导出 Word`（下载 .docx）、`保存到云盘`（POST 回存，成功后展示「已保存：<fileName> · 下载」链接，用 `cloudApi.getRawFile(uploadUuid)` 取 url 打开）
  - 文档列表/详情显示来源：`来自：<source.fileName>`；`最近回存：<lastExport.fileName>（时间）`
  - 保留现有 Markdown / LaTeX 导出；页面不引入新依赖。

## 4. 验收

- app-ts：`npm run typecheck` 通过；新增 `test/manuscript-docx.test.ts`（生成→解包→含标题/章节；模板复用时 styles.xml 保留；解析 round-trip）+ 路由测试（import/export 成功与 404/503），无新增失败。
- frontendv2：`npx tsc --noEmit` 通过。
- 运行态：用真实 `.docx`（带标题样式）导入 → 章节出现 → 修改一章 → `POST .../export/docx` 返回 uploadUuid → 云盘出现文件、可 presigned 下载；`GET .../export/docx` 浏览器可下载且 Word 打开正常。
