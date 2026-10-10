import { config } from "../config/index.js";
import { createLogger } from "../logger.js";
import { GatewayEmbeddings, type EmbeddingsClient } from "../llm/embeddings.js";
import { MilvusStore } from "./milvus.js";
import { RAGService } from "./service.js";

const log = createLogger("RAG");

/**
 * RAG bootstrap: construction + startup wiring. Initialization lives here, NOT in the
 * service class — services contain business logic only.
 *
 * Dimension flow mirrors Python: probe the live embedding dimension FIRST, then create
 * the stores with the probed dim; a mismatch against the configured dim means the
 * collection is rebuilt (in-store red-line guard) and must be re-ingested.
 * Degrade semantics: Milvus unreachable → degraded mode (empty results); gateway
 * unreachable → probe skipped, configured dim used.
 */
export async function createRAGService(): Promise<RAGService> {
  const embeddings = new GatewayEmbeddings();

  // 1. probe the real embedding dimension (red line: model ↔ collection dim must match)
  let dim = config.milvus.dimension;
  try {
    const probed = await embeddings.probeDimension();
    if (probed !== config.milvus.dimension) {
      log.error(
        `[RAG] RED LINE: embedding model "${config.embedding.model}" returns dim=${probed}, configured=${config.milvus.dimension} — collections will be (re)created with dim=${probed} and MUST be fully re-ingested`,
      );
      dim = probed;
    }
  } catch (err) {
    log.warn(`[RAG] dimension probe skipped (gateway offline?): ${err instanceof Error ? err.message : err}`);
  }

  // 2. both stores (video + cloud) with the effective dim; mismatch → recreate inside initialize()
  const rag = new RAGService(
    embeddings,
    new MilvusStore("video", undefined, dim),
    new MilvusStore("cloud", undefined, dim),
  );
  await Promise.all([rag.store.initialize(), rag.cloudStore.initialize()]);

  for (const store of [rag.store, rag.cloudStore]) {
    if (store.wasRecreated) {
      log.error(
        `[RAG] collection ${store.collection} was recreated — all stored vectors are gone; re-ingestion required (vector statuses must be reset)`,
      );
    }
  }
  if (rag.store.available) {
    log.info(
      `[RAG] initialized collection=${rag.store.collection} dim=${dim} hybrid=${config.milvus.hybridSearch} cloud=${rag.cloudStore.collection}(${rag.cloudStore.available ? "ok" : "degraded"})`,
    );
  }
  return rag;
}
