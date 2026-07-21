"""Rerank 控制变量测试 CLI.

Fix the candidate pool + query, vary only the rerank strategy, and compare
the top-k ordering side by side. This is the controlled-variable harness
for A/B-ing rerank algorithms from the command line.

Usage:
    # Built-in fixture (no Milvus / no API key; dashscope will fallback)
    python -m app.test.rag.rerank_benchmark \\
        --query "猫的习性" --strategies null,dashscope,hybrid,mmr

    # Recall real candidates from Milvus (needs a live Milvus connection)
    python -m app.test.rag.rerank_benchmark \\
        --query "..." --from-milvus --bvids BV1xx,BV2xx

    # Single-algorithm smoke check
    python -m app.test.rag.rerank_benchmark --query "..." --strategies mmr --k 3
"""

from __future__ import annotations

import argparse
import os
import sys
from typing import Optional

from langchain_core.documents import Document

from app.services.rag.rerank import Reranker

# Ensure Chinese output renders on Windows consoles (GBK default stdout).
try:
    sys.stdout.reconfigure(encoding="utf-8")
except (AttributeError, ValueError):
    pass


# Fixed candidate pool (controlled variable): simulated video chunks with
# distinct titles / scores / overlap so each strategy produces visibly
# different orderings.
FIXTURE_DOCS: list[Document] = [
    Document(
        page_content="猫的习性 猫是夜行动物 喜欢捕猎小型猎物 独居动物",
        metadata={"bvid": "BV1", "title": "cats", "section_title": "", "score": 0.90},
    ),
    Document(
        page_content="狗的品种 拉布拉多 金毛 边牧 性格温顺 需要大量运动",
        metadata={"bvid": "BV2", "title": "dogs", "section_title": "", "score": 0.70},
    ),
    Document(
        page_content="鸟类观察 麻雀 燕子 候鸟迁徙 季节性出现",
        metadata={"bvid": "BV3", "title": "birds", "section_title": "", "score": 0.50},
    ),
    Document(
        page_content="猫的护理 猫粮 猫砂 定期疫苗 猫是夜行动物 独居动物",
        metadata={"bvid": "BV4", "title": "cats care", "section_title": "", "score": 0.60},
    ),
    Document(
        page_content="Python 编程基础 变量 函数 类 面向对象",
        metadata={"bvid": "BV5", "title": "python basics", "section_title": "", "score": 0.40},
    ),
]


def recall_from_fixture(recall_n: int) -> list[Document]:
    """Return the built-in candidate pool (no external dependencies)."""
    return list(FIXTURE_DOCS[:recall_n])


def recall_from_milvus(
    query: str, recall_n: int, bvids: Optional[list[str]]
) -> list[Document]:
    """Pure vector recall (bypasses rerank) to build a controlled candidate pool.

    Hits the Milvus backend directly so the candidate pool is NOT influenced
    by any rerank strategy - the controlled variable.
    """
    from app.services.rag import get_rag_service

    rag = get_rag_service()
    if rag.vectorstore is None:
        raise RuntimeError("Milvus vectorstore not initialized (check milvus.enabled)")
    filter_cond = {"bvid": {"$in": bvids}} if bvids else None
    return rag.vectorstore.search(query, k=recall_n, filter=filter_cond)


def _label(doc: Document) -> str:
    """One-line cell: bvid + title + whichever score the strategy wrote."""
    meta = doc.metadata or {}
    bvid = meta.get("bvid", "?")
    title = meta.get("title", "")
    score = (
        meta.get("rerank_score")
        or meta.get("final_score")
        or meta.get("score", 0)
    )
    try:
        score_str = f"{float(score):.2f}"
    except (TypeError, ValueError):
        score_str = str(score)
    return f"{bvid} {title} ({score_str})"


def plot_results(
    query: str,
    strategies: list[str],
    results: dict[str, list[Document]],
    k: int,
    out_path: str,
) -> None:
    """Save a side-by-side visualization of each strategy's top-k ordering.

    Two panels:
      1. Ordering table - strategy (row) x rank (col), cell = bvid + score.
      2. Score bars - each strategy's top-k scores grouped by rank.
    Requires matplotlib; silently skips if not installed.
    """
    try:
        import matplotlib

        matplotlib.use("Agg")  # headless backend (no display needed)
        import matplotlib.pyplot as plt
    except ImportError:
        print("matplotlib 未安装, 跳过可视化: pip install matplotlib")
        return

    plt.rcParams["font.sans-serif"] = [
        "SimHei",
        "Microsoft YaHei",
        "Arial",
        "DejaVu Sans",
    ]
    plt.rcParams["axes.unicode_minus"] = False

    fig, axes = plt.subplots(2, 1, figsize=(max(8, k * 3), 4 + 1.2 * len(strategies)))

    # Panel 1: ordering table (strategy x rank)
    ax = axes[0]
    ax.axis("off")
    cell_text = []
    for s in strategies:
        docs = results.get(s, [])
        cell_text.append(
            [_label(docs[i]) if i < len(docs) else "-" for i in range(k)]
        )
    table = ax.table(
        cellText=cell_text,
        rowLabels=strategies,
        colLabels=[f"rank {i + 1}" for i in range(k)],
        cellLoc="center",
        loc="center",
    )
    table.auto_set_font_size(False)
    table.set_fontsize(9)
    table.scale(1, 1.5)
    ax.set_title(f"Rerank 排序对比  query={query!r}", fontsize=10)

    # Panel 2: score bars grouped by rank
    ax = axes[1]
    x = list(range(len(strategies)))
    width = 0.8 / max(k, 1)
    for rank_i in range(k):
        scores = []
        for s in strategies:
            docs = results.get(s, [])
            if rank_i < len(docs):
                meta = docs[rank_i].metadata or {}
                sc = (
                    meta.get("rerank_score")
                    or meta.get("final_score")
                    or meta.get("score", 0)
                )
                try:
                    scores.append(float(sc))
                except (TypeError, ValueError):
                    scores.append(0.0)
            else:
                scores.append(0.0)
        ax.bar(
            [xi + rank_i * width for xi in x],
            scores,
            width,
            label=f"rank {rank_i + 1}",
        )
    ax.set_xticks([xi + width * (k - 1) / 2 for xi in x])
    ax.set_xticklabels(strategies)
    ax.set_ylabel("score")
    ax.set_title("各 strategy 的 top-k score")
    ax.legend(loc="upper right", fontsize=8)

    fig.tight_layout()
    fig.savefig(out_path, dpi=120, bbox_inches="tight")
    print(f"可视化已保存: {out_path}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Rerank 控制变量测试: 固定候选池, 对比各 strategy 排序",
    )
    parser.add_argument("--query", help="查询文本 (fixture/milvus 必填; mmarco 模式忽略)")
    parser.add_argument("--k", type=int, default=3, help="top_k (default 3)")
    parser.add_argument(
        "--strategies",
        default="null,dashscope,hybrid,mmr",
        help="逗号分隔的 strategy (default: null,dashscope,hybrid,mmr)",
    )
    parser.add_argument("--recall-n", type=int, default=30, help="候选池大小 (default 30)")
    parser.add_argument(
        "--from-milvus",
        action="store_true",
        help="从 Milvus 召回真实候选 (默认用内置 fixture)",
    )
    parser.add_argument(
        "--bvids",
        help="逗号分隔的 bvid, 限定召回范围 (--from-milvus 时)",
    )
    parser.add_argument(
        "--plot",
        default=None,
        help="可视化图片保存路径 (.png), 需 matplotlib",
    )
    parser.add_argument(
        "--from-mmarco",
        action="store_true",
        help="用 Mmarco-reranking dev 集做量化评测 (positive 排第一的比例)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=50,
        help="--from-mmarco 评测的对数上限 (default 50; dashscope 调用多, 可调小)",
    )
    args = parser.parse_args()

    strategies = [s.strip() for s in args.strategies.split(",") if s.strip()]
    bvids = (
        [b.strip() for b in args.bvids.split(",") if b.strip()]
        if args.bvids
        else None
    )

    if args.from_mmarco:
        # Quantitative eval: for each (query, positive, negative) pair, rerank
        # the 2-candidate pool (order randomized per pair) and check if positive
        # ranks #1. Accuracy = positive-ranked-first rate. null ~50% (random
        # order baseline); a good rerank should beat it.
        import random as _r
        from app.test.rag.fetch_hf import load_reranking_pairs

        data_dir = os.path.join(os.path.dirname(__file__), "data", "mmarco-reranking")
        pairs = load_reranking_pairs(data_dir, split="dev")[: args.limit]
        if not pairs:
            print("未找到 Mmarco 数据, 先跑: python -m app.test.rag.fetch_hf --summarize")
            return 1
        print(f"\nMmarco 量化评测: {len(pairs)} 对 (候选顺序随机, null baseline ~50%)")
        reranker = Reranker.from_settings()
        rng = _r.Random(42)
        correct: dict[str, int] = {s: 0 for s in strategies}
        for pair in pairs:
            pos_text = pair["positive"]
            neg_text = pair["negative"]
            if isinstance(pos_text, list):
                pos_text = pos_text[0] if pos_text else ""
            if isinstance(neg_text, list):
                neg_text = neg_text[0] if neg_text else ""
            pos = Document(page_content=pos_text, metadata={"label": "positive"})
            neg = Document(page_content=neg_text, metadata={"label": "negative"})
            candidates = [pos, neg] if rng.random() < 0.5 else [neg, pos]
            for s in strategies:
                ranked = reranker.rerank(pair["query"], candidates, top_k=1, strategy=s)
                if ranked and ranked[0].metadata.get("label") == "positive":
                    correct[s] += 1
        print(f"\n{'strategy':<15} {'accuracy':<10} {'correct/total'}")
        print("-" * 45)
        for s in strategies:
            acc = correct[s] / len(pairs) if pairs else 0.0
            print(f"{s:<15} {acc:<10.2%} {correct[s]}/{len(pairs)}")
        print()
        return 0

    # 1. Recall a FIXED candidate pool (controlled variable: identical for all
    #    strategies). Bypasses rerank so no strategy biases the pool.
    if args.from_milvus:
        candidates = recall_from_milvus(args.query, args.recall_n, bvids)
    else:
        candidates = recall_from_fixture(args.recall_n)

    print(f"\n查询: {args.query!r}")
    print(f"候选池: {len(candidates)} 条  |  k={args.k}  |  strategies={strategies}")
    if not candidates:
        print("候选池为空, 退出。")
        return 1

    # 2. One Reranker instance (params from settings); per-call `strategy=`
    #    overrides the algorithm without touching dashscope api key etc.
    reranker = Reranker.from_settings()

    # 3. Run each strategy over the SAME candidate pool.
    results: dict[str, list[Document]] = {}
    for s in strategies:
        try:
            results[s] = reranker.rerank(args.query, candidates, top_k=args.k, strategy=s)
        except Exception as exc:  # noqa: BLE001 - report and continue
            print(f"[{s}] 失败: {exc}")
            results[s] = []

    # 4. Side-by-side comparison.
    col_width = max((len(_label(d)) for docs in results.values() for d in docs), default=10)
    col_width = max(col_width, max(len(s) for s in strategies)) + 2

    header = f"{'rank':<5} " + "".join(f"{s:<{col_width}}" for s in strategies)
    print("\n" + header)
    print("-" * len(header))
    for i in range(args.k):
        row = f"{i + 1:<5} "
        for s in strategies:
            docs = results.get(s, [])
            cell = _label(docs[i]) if i < len(docs) else "-"
            row += f"{cell:<{col_width}}"
        print(row)
    print()

    if args.plot:
        plot_results(args.query, strategies, results, args.k, args.plot)
    return 0


if __name__ == "__main__":
    sys.exit(main())
