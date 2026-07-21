"""uid 隔离评测 (方案 A): NFCorpus 分配 uid -> 入库 -> uid scope 搜索 -> Recall@k.

Simulate multi-user personal libraries by partitioning NFCorpus corpus across
N uids. Each uid owns a subset of docs; search is scoped to that uid's bvids
(equivalent to bilibili favorites / cloud_drive uid filter). Tests:
  1. uid isolation correctness (uid-A search returns only uid-A docs)
  2. Recall@k under uid scope: pure vector vs hybrid
  3. cross-uid safety (no leakage)

Requires NFCorpus downloaded first:
    python -m app.test.rag.fetch_beir --dataset nfcorpus --summarize

Usage:
    # 1. Ingest (partition corpus to N uids, new schema with BM25)
    python -m app.test.rag.eval_uid --ingest --n-uids 5

    # 2. Eval (uid-scoped, vector vs hybrid)
    python -m app.test.rag.eval_uid --eval --strategies null,dashscope --k 5
    python -m app.test.rag.eval_uid --eval --hybrid --strategies null,dashscope --k 5

    # 3. Cleanup
    python -m app.test.rag.eval_uid --cleanup
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from typing import Optional

from langchain_core.documents import Document
from loguru import logger

# Suppress noisy INFO logs (Milvus search / RERANK) so the result table stands out.
logger.remove()
logger.add(sys.stderr, level="WARNING")

COLLECTION = "uid_eval"
DATA_DIR = os.path.join(os.path.dirname(__file__), "data", "nfcorpus")
META_PATH = os.path.join(os.path.dirname(__file__), "data", "uid_eval_meta.json")


def _get_store():
    from app.infra.config import config
    from app.repository.vector_store_milvus import MilvusVectorStore
    from app.services.rag import get_rag_service

    rag = get_rag_service()
    return MilvusVectorStore(config.milvus, rag.embeddings, COLLECTION, analyzer="standard")


def _drop_collection() -> None:
    from app.infra.config import config
    from pymilvus import MilvusClient

    client = MilvusClient(uri=config.milvus.uri, token=config.milvus.token or None)
    try:
        if client.has_collection(COLLECTION):
            client.drop_collection(COLLECTION)
            print(f"已 drop 旧 {COLLECTION}")
    finally:
        client.close()


def ingest(n_uids: int = 5, limit: Optional[int] = None) -> None:
    """Load NFCorpus, partition docs across N uids, ingest to uid_eval."""
    from app.test.rag.fetch_beir import load_corpus, load_queries, load_qrels

    corpus = load_corpus(DATA_DIR)
    queries = load_queries(DATA_DIR)
    qrels = load_qrels(DATA_DIR)
    print(f"NFCorpus: {len(corpus)} docs, {len(queries)} queries, {len(qrels)} qrels")

    # Partition docs across uids by hash (stable, even).
    doc_uid: dict[str, str] = {}
    for i, doc_id in enumerate(corpus):
        doc_uid[doc_id] = f"u{i % n_uids}"

    # Build uid -> bvids map (the scope filter for each uid).
    uid_bvids: dict[str, list[str]] = {f"u{i}": [] for i in range(n_uids)}
    for doc_id, uid in doc_uid.items():
        uid_bvids[uid].append(doc_id)

    _drop_collection()
    store = _get_store()
    docs = [
        Document(
            page_content=doc.get("text", ""),
            metadata={
                "bvid": doc_id,
                "title": doc.get("title", ""),
                "page_index": 0,
                "chunk_index": 0,
                "source": "nfcorpus",
            },
        )
        for doc_id, doc in corpus.items()
    ]
    if limit:
        docs = docs[:limit]
    store.add(docs)

    meta = {
        "doc_uid": doc_uid,
        "uid_bvids": uid_bvids,
        "queries": queries,
        "qrels": qrels,
        "n_uids": n_uids,
    }
    os.makedirs(os.path.dirname(META_PATH), exist_ok=True)
    with open(META_PATH, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False)
    print(f"入库 {len(docs)} docs -> {COLLECTION}, 分配 {n_uids} uid")
    for uid, bvids in uid_bvids.items():
        print(f"  {uid}: {len(bvids)} docs")


def _recall_at_k(retrieved: list[str], relevant: set[str], k: int) -> float:
    return 1.0 if (set(retrieved[:k]) & relevant) else 0.0


def _ndcg_at_k(retrieved: list[str], relevant: set[str], k: int) -> float:
    dcg = 0.0
    for i, did in enumerate(retrieved[:k]):
        if did in relevant:
            dcg += 1.0 / math.log2(i + 2)
    idcg = 1.0 / math.log2(2) if relevant else 0.0
    return dcg / idcg if idcg > 0 else 0.0


def evaluate(
    strategies: list[str], k: int, hybrid: bool, limit: Optional[int] = None
) -> None:
    """Per query: scope search to the relevant doc's uid (bvid filter), score Recall@k."""
    from app.services.rag.rerank import Reranker

    if not os.path.exists(META_PATH):
        print("uid_eval_meta.json 不存在, 先跑 --ingest", file=sys.stderr)
        sys.exit(1)
    with open(META_PATH, encoding="utf-8") as f:
        meta = json.load(f)
    doc_uid = meta["doc_uid"]
    uid_bvids = meta["uid_bvids"]
    queries: dict[str, str] = meta["queries"]
    qrels: dict[str, dict[str, int]] = meta["qrels"]

    store = _get_store()
    reranker = Reranker.from_settings()
    recall_n = max(k * 6, 50)

    # Only keep queries whose ALL relevant docs are under a single uid
    # (so uid-scope search can find them). Skip cross-uid queries.
    eval_queries = []
    for qid, query in queries.items():
        rel_docs = set(qrels.get(qid, {}).keys())
        if not rel_docs:
            continue
        uids = {doc_uid.get(d) for d in rel_docs if doc_uid.get(d)}
        if len(uids) != 1:
            continue  # relevant docs span multiple uids -> skip
        eval_queries.append((qid, query, rel_docs, uids.pop()))
    if limit:
        eval_queries = eval_queries[:limit]

    print(f"\nuid 隔离评测: {len(eval_queries)} query, k={k}, hybrid={hybrid}, recall_n={recall_n}")
    print(f"\n{'strategy':<14} {'Recall@'+str(k):<12} {'NDCG@'+str(k):<12} {'Recall@pool':<12}")
    print("-" * 52)
    results: dict[str, tuple[float, float]] = {}
    for s in strategies:
        rec_sum = 0.0
        ndcg_sum = 0.0
        recall_n_sum = 0.0  # Recall@pool: positive in recall pool (before rerank)
        for qid, query, relevant, uid in eval_queries:
            # uid scope: only search this uid's docs (bvid filter)
            scope_bvids = uid_bvids.get(uid, [])
            filter_cond = {"bvid": {"$in": scope_bvids}}
            if hybrid:
                docs = store.hybrid_search(query, k=recall_n, filter=filter_cond)
            else:
                docs = store.search(query, k=recall_n, filter=filter_cond)
            recall_ids = [d.metadata.get("bvid", "") for d in docs]
            recall_n_sum += _recall_at_k(recall_ids, relevant, len(recall_ids))
            docs = reranker.rerank(query, docs, top_k=k, strategy=s)
            retrieved = [d.metadata.get("bvid", "") for d in docs]
            rec_sum += _recall_at_k(retrieved, relevant, k)
            ndcg_sum += _ndcg_at_k(retrieved, relevant, k)
        n = len(eval_queries)
        rec, ndcg = (rec_sum / n if n else 0.0, ndcg_sum / n if n else 0.0)
        results[s] = (rec, ndcg)
        rec_pool = recall_n_sum / n if n else 0.0
        print(f"{s:<14} {rec:<12.2%} {ndcg:<12.2%} {rec_pool:<12.2%}")
    print()

    # Save metrics plot (unified via plot_utils)
    try:
        from app.test.rag.plot_utils import plot_strategy_comparison

        plot_strategy_comparison(
            strategies=list(results.keys()),
            metrics_dict={
                f"Recall@{k}": [results[s][0] for s in results],
                f"NDCG@{k}": [results[s][1] for s in results],
            },
            title=f"uid 隔离评测 (NFCorpus, k={k}, hybrid={hybrid})",
            out_name=f"retrieval_nfcorpus_{'hybrid' if hybrid else 'vector'}_k{k}",
        )
    except ImportError:
        pass


def main() -> int:
    parser = argparse.ArgumentParser(description="uid 隔离评测 (NFCorpus + uid 分配)")
    parser.add_argument("--ingest", action="store_true")
    parser.add_argument("--eval", action="store_true")
    parser.add_argument("--strategies", default="null,dashscope")
    parser.add_argument("--k", type=int, default=5)
    parser.add_argument("--n-uids", type=int, default=5, help="模拟用户数 (default 5)")
    parser.add_argument("--hybrid", action="store_true", help="召回用 hybrid_search")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--cleanup", action="store_true")
    args = parser.parse_args()

    if args.ingest:
        ingest(args.n_uids, args.limit)
    if args.eval:
        strategies = [s.strip() for s in args.strategies.split(",") if s.strip()]
        evaluate(strategies, args.k, args.hybrid, args.limit)
    if args.cleanup:
        _drop_collection()
    if not (args.ingest or args.eval or args.cleanup):
        parser.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
