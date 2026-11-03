/**
 * 学术科研 API - 科研工作台（plan/1.0.17 Phase 2）.
 *
 * 后端契约：app-ts src/transport/http/routes/academic.ts（经 APISIX → app-ts）。
 * 鉴权由网关注入 X-Uid，前端只带 bili_session 的 Bearer 头；所有 JSON 均为
 * camelCase，错误体统一 { detail }（沿用 ./client 的 sanitizeError）。
 *
 * 本文件是唯一允许出现 /academic 端点的地方：组件只 import academicApi 与类型，
 * 不得自行 fetch（frontendv2 强制约束，见根 AGENTS.md §2.4）。
 */
import { getAuthHeaders, request } from "./client";

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

export interface AcademicStageState {
    status: AcademicStageStatus;
    updatedAt: number;
    /** 自由备注（阶段确认说明 / 回退原因） */
    note?: string;
}

/** 每个阶段的执行计划任务（agent 起草、用户勾选）。 */
export interface AcademicPlanTask {
    id: string;
    title: string;
    done: boolean;
    note?: string;
}

/** 项目列表项 / 详情中的项目摘要。 */
export interface AcademicProjectSummary {
    id: string;
    title: string;
    paperType: AcademicPaperType;
    field: string;
    targetJournal?: string;
    /** YYYY-MM-DD */
    deadline?: string;
    stage: AcademicStage;
    stages: Record<AcademicStage, AcademicStageState>;
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

export interface AcademicDocument {
    id: string;
    projectId: string;
    kind: AcademicDocumentKind;
    title: string;
    sections: AcademicSection[];
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
// 写入载荷
// ---------------------------------------------------------------------------

export interface AcademicProjectCreateInput {
    title: string;
    paperType?: AcademicPaperType;
    field?: string;
    targetJournal?: string;
    /** YYYY-MM-DD */
    deadline?: string;
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
    stage?: AcademicStage;
    stages?: Partial<Record<AcademicStage, AcademicStageStatePatch>>;
    plans?: Partial<Record<AcademicStage, AcademicPlanTask[]>>;
    advice?: Partial<Record<AcademicStage, string>>;
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

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * 科研工作台全部端点。写操作统一 POST/PATCH/DELETE + JSON body；读操作显式带
 * getAuthHeaders()（与其它域模块保持一致，client 也会兜底注入）。
 */
export const academicApi = {
    // ---- 项目 ----
    listProjects: () =>
        request<{ projects: AcademicProjectSummary[] }>("/academic/projects", {
            headers: getAuthHeaders(),
        }),

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

    deleteProject: (projectId: string) =>
        request<{ deleted: boolean }>(projectPath(projectId), {
            method: "DELETE",
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

    /** 按 key 或标题 upsert 章节（key 省略时后端按标题派生）。 */
    upsertSection: (documentId: string, input: AcademicSectionInput) =>
        request<{ document: AcademicDocument }>(documentPath(documentId, "/sections"), {
            method: "POST",
            headers: { ...getAuthHeaders(), ...JSON_HEADERS },
            body: JSON.stringify(input),
        }),

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

    // ---- 动态 ----
    listEvents: (projectId: string, limit = 50) =>
        request<{ events: AcademicEventRecord[] }>(
            projectPath(projectId, `/events${query({ limit })}`),
            { headers: getAuthHeaders() },
        ),
};
