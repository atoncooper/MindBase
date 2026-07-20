"""End-to-end RAG retrieval eval: ingest Mmarco into Milvus + search + Recall@k/NDCG@k.

Ingests Mmarco-reranking passages into an ISOLATED ``mmarco_eval`` collection
(does NOT touch production ``bilibili_videos``), then runs vector retrieval per
query and scores Recall@k / NDCG@k across rerank strategies.

Pipeline:
    pairs (query, positive, negative)
      -> corpus (dedup positive + negative passages)
      -> ingest into Milvus mmarco_eval (embeds each passage)
      -> per query: ANN recall -> rerank(strategy) -> top-k
      -> Recall@k (positive in top-k?) + NDCG@k (position-weighted)

Usage:
    # 1. Ingest (calls embedding API; ~hundreds of passages)
    python -m app.test.rag.eval_ingest --ingest --limit 100

    # 2. Eval (Recall@k + NDCG@k, multi-strategy)
    python -m app.test.rag.eval_ingest --eval --strategies null,dashscope,hybrid,mmr --k 5

    # 3. Cleanup (drop mmarco_eval)
    python -m app.test.rag.eval_ingest --cleanup
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
from typing import Optional

from langchain_core.documents import Document

COLLECTION = "mmarco_eval"
DATA_DIR = os.path.join(os.path.dirname(__file__), "data", "mmarco-reranking")
QRELS_PATH = os.path.join(DATA_DIR, "qrels.json")
METRICS_DIR = os.path.join(os.path.dirname(__file__), "metrics")


def _doc_id(text: str, prefix: str) -> str:
    return prefix + hashlib.md5(text.encode("utf-8")).hexdigest()[:12]


def build_corpus_qrels(
    pairs: list[dict], neg_per_pair: int = 10,
) -> tuple[dict[str, str], dict[str, str], dict[str, dict[str, int]]]:
    """Build corpus (dedup passages) + queries + qrels from Mmarco pairs.

    Each pair has ~1000 negatives (MS MARCO hard negatives); cap at
    neg_per_pair to keep the corpus small (default 10 -> enough distractors
    without ingesting 20k passages).
    """
    corpus: dict[str, str] = {}
    queries: dict[str, str] = {}
    qrels: dict[str, dict[str, int]] = {}
    for i, pair in enumerate(pairs):
        qid = f"q{i}"
        queries[qid] = pair["query"]
        qrels[qid] = {}
        pos = pair["positive"][0] if isinstance(pair["positive"], list) else pair["positive"]
        if pos:
            pid = _doc_id(pos, "p")
            corpus[pid] = pos
            qrels[qid][pid] = 1
        negs = pair["negative"] if isinstance(pair["negative"], list) else [pair["negative"]]
        for neg in negs[:neg_per_pair]:
            if neg:
                nid = _doc_id(neg, "n")
                corpus[nid] = neg
    return corpus, queries, qrels


def _get_store():
    from app.infra.config import config
    from app.repository.vector_store_milvus import MilvusVectorStore
    from app.services.rag import get_rag_service

    rag = get_rag_service()
    # New MilvusVectorStore bound to the isolated mmarco_eval collection.
    return MilvusVectorStore(config.milvus, rag.embeddings, COLLECTION)


def _drop_collection() -> None:
    """Drop mmarco_eval if it exists (so re-ingest is clean, no duplicates)."""
    from app.infra.config import config
    from pymilvus import MilvusClient

    client = MilvusClient(uri=config.milvus.uri, token=config.milvus.token or None)
    try:
        if client.has_collection(COLLECTION):
            client.drop_collection(COLLECTION)
            print(f"已 drop 旧 {COLLECTION} (干净重入库)")
    finally:
        client.close()


def ingest(limit: Optional[int] = None) -> None:
    from app.test.rag.fetch_hf import load_reranking_pairs

    pairs = load_reranking_pairs(DATA_DIR, "dev")
    if limit:
        pairs = pairs[:limit]
    corpus, queries, qrels = build_corpus_qrels(pairs)
    print(f"入库 {len(corpus)} passage (去重) -> {COLLECTION}, queries={len(queries)}")

    _drop_collection()
    store = _get_store()
    docs = [
        Document(
            page_content=text,
            metadata={
                "bvid": did,
                "title": did,
                "page_index": 0,
                "chunk_index": 0,
                "source": "mmarco",
            },
        )
        for did, text in corpus.items()
    ]
    store.add(docs)
    with open(QRELS_PATH, "w", encoding="utf-8") as f:
        json.dump({"queries": queries, "qrels": qrels}, f, ensure_ascii=False)
    print(f"入库完成, qrels -> {QRELS_PATH}")


def _recall_at_k(retrieved_ids: list[str], relevant: set[str], k: int) -> float:
    return 1.0 if (set(retrieved_ids[:k]) & relevant) else 0.0


def _ndcg_at_k(retrieved_ids: list[str], relevant: set[str], k: int) -> float:
    # Binary relevance; each query has exactly 1 positive in this dataset.
    dcg = 0.0
    for i, did in enumerate(retrieved_ids[:k]):
        if did in relevant:
            dcg += 1.0 / math.log2(i + 2)
    idcg = 1.0 / math.log2(2) if relevant else 0.0
    return dcg / idcg if idcg > 0 else 0.0


def plot_eval_results(
    results: dict[str, tuple[float, float]],
    k: int,
    out_dir: str,
) -> None:
    """Bar chart of Recall@k / NDCG@k per strategy (unified via plot_utils)."""
    try:
        from app.test.rag.plot_utils import plot_strategy_comparison

        plot_strategy_comparison(
            strategies=list(results.keys()),
            metrics_dict={
                f"Recall@{k}": [results[s][0] for s in results],
                f"NDCG@{k}": [results[s][1] for s in results],
            },
            title=f"RAG 检索评测 (k={k})",
            out_name=f"retrieval_mmarco_k{k}",
        )
    except ImportError:
        print("matplotlib 未安装, 跳过画图: pip install matplotlib")


def evaluate(strategies: list[str], k: int, limit: Optional[int] = None, hybrid: bool = False) -> None:
    from app.services.rag.rerank import Reranker

    if not os.path.exists(QRELS_PATH):
        print("qrels.json 不存在, 先跑 --ingest", file=sys.stderr)
        sys.exit(1)
    with open(QRELS_PATH, encoding="utf-8") as f:
        meta = json.load(f)
    queries: dict[str, str] = meta["queries"]
    qrels: dict[str, dict[str, int]] = meta["qrels"]
    if limit:
        queries = dict(list(queries.items())[:limit])

    store = _get_store()
    reranker = Reranker.from_settings()
    recall_n = max(k * 6, 30)  # over-recall pool for rerank

    print(f"\n端到端评测: {len(queries)} query, k={k}, recall_n={recall_n}")
    results: dict[str, tuple[float, float]] = {}
    for s in strategies:
        rec_sum = 0.0
        ndcg_sum = 0.0
        for qid, query in queries.items():
            relevant = set(qrels.get(qid, {}).keys())
            if not relevant:
                continue
            if hybrid:
                docs = store.hybrid_search(query, k=recall_n)
            else:
                docs = store.search(query, k=recall_n)
            docs = reranker.rerank(query, docs, top_k=k, strategy=s)
            retrieved = [d.metadata.get("bvid", "") for d in docs]
            rec_sum += _recall_at_k(retrieved, relevant, k)
            ndcg_sum += _ndcg_at_k(retrieved, relevant, k)
        n = len(queries)
        results[s] = (rec_sum / n, ndcg_sum / n)

    print(f"\n{'strategy':<14} {'Recall@k':<10} {'NDCG@k':<10}")
    print("-" * 36)
    for s in strategies:
        rec, ndcg = results[s]
        print(f"{s:<14} {rec:<10.2%} {ndcg:<10.2%}")
    print()

    plot_eval_results(results, k, METRICS_DIR)


def cleanup() -> None:
    _drop_collection()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Mmarco 端到端 RAG 评测 (入库 + 检索 + Recall@k/NDCG@k)",
    )
    parser.add_argument("--ingest", action="store_true", help="入库 Mmarco -> mmarco_eval")
    parser.add_argument("--eval", action="store_true", help="检索评测 Recall@k/NDCG@k")
    parser.add_argument("--strategies", default="null,dashscope,hybrid,mmr")
    parser.add_argument("--k", type=int, default=5)
    parser.add_argument("--limit", type=int, default=None, help="限制 pair/query 数 (debug)")
    parser.add_argument("--cleanup", action="store_true", help="drop mmarco_eval collection")
    parser.add_argument(
        "--hybrid",
        action="store_true",
        help="召回用 hybrid_search (向量+BM25+RRF), 需新 schema collection",
    )
    args = parser.parse_args()

    if args.ingest:
        ingest(args.limit)
    if args.eval:
        strategies = [s.strip() for s in args.strategies.split(",") if s.strip()]
        evaluate(strategies, args.k, args.limit, args.hybrid)
    if args.cleanup:
        cleanup()
    if not (args.ingest or args.eval or args.cleanup):
        parser.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
