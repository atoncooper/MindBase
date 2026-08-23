/**
 * Blindspot API - knowledge blind-spot map (Plan 1.0.6).
 *
 * Backend contract: app/routers/blindspot.py; design: plan/1.0.6-BlindSpotMap/.
 */
import { request } from "./client";

export type Quadrant =
    | "danger"
    | "blind"
    | "learning"
    | "familiar"
    | "unexplored";

export interface EvidenceSample {
    bvid: string;
    page_index: number;
    quote: string;
}

export interface BlindspotEntity {
    eid: string;
    name: string;
    type: string;
    description: string;
    exposure: number;
    evidence_sample: EvidenceSample[];
    quiz_total: number;
    quiz_correct: number;
    quiz_wrong: number;
    probed: boolean;
    priority: number;
}

export interface QuadrantStats {
    total_entities: number;
    danger: number;
    blind: number;
    learning: number;
    familiar: number;
    unexplored: number;
}

export interface BlindspotMap {
    available: boolean;
    scope_bvids: number;
    quadrants: Record<Quadrant, BlindspotEntity[]>;
    stats: QuadrantStats;
}

export interface ReviewPathItem {
    bvid: string;
    page_index: number;
    quote: string;
    title: string;
}

export interface BlindspotEntityDetail {
    eid: string;
    name: string;
    type: string;
    description: string;
    exposure: number;
    review_path: ReviewPathItem[];
    quiz_total: number;
    quiz_correct: number;
    quiz_wrong: number;
}

export interface EntityQuizStart {
    quiz_uuid: string;
    status: string;
    title: string;
}

export const QUADRANT_LABELS: Record<Quadrant, string> = {
    danger: "危险区",
    blind: "盲区",
    learning: "追问中",
    familiar: "已掌握",
    unexplored: "未探索",
};

export const blindspotApi = {
    // Five-quadrant map (empty folderIds = all user folders)
    getMap: (folderIds?: number[]) => {
        const q = folderIds?.length ? `?folder_ids=${folderIds.join(",")}` : "";
        return request<BlindspotMap>(`/blindspot/map${q}`);
    },

    // Entity detail (review path + quiz stats)
    getEntity: (eid: string) =>
        request<BlindspotEntityDetail>(`/blindspot/entity/${encodeURIComponent(eid)}`),

    // One-click quiz for a weak entity; poll GET /quiz/{quiz_uuid} afterwards
    generateQuiz: (eid: string, questionCount = 5, difficulty = "medium") =>
        request<EntityQuizStart>(`/blindspot/${encodeURIComponent(eid)}/quiz`, {
            method: "POST",
            body: JSON.stringify({
                question_count: questionCount,
                difficulty,
            }),
        }),
};
