import { config } from "../config/index.js";
import { createLogger } from "../logger.js";
import type { KgGraphRepository } from "../repository/kg-graph.js";
import type { KgEntityIndex } from "../repository/kg-entity-index.js";
import type { EmbeddingsClient } from "../llm/embeddings.js";
import type { AppBiliClient } from "./app-bili-client.js";
import type { AppQuizClient } from "./app-quiz-client.js";
import type { QuizGenerationService } from "./quiz-generation.js";
import { normalizeName } from "../kg/resolver.js";
import type { ExposureRow } from "../kg/types.js";

const log = createLogger("BLINDSPOT");

/**
 * Knowledge blind-spot map — port of the Python BlindspotService
 * (scoring/attribution). Data sources:
 *   - scope bvids: the app-bili knowledge scope (folder → video tree)
 *   - entity exposure + appearances: Neo4j via app-kg gRPC
 *   - quiz signals: app-quiz internal face (submissions/answers + Mongo
 *     attributions), vector-attribution fallback via the kg entity index
 *   - probed names: the user's recent chat texts (injected provider)
 * Pure classification math lives in scoreEntity; everything else is assembly.
 */

const FAMILIAR_RATE_THRESHOLD = 0.7;
const BLIND_MIN_EXPOSURE = 2;
const ATTRIBUTION_SCORE_THRESHOLD = 0.75;
const EXPOSURE_LIMIT = 500;
const EVIDENCE_SAMPLE_LIMIT = 5;
const APPEARANCES_LIMIT = 50;

export type Quadrant = "danger" | "blind" | "learning" | "familiar" | "unexplored";

export interface BlindspotEntity {
  eid: string;
  name: string;
  type: string;
  description: string;
  exposure: number;
  evidence_sample: Array<{ bvid: string; page_index: number; quote: string }>;
  quiz_total: number;
  quiz_correct: number;
  quiz_wrong: number;
  probed: boolean;
  priority: number;
}

export interface BlindspotMapResult {
  available: boolean;
  scope_bvids: number;
  quadrants: Record<Quadrant, BlindspotEntity[]>;
  stats: { total_entities: number } & Record<Quadrant, number>;
}

export interface QuizSignal {
  question_uuid: string;
  is_correct: boolean;
  question_text: string;
  related_entities: string[];
}

export class BlindspotError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Pure quadrant classification (port of scoring.classify). */
export function classify(entity: {
  exposure: number;
  quiz_total: number;
  quiz_correct: number;
  probed: boolean;
}): Quadrant {
  if (entity.quiz_total > 0) {
    const rate = entity.quiz_total > 0 ? entity.quiz_correct / entity.quiz_total : 0;
    return rate >= FAMILIAR_RATE_THRESHOLD ? "familiar" : "danger";
  }
  if (entity.probed) return "learning";
  if (entity.exposure >= BLIND_MIN_EXPOSURE) return "blind";
  return "unexplored";
}

function priorityOf(entity: { exposure: number; quiz_correct: number; quiz_wrong: number }): number {
  return Math.max(0, entity.exposure + 3 * entity.quiz_wrong - entity.quiz_correct);
}

export interface BlindspotDeps {
  graph: KgGraphRepository;
  index?: KgEntityIndex | null;
  embeddings: EmbeddingsClient;
  appBili: AppBiliClient;
  appQuiz: AppQuizClient;
  quizGen: QuizGenerationService;
  /** recent user chat texts (probed-name signal); memory fallback = empty */
  recentUserTexts: (uid: string, limit: number) => Promise<string[]>;
}

export class BlindspotService {
  constructor(private readonly deps: BlindspotDeps) {}

  async map(uid: string, folderIds: number[]): Promise<BlindspotMapResult> {
    const empty = (): BlindspotMapResult => ({
      available: false,
      scope_bvids: 0,
      quadrants: { danger: [], blind: [], learning: [], familiar: [], unexplored: [] },
      stats: { total_entities: 0, danger: 0, blind: 0, learning: 0, familiar: 0, unexplored: 0 },
    });

    const folders = await this.deps.appBili.scope(uid);
    const selected = folderIds.length > 0 ? folders.filter((f) => folderIds.includes(f.media_id)) : folders;
    const bvids = [...new Set(selected.flatMap((f) => f.videos.map((v) => v.bvid)))].filter(Boolean);
    if (bvids.length === 0) return empty();

    let exposures: ExposureRow[];
    try {
      exposures = await this.deps.graph.entityExposure(bvids, EXPOSURE_LIMIT);
    } catch (err) {
      log.warn(`exposure read failed uid=${uid}: ${err instanceof Error ? err.message : err}`);
      return empty();
    }
    if (exposures.length === 0) return { ...empty(), available: true, scope_bvids: bvids.length };

    const [signals, probedNames] = await Promise.all([
      this.quizSignals(uid),
      this.deps.recentUserTexts(uid, 300).then((texts) => new Set(normalizeName(texts.join(" ")))),
    ]);

    const quadrants: Record<Quadrant, BlindspotEntity[]> = {
      danger: [], blind: [], learning: [], familiar: [], unexplored: [],
    };
    for (const row of exposures) {
      const signal = signals.get(normalizeName(row.name)) ?? { total: 0, correct: 0, wrong: 0 };
      const entity: BlindspotEntity = {
        eid: row.eid,
        name: row.name,
        type: row.type,
        description: row.description,
        exposure: Number(row.pages) || 0,
        evidence_sample: (row.evidenceSample ?? []).slice(0, EVIDENCE_SAMPLE_LIMIT).map((e) => ({
          bvid: e.bvid,
          page_index: Number(e.pageIndex) || 0,
          quote: e.quote,
        })),
        quiz_total: signal.total,
        quiz_correct: signal.correct,
        quiz_wrong: signal.wrong,
        probed: probedNames.has(normalizeName(row.name)),
        priority: priorityOf({
          exposure: Number(row.pages) || 0,
          quiz_correct: signal.correct,
          quiz_wrong: signal.wrong,
        }),
      };
      quadrants[classify(entity)].push(entity);
    }
    for (const list of Object.values(quadrants)) {
      list.sort((a, b) => b.priority - a.priority || b.exposure - a.exposure || a.name.localeCompare(b.name));
    }
    const stats = {
      total_entities: exposures.length,
      danger: quadrants.danger.length,
      blind: quadrants.blind.length,
      learning: quadrants.learning.length,
      familiar: quadrants.familiar.length,
      unexplored: quadrants.unexplored.length,
    };
    return { available: true, scope_bvids: bvids.length, quadrants, stats };
  }

  async entityDetail(uid: string, eid: string): Promise<Record<string, unknown> | null> {
    const base = await this.deps.graph.entitiesByEids([eid]);
    if (base.length === 0) return null;
    const folders = await this.deps.appBili.scope(uid);
    const bvids = [...new Set(folders.flatMap((f) => f.videos.map((v) => v.bvid)))];
    const appearances = await this.deps.graph.entityAppearances(eid, bvids, APPEARANCES_LIMIT);

    // page titles from the scope tree
    const titleByKey = new Map<string, string>();
    for (const folder of folders) {
      for (const video of folder.videos) {
        for (const page of video.pages) {
          titleByKey.set(`${video.bvid}:${page.page_index}`, page.page_title || `P${page.page_index + 1}`);
        }
      }
    }
    const review_path = appearances.map((a) => ({
      bvid: a.bvid,
      page_index: Number(a.pageIndex) || 0,
      quote: a.quote,
      title: titleByKey.get(`${a.bvid}:${Number(a.pageIndex) || 0}`) || "",
    }));
    const signals = await this.quizSignals(uid);
    const signal = signals.get(normalizeName(base[0].name)) ?? { total: 0, correct: 0, wrong: 0 };
    return {
      eid: base[0].eid,
      name: base[0].name,
      type: base[0].type,
      description: base[0].description,
      exposure: review_path.length,
      review_path,
      quiz_total: signal.total,
      quiz_correct: signal.correct,
      quiz_wrong: signal.wrong,
    };
  }

  async startEntityQuiz(
    uid: string,
    eid: string,
    opts: { questionCount: number; difficulty: string },
  ): Promise<{ quiz_uuid: string; status: string; title: string }> {
    const base = await this.deps.graph.entitiesByEids([eid]);
    if (base.length === 0) {
      throw new BlindspotError(404, "实体不存在或图谱不可用");
    }
    const entityName = base[0].name;
    const folders = await this.deps.appBili.scope(uid);
    const bvids = [...new Set(folders.flatMap((f) => f.videos.map((v) => v.bvid)))];
    const appearances = await this.deps.graph.entityAppearances(eid, bvids, 100);

    // appearances → pages with ASR done (is_processed from the scope tree)
    const processedByKey = new Map<string, { cid: number; page_title: string }>();
    for (const folder of folders) {
      for (const video of folder.videos) {
        for (const page of video.pages) {
          if (page.is_processed) {
            processedByKey.set(`${video.bvid}:${page.page_index}`, {
              cid: page.cid,
              page_title: page.page_title || `P${page.page_index + 1}`,
            });
          }
        }
      }
    }
    const pages = appearances
      .map((a) => ({ bvid: a.bvid, pageIndex: Number(a.pageIndex) || 0 }))
      .map(({ bvid, pageIndex }) => {
        const meta = processedByKey.get(`${bvid}:${pageIndex}`);
        return meta ? { bvid, cid: meta.cid, page_index: pageIndex, page_title: meta.page_title } : null;
      })
      .filter((p): p is { bvid: string; cid: number; page_index: number; page_title: string } => p !== null);
    const cap = Math.max(opts.questionCount * 2, opts.questionCount);
    const trimmed = pages.slice(0, cap);
    if (trimmed.length === 0) {
      throw new BlindspotError(400, "该实体在你的收藏范围内没有视频出处，无法出题");
    }
    const title = `薄弱点特训 · ${entityName}`.slice(0, 200);
    const result = await this.deps.quizGen.startFromSource(uid, {
      pages: trimmed,
      questionCount: opts.questionCount,
      difficulty: opts.difficulty,
      title,
    });
    return { ...result, title };
  }

  /** Aggregate per-normalized-name quiz stats; vector attribution for untagged questions. */
  private async quizSignals(uid: string): Promise<Map<string, { total: number; correct: number; wrong: number }>> {
    let signals: QuizSignal[] = [];
    try {
      signals = (await this.deps.appQuiz.getQuizSignals(uid)).signals ?? [];
    } catch (err) {
      log.warn(`quiz signals read failed uid=${uid}: ${err instanceof Error ? err.message : err}`);
    }
    const stats = new Map<string, { total: number; correct: number; wrong: number }>();
    const bump = (name: string, correct: boolean) => {
      const key = normalizeName(name);
      if (!key) return;
      const entry = stats.get(key) ?? { total: 0, correct: 0, wrong: 0 };
      entry.total += 1;
      if (correct) entry.correct += 1;
      else entry.wrong += 1;
      stats.set(key, entry);
    };
    for (const signal of signals) {
      if (Array.isArray(signal.related_entities) && signal.related_entities.length > 0) {
        for (const name of signal.related_entities) bump(name, signal.is_correct);
        continue;
      }
      // scheme B: vector attribution on the question text (top-3, threshold)
      if (!this.deps.index || !signal.question_text) continue;
      try {
        const hits = await this.deps.index.search(
          signal.question_text.slice(0, 500),
          3,
          this.deps.embeddings,
        );
        for (const hit of hits) {
          if (hit.score >= ATTRIBUTION_SCORE_THRESHOLD) {
            bump(hit.name, signal.is_correct);
          }
        }
      } catch (err) {
        log.warn(`attribution fallback failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    return stats;
  }
}
