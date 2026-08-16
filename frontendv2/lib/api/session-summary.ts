/**
 * Session summary API - 会话总结：流式生成 / 读取最近总结.
 *
 * POST /chat/sessions/{id}/summary streams a fresh detailed summary produced
 * by the summary agent (chat-header button); GET the same path returns the
 * latest persisted summary (404 when none exists yet). Both ride the regular
 * /chat/* chain (nginx -> backend, bili_session Bearer auth) - no APISIX
 * forward-auth involved.
 */
import { getAuthHeaders, API_BASE_URL, snakeToCamel } from "./client";

export interface SessionSummary {
    summaryId: string;
    chatSessionId: string;
    content: string;
    messageCount: number;
    firstMessageAt: string | null;
    lastMessageAt: string | null;
    createdAt: string;
}

export interface SessionSummaryStreamHandlers {
    onChunk?: (content: string) => void;
    onDone?: (e: { summary_id: string | null; message_count?: number }) => void;
    onError?: (msg: string) => void;
}

export const sessionSummaryApi = {
    /**
     * Stream a fresh session summary (SSE: chunk / done / error). Direct fetch
     * with API_BASE_URL as stream base - mirrors taskQuizApi.streamChat (the
     * Next.js dev proxy buffers SSE, and in docker prod the browser resolves
     * "" relative to nginx, never the container names).
     */
    streamSummary: async (
        chatSessionId: string,
        handlers: SessionSummaryStreamHandlers,
        signal?: AbortSignal,
    ): Promise<void> => {
        const resp = await fetch(
            `${API_BASE_URL}/chat/sessions/${encodeURIComponent(chatSessionId)}/summary`,
            {
                method: "POST",
                headers: { ...getAuthHeaders() },
                signal,
            },
        );

        if (resp.status === 401) {
            if (typeof window !== "undefined") {
                localStorage.removeItem("bili_session");
                localStorage.removeItem("bili_user");
                window.dispatchEvent(new Event("auth:unauthorized"));
            }
            handlers.onError?.("会话已过期，请重新登录");
            return;
        }

        // Non-OK before the stream starts: surface the backend detail
        // (400 empty session / 404 not found / 503 harness not started).
        if (!resp.ok || !resp.body) {
            let detail = `HTTP ${resp.status}`;
            try {
                const body = await resp.json();
                if (body?.detail) detail = body.detail;
            } catch {
                /* keep status detail */
            }
            handlers.onError?.(detail);
            return;
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const frames = buf.split("\n\n");
            buf = frames.pop() || "";
            for (const frame of frames) {
                const data = frame.replace(/^data: /, "").trim();
                if (!data) continue;
                try {
                    const evt = JSON.parse(data);
                    if (evt.type === "chunk" && evt.content) handlers.onChunk?.(evt.content);
                    else if (evt.type === "done") handlers.onDone?.(evt);
                    else if (evt.type === "error") handlers.onError?.(evt.message || "总结生成失败");
                } catch {
                    /* ignore malformed SSE frame */
                }
            }
        }
    },

    /** Get the latest persisted summary (null when none exists yet). */
    getLatest: async (chatSessionId: string): Promise<SessionSummary | null> => {
        // Raw fetch instead of requestCamel so the 404-no-summary-yet case can
        // be branched on the status code instead of sniffing the sanitized
        // error message (and must not trigger the shared 401/403 handling).
        const resp = await fetch(
            `${API_BASE_URL}/chat/sessions/${encodeURIComponent(chatSessionId)}/summary`,
            { headers: { ...getAuthHeaders() } },
        );
        if (resp.status === 404) return null;
        if (!resp.ok) throw new Error(`获取总结失败: HTTP ${resp.status}`);
        return snakeToCamel<SessionSummary>(await resp.json());
    },
};
