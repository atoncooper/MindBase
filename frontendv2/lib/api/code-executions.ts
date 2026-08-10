/**
 * Code executions API - 代码执行记录（关联 assistant 消息）.
 */
import { request } from "./client";

export interface CodeExecutionArtifact {
    name: string;
    url?: string;
    minio_key?: string;
    content_type?: string;
    size?: number;
}

export interface CodeExecutionListItem {
    exec_id: string;
    uid: number;
    chat_session_id: string;
    assistant_msg_id: string;
    delegate_query: string;
    language: string;
    exit_code: number;
    latency_ms: number;
    error?: string | null;
    timeout: boolean;
    artifact_count: number;
    created_at: string;
}

export interface CodeExecutionListResponse {
    items: CodeExecutionListItem[];
    total: number;
    page: number;
    page_size: number;
}

export interface CodeExecutionDetail extends CodeExecutionListItem {
    code: string;
    stdout: string;
    artifacts: CodeExecutionArtifact[];
}

export const codeExecutionsApi = {
    // 某条 assistant 消息触发的代码执行记录
    listForMessage: (msgId: string, page = 1, pageSize = 50) =>
        request<CodeExecutionListResponse>(
            `/chat/messages/${msgId}/code-executions?page=${page}&page_size=${pageSize}`
        ),

    // 单条执行详情
    getDetail: (msgId: string, execId: string) =>
        request<CodeExecutionDetail>(
            `/chat/messages/${msgId}/code-executions/${execId}`
        ),
};
