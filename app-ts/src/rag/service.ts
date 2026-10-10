import { config } from "../config/index.js";
import { createLogger } from "../logger.js";
import { GatewayEmbeddings, type EmbeddingsClient } from "../llm/embeddings.js";
import { MilvusStore, type InsertRow, type StoreKind } from "./milvus.js";
import { SemanticChunker } from "./chunking.js";
import { Reranker } from "./rerank.js";
import type { CollectionStats, Document, RagFilter, VideoContent } from "./types.js";

/**
 * RAGService: v1 mirrors the core flow of Python legacy.py.
 * Business methods only — startup wiring (Milvus connect/schema guard + dimension
 * red-line probe) lives in bootstrap.ts, not here.
 * - addVideoContent / addCloudContent: chunking → embedding → delete-then-insert (idempotent)
 * - search: over-recall (k→topN when rerank is enabled) → parallel video + cloud store
 *   retrieval → workspace refinement → rerank → top_k
 * - Degraded semantics: empty results when Milvus is unavailable; on rerank failure fall
 *   back to the original order, truncated
 */
const log = createLogger("RAG");

/** Cloud-drive document payload (mirrors Python cloud ingestion input). */
export interface CloudContent {
  uploadUuid: string;
  uid: string;
  title: string;
  content: string;
  sourceType?: string;
}

export class RAGService {
  readonly embeddings: EmbeddingsClient;
  readonly store: MilvusStore;
  readonly cloudStore: MilvusStore;
  private readonly chunker: SemanticChunker;
  private readonly reranker: Reranker;

  constructor(embeddings?: EmbeddingsClient, store?: MilvusStore, cloudStore?: MilvusStore) {
    this.embeddings = embeddings ?? new GatewayEmbeddings();
    this.store = store ?? new MilvusStore("video");
    this.cloudStore = cloudStore ?? new MilvusStore("cloud");
    this.chunker = new SemanticChunker();
    this.reranker = new Reranker();
  }

  /** Writes content for a single video page (P), returns the chunk count. */
  async addVideoContent(video: VideoContent, pageIndex = 0, pageTitle: string | null = null): Promise<number> {
    const content = video.content?.trim() ?? "";
    if (content.length < 10) return 0;

    const chunks = this.chunker.chunk(content, video.title, pageTitle, video.outline ?? null);
    const usable = chunks.filter((c) => c.embeddingText.length > 5);
    if (usable.length === 0) return 0;

    const vectors = await this.embeddings.embedDocuments(usable.map((c) => c.embeddingText));

    // Idempotent: delete-then-insert
    await this.store.deleteByFilter(this.pageFilterExpr(video.bvid, pageIndex));

    const rows: InsertRow[] = usable.map((c, i) => ({
      bvid: video.bvid,
      cid: video.cid,
      pageIndex,
      chunkIndex: i,
      chunkId: `${video.bvid}:${pageIndex}:${i}`,
      title: video.title,
      pageTitle: pageTitle ?? undefined,
      source: video.source,
      sectionTitle: c.sectionTitle || undefined,
      contentType: c.contentType,
      url: video.url,
      text: c.embeddingText,
      embedding: vectors[i],
    }));
    const written = await this.store.insert(rows, this.partitionDt());
    log.info(`[RAG] add_video_content bvid=${video.bvid} page=${pageIndex} chunks=${written}`);
    return written;
  }

  /** Writes a cloud-drive document (uid-scoped), returns the chunk count. */
  async addCloudContent(doc: CloudContent): Promise<number> {
    const content = doc.content?.trim() ?? "";
    if (content.length < 10) return 0;

    const chunks = this.chunker.chunk(content, doc.title);
    const usable = chunks.filter((c) => c.embeddingText.length > 5);
    if (usable.length === 0) return 0;

    const vectors = await this.embeddings.embedDocuments(usable.map((c) => c.embeddingText));

    await this.cloudStore.deleteByFilter(`upload_uuid == "${doc.uploadUuid}"`);

    const rows: InsertRow[] = usable.map((c, i) => ({
      uploadUuid: doc.uploadUuid,
      uid: doc.uid,
      sourceType: doc.sourceType ?? "document",
      chunkIndex: i,
      chunkId: `${doc.uploadUuid}:${i}`,
      title: doc.title,
      sectionTitle: c.sectionTitle || undefined,
      contentType: c.contentType,
      text: c.embeddingText,
      embedding: vectors[i],
    }));
    const written = await this.cloudStore.insert(rows, this.partitionDt());
    log.info(`[RAG] add_cloud_content upload=${doc.uploadUuid} uid=${doc.uid} chunks=${written}`);
    return written;
  }

  /**
   * Search: video store always queried (bvid scope when given); cloud store queried in
   * parallel when a uid scope exists. Results merged before rerank.
   */
  async search(query: string, k = config.search.defaultK, filter: RagFilter = {}): Promise<Document[]> {
    const effectiveK = config.rerank.enabled ? Math.max(config.rerank.topN, k) : k;

    const [queryVector] = await this.embeddings.embedDocuments([query]);
    const videoFilter = this.buildVideoFilter(filter);
    const cloudFilter = this.buildCloudFilter(filter);

    const [videoDocs, cloudDocs] = await Promise.all([
      this.store.search(queryVector, {
        k: effectiveK,
        filterExpr: videoFilter,
        queryText: query,
      }),
      // cloud content is uid-scoped by construction — without a uid there is nothing to scope to
      filter.uid !== undefined
        ? this.cloudStore.search(queryVector, {
            k: effectiveK,
            filterExpr: cloudFilter,
            queryText: query,
          })
        : Promise.resolve([] as Document[]),
    ]);

    let docs = [...videoDocs, ...cloudDocs];

    // workspace in-memory refinement
    if (filter.workspacePages && filter.workspacePages.length > 0) {
      const allow = new Set(filter.workspacePages.map((p) => `${p.bvid}:${p.pageIndex}`));
      docs = docs.filter((d) => allow.has(`${d.metadata.bvid}:${d.metadata.pageIndex}`));
    }

    if (config.rerank.enabled && docs.length > 0) {
      docs = await this.reranker.rerank(query, docs, k);
    }
    return docs.slice(0, k);
  }

  async deleteVideo(bvid: string): Promise<void> {
    await this.store.deleteByFilter(`bvid == "${bvid}"`);
  }

  /** Count vectors of one page (page-level self-heal for /vec/page/status). */
  async countPageVectors(bvid: string, pageIndex: number): Promise<number> {
    return this.store.countByFilter(`bvid == "${bvid}" && page_index == ${pageIndex}`);
  }

  /** Wipe the whole video collection (admin /knowledge/clear). */
  async clearVideoCollection(): Promise<void> {
    await this.store.deleteByFilter('bvid != ""');
  }

  async deletePageVectors(bvid: string, pageIndex: number): Promise<void> {
    await this.store.deleteByFilter(this.pageFilterExpr(bvid, pageIndex));
  }

  async deleteCloudVectors(uploadUuid: string): Promise<void> {
    await this.cloudStore.deleteByFilter(`upload_uuid == "${uploadUuid}"`);
  }

  async getCollectionStats(): Promise<CollectionStats> {
    const [video, cloud] = await Promise.all([this.store.getStats(), this.cloudStore.getStats()]);
    return {
      collectionName: this.store.collection,
      totalChunks: video.totalChunks,
      totalVideos: video.totalVideos,
      available: video.available,
      cloudCollectionName: this.cloudStore.collection,
      cloudChunks: cloud.totalChunks,
      cloudAvailable: cloud.available,
    };
  }

  /** monthly partition for writes when enabled; search stays unpartitioned (scans all) */
  private partitionDt(): Date | undefined {
    return config.milvus.useMonthlyPartitions ? new Date() : undefined;
  }

  private pageFilterExpr(bvid: string, pageIndex: number): string {
    return `bvid == "${bvid}" && page_index == ${pageIndex}`;
  }

  private buildVideoFilter(filter: RagFilter): string {
    if (filter.bvids && filter.bvids.length > 0) {
      return this.store.buildFilterExpr({ bvid: filter.bvids });
    }
    return "";
  }

  private buildCloudFilter(filter: RagFilter): string {
    const parts: string[] = [`uid == ${filter.uid ?? 0}`];
    if (filter.uploadUuids && filter.uploadUuids.length > 0) {
      parts.push(this.cloudStore.buildFilterExpr({ upload_uuid: filter.uploadUuids }));
    }
    return parts.join(" && ");
  }
}
