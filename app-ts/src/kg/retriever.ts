import { config } from "../config/index.js";
import { createLogger } from "../logger.js";
import type { Source } from "../context/types.js";
import type { KgEntityIndex, EntityHit } from "../repository/kg-entity-index.js";
import type { EmbeddingsClient } from "../llm/embeddings.js";
import type { KgGraphRepository } from "../repository/kg-graph.js";
import type { EvidenceRow, RelationRow } from "./types.js";

const log = createLogger("KG_RETRIEVER");

/**
 * KgRetriever — query-time KG retrieval, port of app/services/kg/retriever.py:
 * query → entity linking (Milvus, seedTopN, score ≥ linkScoreThreshold) →
 * BFS subgraph expansion over RELATES edges (≤ maxHops) → APPEARS_IN evidence
 * pull (user bvid scope) → entity-card content + vector_search-isomorphic
 * sources for the SSE protocol.
 *
 * All dependency failures degrade to an empty result — the tool never throws.
 */

export interface KgRetrievalResult {
  content: string;
  sources: Source[];
  entityCount: number;
  evidenceCount: number;
}

export interface KgRetrieverDeps {
  graph: KgGraphRepository;
  /** null when Milvus is unavailable — semantic linking degrades to "no seeds" */
  index: KgEntityIndex | null;
  embeddings: EmbeddingsClient;
}

const EMPTY: KgRetrievalResult = { content: "", sources: [], entityCount: 0, evidenceCount: 0 };

export class KgRetriever {
  constructor(private readonly deps: KgRetrieverDeps) {}

  /** Graph store reachable AND entity index constructible (Python parity). */
  isAvailable(): boolean {
    return this.deps.index !== null && this.deps.index.available;
  }

  async retrieve(query: string, bvids: string[] | undefined, k = 8): Promise<KgRetrievalResult> {
    const { graph, index, embeddings } = this.deps;
    if (!index || !index.available) return EMPTY;

    // ── 1. entity linking ──
    let seeds: EntityHit[];
    try {
      seeds = await index.search(query, config.kg.seedTopN, embeddings);
    } catch (err) {
      log.error(`[KG_RETRIEVER] entity linking failed: ${err instanceof Error ? err.message : err}`);
      return EMPTY;
    }
    const threshold = config.kg.linkScoreThreshold;
    seeds = seeds.filter((s) => s.score >= threshold);
    if (seeds.length === 0) {
      log.info(`[KG_RETRIEVER] no linked entities above threshold=${threshold} query='${query.slice(0, 50)}'`);
      return EMPTY;
    }

    const seedScores = new Map(seeds.map((s) => [s.eid, s.score]));
    const seedEids = seeds.map((s) => s.eid);

    try {
      // ── 2. BFS subgraph expansion ──
      const visited = new Set(seedEids);
      let frontier = [...seedEids];
      for (let hop = 0; hop < Math.max(config.kg.maxHops, 0); hop += 1) {
        if (frontier.length === 0) break;
        const rows = await graph.neighbors(frontier, [...visited], config.kg.expandLimitPerHop);
        const newIds = rows.map((r) => r.eid).filter((eid) => !visited.has(eid));
        for (const id of newIds) visited.add(id);
        frontier = newIds;
      }
      const allEids = [...visited];

      // ── 3. evidence + relations + entity details ──
      const evidence = await graph.fetchEvidence(allEids, bvids ?? [], config.kg.evidenceLimit);
      const relations = await graph.relationsAmong(allEids);
      const entities = await graph.entitiesByEids(allEids);
      if (evidence.length === 0 && relations.length === 0) return EMPTY;

      const content = formatContent({
        entities,
        relations,
        evidence,
        seedNames: seeds.map((s) => s.name),
        limit: k,
      });
      const sources = buildSources(evidence, seedScores);
      log.info(
        `[KG_RETRIEVER] done query='${query.slice(0, 50)}' entities=${entities.length} evidence=${evidence.length} sources=${sources.length}`,
      );
      return { content, sources, entityCount: entities.length, evidenceCount: evidence.length };
    } catch (err) {
      log.error(`[KG_RETRIEVER] graph traversal failed: ${err instanceof Error ? err.message : err}`);
      return EMPTY;
    }
  }
}

/** Entity-card text the LLM reads (Python _format_content parity: entities
 * with evidence first, ≤5 relations and ≤5 quotes each). */
function formatContent(args: {
  entities: Array<{ eid: string; name: string; type: string; description: string }>;
  relations: RelationRow[];
  evidence: EvidenceRow[];
  seedNames: string[];
  limit: number;
}): string {
  const relBySrc = new Map<string, RelationRow[]>();
  for (const rel of args.relations) {
    relBySrc.set(rel.srcEid, [...(relBySrc.get(rel.srcEid) ?? []), rel]);
  }
  const evByEid = new Map<string, EvidenceRow[]>();
  for (const ev of args.evidence) {
    evByEid.set(ev.eid, [...(evByEid.get(ev.eid) ?? []), ev]);
  }

  const withEvidence = args.entities.filter((e) => evByEid.has(e.eid));
  const withoutEvidence = args.entities.filter((e) => !evByEid.has(e.eid));
  const ordered = [...withEvidence, ...withoutEvidence];

  const parts: string[] = [`知识图谱检索结果（核心实体：${args.seedNames.slice(0, 3).join("、")}）`];
  let shown = 0;
  for (const ent of ordered) {
    if (shown >= args.limit) break;
    const lines = [`\n## ${ent.name}（${ent.type}）`];
    if (ent.description) lines.push(`描述：${ent.description}`);

    const rels = relBySrc.get(ent.eid) ?? [];
    if (rels.length > 0) {
      const relStrs = rels.slice(0, 5).map((r) => `${r.srcName} --${r.relType}--> ${r.dstName}`);
      lines.push(`关系：${relStrs.join("；")}`);
    }

    for (const ev of (evByEid.get(ent.eid) ?? []).slice(0, 5)) {
      const title = ev.pageTitle || ev.bvid;
      const quote = (ev.quote ?? "").trim();
      lines.push(quote ? `出处：【${title}】"${quote}"` : `出处：【${title}】`);
    }
    parts.push(lines.join("\n"));
    shown += 1;
  }

  if (args.evidence.length === 0) {
    parts.push("\n（注意：以下实体在你的当前范围内暂无视频出处证据）");
  }
  return parts.join("\n\n");
}

/** Sources deduped by bvid — same field shape as vector_search output. */
function buildSources(evidence: EvidenceRow[], seedScores: Map<string, number>): Source[] {
  const seen = new Set<string>();
  const sources: Source[] = [];
  for (const ev of evidence) {
    if (!ev.bvid || seen.has(ev.bvid)) continue;
    seen.add(ev.bvid);
    sources.push({
      bvid: ev.bvid,
      title: ev.pageTitle || ev.bvid,
      url: `https://www.bilibili.com/video/${ev.bvid}`,
      score: Math.round((seedScores.get(ev.eid) ?? 0) * 10000) / 10000,
      pageIndex: ev.pageIndex,
    });
  }
  return sources;
}
