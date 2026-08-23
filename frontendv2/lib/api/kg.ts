/**
 * Knowledge Graph API - graph build / stats / visualization subgraph.
 *
 * Backend contract: app/routers/knowledge.py KG section; frontend design:
 * plan/1.0.5-KnowledgeGraph/frontend-design.md.
 */
import { request } from "./client";

export type KgTaskStatus =
    | "pending"
    | "processing"
    | "running"
    | "done"
    | "completed"
    | "failed";

export interface KgGraphStats {
    entities: number;
    relations: number;
    evidence: number;
    videos: number;
}

export interface KgStats {
    available: boolean;
    graph: KgGraphStats;
    entity_vectors: number;
    pending_pages: number;
}

export interface KgBuildStart {
    task_id: string;
    reused: boolean;
}

export interface KgActiveTask {
    task_id: string | null;
}

export interface KgSubgraphNode {
    eid: string;
    name: string;
    type: string;
    description: string;
    degree: number;
}

export interface KgSubgraphEdge {
    src: string;
    dst: string;
    rel_type: string;
}

export interface KgSubgraph {
    available: boolean;
    center: string | null;
    nodes: KgSubgraphNode[];
    edges: KgSubgraphEdge[];
}

export interface KgBuildStatus {
    task_id: string;
    status: KgTaskStatus;
    progress: number;
    current_step: string;
    /** On completion: {total, ok, failed} or {total: 0, message}; {} while running */
    result: Record<string, unknown>;
    error: string;
}

export const kgApi = {
    // Graph stats (Neo4j counts + pending pages)
    getStats: () => request<KgStats>("/knowledge/kg/stats"),

    // Trigger build (empty folder_ids = all user folders); reuses the active task_id
    build: (folderIds: number[]) =>
        request<KgBuildStart>("/knowledge/kg/build", {
            method: "POST",
            body: JSON.stringify({ folder_ids: folderIds }),
        }),

    // Detect active task (resume polling after page refresh)
    getActiveTask: () => request<KgActiveTask>("/knowledge/kg/active"),

    // Poll build status
    getStatus: (taskId: string) =>
        request<KgBuildStatus>(`/knowledge/kg/status/${taskId}`),

    // Visualization subgraph (no center = overview; center = BFS expansion)
    getSubgraph: (params?: { center?: string; depth?: number; maxNodes?: number }) => {
        const sp = new URLSearchParams();
        if (params?.center) sp.set("center", params.center);
        if (params?.depth) sp.set("depth", String(params.depth));
        if (params?.maxNodes) sp.set("max_nodes", String(params.maxNodes));
        const qs = sp.toString();
        return request<KgSubgraph>(`/knowledge/kg/subgraph${qs ? `?${qs}` : ""}`);
    },
};
