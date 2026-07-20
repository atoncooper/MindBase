"""Download BEIR standard RAG evaluation datasets for controlled testing.

BEIR (Benchmarking IR) is the de-facto standard for evaluating retrieval /
rerank quality. This script downloads a small subset (NFCorpus by default) to
``app/test/rag/data/``, providing:
  - ``corpus.jsonl``   : {id, title, text}      -> candidate documents
  - ``queries.jsonl``  : {id, text}             -> test queries
  - ``qrels/<split>.tsv`` : query_id, doc_id, score -> relevance judgments

With qrels you can compute Recall@k / NDCG@k, enabling *quantitative* rerank
comparison instead of the fixture's qualitative side-by-side.

Usage:
    python -m app.test.rag.fetch_beir                      # nfcorpus -> data/nfcorpus
    python -m app.test.rag.fetch_beir --dataset scifact    # scifact (smaller)
    python -m app.test.rag.fetch_beir --summarize          # print stats after download

Loaders (for other tests):
    from app.test.rag.fetch_beir import load_corpus, load_queries, load_qrels
    corpus = load_corpus("app/test/rag/data/nfcorpus")
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import zipfile

import httpx

BEIR_BASE = "https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets"

# Small BEIR subsets suitable for local testing (smallest first).
DATASETS = {
    "arguana": f"{BEIR_BASE}/arguana.zip",    # ~10 MB, argument retrieval
    "scifact": f"{BEIR_BASE}/scifact.zip",     # ~20 MB, scientific, ~5k docs
    "nfcorpus": f"{BEIR_BASE}/nfcorpus.zip",   # ~30 MB, medical, ~3.6k docs, ~323 queries
}

DEFAULT_OUT = os.path.join(os.path.dirname(__file__), "data")


def download(dataset: str, out_dir: str) -> str:
    """Download + unzip a BEIR dataset. Returns the extracted dir path.

    Idempotent: skips download if the corpus already exists locally.
    """
    url = DATASETS.get(dataset)
    if url is None:
        raise ValueError(f"unknown dataset: {dataset}; pick one of {list(DATASETS)}")

    target_dir = os.path.join(out_dir, dataset)
    if os.path.isdir(target_dir) and os.path.exists(
        os.path.join(target_dir, "corpus.jsonl")
    ):
        print(f"已存在, 跳过下载: {target_dir}")
        return target_dir

    os.makedirs(out_dir, exist_ok=True)
    zip_path = os.path.join(out_dir, f"{dataset}.zip")
    print(f"下载 {url} -> {zip_path} (可能需 1-2 分钟)")

    with httpx.Client(timeout=600.0, follow_redirects=True) as client:
        with client.stream("GET", url) as resp:
            resp.raise_for_status()
            with open(zip_path, "wb") as f:
                for chunk in resp.iter_bytes():
                    f.write(chunk)

    print(f"解压 -> {target_dir}")
    with zipfile.ZipFile(zip_path) as z:
        z.extractall(out_dir)
    os.remove(zip_path)
    print(f"完成: {target_dir}")
    return target_dir


def _jsonl(path: str) -> list[dict]:
    rows: list[dict] = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def load_corpus(data_dir: str) -> dict[str, dict]:
    """Return {doc_id: {_id, title, text}}."""
    rows = _jsonl(os.path.join(data_dir, "corpus.jsonl"))
    return {r["_id"]: r for r in rows}


def load_queries(data_dir: str, split: str = "test") -> dict[str, str]:
    """Return {query_id: query_text}. Honors a ``split`` field if present."""
    path = os.path.join(data_dir, "queries.jsonl")
    rows = _jsonl(path)
    return {
        r["_id"]: r["text"]
        for r in rows
        if r.get("split", split) == split or "split" not in r
    }


def load_qrels(data_dir: str, split: str = "test") -> dict[str, dict[str, int]]:
    """Return {query_id: {doc_id: relevance_score}} from qrels/<split>.tsv."""
    path = os.path.join(data_dir, "qrels", f"{split}.tsv")
    qrels: dict[str, dict[str, int]] = {}
    with open(path, encoding="utf-8") as f:
        f.readline()  # header: query_id \t doc_id \t score
        for line in f:
            parts = line.strip().split("\t")
            if len(parts) < 3:
                continue
            qid, did, score = parts[0], parts[1], parts[2]
            try:
                qrels.setdefault(qid, {})[did] = int(score)
            except ValueError:
                continue
    return qrels


def summarize(data_dir: str) -> None:
    """Print dataset statistics."""
    corpus = load_corpus(data_dir)
    queries = load_queries(data_dir)
    qrels = load_qrels(data_dir)
    total_rel = sum(len(v) for v in qrels.values())
    print(f"\n统计 ({data_dir}):")
    print(f"  文档数:         {len(corpus)}")
    print(f"  query 数:       {len(queries)}")
    print(f"  qrels query 数: {len(qrels)}")
    print(f"  相关性标注条数: {total_rel}")


def main() -> int:
    parser = argparse.ArgumentParser(description="下载 BEIR 标准 RAG 评测数据集子集")
    parser.add_argument(
        "--dataset",
        default="nfcorpus",
        choices=list(DATASETS),
        help="数据集名 (default: nfcorpus)",
    )
    parser.add_argument("--out", default=DEFAULT_OUT, help="输出目录 (default: rag/data)")
    parser.add_argument("--summarize", action="store_true", help="下载后打印统计")
    args = parser.parse_args()

    try:
        target = download(args.dataset, args.out)
    except (httpx.HTTPError, OSError) as exc:
        print(f"下载失败: {exc}", file=sys.stderr)
        print(
            "提示: 若网络不通, 可手动下载 zip 放到 --out 目录后重跑 (会自动解压)",
            file=sys.stderr,
        )
        return 1

    if args.summarize:
        summarize(target)
    return 0


if __name__ == "__main__":
    sys.exit(main())
