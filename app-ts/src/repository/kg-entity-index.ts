import { MilvusClient, DataType, type FieldType } from "@zilliz/milvus2-sdk-node";
import { config } from "../config/index.js";
import { createLogger } from "../logger.js";
import type { EmbeddingsClient } from "../llm/embeddings.js";
import type { ResolvedEntity } from "../kg/types.js";

const log = createLogger("KG_INDEX");

/**
 * KgEntityIndex — entity-embedding index for semantic entity linking, a
 * faithful port of app/repository/kg_entity_index.py: its OWN MilvusClient
 * (separate from the chunk store, same as Python), collection
 * mind_base_ts.kg_entities (app-ts's isolated database — deliberately NOT
 * the Python mind_base.kg_entities collection; the two stacks rebuild
 * independently and no data migration is expected).
 *
 * Schema: id INT64 auto_id PK / eid VARCHAR(64) / name VARCHAR(256) /
 * type VARCHAR(32) / text VARCHAR(2048) / embedding FLOAT_VECTOR(dim probed).
 * IVF_FLAT COSINE nlist=128, search nprobe=16, dynamic fields on.
 * Upsert = delete-by-eids then insert (auto_id makes true upsert impossible).
 * Dimension mismatch on an existing collection → drop + recreate (self-heal).
 */

export interface EntityHit {
  eid: string;
  name: string;
  type: string;
  score: number;
}

/** "{name} ({type}) {description[:1500]}" truncated to 2000 — Python parity. */
export function buildEmbeddingText(entity: { name: string; type: string; description?: string }): string {
  const text = `${entity.name} (${entity.type}) ${(entity.description ?? "").slice(0, 1500)}`;
  return text.slice(0, 2000);
}

export class KgEntityIndex {
  private client: MilvusClient | null = null;
  private dimension = 0;
  private _available = false;

  private constructor(private readonly collectionName: string) {}

  get available(): boolean {
    return this._available;
  }

  static async connect(embeddings: EmbeddingsClient): Promise<KgEntityIndex | null> {
    const index = new KgEntityIndex(config.kg.collectionName);
    try {
      index.dimension = await embeddings.probeDimension();
      const client = new MilvusClient({
        address: config.milvus.address,
        token: config.milvus.token || undefined,
        database: config.milvus.database,
        timeout: 10_000,
      });
      await client.createDatabase({ db_name: config.milvus.database }).catch(() => undefined);
      await client.useDatabase({ db_name: config.milvus.database }).catch(() => undefined);
      index.client = client;
      await index.ensureCollection(client);
      index._available = true;
      log.info(`[KG_INDEX] ready collection=${index.collectionName} dim=${index.dimension}`);
      return index;
    } catch (err) {
      log.warn(`[KG_INDEX] unavailable (degraded): ${err instanceof Error ? err.message : err}`);
      const client = index.client as unknown as { closeClient?: () => Promise<void> } | null;
      await client?.closeClient?.();
      index.client = null;
      return null;
    }
  }

  private async ensureCollection(client: MilvusClient): Promise<void> {
    const has = await client.hasCollection({ collection_name: this.collectionName });
    if (has.value) {
      // dimension red-line guard: a mismatch means the embedding model changed
      // and the stored vectors are unusable — drop and rebuild
      const desc = await client.describeCollection({ collection_name: this.collectionName });
      const embField = desc.schema?.fields?.find((f) => f.name === "embedding") as unknown as
        | Record<string, unknown>
        | undefined;
      const schemaDim = Number((embField?.params as Record<string, unknown> | undefined)?.dim ?? -1);
      if (schemaDim > 0 && schemaDim !== this.dimension) {
        log.error(
          `[KG_INDEX] RED LINE: collection ${this.collectionName} dim=${schemaDim} != ${this.dimension} — dropping and recreating`,
        );
        await client.dropCollection({ collection_name: this.collectionName });
        await this.createCollection(client);
      }
      return;
    }
    await this.createCollection(client);
  }

  private schema(): FieldType[] {
    return [
      { name: "id", data_type: DataType.Int64, is_primary_key: true, autoID: true },
      { name: "eid", data_type: DataType.VarChar, max_length: 64 },
      { name: "name", data_type: DataType.VarChar, max_length: 256 },
      { name: "type", data_type: DataType.VarChar, max_length: 32 },
      { name: "text", data_type: DataType.VarChar, max_length: 2048 },
      { name: "embedding", data_type: DataType.FloatVector, dim: this.dimension },
    ];
  }

  private async createCollection(client: MilvusClient): Promise<void> {
    await client.createCollection({
      collection_name: this.collectionName,
      fields: this.schema(),
      index_params: [
        {
          field_name: "embedding",
          index_type: "IVF_FLAT",
          metric_type: "COSINE",
          params: { nlist: 128 },
        },
      ],
      enable_dynamic_field: true,
    });
  }

  async close(): Promise<void> {
    const client = this.client as unknown as { closeClient?: () => Promise<void> } | null;
    await client?.closeClient?.();
    this.client = null;
    this._available = false;
  }  /** Delete-then-insert upsert keyed by eid; embedding failure throws (the
   * build pipeline treats the entity-index write as best-effort). */
  async upsert(entities: ResolvedEntity[], embeddings: EmbeddingsClient): Promise<void> {
    if (!this.client || !this._available || entities.length === 0) return;
    const eids = entities.map((e) => e.eid);
    await this.deleteByEids(eids);
    const texts = entities.map(buildEmbeddingText);
    const vectors = await embeddings.embedDocuments(texts);
    await this.client.insert({
      collection_name: this.collectionName,
      data: entities.map((e, i) => ({
        eid: e.eid,
        name: e.name.slice(0, 256),
        type: e.type.slice(0, 32),
        text: texts[i],
        embedding: vectors[i],
      })),
    });
    await this.client.flush({ collection_names: [this.collectionName] });
  }

  async deleteByEids(eids: string[]): Promise<void> {
    if (!this.client || !this._available || eids.length === 0) return;
    const filter = `eid in [${eids.map((e) => `"${e.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(", ")}]`;
    await this.client.delete({ collection_name: this.collectionName, filter });
  }

  /** Semantic entity linking: query → {eid, name, type, score} (COSINE). */
  async search(query: string, topN: number, embeddings: EmbeddingsClient): Promise<EntityHit[]> {
    if (!this.client || !this._available) return [];
    const vector = await embeddings.embedQuery(query);
    const res = await this.client.search({
      collection_name: this.collectionName,
      data: [vector],
      limit: topN,
      output_fields: ["eid", "name", "type"],
      search_params: { metric_type: "COSINE", params: { nprobe: 16 } },
    });
    const hits = (res.results ?? []) as Array<Record<string, unknown>>;
    return hits
      .filter((h) => typeof h.eid === "string" && h.eid !== "")
      .map((h) => ({
        eid: h.eid as string,
        name: typeof h.name === "string" ? h.name : "",
        type: typeof h.type === "string" ? h.type : "other",
        score: typeof h.score === "number" ? h.score : 0,
      }));
  }

  async count(): Promise<number> {
    if (!this.client || !this._available) return 0;
    const stats = await this.client.getCollectionStatistics({ collection_name: this.collectionName });
    return Number(stats.data?.row_count ?? 0);
  }

  /** Drop the whole collection (admin/test only). */
  async clear(): Promise<void> {
    if (!this.client) return;
    await this.client.dropCollection({ collection_name: this.collectionName });
    await this.createCollection(this.client);
  }
}
