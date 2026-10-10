import type {
  AppearanceRow,
  BeginPageResult,
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
