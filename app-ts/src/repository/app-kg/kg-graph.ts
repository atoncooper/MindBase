import { config } from "../../config/index.js";
import { GrpcClient } from "../../transport/grpc.js";
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
} from "../../kg/types.js";
import type {
  AppearanceInput,
  CloudDocAppearanceInput,
  DeleteCloudDocStats,
  DeleteVideoStats,
  KgGraphRepository,
} from "../kg-graph.js";

/**
 * gRPC implementation of KgGraphRepository against the app-kg Go service.
 * Transport (proto loading / channel / deadline / error normalization) lives
 * in src/transport/grpc.ts; this file is ONLY message↔domain mapping — the
 * repository layer owns "what the data is", never "how the bytes travel".
 *
 * IMPORTANT: transport/grpc.ts loads the proto with keepCase:false, so the
 * runtime message keys are camelCase (uploadUuid / cloudDocs / pageIndex).
 * Snake_case keys are silently dropped by the protobuf serializer — always
 * map to the camelCase names below.
 */

/** Service FQN inside proto/kg/v1/kg.proto. */
const KG_SERVICE_FQN = "kg.v1.KgGraph";

function arr(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function strArr(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** int64 fields are strings inside app-ts (precision-safe); protobuf accepts
 * a decimal string for int64, so uids travel as-is. */
export class GrpcKgGraphRepository implements KgGraphRepository {
  private constructor(private readonly rpc: GrpcClient) {}

  /** Open the channel to app-kg. Throws on failure — the caller (index.ts
   * wiring) treats construction failure as "kg degraded to memory". */
  static async connect(): Promise<GrpcKgGraphRepository> {
    const rpc = await GrpcClient.create({
      target: config.kgGrpc.target,
      protoPath: config.kgGrpc.protoPath,
      serviceFqn: KG_SERVICE_FQN,
      timeoutMs: config.kgGrpc.timeoutMs,
    });
    return new GrpcKgGraphRepository(rpc);
  }

  async close(): Promise<void> {
    this.rpc.close();
  }

  // ── MySQL bookkeeping ────────────────────────────────────────────────

  async resolveScope(uid: string, folderIds: number[]): Promise<string[]> {
    const res = await this.rpc.call("ResolveScope", { uid, folderIds });
    return strArr(res.bvids);
  }

  async selectPendingPages(bvids: string[], limit: number): Promise<PendingPage[]> {
    if (bvids.length === 0) return [];
    const res = await this.rpc.call("SelectPendingPages", { bvids, limit });
    return arr(res.pages).map((p) => ({
      bvid: str(p.bvid),
      cid: num(p.cid),
      pageIndex: num(p.pageIndex),
      pageTitle: str(p.pageTitle),
      version: num(p.version),
    }));
  }

  async beginPage(bvid: string, cid: number, expectedVersion?: number): Promise<BeginPageResult> {
    const res = await this.rpc.call<Record<string, unknown>>("BeginPage", {
      bvid,
      cid,
      expectedVersion: expectedVersion ?? -1,
    });
    return {
      found: Boolean(res.found),
      asrDone: Boolean(res.asrDone),
      skip: Boolean(res.skip),
      reason: str(res.reason),
      contentVersion: num(res.contentVersion),
      pageTitle: str(res.pageTitle),
      pageIndex: num(res.pageIndex),
    };
  }

  async markPageDone(bvid: string, cid: number, contentVersion: number): Promise<void> {
    await this.rpc.call("MarkPageDone", { bvid, cid, contentVersion });
  }

  async markPageFailed(bvid: string, cid: number): Promise<void> {
    await this.rpc.call("MarkPageFailed", { bvid, cid });
  }

  async countPendingPages(): Promise<number> {
    const res = await this.rpc.call("CountPendingPages", {});
    return num(res.count);
  }

  // ── graph writes ─────────────────────────────────────────────────────

  async upsertEntities(entities: ResolvedEntity[]): Promise<string[]> {
    if (entities.length === 0) return [];
    const res = await this.rpc.call("UpsertEntities", {
      entities: entities.map((e) => ({
        eid: e.eid,
        name: e.name,
        nameLower: e.nameLower,
        type: e.type,
        description: e.description,
        alias: "",
      })),
    });
    return strArr(res.eids);
  }

  async linkAppearances(bvid: string, pageIndex: number, appearances: AppearanceInput[]): Promise<number> {
    if (appearances.length === 0) return 0;
    const res = await this.rpc.call("LinkAppearances", {
      bvid,
      pageIndex,
      appearances: appearances.map((a) => ({ eid: a.eid, quote: a.quote })),
    });
    return num(res.linked);
  }

  async upsertRelations(relations: ResolvedRelation[]): Promise<void> {
    if (relations.length === 0) return;
    await this.rpc.call("UpsertRelations", {
      relations: relations.map((r) => ({
        srcEid: r.srcEid,
        dstEid: r.dstEid,
        relType: r.relType,
        quote: r.quote,
      })),
    });
  }

  async deletePageEvidence(bvid: string, pageIndex: number): Promise<number> {
    const res = await this.rpc.call("DeletePageEvidence", { bvid, pageIndex });
    return num(res.deleted);
  }

  async deleteVideo(bvid: string): Promise<DeleteVideoStats> {
    const res = await this.rpc.call("DeleteVideo", { bvid });
    return { entitiesRemoved: num(res.entitiesRemoved), videosRemoved: num(res.videosRemoved) };
  }

  async clearAll(): Promise<void> {
    await this.rpc.call("ClearAll", {});
  }

  // ── cloud-drive knowledge points (same Entity/RELATES space as videos) ──

  async linkCloudDocAppearances(input: CloudDocAppearanceInput): Promise<number> {
    // Always call: app-kg merges the CloudDoc node AND performs delete-before-write,
    // so a re-extraction that yields zero entities still clears stale evidence.
    const res = await this.rpc.call("LinkCloudDocAppearances", {
      uid: input.uid,
      uploadUuid: input.uploadUuid,
      title: input.title,
      contentHash: input.contentHash,
      appearances: input.appearances.map((a) => ({ eid: a.eid, quote: a.quote })),
    });
    return num(res.linked);
  }

  async deleteCloudDocAppearances(uid: string, uploadUuid: string): Promise<DeleteCloudDocStats> {
    const res = await this.rpc.call("DeleteCloudDocAppearances", { uid, uploadUuid });
    return { deleted: num(res.deleted), entitiesRemoved: num(res.entitiesRemoved) };
  }

  async fetchCloudDocEvidence(
    eids: string[],
    uid: string,
    uploadUuids: string[],
    limit: number,
  ): Promise<CloudDocEvidenceRow[]> {
    if (eids.length === 0 || !uid) return [];
    const res = await this.rpc.call("FetchCloudDocEvidence", {
      eids,
      uid,
      uploadUuids,
      limit,
    });
    return arr(res.rows).map((r) => ({
      eid: str(r.eid),
      name: str(r.name),
      type: str(r.type),
      uploadUuid: str(r.uploadUuid),
      quote: str(r.quote),
      title: str(r.title),
    }));
  }

  // ── graph reads ──────────────────────────────────────────────────────

  async neighbors(eids: string[], excludeEids: string[], limit: number): Promise<NeighborRow[]> {
    if (eids.length === 0) return [];
    const res = await this.rpc.call("Neighbors", { eids, excludeEids, limit });
    return arr(res.rows).map((r) => ({
      eid: str(r.eid),
      name: str(r.name),
      type: str(r.type),
      description: str(r.description),
      relType: str(r.relType),
      fromEid: str(r.fromEid),
    }));
  }

  async fetchEvidence(eids: string[], bvids: string[], limit: number): Promise<EvidenceRow[]> {
    if (eids.length === 0) return [];
    const res = await this.rpc.call("FetchEvidence", { eids, bvids, limit });
    return arr(res.rows).map((r) => ({
      eid: str(r.eid),
      name: str(r.name),
      type: str(r.type),
      bvid: str(r.bvid),
      pageIndex: num(r.pageIndex),
      quote: str(r.quote),
      pageTitle: str(r.pageTitle),
    }));
  }

  async relationsAmong(eids: string[]): Promise<RelationRow[]> {
    if (eids.length < 2) return [];
    const res = await this.rpc.call("RelationsAmong", { eids });
    return arr(res.rows).map((r) => ({
      srcEid: str(r.srcEid),
      srcName: str(r.srcName),
      relType: str(r.relType),
      dstEid: str(r.dstEid),
      dstName: str(r.dstName),
      weight: num(r.weight),
      quotes: strArr(r.quotes),
    }));
  }

  async entitiesByEids(eids: string[]): Promise<EntityDetail[]> {
    if (eids.length === 0) return [];
    const res = await this.rpc.call("EntitiesByEids", { eids });
    return arr(res.rows).map((r) => ({
      eid: str(r.eid),
      name: str(r.name),
      type: str(r.type),
      description: str(r.description),
      aliases: strArr(r.aliases),
    }));
  }

  async entityExposure(bvids: string[], limit: number): Promise<ExposureRow[]> {
    if (bvids.length === 0) return [];
    const res = await this.rpc.call("EntityExposure", { bvids, limit });
    return arr(res.rows).map((r) => ({
      eid: str(r.eid),
      name: str(r.name),
      type: str(r.type),
      description: str(r.description),
      pages: num(r.pages),
      evidenceSample: arr(r.evidenceSample).map((s) => ({
        bvid: str(s.bvid),
        pageIndex: num(s.pageIndex),
        quote: str(s.quote),
      })),
    }));
  }

  async entityAppearances(eid: string, bvids: string[], limit: number): Promise<AppearanceRow[]> {
    const res = await this.rpc.call("EntityAppearances", { eid, bvids, limit });
    return arr(res.rows).map((r) => ({
      bvid: str(r.bvid),
      pageIndex: num(r.pageIndex),
      quote: str(r.quote),
    }));
  }

  async topEntities(limit: number): Promise<TopEntityRow[]> {
    const res = await this.rpc.call("TopEntities", { limit });
    return arr(res.rows).map((r) => ({
      eid: str(r.eid),
      name: str(r.name),
      type: str(r.type),
      description: str(r.description),
      degree: num(r.degree),
    }));
  }

  async edgesAmong(eids: string[]): Promise<EdgeRow[]> {
    if (eids.length < 2) return [];
    const res = await this.rpc.call("EdgesAmong", { eids });
    return arr(res.rows).map((r) => ({
      srcEid: str(r.srcEid),
      dstEid: str(r.dstEid),
      relType: str(r.relType),
    }));
  }

  async stats(): Promise<GraphStats> {
    const res = await this.rpc.call("Stats", {});
    return {
      entities: num(res.entities),
      relations: num(res.relations),
      evidence: num(res.evidence),
      videos: num(res.videos),
      pendingPages: num(res.pendingPages),
      cloudDocs: num(res.cloudDocs),
      cloudEvidence: num(res.cloudEvidence),
    };
  }
}
