/**
 * KG domain types — shapes shared by the resolver, the graph repository, the
 * retriever and the build pipeline. Mirrors the Python kg stack
 * (services/kg/{resolver,extractor,retriever}.py + repository/kg_graph_repository.py).
 */

/** Raw LLM extraction output (before validation). */
export interface ExtractedEntity {
  name: string;
  type: string;
  description: string;
  quote: string;
}

export interface ExtractedRelation {
  src: string;
  dst: string;
  relationType: string;
  quote: string;
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
}

/** Validated entity ready for the graph + entity index. eid/nameLower are
 * computed here (deterministic sha1 of the normalized name) so the graph
 * store never normalizes — one implementation, two consumers. */
export interface ResolvedEntity {
  eid: string;
  name: string;
  nameLower: string;
  type: string;
  description: string;
  quote: string;
}

export interface ResolvedRelation {
  srcEid: string;
  dstEid: string;
  relType: string;
  quote: string;
}

export interface ResolvedExtraction {
  entities: ResolvedEntity[];
  relations: ResolvedRelation[];
  /** relations dropped for missing/short quotes, self-loops, caps (observability) */
  droppedRelations: number;
}

/** One video page selected for (re-)extraction. */
export interface PendingPage {
  bvid: string;
  cid: number;
  pageIndex: number;
  pageTitle: string;
  version: number;
}

/** Result of the idempotency check + status flip (process_page Phase 1). */
export interface BeginPageResult {
  found: boolean;
  asrDone: boolean;
  skip: boolean;
  reason: string;
  contentVersion: number;
  pageTitle: string;
  pageIndex: number;
}

// ── graph read shapes ────────────────────────────────────────────────

export interface NeighborRow {
  eid: string;
  name: string;
  type: string;
  description: string;
  relType: string;
  fromEid: string;
}

export interface EvidenceRow {
  eid: string;
  name: string;
  type: string;
  bvid: string;
  pageIndex: number;
  quote: string;
  /** joined from the video table by app-kg; missing → "P{n+1}" */
  pageTitle: string;
}

export interface RelationRow {
  srcEid: string;
  srcName: string;
  relType: string;
  dstEid: string;
  dstName: string;
  weight: number;
  quotes: string[];
}

export interface EntityDetail {
  eid: string;
  name: string;
  type: string;
  description: string;
  aliases: string[];
}

export interface ExposureEvidence {
  bvid: string;
  pageIndex: number;
  quote: string;
}

export interface ExposureRow {
  eid: string;
  name: string;
  type: string;
  description: string;
  pages: number;
  evidenceSample: ExposureEvidence[];
}

export interface AppearanceRow {
  bvid: string;
  pageIndex: number;
  quote: string;
}

export interface TopEntityRow {
  eid: string;
  name: string;
  type: string;
  description: string;
  degree: number;
}

export interface EdgeRow {
  srcEid: string;
  dstEid: string;
  relType: string;
}

export interface GraphStats {
  entities: number;
  relations: number;
  evidence: number;
  videos: number;
  pendingPages: number;
}

// ── build task record (Mongo mind_base_ts.kg_builds) ─────────────────

export interface KgBuildStep {
  name: string;
  status: string;
  progress: number;
  at: number;
}

export interface KgBuildResult {
  total?: number;
  ok?: number;
  failed?: number;
  message?: string;
}

export interface KgBuildRecord {
  taskId: string;
  uid: string;
  folderIds: number[];
  bvidCount: number;
  status: "processing" | "done" | "failed";
  progress: number;
  currentStep: string;
  steps: KgBuildStep[];
  result?: KgBuildResult;
  error?: string;
  createdAt: number;
  updatedAt: number;
}
