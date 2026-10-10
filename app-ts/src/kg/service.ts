import { randomUUID } from "node:crypto";
import { config } from "../config/index.js";
import { createLogger } from "../logger.js";
import type { KgBuildRecord, KgBuildResult } from "./types.js";
import type { KgGraphRepository } from "../repository/kg-graph.js";
import type { KgSourceStore } from "../repository/kg-sources.js";
import type { KgBuildRepository } from "../repository/kg-builds.js";
import type { KgExtractor } from "./extractor.js";
import { resolveExtraction } from "./resolver.js";
import type { KgEntityIndex } from "../repository/kg-entity-index.js";
import type { EmbeddingsClient } from "../llm/embeddings.js";

const log = createLogger("KG");

/**
 * KgService — build orchestration + stats + visualization subgraph, port of
 * app/services/kg/service.py (the build/query facade).
 *
 * Pipeline: POST /knowledge/kg/build → scope resolve (via app-kg) → task
 * record persisted `processing` synchronously → background run: select
 * pending pages (MySQL kg bookkeeping) → concurrent per-page extraction with
 * failure isolation (a failed page is retryable, never aborts the batch) →
 * per-page: idempotency check → ASR text → delete-before-write → LLM extract
 * → resolver → graph writes → entity-vector upsert (best-effort) → done.
 *
 * The returned `completion` promise settles when the whole run settles
 * (never rejects) — the test seam, mirroring CloudDocumentService.
 * Deviation from Python: the single-active guard is per-uid (Mongo-backed)
 * instead of one global in-process task — matches the per-uid status view.
 */

export interface SubgraphNode {
  eid: string;
  name: string;
  type: string;
  description: string;
  degree: number;
}

export interface SubgraphEdge {
  src: string;
  dst: string;
  relType: string;
}

export interface SubgraphResult {
  available: boolean;
  center: string | null;
  nodes: SubgraphNode[];
  edges: SubgraphEdge[];
}

export interface KgServiceDeps {
  graph: KgGraphRepository;
  extractor: KgExtractor;
  sources: KgSourceStore;
  builds: KgBuildRepository;
  /** entity index may be absent (Milvus down) — vectors become best-effort */
  index: KgEntityIndex | null;
  embeddings: EmbeddingsClient;
}

/** Typed error the HTTP layer maps to a status code (service must not import http/). */
export class KgServiceError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface BuildStartResult {
  taskId: string;
  reused: boolean;
  /** resolves when this new run settles (done/failed); never rejects.
   * Absent when an active task was reused. */
  completion?: Promise<void>;
}

export class KgService {
  constructor(private readonly deps: KgServiceDeps) {}

  /** Neo4j reachable (checked through the graph store's stats round-trip). */
  async isAvailable(): Promise<boolean> {
    try {
      await this.deps.graph.stats();
      return true;
    } catch {
      return false;
    }
  }

  /** Trigger a build for the user's folders. Reuses the active task when one
   * is still running. Throws KgServiceError(503/404) on unavailable/empty scope. */
  async startBuild(uid: string, folderIds: number[] | undefined): Promise<BuildStartResult> {
    if (!(await this.isAvailable())) {
      throw new KgServiceError(503, "知识图谱存储不可用（Neo4j 未连接）");
    }
    const active = await this.deps.builds.findActive(uid);
    if (active) {
      return { taskId: active.taskId, reused: true };
    }
    const bvids = await this.deps.graph.resolveScope(uid, folderIds ?? []);
    if (bvids.length === 0) {
      throw new KgServiceError(404, "未找到已同步的收藏夹视频，请先执行收藏夹同步");
    }

    const now = Date.now();
    const record: KgBuildRecord = {
      taskId: randomUUID(),
      uid,
      folderIds: folderIds ?? [],
      bvidCount: bvids.length,
      status: "processing",
      progress: 0,
      currentStep: "init",
      steps: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.builds.save(record);
    const completion = this.run(record, bvids);
    log.info(`[KG] build started task_id=${record.taskId} uid=${uid} bvids=${bvids.length}`);
    return { taskId: record.taskId, reused: false, completion };
  }

  get(taskId: string, uid: string): Promise<KgBuildRecord | undefined> {
    return this.deps.builds.get(taskId, uid);
  }

  active(uid: string): Promise<KgBuildRecord | undefined> {
    return this.deps.builds.findActive(uid);
  }

  /** Background run: per-page concurrency + failure isolation + progress.
   * Never throws — the completion promise exists so tests can await it. */
  private async run(record: KgBuildRecord, bvids: string[]): Promise<void> {
    const save = async (patch: Partial<KgBuildRecord>): Promise<void> => {
      await this.deps.builds
        .save({ ...record, ...patch, updatedAt: Date.now() })
        .catch((err) => log.error(`[KG] failed to persist build state: ${err instanceof Error ? err.message : err}`));
    };
    try {
      const pages = await this.deps.graph.selectPendingPages(bvids, config.kg.pageBatchSize);
      const total = pages.length;
      log.info(`[KG] pending pages=${total} task_id=${record.taskId}`);
      if (total === 0) {
        record.status = "done";
        record.result = { total: 0, message: "所有分P已是最新" };
        await save({ status: record.status, result: record.result });
        return;
      }

      let ok = 0;
      let failed = 0;
      const sem = new Semaphore(Math.max(config.kg.concurrency, 1));

      await Promise.all(
        pages.map((page) =>
          sem.acquire(async () => {
            try {
              await this.processPage(page.bvid, page.cid, page.pageIndex, page.pageTitle, page.version);
              ok += 1;
            } catch (err) {
              failed += 1;
              log.error(`[KG] page failed bvid=${page.bvid} p${page.pageIndex}: ${err instanceof Error ? err.message : err}`);
            } finally {
              const done = ok + failed;
              const progress = Math.floor((done * 100) / total);
              const currentStep = `extract:${page.bvid}:p${page.pageIndex}`;
              record.progress = progress;
              record.currentStep = currentStep;
              record.steps = [...record.steps, { name: currentStep, status: "done", progress, at: Date.now() }];
              await save({ progress, currentStep, steps: record.steps });
            }
          }),
        ),
      );

      record.status = "done";
      const result: KgBuildResult = { total, ok, failed };
      record.result = result;
      await save({ status: "done", result });
      log.info(`[KG] build done task_id=${record.taskId} ok=${ok} failed=${failed}`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error(`[KG] build failed task_id=${record.taskId}: ${error}`);
      record.status = "failed";
      record.error = error;
      await save({ status: "failed", error });
    }
  }

  /** Per-page idempotent pipeline (process_page Phase 1–7). Throws on
   * failure after marking the page failed — the batch keeps going. */
  async processPage(
    bvid: string,
    cid: number,
    pageIndex: number,
    pageTitleArg: string | undefined,
    expectedVersion: number | undefined,
  ): Promise<{ entities: number; relations: number; droppedRelations: number }> {
    // Phase 1: idempotency check + mark processing
    const begin = await this.deps.graph.beginPage(bvid, cid, expectedVersion);
    if (!begin.found) throw new Error(`Video not found: bvid=${bvid}, cid=${cid}`);
    if (!begin.asrDone) throw new Error(`ASR not done yet: bvid=${bvid}, cid=${cid}`);
    if (begin.skip) return { entities: 0, relations: 0, droppedRelations: 0 };

    try {
      // Phase 2: read transcript
      const doc = await this.deps.sources.getLatest(bvid, cid);
      const text = doc?.content ?? "";
      if (!text) throw new Error(`no ASR content in MongoDB: bvid=${bvid}, cid=${cid}`);
      const title = pageTitleArg || begin.pageTitle || `P${pageIndex + 1}`;

      // Phase 3: delete-before-write
      await this.deps.graph.deletePageEvidence(bvid, pageIndex);

      // Phase 4: extract + validate
      const raw = await this.deps.extractor.extract(text, title);
      const resolved = resolveExtraction(raw);
      if (resolved.entities.length === 0) {
        log.info(`[KG] no entities extracted bvid=${bvid} p${pageIndex}`);
      }

      // Phase 5: graph writes
      if (resolved.entities.length > 0) {
        await this.deps.graph.upsertEntities(resolved.entities);
        await this.deps.graph.linkAppearances(
          bvid,
          pageIndex,
          resolved.entities.map((ent) => ({ eid: ent.eid, quote: ent.quote })),
        );
      }
      if (resolved.relations.length > 0) {
        await this.deps.graph.upsertRelations(resolved.relations);
      }

      // Phase 6: entity vectors (best-effort; Milvus failure does not roll back the graph)
      if (resolved.entities.length > 0 && this.deps.index && this.deps.index.available) {
        try {
          await this.deps.index.upsert(resolved.entities, this.deps.embeddings);
        } catch (err) {
          log.warn(`[KG] entity index upsert failed: ${err instanceof Error ? err.message : err}`);
        }
      }

      // Phase 7: confirm done
      await this.deps.graph.markPageDone(bvid, cid, begin.contentVersion);

      log.info(`[KG] page done bvid=${bvid} p${pageIndex} entities=${resolved.entities.length} relations=${resolved.relations.length}`);
      return {
        entities: resolved.entities.length,
        relations: resolved.relations.length,
        droppedRelations: resolved.droppedRelations,
      };
    } catch (err) {
      // failure path: mark failed (retryable) — does not affect other pages
      try {
        await this.deps.graph.markPageFailed(bvid, cid);
      } catch (dbErr) {
        log.error(`[KG] failed to mark failed status: ${dbErr instanceof Error ? dbErr.message : dbErr}`);
      }
      throw err;
    }
  }

  /** Cascade-delete a video's graph data (best-effort companion of KB deletion). */
  async deleteVideoData(bvid: string): Promise<void> {
    await this.deps.graph.deleteVideo(bvid);
  }

  /** Graph stats: Neo4j counts + entity-vector count + pending pages. */
  async stats(): Promise<{
    available: boolean;
    graph: { entities: number; relations: number; evidence: number; videos: number };
    entityVectors: number;
    pendingPages: number;
  }> {
    const empty = {
      available: false,
      graph: { entities: 0, relations: 0, evidence: 0, videos: 0 },
      entityVectors: 0,
      pendingPages: 0,
    };
    if (!(await this.isAvailable())) return empty;
    try {
      const graph = await this.deps.graph.stats();
      let entityVectors = 0;
      if (this.deps.index?.available) {
        entityVectors = await this.deps.index.count().catch(() => 0);
      }
      return {
        available: true,
        graph: { entities: graph.entities, relations: graph.relations, evidence: graph.evidence, videos: graph.videos },
        entityVectors,
        pendingPages: graph.pendingPages,
      };
    } catch (err) {
      log.warn(`[KG] stats failed: ${err instanceof Error ? err.message : err}`);
      return { ...empty, available: true };
    }
  }

  /** Visualization subgraph: overview (top entities + internal edges) or
   * BFS expansion from a center entity. Port of service.subgraph. */
  async subgraph(centerEid?: string, depth = 2, maxNodes = 80): Promise<SubgraphResult> {
    if (!(await this.isAvailable())) {
      return { available: false, center: null, nodes: [], edges: [] };
    }
    if (centerEid) return this.subgraphCentered(centerEid, depth, maxNodes);
    return this.subgraphOverview(maxNodes);
  }

  private async subgraphOverview(maxNodes: number): Promise<SubgraphResult> {
    const tops = await this.deps.graph.topEntities(maxNodes);
    if (tops.length === 0) return { available: true, center: null, nodes: [], edges: [] };
    const eids = tops.map((t) => t.eid);
    const rows = await this.deps.graph.edgesAmong(eids);
    const nodes: SubgraphNode[] = tops.map((t) => ({
      eid: t.eid,
      name: t.name,
      type: t.type || "other",
      description: t.description || "",
      degree: 0,
    }));
    const edges: SubgraphEdge[] = rows.map((r) => ({ src: r.srcEid, dst: r.dstEid, relType: r.relType || "关联" }));
    return finalizeSubgraph(null, nodes, edges);
  }

  private async subgraphCentered(centerEid: string, depth: number, maxNodes: number): Promise<SubgraphResult> {
    const base = await this.deps.graph.entitiesByEids([centerEid]);
    if (base.length === 0) return { available: true, center: null, nodes: [], edges: [] };

    const nodeInfo = new Map<string, SubgraphNode>([
      [
        centerEid,
        {
          eid: centerEid,
          name: base[0].name || "",
          type: base[0].type || "other",
          description: base[0].description || "",
          degree: 0,
        },
      ],
    ]);
    const edgeSet = new Set<string>();
    const visited = new Set([centerEid]);
    let frontier = [centerEid];

    for (let d = 0; d < Math.max(depth, 0); d += 1) {
      if (frontier.length === 0 || visited.size >= maxNodes) break;
      const rows = await this.deps.graph.neighbors(frontier, [...visited], maxNodes);
      const next: string[] = [];
      for (const r of rows) {
        const relType = r.relType || "关联";
        edgeSet.add([...[r.fromEid, r.eid].sort()].join("|") + `|${relType}`);
        if (!visited.has(r.eid) && visited.size < maxNodes) {
          visited.add(r.eid);
          nodeInfo.set(r.eid, {
            eid: r.eid,
            name: r.name || "",
            type: r.type || "other",
            description: r.description || "",
            degree: 0,
          });
          next.push(r.eid);
        }
      }
      frontier = next;
    }

    const edges: SubgraphEdge[] = [...edgeSet].map((key) => {
      const [a, b, relType] = key.split("|");
      return { src: a, dst: b, relType };
    });
    return finalizeSubgraph(centerEid, [...nodeInfo.values()], edges);
  }
}

/** Overwrite node degrees with in-subgraph connection counts (frontend node
 * sizing) and sort by degree desc. */
function finalizeSubgraph(
  center: string | null,
  nodes: SubgraphNode[],
  edges: SubgraphEdge[],
): SubgraphResult {
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.src, (degree.get(e.src) ?? 0) + 1);
    degree.set(e.dst, (degree.get(e.dst) ?? 0) + 1);
  }
  for (const n of nodes) n.degree = degree.get(n.eid) ?? 0;
  nodes.sort((a, b) => b.degree - a.degree);
  return { available: true, center, nodes, edges };
}

/** Counting semaphore for per-page concurrency (config.kg.concurrency). */
class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async acquire<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }
}
