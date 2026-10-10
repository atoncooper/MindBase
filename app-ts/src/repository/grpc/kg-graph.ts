import { config } from "../../config/index.js";
import { GrpcClient } from "../../transport/grpc.js";
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
} from "../../kg/types.js";
import type { AppearanceInput, DeleteVideoStats, KgGraphRepository } from "../kg-graph.js";

/**
 * gRPC implementation of KgGraphRepository against the app-kg Go service.
 * Transport (proto loading / channel / deadline / error normalization) lives
 * in src/grpc/client.ts; this file is ONLY message↔domain mapping — the
 * repository layer owns "what the data is", never "how the bytes travel".
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
    const res = await this.rpc.call("ResolveScope", { uid, folder_ids: folderIds });
    return strArr(res.bvids);
  }

  async selectPendingPages(bvids: string[], limit: number): Promise<PendingPage[]> {
    if (bvids.length === 0) return [];
    const res = await this.rpc.call("SelectPendingPages", { bvids, limit });
    return arr(res.pages).map((p) => ({
      bvid: str(p.bvid),
      cid: num(p.cid),
      pageIndex: num(p.page_index),
      pageTitle: str(p.page_title),
      version: num(p.version),
    }));
  }

  async beginPage(bvid: string, cid: number, expectedVersion?: number): Promise<BeginPageResult> {
    const res = await this.rpc.call<Record<string, unknown>>("BeginPage", {
      bvid,
      cid,
      expected_version: expectedVersion ?? -1,
    });
    return {
      found: Boolean(res.found),
      asrDone: Boolean(res.asr_done),
      skip: Boolean(res.skip),
      reason: str(res.reason),
      contentVersion: num(res.content_version),
      pageTitle: str(res.page_title),
      pageIndex: num(res.page_index),
    };
  }

  async markPageDone(bvid: string, cid: number, contentVersion: number): Promise<void> {
    await this.rpc.call("MarkPageDone", { bvid, cid, content_version: contentVersion });
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
        name_lower: e.nameLower,
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
      page_index: pageIndex,
      appearances: appearances.map((a) => ({ eid: a.eid, quote: a.quote })),
    });
    return num(res.linked);
  }

  async upsertRelations(relations: ResolvedRelation[]): Promise<void> {
    if (relations.length === 0) return;
    await this.rpc.call("UpsertRelations", {
      relations: relations.map((r) => ({
        src_eid: r.srcEid,
        dst_eid: r.dstEid,
        rel_type: r.relType,
        quote: r.quote,
      })),
    });
  }

  async deletePageEvidence(bvid: string, pageIndex: number): Promise<number> {
    const res = await this.rpc.call("DeletePageEvidence", { bvid, page_index: pageIndex });
    return num(res.deleted);
  }

  async deleteVideo(bvid: string): Promise<DeleteVideoStats> {
    const res = await this.rpc.call("DeleteVideo", { bvid });
    return { entitiesRemoved: num(res.entities_removed), videosRemoved: num(res.videos_removed) };
  }

  async clearAll(): Promise<void> {
    await this.rpc.call("ClearAll", {});
  }

  // ── graph reads ──────────────────────────────────────────────────────

  async neighbors(eids: string[], excludeEids: string[], limit: number): Promise<NeighborRow[]> {
    if (eids.length === 0) return [];
    const res = await this.rpc.call("Neighbors", { eids, exclude_eids: excludeEids, limit });
    return arr(res.rows).map((r) => ({
      eid: str(r.eid),
      name: str(r.name),
      type: str(r.type),
      description: str(r.description),
      relType: str(r.rel_type),
      fromEid: str(r.from_eid),
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
      pageIndex: num(r.page_index),
      quote: str(r.quote),
      pageTitle: str(r.page_title),
    }));
  }

  async relationsAmong(eids: string[]): Promise<RelationRow[]> {
    if (eids.length < 2) return [];
    const res = await this.rpc.call("RelationsAmong", { eids });
    return arr(res.rows).map((r) => ({
      srcEid: str(r.src_eid),
      srcName: str(r.src_name),
      relType: str(r.rel_type),
      dstEid: str(r.dst_eid),
      dstName: str(r.dst_name),
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
      evidenceSample: arr(r.evidence_sample).map((s) => ({
        bvid: str(s.bvid),
        pageIndex: num(s.page_index),
        quote: str(s.quote),
      })),
    }));
  }

  async entityAppearances(eid: string, bvids: string[], limit: number): Promise<AppearanceRow[]> {
    const res = await this.rpc.call("EntityAppearances", { eid, bvids, limit });
    return arr(res.rows).map((r) => ({
      bvid: str(r.bvid),
      pageIndex: num(r.page_index),
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
      srcEid: str(r.src_eid),
      dstEid: str(r.dst_eid),
      relType: str(r.rel_type),
    }));
  }

  async stats(): Promise<GraphStats> {
    const res = await this.rpc.call("Stats", {});
    return {
      entities: num(res.entities),
      relations: num(res.relations),
      evidence: num(res.evidence),
      videos: num(res.videos),
      pendingPages: num(res.pending_pages),
    };
  }
}
