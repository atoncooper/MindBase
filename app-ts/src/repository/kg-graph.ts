import type {
  AppearanceRow,
  BeginPageResult,
  CloudDocEvidenceRow,
  EdgeRow,
  EntityDetail,
  EvidenceRow,
  ExposureRow,
  GraphStats,
  NeighborRow,
  PendingPage,
  RelationRow,
  ResolvedEntity,
  ResolvedRelation,
  TopEntityRow,
} from "../kg/types.js";

/**
 * KgGraphRepository — data access for the KG graph storage face (served by
 * the app-kg Go service over gRPC). The AI side (app-ts) consumes this
 * interface; the repository layer is the only place that knows about the
 * transport, mirroring the chat/session-doc repository split.
 */

export interface AppearanceInput {
  eid: string;
  quote: string;
}

export interface DeleteVideoStats {
  entitiesRemoved: number;
  videosRemoved: number;
}

export interface DeleteCloudDocStats {
  /** evidence edges removed for this document */
  deleted: number;
  /** entities left orphaned by the removal and cleaned up */
  entitiesRemoved: number;
}

/** One cloud document's evidence batch (app-kg LinkCloudDocAppearances input). */
export interface CloudDocAppearanceInput {
  uid: string;
  uploadUuid: string;
  /** non-empty overwrites CloudDoc.title; empty keeps the route-graph value */
  title: string;
  /** non-empty overwrites CloudDoc.content_hash */
  contentHash: string;
  appearances: AppearanceInput[];
}

export interface KgGraphRepository {
  /** favorite folders → bvids (dedup, order-stable); empty folderIds = all user folders */
  resolveScope(uid: string, folderIds: number[]): Promise<string[]>;
  selectPendingPages(bvids: string[], limit: number): Promise<PendingPage[]>;
  /** idempotency check + flip to processing (process_page Phase 1) */
  beginPage(bvid: string, cid: number, expectedVersion?: number): Promise<BeginPageResult>;
  markPageDone(bvid: string, cid: number, contentVersion: number): Promise<void>;
  markPageFailed(bvid: string, cid: number): Promise<void>;
  countPendingPages(): Promise<number>;

  upsertEntities(entities: ResolvedEntity[]): Promise<string[]>;
  linkAppearances(bvid: string, pageIndex: number, appearances: AppearanceInput[]): Promise<number>;
  upsertRelations(relations: ResolvedRelation[]): Promise<void>;
  deletePageEvidence(bvid: string, pageIndex: number): Promise<number>;
  deleteVideo(bvid: string): Promise<DeleteVideoStats>;
  clearAll(): Promise<void>;

  // ── cloud-drive knowledge points (same Entity/RELATES space as videos) ──

  /** Write one cloud doc's knowledge evidence: MERGE (:CloudDoc), delete its
   * previous APPEARS_IN edges (delete-before-write), then link
   * (entity)-[:APPEARS_IN {quote}]->(cloudDoc). Always call it — even with an
   * empty appearance list — so stale evidence is removed after a re-extraction.
   * Returns the number of linked evidence edges. */
  linkCloudDocAppearances(input: CloudDocAppearanceInput): Promise<number>;
  /** Delete one cloud doc's knowledge evidence + orphan Entity cleanup. The
   * CloudDoc node itself belongs to the cloud route graph and is kept. */
  deleteCloudDocAppearances(uid: string, uploadUuid: string): Promise<DeleteCloudDocStats>;
  /** Cloud evidence pull-back. uid is REQUIRED (tenant isolation); empty
   * uploadUuids = all of the user's cloud documents, else that set. */
  fetchCloudDocEvidence(
    eids: string[],
    uid: string,
    uploadUuids: string[],
    limit: number,
  ): Promise<CloudDocEvidenceRow[]>;

  neighbors(eids: string[], excludeEids: string[], limit: number): Promise<NeighborRow[]>;
  fetchEvidence(eids: string[], bvids: string[], limit: number): Promise<EvidenceRow[]>;
  relationsAmong(eids: string[]): Promise<RelationRow[]>;
  entitiesByEids(eids: string[]): Promise<EntityDetail[]>;
  entityExposure(bvids: string[], limit: number): Promise<ExposureRow[]>;
  entityAppearances(eid: string, bvids: string[], limit: number): Promise<AppearanceRow[]>;
  topEntities(limit: number): Promise<TopEntityRow[]>;
  edgesAmong(eids: string[]): Promise<EdgeRow[]>;
  stats(): Promise<GraphStats>;

  close(): Promise<void>;
}
