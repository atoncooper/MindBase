/**
 * 学术科研 API - 科研工作台（plan/1.0.17 Phase 2）.
 *
 * 后端契约：app-ts src/transport/http/routes/academic.ts（经 APISIX → app-ts）。
 * 鉴权由网关注入 X-Uid，前端只带 session_token 的 Bearer 头；所有 JSON 均为
 * camelCase，错误体统一 { detail }（沿用 ./client 的 sanitizeError）。
 *
 * 本文件是唯一允许出现 /academic 端点的地方：组件只 import academicApi 与类型，
 * 不得自行 fetch（frontendv2 强制约束，见根 AGENTS.md §2.4）。
 */
import { API_BASE_URL, getAuthHeaders, request } from "./client";

// ---------------------------------------------------------------------------
// 基础枚举
// ---------------------------------------------------------------------------

/** 科研流程六阶段（顺序即进度语义）。 */
export type AcademicStage =
    | "topic"
    | "design"
    | "advise"
    | "experiment"
    | "writing"
    | "submission";

/** 阶段状态机：locked → active → submitted → approved → frozen（rework 回 active）。 */
export type AcademicStageStatus = "locked" | "active" | "submitted" | "approved" | "frozen";

/**
 * 项目自动模式：off=全手动；assist=带 autoRule 的计划任务可自动打勾但不自动推进；
 * auto=门禁就绪时自动把当前阶段置为「待确认」并推进下一阶段。approved 永远人工。
 */
export type AcademicAutoMode = "off" | "assist" | "auto";

/** 成果类型：期刊论文 / 学位论文 / 基金申请。 */
export type AcademicPaperType = "journal" | "thesis" | "fund";

/** 写作文档类型。 */
export type AcademicDocumentKind =
    | "proposal"
    | "plan"
    | "draft"
    | "revision"
    | "cover_letter"
    | "custom";

/** 事件发起者：用户本人或代为操作的 agent。 */
export type AcademicActor = "user" | "agent";

/** 文献检索源（auto = Crossref 优先、OpenAlex 兜底）。 */
export type AcademicLiteratureSearchSource = "auto" | "crossref" | "openalex" | "arxiv";

// ---------------------------------------------------------------------------
// 项目
// ---------------------------------------------------------------------------

export type AcademicApprovalKind = "experiment" | "submission";
export type AcademicApprovalStatus = "pending" | "approved" | "rejected";

export interface AcademicApproval {
    id: string;
    projectId: string;
    kind: AcademicApprovalKind;
    status: AcademicApprovalStatus;
    note?: string;
    requestedAt: number;
    decidedAt?: number;
    decisionNote?: string;
}

export interface AcademicStageState {
    status: AcademicStageStatus;
    updatedAt: number;
    /** 自由备注（阶段确认说明 / 回退原因） */
    note?: string;
}

/** 计划任务的自动打勾规则事件（后端 gate 服务按交付物求值）。 */
export type AcademicAutoRuleEvent =
    | "manuscript.section_saved"
    | "academic.run_recorded"
    | "literature.verified"
    | "validation.passed";

/** 自动打勾规则：sectionKey 限定章节；minRuns 限定运行/文献核验数量。 */
export interface AcademicAutoRule {
    event: AcademicAutoRuleEvent;
    match?: { sectionKey?: string; minRuns?: number };
}

/** 计划任务完成来源：用户 / 事件（autoRule）/ agent。 */
export type AcademicPlanTaskDoneSource = "user" | "event" | "agent";

/** 每个阶段的执行计划任务（agent 起草、用户勾选；可带 autoRule 自动打勾）。 */
export interface AcademicPlanTask {
    id: string;
    title: string;
    done: boolean;
    note?: string;
    autoRule?: AcademicAutoRule;
    doneSource?: AcademicPlanTaskDoneSource;
}

/** 引用风格。 */
export type AcademicCitationStyle = "plain" | "apa" | "ieee" | "gb7714";

/** 项目列表项 / 详情中的项目摘要。 */
export interface AcademicProjectSummary {
    /** 回收站时间戳；存在表示项目已在回收站。 */
    archivedAt?: number;
    id: string;
    title: string;
    paperType: AcademicPaperType;
    field: string;
    targetJournal?: string;
    /** YYYY-MM-DD */
    deadline?: string;
    /** 项目元数据 */
    researchQuestion?: string;
    objectives?: string[];
    keywords?: string[];
    contributions?: string[];
    methodology?: string;
    ethicsNote?: string;
    venueRequirements?: string;
    language?: "zh" | "en";
    citationStyle?: AcademicCitationStyle;
    stage: AcademicStage;
    stages: Record<AcademicStage, AcademicStageState>;
    /** 自动模式；旧后端/旧项目缺省按 off 处理 */
    autoMode?: AcademicAutoMode;
    literatureCount: number;
    documentCount: number;
    createdAt: number;
    updatedAt: number;
}

/** 项目动态流事件。 */
export interface AcademicEventRecord {
    id: string;
    type: string;
    payload: Record<string, unknown>;
    actor: AcademicActor;
    createdAt: number;
}

/** GET /academic/projects/:id 的完整项目视图。 */
export interface AcademicProjectDetail {
    project: AcademicProjectSummary;
    plans: Partial<Record<AcademicStage, AcademicPlanTask[]>>;
    advice: Partial<Record<AcademicStage, string>>;
    events: AcademicEventRecord[];
}

// ---------------------------------------------------------------------------
// 阶段门禁 + 自动语义
// ---------------------------------------------------------------------------

/** 单个阶段的交付物门禁结果：ready=false 时 missing 是中文缺口清单。 */
export interface AcademicStageGate {
    stage: AcademicStage;
    status: AcademicStageStatus;
    ready: boolean;
    missing: string[];
    doneCount: number;
    taskCount: number;
}

/** GET /academic/projects/:id/gates 响应（只读，不写库）。 */
export interface AcademicStageGateReport {
    /** 当前阶段 */
    stage: AcademicStage;
    report: AcademicStageGate[];
}

/** 一次自动同步中被打勾的计划任务。 */
export interface AcademicGatePlanChange {
    stage: AcademicStage;
    id: string;
    title: string;
}

/** 自动推进结果：advanced=false 时 reason 说明原因。 */
export interface AcademicGateAdvance {
    advanced: boolean;
    from?: AcademicStage;
    to?: AcademicStage;
    reason?: string;
}

/** POST /academic/projects/:id/gates/sync 响应（自动打勾 + 可能的自动推进）。 */
export interface AcademicGateSyncResult {
    sync: AcademicGatePlanChange[];
    advanced: AcademicGateAdvance;
    report: AcademicStageGate[];
}

// ---------------------------------------------------------------------------
// 文献库
// ---------------------------------------------------------------------------

/** 文献库条目（DOI 已归一化，citeKey 项目内唯一）。 */
export interface AcademicLiteratureEntry {
    id: string;
    citeKey: string;
    title: string;
    authors: string[];
    year?: number;
    venue?: string;
    doi?: string;
    url?: string;
    abstract?: string;
    tags?: string[];
    notes?: string;
    readingStatus?: "unread" | "reading" | "read";
    keywords?: string[];
    source: string;
    verified: boolean;
    verifiedAt?: number;
    importedAt: number;
}

/** 在线检索候选（尚未入库，一律未核验）。 */
export interface AcademicLiteratureHit {
    source: string;
    title: string;
    authors: string[];
    year?: number;
    venue?: string;
    doi?: string;
    url?: string;
    abstract?: string;
}

export interface AcademicLiteraturePage {
    entries: AcademicLiteratureEntry[];
    total: number;
}

/** 单条入库结果：duplicate=true 时 entry 为已存在的旧条目（未写入）。 */
export interface AcademicLiteratureAddResult {
    entry: AcademicLiteratureEntry;
    duplicate: boolean;
}

/** DOI 核验结果：verified=false 时 message 说明原因（未收录 / 标题不一致等）。 */
export interface AcademicLiteratureVerifyResult {
    entry: AcademicLiteratureEntry;
    verified: boolean;
    message: string;
}

// ---------------------------------------------------------------------------
// 论文稿件
// ---------------------------------------------------------------------------

export interface AcademicSection {
    /** 章节稳定标识（后端按 key 或标题 upsert） */
    key: string;
    title: string;
    content: string;
    order: number;
    updatedAt: number;
}

/** 导入已有 Word 时保留的源文件信息（原文件在项目云盘 05_论文）。 */
export interface AcademicDocumentSource {
    /** 云盘文件 uuid（原始上传的 .docx） */
    uploadUuid: string;
    fileName: string;
    mimeType: string;
    /** 05_论文 目录 id */
    folderId?: number;
}

/** 最近一次回存云盘的 Word（导出后落在项目云盘 05_论文）。 */
export interface AcademicDocumentExport {
    uploadUuid: string;
    fileName: string;
    folderId?: number;
    createdAt: number;
}

export interface AcademicDocument {
    id: string;
    projectId: string;
    kind: AcademicDocumentKind;
    title: string;
    sections: AcademicSection[];
    /** 上传的原始 Word（导入已有稿时存在） */
    source?: AcademicDocumentSource;
    /** 最近一次回存云盘的 Word */
    lastExport?: AcademicDocumentExport;
    createdAt: number;
    updatedAt: number;
}

/** GET .../documents 的列表项（不含正文，只带统计）。 */
export interface AcademicDocumentSummary {
    id: string;
    kind: AcademicDocumentKind;
    title: string;
    sectionCount: number;
    wordCount: number;
    /** 上传的原始 Word（导入已有稿时存在） */
    source?: AcademicDocumentSource;
    /** 最近一次回存云盘的 Word */
    lastExport?: AcademicDocumentExport;
    updatedAt: number;
}

/** 章节写入载荷：key 省略时后端按标题派生并匹配（标题相同即覆盖该章节）。 */
export interface AcademicSectionInput {
    key?: string;
    title: string;
    content?: string;
    order?: number;
}

// ---------------------------------------------------------------------------
// 实验（academic_experiment）
// ---------------------------------------------------------------------------

/** 实验执行状态：queued/running 可取消，其余为终态。 */
export type AcademicExperimentStatus =
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "interrupted"
    | "cancelled";

/** 一次实验执行记录（stdout/stderr 为后端截断后的预览）。 */
export interface AcademicExperiment {
    id: string;
    projectId: string;
    chatSessionId?: string;
    workspaceId?: string;
    title?: string;
    language: string;
    code: string;
    timeoutMs: number;
    status: AcademicExperimentStatus;
    exitCode?: number;
    stdoutPreview?: string;
    stderrPreview?: string;
    error?: string;
    createdAt: number;
    startedAt?: number;
    endedAt?: number;
}

// ---------------------------------------------------------------------------
// 证据（academic_evidence）
// ---------------------------------------------------------------------------

/** 数据集文件 / 运行产物：只有元数据，正文在对象存储。 */
export interface AcademicEvidenceFile {
    name: string;
    sizeBytes?: number;
    sha256?: string;
    url?: string;
}

/** 项目数据集（实验的输入侧）。 */
export interface AcademicDataset {
    id: string;
    projectId: string;
    name: string;
    description?: string;
    source: string;
    files: AcademicEvidenceFile[];
    createdAt: number;
}

/** 记录下来的运行结果终态。 */
export type AcademicRunStatus = "succeeded" | "failed" | "timed_out" | "recorded";

/** 一次已记录实验运行（脚本全文以 scriptSha256 标识，正文截断存储）。 */
export interface AcademicRun {
    id: string;
    projectId: string;
    datasetId?: string;
    name: string;
    script?: string;
    scriptSha256?: string;
    language: string;
    executionId?: string;
    status: AcademicRunStatus;
    exitCode?: number;
    stdoutPreview?: string;
    stderrPreview?: string;
    artifacts: AcademicEvidenceFile[];
    cpuMillis?: number;
    startedAt?: number;
    finishedAt?: number;
    createdAt: number;
}

export interface AcademicEvidencePage {
    datasets: AcademicDataset[];
    runs: AcademicRun[];
}

// ---------------------------------------------------------------------------
// 校验（academic_validation）与分析（academic_analysis）
// ---------------------------------------------------------------------------

/** 只读一致性校验报告：引用 / 运行可复现性 / 结果章节证据引用。 */
export interface AcademicValidationReport {
    pass: boolean;
    citations: { total: number; missing: string[]; unverified: string[] };
    /** invalidRefs = 正文 [[run:id]] 指向不存在或未成功的运行（会阻断导出）。 */
    runs: { total: number; unreproducible: string[]; invalidRefs: string[] };
    results: { sections: string[]; withoutEvidenceRef: string[] };
    /** 仅提示字段：正文含数字的章节 / 其中未带 run 证据的章节（不参与 pass）。 */
    sectionsWithNumbers: string[];
    sectionsMissingRunRef: string[];
    /** 数字-证据匹配（仅结果章节，不参与 pass）。 */
    numbers: {
        total: number;
        matched: number;
        unmatched: Array<{ section: string; value: string }>;
    };
    /** 表格证据（不参与 pass）。 */
    tables: {
        sections: string[];
        withoutEvidence: string[];
    };
}

/** 多 run 对比的图表数据（按指标名做系列）。 */
export interface AcademicAnalysisChart {
    categories: string[];
    series: Array<{ name: string; values: number[] }>;
}

/** 生成结果表的返回：Markdown 正文 + 尽力上传的云盘位置。 */
export interface AcademicAnalysisResult {
    markdown: string;
    uploadUuid?: string;
    folderId?: number;
    /** mode=compare 时返回的图表数据。 */
    chart?: AcademicAnalysisChart;
}

// ---------------------------------------------------------------------------
// 学术空间（research_workspace）
// ---------------------------------------------------------------------------

/** 学术空间的七个固定目录。 */
export type AcademicWorkspaceFolderKind =
    | "plan"
    | "literature"
    | "data"
    | "code"
    | "results"
    | "manuscript"
    | "submission";

export interface AcademicWorkspaceFolders {
    plan: number;
    literature: number;
    data: number;
    code: number;
    results: number;
    manuscript: number;
    submission: number;
}

/** 一个课题（科研项目）在学术空间里的云盘目录映射。 */
export interface AcademicWorkspaceProject {
    projectId: string;
    title: string;
    rootFolderId: number;
    folders: AcademicWorkspaceFolders;
}

export interface AcademicWorkspace {
    workspaceId: string;
    title: string;
    project: AcademicWorkspaceProject;
}

/** 云盘文件（字段沿用 app-cloud 的 snake_case 形状）。 */
export interface AcademicWorkspaceFile {
    upload_uuid: string;
    name: string;
    size: number;
    mime_type: string;
    sha256?: string;
    createdAt?: number;
}

export interface AcademicWorkspaceFilePage {
    kind: string;
    folderId: number;
    files: AcademicWorkspaceFile[];
}

// ---------------------------------------------------------------------------
// 项目文件聚合（project files，契约 docs/project-files.md §1）
// ---------------------------------------------------------------------------

/** 文件来源：学术空间目录 / 写作文档原始上传稿 / 写作文档回存稿。 */
export type AcademicProjectFileOrigin = "workspace" | "document-source" | "document-export";

/** 学术空间七个固定目录之一（项目文件列表的 workspace.folders）。 */
export interface AcademicProjectWorkspaceFolder {
    /** plan | literature | data | code | results | manuscript | submission */
    kind: string;
    /** 00_课题与计划 … 06_投稿 */
    label: string;
    folderId: number;
}

/** 项目学术空间：exists=false 表示还没创建（AI 生成文件将无处归档）。 */
export type AcademicProjectWorkspace =
    | { exists: false }
    | {
          exists: true;
          workspaceId: string;
          title: string;
          folders: AcademicProjectWorkspaceFolder[];
      };

/** 项目聚合文件条目（workspace 目录文件或写作文档来源/回存）。 */
export interface AcademicProjectFile {
    uploadUuid: string;
    name: string;
    size: number;
    mimeType: string;
    createdAt?: number;
    origin: AcademicProjectFileOrigin;
    /** workspace 文件才有（kind 同上方目录枚举） */
    folderKind?: string;
    /** workspace 文件才有（00_课题与计划 … 06_投稿） */
    folderLabel?: string;
    /** 写作文档来源/回存才有 */
    documentId?: string;
    documentTitle?: string;
}

/** GET /academic/projects/:projectId/files 的响应。 */
export interface AcademicProjectFiles {
    workspace: AcademicProjectWorkspace;
    files: AcademicProjectFile[];
}

// ---------------------------------------------------------------------------
// DAG 计划历史（plan_and_run）
// ---------------------------------------------------------------------------

export type AcademicPlanRunStatus =
    | "pending"
    | "running"
    | "paused"
    | "cancelled"
    | "completed"
    | "failed"
    | "partial";

export interface AcademicPlanRunNodeCounts {
    total: number;
    done: number;
    failed: number;
    skipped: number;
    running: number;
    pending: number;
}

/** 账号维度（跨项目）的计划运行摘要。 */
export interface AcademicPlanRunSummary {
    runId: string;
    goal: string;
    status: AcademicPlanRunStatus;
    chatSessionId: string;
    /** 计划运行所属科研项目（从科研工作台发起的对话才有；普通对话没有） */
    projectId?: string;
    createdAt: number;
    updatedAt: number;
    endedAt?: number;
    nodeCounts: AcademicPlanRunNodeCounts;
}

export type AcademicPlanNodeStatus = "pending" | "in_progress" | "done" | "failed" | "skipped";

/** DAG 快照节点：output/error 仅快照携带时存在（宽松类型，未携带则只在展开里显示状态）。 */
export interface AcademicPlanNodeView {
    id: string;
    title: string;
    agent?: string;
    deps?: string[];
    status: AcademicPlanNodeStatus;
    note?: string;
    output?: string;
    error?: string;
}

/** 计划 DAG 快照（后端 PlanSnapshot；兼容旧线性 steps）。 */
export interface AcademicPlanSnapshot {
    runId?: string;
    version?: number;
    goal?: string;
    nodes?: AcademicPlanNodeView[];
    steps?: Array<{ desc: string; status: string; note?: string }>;
    done?: number;
    total?: number;
}

/** GET /chat/plans/:runId 的详情（chat_session_id / updated_at 为后端原样字段）。 */
export interface AcademicPlanRunDetail {
    runId: string;
    status: AcademicPlanRunStatus;
    chat_session_id: string;
    updated_at: number;
    plan: AcademicPlanSnapshot;
}

// ---------------------------------------------------------------------------
// 写入载荷
// ---------------------------------------------------------------------------

export interface AcademicProjectCreateInput {
    title: string;
    paperType?: AcademicPaperType;
    field?: string;
    targetJournal?: string;
    /** YYYY-MM-DD */
    deadline?: string;
    researchQuestion?: string;
    objectives?: string[];
    keywords?: string[];
    contributions?: string[];
    methodology?: string;
    ethicsNote?: string;
    venueRequirements?: string;
    language?: "zh" | "en";
    citationStyle?: AcademicCitationStyle;
}

/** 阶段状态补丁：只传要改的字段（updatedAt 由后端补）。 */
export interface AcademicStageStatePatch {
    status?: AcademicStageStatus;
    updatedAt?: number;
    note?: string;
}

/** PATCH 载荷：stages/plans/advice 按键合并；空数组 / 空字符串表示清空。 */
export interface AcademicProjectPatchInput {
    title?: string;
    paperType?: AcademicPaperType;
    field?: string;
    targetJournal?: string;
    deadline?: string;
    researchQuestion?: string;
    objectives?: string[];
    keywords?: string[];
    contributions?: string[];
    methodology?: string;
    ethicsNote?: string;
    venueRequirements?: string;
    language?: "zh" | "en";
    citationStyle?: AcademicCitationStyle;
    stage?: AcademicStage;
    stages?: Partial<Record<AcademicStage, AcademicStageStatePatch>>;
    plans?: Partial<Record<AcademicStage, AcademicPlanTask[]>>;
    advice?: Partial<Record<AcademicStage, string>>;
    /** 自动模式（off/assist/auto） */
    autoMode?: AcademicAutoMode;
}

/** 手工入库载荷（元数据只能来自检索结果或用户输入）。 */
export interface AcademicLiteratureInput {
    title: string;
    authors?: string[];
    year?: number;
    venue?: string;
    doi?: string;
    url?: string;
    abstract?: string;
    tags?: string[];
    notes?: string;
    readingStatus?: "unread" | "reading" | "read";
    keywords?: string[];
}

/** PATCH 文献元数据载荷（身份字段不可改）。 */
export interface AcademicLiteraturePatchInput {
    tags?: string[];
    notes?: string;
    readingStatus?: "unread" | "reading" | "read";
    keywords?: string[];
}

/** 研究顾问的下一步建议。 */
export interface AcademicResearchSuggestion {
    id: string;
    title: string;
    reason: string;
    action: string;
    severity: "blocker" | "warning" | "info";
}

export interface AcademicResearchAdvice {
    stage: AcademicStage;
    suggestions: AcademicResearchSuggestion[];
}

/** 项目自动推进（Autopilot）。 */
export type AcademicAutopilotMode = "off" | "assist" | "auto";

export interface AcademicAutopilotSetting {
    projectId: string;
    mode: AcademicAutopilotMode;
    maxActionsPerDay: number;
    actionsToday: number;
    day: string;
    stoppedAt?: number;
    lastTickAt?: number;
    lastResult?: string;
    updatedAt: number;
}

/** 站内通知。 */
export interface AcademicNotification {
    id: string;
    projectId: string;
    type: "approval" | "experiment" | "validation" | "plan" | "system";
    title: string;
    body?: string;
    link?: string;
    readAt?: number;
    createdAt: number;
}

// ---------------------------------------------------------------------------
// URL 工具
// ---------------------------------------------------------------------------

/** 路径段编码：DOI 里的 / 必须编码，否则会被当成额外路径层。 */
function seg(value: string): string {
    return encodeURIComponent(value);
}

/** 拼查询串，跳过 undefined / 空串。 */
function query(params: Record<string, string | number | undefined>): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === "") continue;
        search.set(key, String(value));
    }
    const text = search.toString();
    return text ? `?${text}` : "";
}

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

function projectPath(projectId: string, suffix = ""): string {
    return `/academic/projects/${seg(projectId)}${suffix}`;
}

function documentPath(documentId: string, suffix = ""): string {
    return `/academic/documents/${seg(documentId)}${suffix}`;
}

/** 章节保存（POST .../sections）：body { key?, title, content? }。 */
function saveSectionRequest(documentId: string, input: AcademicSectionInput) {
    return request<{ document: AcademicDocument }>(documentPath(documentId, "/sections"), {
        method: "POST",
        headers: { ...getAuthHeaders(), ...JSON_HEADERS },
        body: JSON.stringify(input),
    });
}

/**
 * 下载二进制响应（Word / 投稿包）：带鉴权头，非 2xx 解析后端 { detail } 抛出；
 * 网关 HTML 错误页回落到兜底文案。
 */
async function downloadBlob(
    endpoint: string,
    fallback: { notFound: string; message: string },
): Promise<Blob> {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        headers: { ...getAuthHeaders(), "X-Requested-With": "XMLHttpRequest" },
    });
    if (!response.ok) {
        let detail = "";
        try {
            const parsed = (await response.json()) as { detail?: unknown };
            if (typeof parsed.detail === "string" && parsed.detail) detail = parsed.detail;
        } catch {
            // 非 JSON（网关 HTML 错误页）→ 走通用提示
        }
        throw new Error(detail || (response.status === 404 ? fallback.notFound : fallback.message));
    }
    return response.blob();
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * 科研工作台全部端点。写操作统一 POST/PATCH/DELETE + JSON body；读操作显式带
 * getAuthHeaders()（与其它域模块保持一致，client 也会兜底注入）。
 */
export const academicApi = {
    // ---- 人工审批 ----
    listApprovals: (projectId: string) =>
        request<AcademicApproval[]>(projectPath(projectId, "/approvals"), {
            headers: getAuthHeaders(),
        }),
    requestApproval: (projectId: string, kind: AcademicApprovalKind, note?: string) =>
        request<AcademicApproval>(projectPath(projectId, "/approvals"), {
            method: "POST",
            headers: { "Content-Type": "application/json", ...getAuthHeaders() },
            body: JSON.stringify({ kind, ...(note ? { note } : {}) }),
        }),
    decideApproval: (approvalId: string, approved: boolean, note?: string) =>
        request<AcademicApproval>(`/academic/approvals/${seg(approvalId)}/decision`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...getAuthHeaders() },
            body: JSON.stringify({ approved, ...(note ? { note } : {}) }),
        }),

    // ---- 项目 ----
    listProjects: (options: { archived?: "only" | "all" } = {}) =>
        request<{ projects: AcademicProjectSummary[] }>(
            `/academic/projects${options.archived ? `?archived=${options.archived}` : ""}`,
            { headers: getAuthHeaders() },
        ),

    createProject: (body: AcademicProjectCreateInput) =>
        request<AcademicProjectDetail>("/academic/projects", {
            method: "POST",
            headers: { ...getAuthHeaders(), ...JSON_HEADERS },
            body: JSON.stringify(body),
        }),

    getProject: (projectId: string) =>
        request<AcademicProjectDetail>(projectPath(projectId), {
            headers: getAuthHeaders(),
        }),

    updateProject: (projectId: string, patch: AcademicProjectPatchInput) =>
        request<AcademicProjectDetail>(projectPath(projectId), {
            method: "PATCH",
            headers: { ...getAuthHeaders(), ...JSON_HEADERS },
            body: JSON.stringify(patch),
        }),

    /** 移入回收站（软删除）。 */
    deleteProject: (projectId: string) =>
        request<{ deleted: boolean; archived: boolean; archivedAt: number }>(projectPath(projectId), {
            method: "DELETE",
            headers: getAuthHeaders(),
        }),

    restoreProject: (projectId: string) =>
        request<import("./academic").AcademicProjectDetail>(projectPath(projectId, "/restore"), {
            method: "POST",
            headers: getAuthHeaders(),
        }),

    /** 永久删除：级联清理子数据（回收站内操作）。 */
    purgeProject: (projectId: string) =>
        request<{ deleted: boolean; counts: Record<string, unknown> }>(projectPath(projectId, "/purge"), {
            method: "DELETE",
            headers: getAuthHeaders(),
        }),

    /** 阶段门禁 checklist（只读，不会写库；门禁服务未启用时后端 503）。 */
    getProjectGates: (projectId: string) =>
        request<AcademicStageGateReport>(projectPath(projectId, "/gates"), {
            headers: getAuthHeaders(),
        }),

    /**
     * 同步进度：按 autoRule 自动打勾计划任务；autoMode=auto 且当前阶段门禁就绪时
     * 自动推进一个阶段（当前→待确认、下一阶段→进行中）。approved 仍需人工。
     */
    syncProjectGates: (projectId: string) =>
        request<AcademicGateSyncResult>(projectPath(projectId, "/gates/sync"), {
            method: "POST",
            headers: getAuthHeaders(),
        }),

    /** 研究顾问：规则化「下一步建议」（不调用 LLM，不编造）。 */
    getNextActions: (projectId: string) =>
        request<AcademicResearchAdvice>(projectPath(projectId, "/next-actions"), {
            headers: getAuthHeaders(),
        }),

    // ---- 文献库 ----
    listLiterature: (projectId: string, params: { limit?: number; offset?: number } = {}) =>
        request<AcademicLiteraturePage>(
            projectPath(projectId, `/literature${query({ limit: params.limit, offset: params.offset })}`),
            { headers: getAuthHeaders() },
        ),

    addLiterature: (projectId: string, input: AcademicLiteratureInput) =>
        request<AcademicLiteratureAddResult>(projectPath(projectId, "/literature"), {
            method: "POST",
            headers: { ...getAuthHeaders(), ...JSON_HEADERS },
            body: JSON.stringify(input),
        }),

    /** ref = 文献 id / citeKey / DOI */
    verifyLiterature: (projectId: string, ref: string) =>
        request<AcademicLiteratureVerifyResult>(projectPath(projectId, `/literature/${seg(ref)}/verify`), {
            method: "POST",
            headers: { ...getAuthHeaders(), ...JSON_HEADERS },
            body: JSON.stringify({}),
        }),

    /** 更新文献元数据（tags/notes/readingStatus/keywords；身份字段不可改）。 */
    updateLiterature: (projectId: string, ref: string, patch: AcademicLiteraturePatchInput) =>
        request<{ entry: AcademicLiteratureEntry }>(projectPath(projectId, `/literature/${seg(ref)}`), {
            method: "PATCH",
            headers: { ...getAuthHeaders(), ...JSON_HEADERS },
            body: JSON.stringify(patch),
        }),

    /** ref = 文献 id / citeKey / DOI */
    deleteLiterature: (projectId: string, ref: string) =>
        request<{ deleted: boolean }>(projectPath(projectId, `/literature/${seg(ref)}`), {
            method: "DELETE",
            headers: getAuthHeaders(),
        }),

    exportBibtex: (projectId: string) =>
        request<{ bibtex: string }>(projectPath(projectId, "/literature/export"), {
            headers: getAuthHeaders(),
        }),

    /** 在线检索（不需要项目）。 */
    searchLiterature: (
        q: string,
        params: { limit?: number; source?: AcademicLiteratureSearchSource } = {},
    ) =>
        request<{ hits: AcademicLiteratureHit[] }>(
            `/academic/literature/search${query({ q, limit: params.limit, source: params.source })}`,
            { headers: getAuthHeaders() },
        ),

    // ---- 稿件 ----
    listDocuments: (projectId: string) =>
        request<{ documents: AcademicDocumentSummary[] }>(projectPath(projectId, "/documents"), {
            headers: getAuthHeaders(),
        }),

    createDocument: (projectId: string, body: { kind: AcademicDocumentKind; title: string }) =>
        request<{ document: AcademicDocument }>(projectPath(projectId, "/documents"), {
            method: "POST",
            headers: { ...getAuthHeaders(), ...JSON_HEADERS },
            body: JSON.stringify(body),
        }),

    getDocument: (documentId: string) =>
        request<{ document: AcademicDocument }>(documentPath(documentId), {
            headers: getAuthHeaders(),
        }),

    /** 保存/更新章节（body { key, title, content }；key 省略时后端按标题匹配）。 */
    saveSection: saveSectionRequest,
    /** 旧名，与 saveSection 等价（保留兼容）。 */
    upsertSection: saveSectionRequest,

    deleteSection: (documentId: string, sectionKey: string) =>
        request<{ document: AcademicDocument }>(
            documentPath(documentId, `/sections/${seg(sectionKey)}`),
            { method: "DELETE", headers: getAuthHeaders() },
        ),

    exportDocument: (documentId: string, format: "markdown" | "latex") =>
        request<{ text: string; title: string }>(
            documentPath(documentId, `/export${query({ format })}`),
            { headers: getAuthHeaders() },
        ),

    /**
     * 导入已有 Word（multipart 字段 file；可选 title / kind）。
     * 后端解析章节、把原文件上传到 05_论文，返回新文档与来源信息。
     */
    importDocumentDocx: (
        projectId: string,
        file: File,
        opts: { title?: string; kind?: AcademicDocumentKind } = {},
    ) => {
        const form = new FormData();
        form.append("file", file);
        if (opts.title) form.append("title", opts.title);
        if (opts.kind) form.append("kind", opts.kind);
        // 不设置 Content-Type：由浏览器生成 multipart boundary。
        return request<{ document: AcademicDocument; source: AcademicDocumentSource }>(
            projectPath(projectId, "/documents/import"),
            { method: "POST", headers: getAuthHeaders(), body: form },
        );
    },

    /**
     * 从项目云盘导入已有 Word 作为写作文档（论文模板）：
     * body { uploadUuid, title?, kind? } → { document, source }。
     * 与导入上传稿同语义，只是文件已在云盘（无需再上传）。
     */
    importDocumentFromCloud: (
        projectId: string,
        input: { uploadUuid: string; title?: string; kind?: AcademicDocumentKind },
    ) =>
        request<{ document: AcademicDocument; source: AcademicDocumentSource }>(
            projectPath(projectId, "/documents/import-from-cloud"),
            {
                method: "POST",
                headers: { ...getAuthHeaders(), ...JSON_HEADERS },
                body: JSON.stringify(input),
            },
        ),

    /** 导出 Word 二进制（直接下载，不落云盘）；失败时解析后端 { detail }。 */
    downloadDocumentDocx: (documentId: string): Promise<Blob> =>
        downloadBlob(documentPath(documentId, "/export/docx"), {
            notFound: "文档不存在或无权访问",
            message: "导出 Word 失败",
        }),

    /**
     * 下载投稿包（zip）：后端先校验稿件并通过投稿审批，未通过返回 409/422，
     * 服务未启用返回 503；错误体 { detail } 原样交给调用方展示。
     */
    /** 项目备份（项目/文献/稿件/事件审计导出）。 */
    downloadProjectBackup: (projectId: string): Promise<Blob> =>
        downloadBlob(projectPath(projectId, "/export"), {
            notFound: "项目不存在或无权访问",
            message: "导出项目备份失败",
        }),

    downloadSubmissionPackage: (documentId: string): Promise<Blob> =>
        downloadBlob(documentPath(documentId, "/package"), {
            notFound: "文档不存在或无权访问",
            message: "下载投稿包失败",
        }),

    /** 生成 Word 并回存到项目云盘 05_论文，返回云盘文件信息（同时更新 lastExport）。 */
    saveDocumentDocx: (documentId: string) =>
        request<AcademicDocumentExport>(documentPath(documentId, "/export/docx"), {
            method: "POST",
            headers: getAuthHeaders(),
        }),

    // ---- 实验 ----
    experiments: (projectId: string, limit = 20) =>
        request<{ experiments: AcademicExperiment[] }>(
            projectPath(projectId, `/experiments${query({ limit })}`),
            { headers: getAuthHeaders() },
        ),

    /** 仅 queued/running 可取消；已终态后端返回 { cancelled: false }。 */
    cancelExperiment: (experimentId: string) =>
        request<{ cancelled: boolean }>(`/academic/experiments/${seg(experimentId)}/cancel`, {
            method: "POST",
            headers: getAuthHeaders(),
        }),

    // ---- 证据 ----
    evidence: (projectId: string, params: { limit?: number; offset?: number } = {}) =>
        request<AcademicEvidencePage>(
            projectPath(projectId, `/evidence${query({ limit: params.limit, offset: params.offset })}`),
            { headers: getAuthHeaders() },
        ),

    getEvidenceRun: (projectId: string, runId: string) =>
        request<{ run: AcademicRun }>(projectPath(projectId, `/evidence/runs/${seg(runId)}`), {
            headers: getAuthHeaders(),
        }),

    // ---- 校验 ----
    /** 只读检查（无副作用）；documentId 缺省 = 校验项目全部稿件。 */
    validateProject: (projectId: string, body: { documentId?: string } = {}) =>
        request<{ report: AcademicValidationReport }>(projectPath(projectId, "/validation"), {
            method: "POST",
            headers: { ...getAuthHeaders(), ...JSON_HEADERS },
            body: JSON.stringify(body),
        }),

    // ---- 分析 ----
    /** 生成结果表/多 run 对比；summary 写 results_summary.md，compare 写 results_comparison.md。 */
    generateResults: (
        projectId: string,
        body: { documentId?: string; mode?: "summary" | "compare"; runIds?: string[] } = {},
    ) =>
        request<AcademicAnalysisResult>(projectPath(projectId, "/analysis/results"), {
            method: "POST",
            headers: { ...getAuthHeaders(), ...JSON_HEADERS },
            body: JSON.stringify(body),
        }),

    // ---- 学术空间 ----
    getWorkspace: (projectId: string) =>
        request<{ workspace: AcademicWorkspace }>(projectPath(projectId, "/workspace"), {
            headers: getAuthHeaders(),
        }),

    /** 幂等确保空间存在（内部 ensureProject）；云盘不可用时后端 503。 */
    ensureWorkspace: (projectId: string) =>
        request<{ workspace: AcademicWorkspace }>(projectPath(projectId, "/workspace"), {
            method: "POST",
            headers: getAuthHeaders(),
        }),

    listWorkspaceFiles: (projectId: string, kind: AcademicWorkspaceFolderKind, limit = 50) =>
        request<AcademicWorkspaceFilePage>(
            projectPath(projectId, `/workspace/files${query({ kind, limit })}`),
            { headers: getAuthHeaders() },
        ),

    /** 项目文件聚合：学术空间 7 个目录 + 写作文档来源/回存（无空间时 files 仅文档条目）。 */
    listProjectFiles: (projectId: string) =>
        request<AcademicProjectFiles>(projectPath(projectId, "/files"), {
            headers: getAuthHeaders(),
        }),

    // ---- DAG 计划历史（uid 维度；传 projectId 时只看该科研项目） ----
    plans: (limit = 20, chatSessionId?: string, projectId?: string) =>
        request<{ runs: AcademicPlanRunSummary[] }>(
            `/chat/plans${query({ limit, chat_session_id: chatSessionId, project_id: projectId })}`,
            { headers: getAuthHeaders() },
        ),

    /** 详情复用 GET /chat/plans/:runId；plan 为 DAG 快照。 */
    getPlanRun: (runId: string) =>
        request<AcademicPlanRunDetail>(`/chat/plans/${seg(runId)}`, {
            headers: getAuthHeaders(),
        }),

    /** 提交稿件：要求校验通过且消耗一次已批准的 submission 审批（一次一用）。 */
    submitDocument: (documentId: string) =>
        request<{
            submitted: boolean;
            documentId: string;
            approvalId: string;
            file: { uploadUuid: string; fileName: string; folderId: number; createdAt: number };
        }>(`/academic/documents/${seg(documentId)}/submit`, {
            method: "POST",
            headers: getAuthHeaders(),
        }),

    /** 取消 running/paused 的计划运行。 */
    cancelPlanRun: (runId: string) =>
        request<{ runId: string; cancelled: boolean }>(`/chat/plans/${seg(runId)}/cancel`, {
            method: "POST",
            headers: getAuthHeaders(),
        }),

    /** 恢复 paused/failed 的计划运行；仍在审批门禁时返回 paused=true。 */
    resumePlanRun: (runId: string) =>
        request<{
            runId: string;
            ok: boolean;
            paused?: boolean;
            approvalId?: string;
            failed: string[];
            skipped: string[];
            outputs: Record<string, string>;
        }>(`/chat/plans/${seg(runId)}/resume`, {
            method: "POST",
            headers: getAuthHeaders(),
        }),

    // ---- 动态 ----
    /** SSE 事件流地址（EventSource 使用；同源 cookie 认证）。 */
    eventsStreamUrl: (projectId: string): string =>
        `${API_BASE_URL}/academic/projects/${seg(projectId)}/events/stream`,

    listEvents: (projectId: string, limit = 50, offset = 0) =>
        request<{ events: AcademicEventRecord[] }>(
            projectPath(projectId, `/events${query({ limit, offset })}`),
            { headers: getAuthHeaders() },
        ),

    // ---- 项目自动推进（Autopilot） ----
    getAutopilot: (projectId: string) =>
        request<AcademicAutopilotSetting>(projectPath(projectId, "/autopilot"), {
            headers: getAuthHeaders(),
        }),
    patchAutopilot: (
        projectId: string,
        patch: { mode?: AcademicAutopilotMode; maxActionsPerDay?: number; stopped?: boolean },
    ) =>
        request<AcademicAutopilotSetting>(projectPath(projectId, "/autopilot"), {
            method: "PATCH",
            headers: { ...getAuthHeaders(), ...JSON_HEADERS },
            body: JSON.stringify(patch),
        }),
    tickAutopilot: (projectId: string) =>
        request<Record<string, unknown>>(projectPath(projectId, "/autopilot/tick"), {
            method: "POST",
            headers: getAuthHeaders(),
        }),
    stopAutopilot: (projectId: string) =>
        request<AcademicAutopilotSetting>(projectPath(projectId, "/autopilot/stop"), {
            method: "POST",
            headers: getAuthHeaders(),
        }),
    resumeAutopilot: (projectId: string) =>
        request<AcademicAutopilotSetting>(projectPath(projectId, "/autopilot/resume"), {
            method: "POST",
            headers: getAuthHeaders(),
        }),

    // ---- 站内通知 ----
    listNotifications: (limit = 20, unreadOnly = false) =>
        request<{ notifications: AcademicNotification[]; unreadCount: number }>(
            `/academic/notifications${query({ limit, ...(unreadOnly ? { unread: 1 } : {}) })}`,
            { headers: getAuthHeaders() },
        ),

    markNotificationRead: (id: string) =>
        request<{ read: boolean }>(`/academic/notifications/${seg(id)}/read`, {
            method: "POST",
            headers: getAuthHeaders(),
        }),
};
