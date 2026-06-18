# RAG Evaluation Harness

Lightweight, offline evaluation framework for the bilibili-rag retrieval +
generation pipeline. No external eval frameworks (ragas / arize / langchain-eval),
just stdlib + the project's existing LLM/embedding clients.

## What it measures

| Metric | Source | Range |
|---|---|---|
| `recall@5` | `metrics.recall_at_k` — top-5 retrieved bvids vs. `must_contain_bvid` | 0 / 1 per sample, mean across set |
| `precision@5` | fraction of top-5 chunks whose bvid is in `must_contain_bvid` | 0–1 |
| `answer_quality` | `judge.judge_answer` — LLM-as-Judge against `expected_answer_points` | 0–5 integer |
| `citation_accuracy` | bvids cited in answer that were actually retrieved | 0–1 |
| `keyword_hit_rate` | fraction of `must_contain_keywords` appearing in answer | 0–1 |
| `negative_keyword` | violation caps `answer_quality` at 1 | — |
| `latency_ms` | end-to-end pipeline time per sample | p50 / p95 / p99 |

## Running

Smallest sane run (5 samples, dry-run skips the judge LLM bill):

```bash
python -m app.test.eval.runner --tag smoke --samples 5 --dry-run
```

Full baseline:

```bash
python -m app.test.eval.runner --tag baseline
```

Filter to one category:

```bash
python -m app.test.eval.runner --tag baseline --category single_video
```

CLI flags:

| flag | default | meaning |
|---|---|---|
| `--tag` | (required) | label for the run id, e.g. `baseline`, `rerank-v2` |
| `--samples N` | 0 (all) | take only the first N samples after filtering |
| `--category X` | none | filter by GoldenSample.category |
| `--qid-prefix X` | none | filter by qid prefix |
| `--concurrency N` | 2 | judge LLM call concurrency |
| `--dry-run` | false | run pipeline + metrics, skip judge calls |

## Reports

Each run writes two files under `app/test/eval/reports/`:

- `<run_id>.json` — full machine-readable report (gitignored by default)
- `<run_id>.md`   — human summary, per-category breakdown, failure list

`run_id` format: `<tag>_<UTC yyyymmdd_HHMM>`. Reports starting with `baseline*`
are checked into git as historical anchors; everything else is local-only.

## Adding samples

Edit `app/test/eval/golden_set.jsonl`. One JSON object per line; `//` and `#`
lines are ignored. See the file header for field semantics.

Validation rules (enforced on load):

- `qid` must be unique
- `vector` scope rows must have at least one of `must_contain_bvid` /
  `must_contain_keywords`
- `category` and `scope` must be from the enums in `schema.py`

A healthy seed set is ~20 rows covering all six categories. Sample counts
below ~15 produce metric noise wider than typical pipeline improvements.

## Configuration

The judge LLM is intentionally separate from the system-under-test to
avoid same-model bias. Override via env vars:

| env var | default | purpose |
|---|---|---|
| `JUDGE__API_KEY` | falls back to `OPENAI_API_KEY`, then `LLM__API_KEY` | judge auth |
| `JUDGE__BASE_URL` | `https://api.openai.com/v1` | judge endpoint |
| `JUDGE__MODEL` | `settings.eval_llm_model` (`gpt-4o-mini`) | judge model |

The pipeline under test is built from the standard `RAGService` +
`ChatHarness` using the configured `llm.api_key` / `llm.model` — no special
test config needed.

## Comparing runs

P0 leaves diff-tooling out; for now use:

```bash
diff app/test/eval/reports/baseline_*.md \
     app/test/eval/reports/<new>.md
```

A formal diff CLI (regression detection, threshold gates) is a P1 follow-up.

## Known limits (P0 scope)

- No rerank step — reflects the production retrieval path as-is
- Judge runs synchronously per sample (concurrency limited by `--concurrency`)
- No CI gating — manually inspect the markdown report
- Judge crashes are caught and surfaced as `error` field, score forced to 0

See `architecture/0030eval/` (if present) for the longer-term roadmap.
