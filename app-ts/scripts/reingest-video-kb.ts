/**
 * Video KB re-ingest — one-shot/re-runnable script for the chat cutover:
 * reads ASR transcripts from the Python backend's Mongo (mind_base
 * .asr_documents, cross-DB read-only) and rebuilds them into app-ts's own
 * Milvus video collection (mind_base_ts.bilibili_videos), so vector_search
 * serves the knowledge base after /chat/* moves off Python.
 *
 * Idempotent per page: delete-by-(bvid,cid) then insert. Re-running only
 * costs the embedding tokens for the pages it (re)ingests.
 *
 * Run: npm run reingest:video-kb [-- --limit=200]
 */
import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import { MilvusClient } from "@zilliz/milvus2-sdk-node";
import { createHash } from "node:crypto";
import { config } from "../src/config/index.js";
import { createLogger } from "../src/logger.js";
import { GatewayEmbeddings } from "../src/llm/embeddings.js";
import { SemanticChunker } from "../src/rag/chunking.js";
import { MongoVectorTaskStore } from "../src/repository/mongo/vector-tasks.js";

const log = createLogger("REINGEST");

interface AsrDoc {
  bvid: string;
  cid: number;
  page_index?: number;
  page_title?: string;
  content?: string;
  version?: number;
  is_latest?: boolean;
}

async function main() {
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const pageLimit = limitArg ? Number(limitArg.split("=")[1]) || Infinity : Infinity;

  if (!config.mongo.uri) {
    log.error("MONGO__URI not configured");
    process.exit(1);
  }

  const embeddings = new GatewayEmbeddings();
  const dim = await embeddings.probeDimension();
  log.info(`embedding dim=${dim} model=${config.embedding.model}`);

  // ── source: the Python backend's Mongo (cross-DB read-only) ──
  const mongo = new MongoClient(config.mongo.uri, {
    serverSelectionTimeoutMS: config.mongo.timeoutMs,
  });
  await mongo.connect();
  const asr = mongo
    .db(config.kg.sourceDatabase)
    .collection<AsrDoc>(config.kg.sourceCollection);

  const docs = await asr
    .find({ is_latest: true } as Record<string, unknown>, {
      projection: { bvid: 1, cid: 1, page_index: 1, page_title: 1, content: 1 },
    })
    .limit(Number.isFinite(pageLimit) ? pageLimit : 0)
    .toArray();
  log.info(`source pages: ${docs.length}`);

  // ── target: app-ts's own video collection ──
  const milvus = new MilvusClient({
    address: config.milvus.address,
    token: config.milvus.token || undefined,
    database: config.milvus.database,
    timeout: 30_000,
  });
  await milvus.createDatabase({ db_name: config.milvus.database }).catch(() => undefined);
  await milvus.useDatabase({ db_name: config.milvus.database }).catch(() => undefined);

  const chunker = new SemanticChunker();

  // vectorization bookkeeping (vec_pages) so /knowledge/pages/vectorized and
  // /vec/page/status reflect pre-cutover content without re-embedding
  const vecTasks = await MongoVectorTaskStore.connect();
  if (!vecTasks) {
    log.warn("vector bookkeeping store unavailable — vec_pages records will not be written");
  }

  let pages = 0;
  let chunks = 0;
  let failed = 0;
  for (const doc of docs) {
    if (!doc.bvid || !doc.cid || !doc.content) {
      failed += 1;
      continue;
    }
    const pageIndex = doc.page_index ?? 0;
    const pageTitle = doc.page_title ?? `P${pageIndex + 1}`;
    try {
      const pieces = chunker.chunk(doc.content, pageTitle, pageTitle);
      // delete-then-insert per (bvid, cid) page
      await milvus.delete({
        collection_name: config.milvus.collection,
        filter: `bvid == "${doc.bvid}" && cid == ${doc.cid}`,
      });
      if (pieces.length === 0) continue;
      const vectors = await embeddings.embedDocuments(pieces.map((p) => p.embeddingText));
      await milvus.insert({
        collection_name: config.milvus.collection,
        data: pieces.map((piece, i) => ({
          bvid: doc.bvid,
          cid: doc.cid,
          page_index: pageIndex,
          chunk_index: i,
          chunk_id: `${doc.bvid}:${doc.cid}:${i}:${randomUUID().slice(0, 8)}`,
          title: pageTitle,
          page_title: pageTitle,
          source: "video",
          section_title: piece.sectionTitle ?? "",
          content_type: "content",
          url: `https://www.bilibili.com/video/${doc.bvid}?p=${pageIndex + 1}`,
          text: piece.displayText,
          embedding: vectors[i],
        })),
      });
      pages += 1;
      chunks += pieces.length;
      if (vecTasks) {
        const existing = await vecTasks.getPage(doc.bvid, doc.cid);
        await vecTasks.upsertPage({
          bvid: doc.bvid,
          cid: doc.cid,
          pageIndex,
          pageTitle,
          status: "done",
          chunkCount: pieces.length,
          contentHash: createHash("sha1").update(doc.content, "utf8").digest("hex"),
          vectorizedAt: existing?.vectorizedAt ?? Date.now(),
          updatedAt: Date.now(),
        });
      }
      if (pages % 20 === 0) {
        log.info(`progress pages=${pages} chunks=${chunks} failed=${failed}`);
      }
    } catch (err) {
      failed += 1;
      log.error(`page failed bvid=${doc.bvid} cid=${doc.cid}: ${err instanceof Error ? err.message : err}`);
    }
  }

  await milvus.flush({ collection_names: [config.milvus.collection] });
  const stats = await milvus.getCollectionStatistics({ collection_name: config.milvus.collection });
  log.info(
    `done pages=${pages} chunks=${chunks} failed=${failed} collection_rows=${stats.data?.row_count ?? "?"}`,
  );
  await vecTasks?.close();
  await mongo.close();
  await (milvus as unknown as { closeClient?: () => Promise<void> }).closeClient?.();
}

main().catch((err) => {
  log.error(`fatal: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
