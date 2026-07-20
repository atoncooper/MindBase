"""Download HuggingFace Chinese RAG evaluation datasets.

Companion to ``fetch_beir.py`` (which handles BEIR English zip downloads).
This one pulls Chinese datasets from the HuggingFace Hub via the ``datasets``
library.

Default: ``Mmarco-reranking-zh`` (C-MTEB) - Chinese MS MARCO reranking, ~12k
(query, positive, negative) pairs. The pair format matches ``rerank_benchmark``:
each query comes with a ready-made candidate pool (positive + negative), so no
need to synthesize candidates.

Usage:
    pip install datasets
    python -m app.test.rag.fetch_hf                         # mmarco-reranking-zh -> data/
    python -m app.test.rag.fetch_hf --summarize            # print stats

Loaders:
    from app.test.rag.fetch_hf import load_reranking_pairs
    pairs = load_reranking_pairs("app/test/rag/data/mmarco-reranking-zh")
    # each: {"query": str, "positive": str, "negative": str}
"""

from __future__ import annotations

import argparse
import json
import os
import sys

# HuggingFace dataset repo ids (verified via HF API: C-MTEB / mteb orgs).
HF_DATASETS = {
    "mmarco-reranking": "C-MTEB/Mmarco-reranking",        # MS MARCO 中文 rerank
    "cmedqa-v2-reranking": "C-MTEB/CMedQAv2-reranking",   # 中文医学 QA rerank
    "t2-reranking": "C-MTEB/T2Reranking",                  # 中文 T2 rerank
}

DEFAULT_OUT = os.path.join(os.path.dirname(__file__), "data")
SPLITS = ("dev", "test")


def download_hf(dataset: str, out_dir: str) -> str:
    """Download a HF dataset's dev/test splits to <out_dir>/<dataset>/*.jsonl.

    Idempotent: skips splits already on disk.
    """
    try:
        from datasets import load_dataset
    except ImportError:
        print(
            "需安装 datasets 库: pip install datasets",
            file=sys.stderr,
        )
        raise

    repo = HF_DATASETS[dataset]
    target = os.path.join(out_dir, dataset)
    os.makedirs(target, exist_ok=True)

    for split in SPLITS:
        path = os.path.join(target, f"{split}.jsonl")
        if os.path.exists(path):
            print(f"已存在, 跳过: {path}")
            continue
        try:
            ds = load_dataset(repo, split=split)
        except Exception as exc:  # noqa: BLE001 - split may not exist
            print(f"split {split} 下载失败 (可能不存在): {exc}")
            continue
        # Write explicitly as UTF-8 with ensure_ascii=False so Chinese stays
        # readable. datasets.to_json can pick the system encoding (GBK) on
        # Windows, garbling CJK content.
        with open(path, "w", encoding="utf-8") as f:
            for row in ds:
                f.write(json.dumps(dict(row), ensure_ascii=False, default=str) + "\n")
        print(f"{split}: {len(ds)} 条 -> {path}")
    return target


def _jsonl(path: str) -> list[dict]:
    rows: list[dict] = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def load_reranking_pairs(data_dir: str, split: str = "test") -> list[dict]:
    """Return list of {query, positive, negative} from <split>.jsonl."""
    return _jsonl(os.path.join(data_dir, f"{split}.jsonl"))


def summarize(data_dir: str) -> None:
    print(f"\n统计 ({data_dir}):")
    for split in SPLITS:
        path = os.path.join(data_dir, f"{split}.jsonl")
        if not os.path.exists(path):
            continue
        rows = _jsonl(path)
        print(f"  {split}: {len(rows)} 对")
        if rows:
            sample = rows[0]
            q = str(sample.get("query", ""))[:60]
            print(f"    样例 query: {q}")


def main() -> int:
    parser = argparse.ArgumentParser(description="下载 HuggingFace 中文 RAG 评测数据集")
    parser.add_argument(
        "--dataset",
        default="mmarco-reranking",
        choices=list(HF_DATASETS),
        help="数据集名 (default: mmarco-reranking)",
    )
    parser.add_argument("--out", default=DEFAULT_OUT, help="输出目录 (default: rag/data)")
    parser.add_argument("--summarize", action="store_true", help="下载后打印统计")
    args = parser.parse_args()

    try:
        target = download_hf(args.dataset, args.out)
    except Exception as exc:  # noqa: BLE001
        print(f"下载失败: {exc}", file=sys.stderr)
        print(
            "提示: 确认已 pip install datasets 且网络可访问 huggingface.co",
            file=sys.stderr,
        )
        return 1

    if args.summarize:
        summarize(target)
    return 0


if __name__ == "__main__":
    sys.exit(main())
