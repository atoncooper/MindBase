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
 * In-memory KgGraphRepository: doubles as the test stub AND the degraded
 * fallback when the app-kg gRPC data face is unreachable at construction.
 * Implements the same Cypher-level semantics (merge keys, dedup, quote
 * sliding window, orphan cleanup) so tests exercise real logic.
 */

interface RelEdge {
  srcEid: string;
  dstEid: string;
  relType: string;
  weight: number;
  quotes: string[];
}

/** CloudDoc node (created/owned by the cloud route graph; merged here). */
interface CloudDocNode {
  uid: string;
  uploadUuid: string;
  title: string;
  contentHash: string;
}

export class MemoryKgGraphRepository implements KgGraphRepository {
  /** eid → entity */
  readonly entities = new Map<string, ResolvedEntity>();
  /** "src|dst|relType" → edge */
  readonly relations = new Map<string, RelEdge>();
  /** "bvid|pageIndex|eid" → quote */
  readonly appearances = new Map<string, { bvid: string; pageIndex: number; eid: string; quote: string }>();
  /** (bvid,cid) → kg bookkeeping */
  readonly pages = new Map<string, { bvid: string; cid: number; pageIndex: number; pageTitle: string; version: number; asrDone: boolean; kgStatus: string | null; kgVersion: number | null }>();
  /** `${uid}|${uploadUuid}` → CloudDoc node */
  readonly cloudDocs = new Map<string, CloudDocNode>();
  /** `${uid}|${uploadUuid}|${eid}` → evidence quote (APPEARS_IN → CloudDoc) */
  readonly cloudAppearances = new Map<string, { uid: string; uploadUuid: string; eid: string; quote: string }>();

  available = true;

  seedPage(page: { bvid: string; cid: number; pageIndex: number; pageTitle: string; version: number; asrDone?: boolean }): void {
    this.pages.set(`${page.bvid}|${page.cid}`, {
      ...page,
      asrDone: page.asrDone ?? true,
      kgStatus: null,
      kgVersion: null,
    });
  }

  async resolveScope(uid: string, folderIds: number[]): Promise<string[]> {
    if (!this.available) throw new Error("kg unavailable");
    void uid;
    void folderIds;
    return [...new Set([...this.pages.values()].map((p) => p.bvid))];
  }

  async selectPendingPages(bvids: string[], limit: number): Promise<PendingPage[]> {
    if (!this.available) throw new Error("kg unavailable");
    const out: PendingPage[] = [];
    for (const p of this.pages.values()) {
      if (!bvids.includes(p.bvid)) continue;
      if (!p.asrDone) continue;
      const stale = p.kgVersion === null || p.kgStatus === "failed" || p.kgVersion !== p.version;
      if (!stale) continue;
      out.push({ bvid: p.bvid, cid: p.cid, pageIndex: p.pageIndex, pageTitle: p.pageTitle, version: p.version });
      if (out.length >= limit) break;
    }
    return out;
  }

  async beginPage(bvid: string, cid: number, expectedVersion?: number): Promise<BeginPageResult> {
    if (!this.available) throw new Error("kg unavailable");
    const page = this.pages.get(`${bvid}|${cid}`);
    if (!page) {
      return { found: false, asrDone: false, skip: false, reason: "video page not found", contentVersion: 0, pageTitle: "", pageIndex: 0 };
    }
    const res: BeginPageResult = {
      found: true,
      asrDone: page.asrDone,
      skip: false,
      reason: "",
      contentVersion: expectedVersion ?? page.version,
      pageTitle: page.pageTitle,
      pageIndex: page.pageIndex,
    };
    if (!page.asrDone) {
      res.reason = "ASR not done yet";
      return res;
    }
    if (page.kgStatus === "done" && page.kgVersion === res.contentVersion && expectedVersion === undefined) {
      res.skip = true;
      res.reason = "up to date";
      return res;
    }
    page.kgStatus = "processing";
    return res;
  }

  async markPageDone(bvid: string, cid: number, contentVersion: number): Promise<void> {
    const page = this.pages.get(`${bvid}|${cid}`);
    if (page) {
      page.kgStatus = "done";
      page.kgVersion = contentVersion;
    }
  }

  async markPageFailed(bvid: string, cid: number): Promise<void> {
    const page = this.pages.get(`${bvid}|${cid}`);
    if (page) page.kgStatus = "failed";
  }

  async countPendingPages(): Promise<number> {
    let n = 0;
    for (const p of this.pages.values()) {
      if (p.asrDone && (p.kgVersion === null || p.kgStatus === "failed" || p.kgVersion !== p.version)) n += 1;
    }
    return n;
  }

  async upsertEntities(list: ResolvedEntity[]): Promise<string[]> {
    if (!this.available) throw new Error("kg unavailable");
    for (const e of list) {
      const existing = this.entities.get(e.nameLower);
      if (existing) {
        if (e.description) existing.description = e.description;
        existing.name = e.name;
      } else {
        this.entities.set(e.nameLower, e);
      }
    }
    return [...new Set(list.map((e) => e.eid))];
  }

  async linkAppearances(bvid: string, pageIndex: number, appearances: AppearanceInput[]): Promise<number> {
    if (!this.available) throw new Error("kg unavailable");
    let linked = 0;
    for (const a of appearances) {
      if (!a.eid) continue;
      this.appearances.set(`${bvid}|${pageIndex}|${a.eid}`, { bvid, pageIndex, eid: a.eid, quote: a.quote });
      linked += 1;
    }
    return linked;
  }

  async upsertRelations(relations: ResolvedRelation[]): Promise<void> {
    if (!this.available) throw new Error("kg unavailable");
    for (const r of relations) {
      const key = `${r.srcEid}|${r.dstEid}|${r.relType}`;
      const edge = this.relations.get(key);
      if (edge) {
        edge.weight += 1;
        if (r.quote && !edge.quotes.includes(r.quote)) {
          if (edge.quotes.length < 3) edge.quotes.push(r.quote);
          else edge.quotes = [...edge.quotes.slice(1), r.quote];
        }
      } else {
        this.relations.set(key, {
          srcEid: r.srcEid,
          dstEid: r.dstEid,
          relType: r.relType,
          weight: 1,
          quotes: r.quote ? [r.quote] : [],
        });
      }
    }
  }

  async deletePageEvidence(bvid: string, pageIndex: number): Promise<number> {
    if (!this.available) throw new Error("kg unavailable");
    let deleted = 0;
    for (const [key, a] of [...this.appearances.entries()]) {
      if (a.bvid === bvid && a.pageIndex === pageIndex) {
        this.appearances.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }

  async deleteVideo(bvid: string): Promise<DeleteVideoStats> {
    if (!this.available) throw new Error("kg unavailable");
    let videosRemoved = 0;
    for (const [key, a] of [...this.appearances.entries()]) {
      if (a.bvid === bvid) this.appearances.delete(key);
    }
    for (const key of [...this.pages.keys()]) {
      if (key.startsWith(`${bvid}|`)) {
        this.pages.delete(key);
        videosRemoved += 1;
      }
    }
    // orphan entity cleanup: no RELATES edge and no evidence left (video or cloud)
    const entitiesRemoved = this.cleanupOrphanEntities();
    return { entitiesRemoved, videosRemoved };
  }

  async clearAll(): Promise<void> {
    this.entities.clear();
    this.relations.clear();
    this.appearances.clear();
    // CloudDoc nodes belong to the cloud route graph (other labels untouched);
    // deleting the entities cascades their evidence edges away.
    this.cloudAppearances.clear();
  }

  /** Drop entities that no longer have a RELATES edge or any evidence (video/cloud). */
  private cleanupOrphanEntities(): number {
    let removed = 0;
    for (const [key, entity] of [...this.entities.entries()]) {
      const hasRel = [...this.relations.values()].some(
        (r) => r.srcEid === entity.eid || r.dstEid === entity.eid,
      );
      const hasVideoEvidence = [...this.appearances.values()].some((a) => a.eid === entity.eid);
      const hasCloudEvidence = [...this.cloudAppearances.values()].some((a) => a.eid === entity.eid);
      if (!hasRel && !hasVideoEvidence && !hasCloudEvidence) {
        this.entities.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  // ── cloud-drive knowledge points (same entity/relation space as videos) ──

  async linkCloudDocAppearances(input: CloudDocAppearanceInput): Promise<number> {
    if (!this.available) throw new Error("kg unavailable");
    const nodeKey = `${input.uid}|${input.uploadUuid}`;
    const node = this.cloudDocs.get(nodeKey) ?? {
      uid: input.uid,
      uploadUuid: input.uploadUuid,
      title: "",
      contentHash: "",
    };
    if (input.title) node.title = input.title;
    if (input.contentHash) node.contentHash = input.contentHash;
    this.cloudDocs.set(nodeKey, node);
    // delete-before-write (app-kg performs the same deletion server-side)
    for (const [key, a] of [...this.cloudAppearances.entries()]) {
      if (a.uid === input.uid && a.uploadUuid === input.uploadUuid) this.cloudAppearances.delete(key);
    }
    // same-doc same-entity dedup keeps the shortest non-empty quote
    const quotes = new Map<string, string>();
    for (const a of input.appearances) {
      if (!a.eid) continue;
      const quote = (a.quote ?? "").trim();
      const prev = quotes.get(a.eid);
      if (prev === undefined || (quote !== "" && (prev === "" || quote.length < prev.length))) {
        quotes.set(a.eid, quote);
      }
    }
    for (const [eid, quote] of quotes) {
      this.cloudAppearances.set(`${input.uid}|${input.uploadUuid}|${eid}`, {
        uid: input.uid,
        uploadUuid: input.uploadUuid,
        eid,
        quote,
      });
    }
    return quotes.size;
  }

  async deleteCloudDocAppearances(uid: string, uploadUuid: string): Promise<DeleteCloudDocStats> {
    if (!this.available) throw new Error("kg unavailable");
    let deleted = 0;
    for (const [key, a] of [...this.cloudAppearances.entries()]) {
      if (a.uid === uid && a.uploadUuid === uploadUuid) {
        this.cloudAppearances.delete(key);
        deleted += 1;
      }
    }
    const entitiesRemoved = this.cleanupOrphanEntities();
    return { deleted, entitiesRemoved };
  }

  async fetchCloudDocEvidence(
    eids: string[],
    uid: string,
    uploadUuids: string[],
    limit: number,
  ): Promise<CloudDocEvidenceRow[]> {
    if (!this.available) throw new Error("kg unavailable");
    if (eids.length === 0 || !uid) return [];
    const out: CloudDocEvidenceRow[] = [];
    for (const a of this.cloudAppearances.values()) {
      if (a.uid !== uid) continue;
      if (!eids.includes(a.eid)) continue;
      if (uploadUuids.length > 0 && !uploadUuids.includes(a.uploadUuid)) continue;
      const entity = [...this.entities.values()].find((e) => e.eid === a.eid);
      const node = this.cloudDocs.get(`${a.uid}|${a.uploadUuid}`);
      out.push({
        eid: a.eid,
        name: entity?.name ?? "",
        type: entity?.type ?? "other",
        uploadUuid: a.uploadUuid,
        quote: a.quote,
        title: node?.title ?? "",
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  async neighbors(eids: string[], excludeEids: string[], limit: number): Promise<NeighborRow[]> {
    if (!this.available) throw new Error("kg unavailable");
    const out = new Map<string, NeighborRow>();
    for (const edge of this.relations.values()) {
      const forward = eids.includes(edge.srcEid);
      const backward = eids.includes(edge.dstEid);
      if (!forward && !backward) continue;
      const neighborEid = forward ? edge.dstEid : edge.srcEid;
      if (neighborEid === (forward ? edge.srcEid : edge.dstEid)) continue;
      if (excludeEids.includes(neighborEid)) continue;
      if (out.has(neighborEid)) continue;
      const entity = [...this.entities.values()].find((e) => e.eid === neighborEid);
      out.set(neighborEid, {
        eid: neighborEid,
        name: entity?.name ?? "",
        type: entity?.type ?? "other",
        description: entity?.description ?? "",
        relType: edge.relType,
        fromEid: forward ? edge.srcEid : edge.dstEid,
      });
      if (out.size >= limit) break;
    }
    return [...out.values()];
  }

  async fetchEvidence(eids: string[], bvids: string[], limit: number): Promise<EvidenceRow[]> {
    if (!this.available) throw new Error("kg unavailable");
    const out: EvidenceRow[] = [];
    for (const a of this.appearances.values()) {
      if (!eids.includes(a.eid)) continue;
      if (bvids.length > 0 && !bvids.includes(a.bvid)) continue;
      const entity = [...this.entities.values()].find((e) => e.eid === a.eid);
      const page = [...this.pages.values()].find((p) => p.bvid === a.bvid && p.pageIndex === a.pageIndex);
      out.push({
        eid: a.eid,
        name: entity?.name ?? "",
        type: entity?.type ?? "other",
        bvid: a.bvid,
        pageIndex: a.pageIndex,
        quote: a.quote,
        pageTitle: page?.pageTitle || `P${a.pageIndex + 1}`,
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  async relationsAmong(eids: string[]): Promise<RelationRow[]> {
    if (!this.available) throw new Error("kg unavailable");
    const nameOf = (eid: string) => [...this.entities.values()].find((e) => e.eid === eid)?.name ?? "";
    const out: RelationRow[] = [];
    for (const r of this.relations.values()) {
      if (!eids.includes(r.srcEid) || !eids.includes(r.dstEid)) continue;
      out.push({
        srcEid: r.srcEid,
        srcName: nameOf(r.srcEid),
        relType: r.relType,
        dstEid: r.dstEid,
        dstName: nameOf(r.dstEid),
        weight: r.weight,
        quotes: [...r.quotes],
      });
    }
    return out;
  }

  async entitiesByEids(eids: string[]): Promise<EntityDetail[]> {
    if (!this.available) throw new Error("kg unavailable");
    return [...this.entities.values()]
      .filter((e) => eids.includes(e.eid))
      .map((e) => ({ eid: e.eid, name: e.name, type: e.type, description: e.description, aliases: [] }));
  }

  async entityExposure(bvids: string[], limit: number): Promise<ExposureRow[]> {
    if (!this.available) throw new Error("kg unavailable");
    if (bvids.length === 0) return [];
    const byEid = new Map<string, { pages: number; samples: { bvid: string; pageIndex: number; quote: string }[] }>();
    for (const a of this.appearances.values()) {
      if (!bvids.includes(a.bvid)) continue;
      const entry = byEid.get(a.eid) ?? { pages: 0, samples: [] };
      entry.pages += 1;
      if (entry.samples.length < 5) entry.samples.push({ bvid: a.bvid, pageIndex: a.pageIndex, quote: a.quote });
      byEid.set(a.eid, entry);
    }
    const rows: ExposureRow[] = [];
    for (const [eid, agg] of byEid) {
      const entity = [...this.entities.values()].find((e) => e.eid === eid);
      rows.push({
        eid,
        name: entity?.name ?? "",
        type: entity?.type ?? "other",
        description: entity?.description ?? "",
        pages: agg.pages,
        evidenceSample: agg.samples,
      });
    }
    rows.sort((a, b) => b.pages - a.pages);
    return rows.slice(0, limit);
  }

  async entityAppearances(eid: string, bvids: string[], limit: number): Promise<AppearanceRow[]> {
    if (!this.available) throw new Error("kg unavailable");
    const out: AppearanceRow[] = [];
    for (const a of [...this.appearances.values()].sort((x, y) => x.bvid.localeCompare(y.bvid) || x.pageIndex - y.pageIndex)) {
      if (a.eid !== eid) continue;
      if (bvids.length > 0 && !bvids.includes(a.bvid)) continue;
      out.push({ bvid: a.bvid, pageIndex: a.pageIndex, quote: a.quote });
      if (out.length >= limit) break;
    }
    return out;
  }

  async topEntities(limit: number): Promise<TopEntityRow[]> {
    if (!this.available) throw new Error("kg unavailable");
    const degree = new Map<string, number>();
    for (const r of this.relations.values()) {
      degree.set(r.srcEid, (degree.get(r.srcEid) ?? 0) + 1);
      degree.set(r.dstEid, (degree.get(r.dstEid) ?? 0) + 1);
    }
    const rows: TopEntityRow[] = [];
    for (const [eid, deg] of degree) {
      const entity = [...this.entities.values()].find((e) => e.eid === eid);
      rows.push({ eid, name: entity?.name ?? "", type: entity?.type ?? "other", description: entity?.description ?? "", degree: deg });
    }
    rows.sort((a, b) => b.degree - a.degree);
    return rows.slice(0, limit);
  }

  async edgesAmong(eids: string[]): Promise<EdgeRow[]> {
    if (!this.available) throw new Error("kg unavailable");
    const out: EdgeRow[] = [];
    for (const r of this.relations.values()) {
      if (eids.includes(r.srcEid) && eids.includes(r.dstEid)) {
        out.push({ srcEid: r.srcEid, dstEid: r.dstEid, relType: r.relType });
      }
    }
    return out;
  }

  async stats(): Promise<GraphStats> {
    if (!this.available) throw new Error("kg unavailable");
    return {
      entities: this.entities.size,
      relations: this.relations.size,
      evidence: this.appearances.size,
      videos: new Set([...this.pages.values()].map((p) => p.bvid)).size,
      pendingPages: await this.countPendingPages(),
      // parity with app-kg: cloud_docs counts documents that HAVE knowledge
      // evidence (a linked doc with zero entities does not count).
      cloudDocs: new Set([...this.cloudAppearances.values()].map((a) => `${a.uid}|${a.uploadUuid}`)).size,
      cloudEvidence: this.cloudAppearances.size,
    };
  }

  async close(): Promise<void> {}
}
