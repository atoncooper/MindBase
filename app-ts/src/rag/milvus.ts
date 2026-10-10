import {
  MilvusClient,
  DataType,
  FunctionType,
  type FieldType,
  type FunctionObject,
  type SearchResultData,
} from "@zilliz/milvus2-sdk-node";
import { config } from "../config/index.js";
import { createLogger } from "../logger.js";
import { partitionNameForMonth } from "../utils/datetime.js";
import { rrfMerge } from "./rrf.js";
import type { Document, DocumentMetadata } from "./types.js";

const log = createLogger("MILVUS");

/** Collection flavor: bilibili videos vs cloud-drive documents (different scalar fields). */
export type StoreKind = "video" | "cloud";

export interface InsertRow {
  bvid?: string;
  cid?: number;
  pageIndex?: number;
  chunkIndex?: number;
  chunkId: string;
  title?: string;
  pageTitle?: string;
  source?: string;
  sectionTitle?: string;
  contentType?: string;
  url?: string;
  /** cloud flavor */
  uploadUuid?: string;
  uid?: string;
  sourceType?: string;
  text: string;
  embedding: number[];
}

export interface SearchOptions {
  k: number;
  filterExpr?: string;
  partitionStart?: Date;
  partitionEnd?: Date;
  /** raw query text — required for the sparse/BM25 leg when hybrid search is on */
  queryText?: string;
}

/**
 * Milvus vector store (standalone mind_base_ts database, isolated from the Python/Go backends).
 * Mirrors Python MilvusVectorStore semantics: degraded mode (empty results, never crash),
 * delete-then-insert idempotency at the service layer, monthly partitions, dimension guard.
 * hybridSearch adds a BM25 sparse field (server-side function) searched with the raw query
 * text; dense + sparse results are fused with RRF. Requires Milvus 2.5+.
 */
export class MilvusStore {
  private client: MilvusClient | null = null;
  private _available = false;
  private _wasRecreated = false;
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly kind: StoreKind = "video",
    private readonly collectionName: string =
      kind === "cloud" ? config.milvus.cloudCollection : config.milvus.collection,
    private readonly dimension: number = config.milvus.dimension,
  ) {}

  get available(): boolean {
    return this._available;
  }

  get collection(): string {
    return this.collectionName;
  }

  /** true when initialize() dropped and recreated an existing incompatible collection */
  get wasRecreated(): boolean {
    return this._wasRecreated;
  }

  /** true when the collection schema carries the sparse BM25 field */
  get hybrid(): boolean {
    return config.milvus.hybridSearch;
  }

  /** Startup init: connect + create db/collection. Failed connect → degraded mode. */
  async initialize(): Promise<void> {
    this.initPromise ??= this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    try {
      const client = new MilvusClient({
        address: config.milvus.address,
        token: config.milvus.token || undefined,
        database: config.milvus.database,
        timeout: 10_000,
      });
      await client.createDatabase({ db_name: config.milvus.database }).catch(() => undefined);
      await client.useDatabase({ db_name: config.milvus.database }).catch(() => undefined);
      this.client = client;

      const has = await client.hasCollection({ collection_name: this.collectionName });
      if (!has.value) {
        await this.createCollection(client);
      } else {
        await this.validateOrRecreate(client);
      }
      this._available = true;
    } catch (err) {
      log.error(`[MILVUS] initialize failed, degraded mode: ${err instanceof Error ? err.message : err}`);
      this._available = false;
    }
  }

  /** Dimension red-line guard: mismatch → drop + recreate (the rebuild), never serve mismapped vectors. */
  private async validateOrRecreate(client: MilvusClient): Promise<void> {
    const desc = await client.describeCollection({ collection_name: this.collectionName });
    const embField = desc.schema?.fields?.find((f) => f.name === "embedding") as unknown as
      | Record<string, unknown>
      | undefined;
    const schemaDim = Number((embField?.params as Record<string, unknown> | undefined)?.dim ?? -1);
    if (schemaDim > 0 && schemaDim !== this.dimension) {
      log.error(
        `[MILVUS] RED LINE: collection ${this.collectionName} dim=${schemaDim} != ${this.dimension} — dropping and recreating (stored vectors are incompatible and must be re-ingested)`,
      );
      await client.dropCollection({ collection_name: this.collectionName });
      await this.createCollection(client);
      this._wasRecreated = true;
    }
  }

  private async createCollection(client: MilvusClient): Promise<void> {
    await client.createCollection({
      collection_name: this.collectionName,
      fields: this.buildSchema(),
      ...(this.hybrid
        ? {
            functions: [
              {
                name: "text_bm25",
                type: FunctionType.BM25,
                input_field_names: ["text"],
                output_field_names: ["sparse_embedding"],
              },
            ] as FunctionObject[],
          }
        : {}),
      index_params: [
        {
          field_name: "embedding",
          index_type: config.milvus.indexType,
          metric_type: config.milvus.metricType,
          params: { nlist: config.milvus.nlist },
        },
        ...(this.hybrid
          ? [
              {
                field_name: "sparse_embedding",
                index_type: "SPARSE_INVERTED_INDEX",
                metric_type: "BM25",
              },
            ]
          : []),
      ],
      enable_dynamic_field: true,
    });
  }

  private buildSchema(): FieldType[] {
    const common: FieldType[] = [
      { name: "id", data_type: DataType.Int64, is_primary_key: true, autoID: true },
      { name: "chunk_index", data_type: DataType.Int64 },
      { name: "chunk_id", data_type: DataType.VarChar, max_length: this.kind === "cloud" ? 128 : 64 },
      { name: "title", data_type: DataType.VarChar, max_length: 512 },
      { name: "source", data_type: DataType.VarChar, max_length: 32 },
      { name: "section_title", data_type: DataType.VarChar, max_length: 256 },
      { name: "content_type", data_type: DataType.VarChar, max_length: 32 },
      { name: "text", data_type: DataType.VarChar, max_length: 65535 },
      ...(this.hybrid
        ? [{ name: "sparse_embedding", data_type: DataType.SparseFloatVector } as FieldType]
        : []),
      { name: "embedding", data_type: DataType.FloatVector, dim: this.dimension },
    ];
    if (this.kind === "cloud") {
      return [
        ...common,
        { name: "upload_uuid", data_type: DataType.VarChar, max_length: 64 },
        { name: "uid", data_type: DataType.Int64 },
        { name: "source_type", data_type: DataType.VarChar, max_length: 16 },
      ];
    }
    return [
      ...common,
      { name: "bvid", data_type: DataType.VarChar, max_length: 20 },
      { name: "cid", data_type: DataType.Int64 },
      { name: "page_index", data_type: DataType.Int64 },
      { name: "page_title", data_type: DataType.VarChar, max_length: 512 },
      { name: "url", data_type: DataType.VarChar, max_length: 512 },
    ];
  }

  private outputFields(): string[] {
    const base = ["chunk_index", "chunk_id", "title", "source", "section_title", "content_type", "text"];
    return this.kind === "cloud"
      ? [...base, "upload_uuid", "uid", "source_type"]
      : [...base, "bvid", "cid", "page_index", "page_title", "url"];
  }

  // ---------- Write ----------

  async insert(rows: InsertRow[], partitionDt?: Date): Promise<number> {
    if (!this.client || !this._available || rows.length === 0) return 0;
    const partitionName = partitionDt ? this.partitionNameFor(partitionDt) : undefined;
    if (partitionName) await this.ensurePartition(partitionName);
    try {
      await this.client.insert({
        collection_name: this.collectionName,
        ...(partitionName ? { partition_name: partitionName } : {}),
        data: rows.map((r) =>
          this.kind === "cloud"
            ? {
                upload_uuid: r.uploadUuid ?? "",
                uid: r.uid ?? 0,
                source_type: r.sourceType ?? "document",
                chunk_index: r.chunkIndex ?? 0,
                chunk_id: r.chunkId,
                title: r.title ?? "",
                source: r.source ?? "",
                section_title: r.sectionTitle ?? "",
                content_type: r.contentType ?? "content",
                text: r.text,
                embedding: r.embedding,
              }
            : {
                bvid: r.bvid ?? "",
                cid: r.cid ?? 0,
                page_index: r.pageIndex ?? 0,
                chunk_index: r.chunkIndex ?? 0,
                chunk_id: r.chunkId,
                title: r.title ?? "",
                page_title: r.pageTitle ?? "",
                source: r.source ?? "",
                section_title: r.sectionTitle ?? "",
                content_type: r.contentType ?? "content",
                url: r.url ?? "",
                text: r.text,
                embedding: r.embedding,
              },
        ),
      });
      await this.client.flush({ collection_names: [this.collectionName] });
      return rows.length;
    } catch (err) {
      log.error(`[MILVUS] insert failed: ${err instanceof Error ? err.message : err}`);
      return 0;
    }
  }

  async deleteByFilter(filterExpr: string, partitionDt?: Date): Promise<void> {
    if (!this.client || !this._available) return;
    try {
      await this.client.delete({
        collection_name: this.collectionName,
        filter: filterExpr,
        ...(partitionDt ? { partition_name: this.partitionNameFor(partitionDt) } : {}),
      });
    } catch (err) {
      log.error(`[MILVUS] delete failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Count rows matching a filter (capped at the query limit — large matches
   * return the cap, which is fine for existence checks and page-level counts).
   * 0 when Milvus is unavailable (callers must treat 0 as "unknown" semantics).
   */
  async countByFilter(filterExpr: string): Promise<number> {
    if (!this.client || !this._available) return 0;
    try {
      const res = await this.client.query({
        collection_name: this.collectionName,
        filter: filterExpr,
        output_fields: ["id"],
        limit: 16384,
      });
      return res.data?.length ?? 0;
    } catch (err) {
      log.error(`[MILVUS] count failed: ${err instanceof Error ? err.message : err}`);
      return 0;
    }
  }

  // ---------- Search ----------

  async search(queryVector: number[], opts: SearchOptions): Promise<Document[]> {
    if (!this.client || !this._available) return [];
    const fields = this.outputFields();
    const partitionNames = this.partitionRange(opts.partitionStart, opts.partitionEnd);

    const runDense = () =>
      this.client!.search({
        collection_name: this.collectionName,
        ...(partitionNames.length > 0 ? { partition_names: partitionNames } : {}),
        ...(opts.filterExpr ? { filter: opts.filterExpr } : {}),
        anns_field: "embedding",
        data: [queryVector] as unknown as SearchResultData,
        limit: opts.k,
        output_fields: fields,
        search_params: {
          metric_type: config.milvus.metricType,
          params: { nprobe: config.milvus.nprobe },
        },
      });

    // sparse leg: Milvus 2.5 full-text search accepts the raw query text on the
    // BM25 function field — no client-side sparse embedding needed
    const runSparse = () =>
      this.client!.search({
        collection_name: this.collectionName,
        ...(partitionNames.length > 0 ? { partition_names: partitionNames } : {}),
        ...(opts.filterExpr ? { filter: opts.filterExpr } : {}),
        anns_field: "sparse_embedding",
        data: [opts.queryText ?? ""] as unknown as SearchResultData,
        limit: opts.k,
        output_fields: fields,
        search_params: { metric_type: "BM25", params: { drop_ratio_search: 0.2 } },
      });

    try {
      if (!this.hybrid || !opts.queryText) {
        const res = await runDense();
        return this.mapHits(res.results ?? []);
      }
      const [dense, sparse] = await Promise.all([
        runDense().then((r) => this.mapHits(r.results ?? [])),
        runSparse()
          .then((r) => this.mapHits(r.results ?? []))
          .catch((err) => {
            log.warn(`[MILVUS] sparse leg failed, dense-only: ${err instanceof Error ? err.message : err}`);
            return [] as Document[];
          }),
      ]);
      if (sparse.length === 0) return dense;
      return rrfMerge(dense, sparse);
    } catch (err) {
      log.error(`[MILVUS] search failed: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  private mapHits(hits: Array<Record<string, unknown>>): Document[] {
    return hits.map((m) => {
      const metadata: DocumentMetadata = {
        chunkId: String(m.chunk_id ?? ""),
        bvid: (m.bvid as string) || undefined,
        cid: m.cid ? Number(m.cid) : undefined,
        pageIndex: m.page_index !== undefined ? Number(m.page_index) : undefined,
        chunkIndex: m.chunk_index !== undefined ? Number(m.chunk_index) : undefined,
        title: (m.title as string) || undefined,
        pageTitle: (m.page_title as string) || undefined,
        source: (m.source as string) || undefined,
        sectionTitle: (m.section_title as string) || undefined,
        contentType: (m.content_type as string) || undefined,
        url: (m.url as string) || undefined,
        uploadUuid: (m.upload_uuid as string) || undefined,
        uid: m.uid !== undefined ? String(m.uid) : undefined,
        sourceType: (m.source_type as string) || undefined,
      };
      return {
        text: String(m.text ?? ""),
        score: typeof m.score === "number" ? m.score : undefined,
        metadata,
      };
    });
  }

  // ---------- Stats ----------

  async getStats(): Promise<{ totalChunks: number; totalVideos: number; available: boolean }> {
    if (!this.client || !this._available) {
      return { totalChunks: 0, totalVideos: 0, available: false };
    }
    try {
      const stats = await this.client.getCollectionStatistics({ collection_name: this.collectionName });
      const totalChunks = Number(stats.data?.row_count ?? 0);
      let totalVideos = 0;
      if (totalChunks > 0) {
        const groupField = this.kind === "cloud" ? "upload_uuid" : "bvid";
        const filter = this.kind === "cloud" ? 'upload_uuid != ""' : 'bvid != ""';
        const res = await this.client.query({
          collection_name: this.collectionName,
          filter,
          output_fields: [groupField],
          limit: 16384,
        });
        totalVideos = new Set((res.data ?? []).map((r) => (r as Record<string, unknown>)[groupField])).size;
      }
      return { totalChunks, totalVideos, available: true };
    } catch (err) {
      log.error(`[MILVUS] stats failed: ${err instanceof Error ? err.message : err}`);
      return { totalChunks: 0, totalVideos: 0, available: false };
    }
  }

  // ---------- Filter expression (mirrors Python _build_filter_expr) ----------

  buildFilterExpr(filters: Record<string, string[] | string | number>): string {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(filters)) {
      if (Array.isArray(value)) {
        if (value.length === 0) continue;
        const capped = value.slice(0, 1000).map((v) => `"${escapeExpr(v)}"`);
        parts.push(`${key} in [${capped.join(", ")}]`);
      } else if (typeof value === "number") {
        parts.push(`${key} == ${value}`);
      } else if (value) {
        parts.push(`${key} == "${escapeExpr(value)}"`);
      }
    }
    return parts.join(" && ");
  }

  // ---------- Partitions ----------

  // Partition naming follows the configured local timezone (mirrors Python server-local behavior).
  // NOTE: renaming partitions after data exists orphans rows — treat TZ changes as a rebuild.
  private partitionNameFor(dt: Date): string {
    return partitionNameForMonth(dt);
  }

  private partitionRange(start?: Date, end?: Date): string[] {
    if (!start && !end) return [];
    const s = start ?? end!;
    const e = end ?? start!;
    const names: string[] = [];
    // walk UTC month starts; for TZ east of UTC (e.g. Asia/Shanghai) a UTC month start
    // always formats into the same local month, so the label sequence is correct
    const cur = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), 1));
    while (cur <= e) {
      names.push(this.partitionNameFor(cur));
      cur.setUTCMonth(cur.getUTCMonth() + 1);
      if (names.length > 60) break;
    }
    return names;
  }

  private async ensurePartition(name: string): Promise<void> {
    if (!this.client) return;
    try {
      const has = await this.client.hasPartition({ collection_name: this.collectionName, partition_name: name });
      if (!has.value) {
        await this.client.createPartition({ collection_name: this.collectionName, partition_name: name });
      }
    } catch (err) {
      log.warn(`[MILVUS] ensure partition failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  async close(): Promise<void> {
    const client = this.client as unknown as { closeClient?: () => Promise<void>; close?: () => Promise<void> } | null;
    await (client?.closeClient?.() ?? client?.close?.());
  }
}

function escapeExpr(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
