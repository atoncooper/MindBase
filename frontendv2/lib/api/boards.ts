/**
 * Boards API - 思维导图/白板 CRUD（app-board 服务，经 APISIX 网关）.
 *
 * 后端响应即为 camelCase（Go 侧 json tag），直接用 request 无需转换。
 * content 是编辑器 JSON 的原样字符串（simple-mind-map 树 / Excalidraw 场景），
 * 本模块对内容格式透明。
 */
import { request } from "./client";

export type BoardKind = "mindmap" | "whiteboard";

export interface BoardMeta {
    uuid: string;
    title: string;
    kind: BoardKind;
    version: number;
    isPinned: boolean;
    createdAt: string;
    updatedAt: string;
}

export interface BoardDetail extends BoardMeta {
    /** 编辑器 JSON 原文；null 表示该板尚未保存过内容。 */
    content: string | null;
}

export interface BoardListResult {
    items: BoardMeta[];
    total: number;
    page: number;
    pageSize: number;
}

export interface BoardUpdateParams {
    title?: string;
    content?: string;
    isPinned?: boolean;
}

/** 乐观锁冲突（HTTP 409）：板已被其他窗口修改，需刷新后重试。 */
export class BoardConflictError extends Error {
    constructor(detail: string) {
        super(detail);
        this.name = "BoardConflictError";
    }
}

function rethrowMapped(err: unknown): never {
    if (err instanceof Error && err.message.includes("version conflict")) {
        throw new BoardConflictError(err.message);
    }
    throw err;
}

/** uuid 拼进路径前统一编码（防御性：合法 uuid 不受影响，异常输入不会改写路径）。 */
function encodeId(uuid: string): string {
    return encodeURIComponent(uuid);
}

export const boardsApi = {
    list: (params?: { kind?: BoardKind; page?: number; pageSize?: number }): Promise<BoardListResult> => {
        const qs = new URLSearchParams();
        if (params?.kind) qs.set("kind", params.kind);
        if (params?.page) qs.set("page", String(params.page));
        if (params?.pageSize) qs.set("page_size", String(params.pageSize));
        const query = qs.toString();
        return request<BoardListResult>(`/board/boards${query ? `?${query}` : ""}`).catch(rethrowMapped);
    },

    create: (data: { title?: string; kind: BoardKind; content?: string }): Promise<BoardMeta> =>
        request<BoardMeta>("/board/boards", {
            method: "POST",
            body: JSON.stringify(data),
        }).catch(rethrowMapped),

    get: (uuid: string): Promise<BoardDetail> =>
        request<BoardDetail>(`/board/boards/${encodeId(uuid)}`).catch(rethrowMapped),

    /** 乐观锁更新：ifMatch 必传（板当前 version），冲突抛 BoardConflictError。 */
    update: (uuid: string, data: BoardUpdateParams, ifMatch: number): Promise<BoardMeta> =>
        request<BoardMeta>(`/board/boards/${encodeId(uuid)}`, {
            method: "PUT",
            body: JSON.stringify(data),
            headers: { "If-Match": String(ifMatch) },
        }).catch(rethrowMapped),

    remove: (uuid: string): Promise<void> =>
        request<void>(`/board/boards/${encodeId(uuid)}`, { method: "DELETE" }).catch(rethrowMapped),

    setPin: (uuid: string, isPinned: boolean): Promise<BoardMeta> =>
        request<BoardMeta>(`/board/boards/${encodeId(uuid)}/pin`, {
            method: "PATCH",
            body: JSON.stringify({ isPinned }),
        }).catch(rethrowMapped),

    /**
     * AI 补全：为锚点节点建议 children / siblings（后端 /chat/board/complete，
     * 单次结构化 LLM 调用；失败由调用方静默处理，不打断编辑）。
     */
    completeBoard: (
        uuid: string,
        payload: { anchor_uid: string; anchor_text: string; direction?: string }
    ): Promise<BoardCompletion> =>
        request<BoardCompletion>("/chat/board/complete", {
            method: "POST",
            body: JSON.stringify({ board_uuid: uuid, ...payload }),
        }).catch(rethrowMapped),
};

export interface NodeSuggestion {
    text: string;
    reason?: string;
    /** text | code | md —— code/md 时由本地渲染管线转富文本卡片 */
    kind?: string;
    code?: string;
    language?: string;
    markdown?: string;
}

export interface BoardCompletion {
    anchor_text: string;
    children: NodeSuggestion[];
    siblings: NodeSuggestion[];
}
