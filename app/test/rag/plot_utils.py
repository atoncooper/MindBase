"""Unified plotting utilities for RAG eval scripts.

All eval scripts (eval_uid / eval_ingest / eval_ragas / ...) should use these
helpers so charts share the same style:
  - Font: SimHei / Microsoft YaHei (CJK-friendly)
  - Color palette: consistent per-metric colors
  - Output: app/test/rag/metrics/<name>.png
"""

from __future__ import annotations

import os

METRICS_DIR = os.path.join(os.path.dirname(__file__), "metrics")

# Consistent color palette keyed by metric prefix (lowercase, before @).
COLORS = {
    "recall": "#4C72B0",        # blue
    "ndcg": "#55A868",          # green
    "pool": "#C44E52",          # red
    "faithfulness": "#8172B3",   # purple
    "answer_relevancy": "#CCB974",  # gold
    "context_precision": "#64B5CD",  # cyan
    "precision": "#64B5CD",
    "relevancy": "#CCB974",
    "final_score": "#DD8452",
    "rerank_score": "#DD8452",
}
DEFAULT_COLOR = "#888888"


def _setup():
    """Configure matplotlib for headless + CJK rendering. Returns the pyplot module."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    plt.rcParams["font.sans-serif"] = [
        "SimHei",
        "Microsoft YaHei",
        "Arial",
        "DejaVu Sans",
    ]
    plt.rcParams["axes.unicode_minus"] = False
    return plt


def _color_for(name: str) -> str:
    key = name.lower().split("@")[0].strip()
    return COLORS.get(key, DEFAULT_COLOR)


def _save(fig, plt, out_name: str) -> str:
    """Save a versioned copy (timestamp, for history) + a latest copy.

    out_name is the base filename (with or without .png). Produces:
      <stem>_<YYYYMMDD_HHMMSS>.png  (history, never overwritten)
      <stem>_latest.png              (latest, overwritten each run)
    Returns the latest path.
    """
    import datetime

    os.makedirs(METRICS_DIR, exist_ok=True)
    stem = out_name[:-4] if out_name.lower().endswith(".png") else out_name
    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    versioned = os.path.join(METRICS_DIR, f"{stem}_{ts}.png")
    latest = os.path.join(METRICS_DIR, f"{stem}_latest.png")
    fig.savefig(versioned, dpi=120, bbox_inches="tight")
    fig.savefig(latest, dpi=120, bbox_inches="tight")
    plt.close(fig)
    print(f"评测图(版本 {ts}): {versioned}")
    print(f"评测图(最新):     {latest}")
    return latest


def plot_metrics_bar(
    metrics: dict[str, float],
    title: str,
    out_name: str,
    ylabel: str = "score",
    ylim: tuple[float, float] = (0.0, 1.0),
) -> str:
    """Single-group bar chart: one bar per metric. metrics = {name: value}.

    e.g. RAGAS: {faithfulness: 0.85, answer_relevancy: 0.9, ...}
    """
    plt = _setup()
    os.makedirs(METRICS_DIR, exist_ok=True)
    names = list(metrics.keys())
    values = [float(metrics[n]) for n in names]
    colors = [_color_for(n) for n in names]

    fig, ax = plt.subplots(figsize=(max(8, len(names) * 1.6), 5))
    bars = ax.bar(names, values, color=colors)
    ax.set_ylabel(ylabel)
    ax.set_title(title)
    ax.set_ylim(*ylim)
    ax.set_xticks(range(len(names)))
    ax.set_xticklabels(names, rotation=0)
    for b in bars:
        ax.annotate(
            f"{b.get_height():.1%}",
            (b.get_x() + b.get_width() / 2, b.get_height()),
            ha="center",
            va="bottom",
            fontsize=9,
        )
    fig.tight_layout()
    return _save(fig, plt, out_name)


def plot_strategy_comparison(
    strategies: list[str],
    metrics_dict: dict[str, list[float]],
    title: str,
    out_name: str,
    ylim: tuple[float, float] = (0.0, 1.0),
) -> str:
    """Grouped bar chart: strategies (x) x metrics (groups).

    e.g. strategies=[null, dashscope], metrics={Recall@5: [0.4, 0.44], NDCG@5: [...]}
    """
    plt = _setup()
    os.makedirs(METRICS_DIR, exist_ok=True)
    n = len(strategies)
    metric_names = list(metrics_dict.keys())
    width = 0.8 / max(len(metric_names), 1)
    x = list(range(n))

    fig, ax = plt.subplots(figsize=(max(8, n * 1.6), 5))
    for i, mname in enumerate(metric_names):
        values = [float(v) for v in metrics_dict[mname]]
        color = _color_for(mname)
        bars = ax.bar(
            [xi + i * width for xi in x], values, width, label=mname, color=color
        )
        for b in bars:
            ax.annotate(
                f"{b.get_height():.0%}",
                (b.get_x() + b.get_width() / 2, b.get_height()),
                ha="center",
                va="bottom",
                fontsize=8,
            )
    ax.set_ylabel("score")
    ax.set_title(title)
    ax.set_xticks([xi + width * (len(metric_names) - 1) / 2 for xi in x])
    ax.set_xticklabels(strategies)
    ax.set_ylim(*ylim)
    ax.legend(loc="upper right", fontsize=9)
    fig.tight_layout()
    return _save(fig, plt, out_name)


__all__ = ["plot_metrics_bar", "plot_strategy_comparison", "METRICS_DIR"]
