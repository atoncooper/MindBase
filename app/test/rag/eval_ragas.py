"""RAGAS 生成质量评测: RAG(检索 + rerank + LLM 生成) -> RAGAS 评生成质量.

默认测 3 个指标 (均无需 ground truth 答案):
  - Faithfulness:                         答案是否忠于 context (防幻觉)
  - Answer Relevancy:                      答案是否回答 query (防答非所问)
  - Context Precision (without reference): 检索 context 是否切题 (用答案作 proxy, 无 GT)
  --full 追加:
  - Summarization Score:                   答案对 context 的覆盖度 (reference_contexts=contexts)

注: Answer Relevancy 对"话题陈述式 query"(如 NFCorpus 标题型 query)会结构性偏低,
   诊断检索质量优先看 Context Precision (without reference)。

judge LLM 用 DashScope 不同 model (同源减偏倚): 生成 qwen3-max, judge qwen-plus.
后续拓展异源 judge: 改 _judge_llm() 用 OpenAI/Anthropic.

前置:
    pip install ragas datasets
    uid_eval collection 已入库 (eval_uid --ingest)

用法:
    python -m app.test.rag.eval_ragas --limit 20 --hybrid
    python -m app.test.rag.eval_ragas --limit 20          # 纯向量对比
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys

from loguru import logger

logger.remove()
logger.add(sys.stderr, level="WARNING")

from app.config import settings  # noqa: E402  (after logger config)

COLLECTION = "uid_eval"
JUDGE_MODEL = "qwen-plus"  # 同源不同 model, 减偏倚 (生成用 settings.llm_model = qwen3-max)
# Faithfulness does long claim-extraction; a low default cap truncates the judge
# output and raises IncompleteOutputException. 8192 is qwen-plus's output ceiling.
JUDGE_MAX_TOKENS = 8192
META_PATH = os.path.join(os.path.dirname(__file__), "data", "uid_eval_meta.json")


def _get_store():
    from app.infra.config import config
    from app.repository.vector_store_milvus import MilvusVectorStore
    from app.services.rag import get_rag_service

    rag = get_rag_service()
    return MilvusVectorStore(config.milvus, rag.embeddings, COLLECTION, analyzer="standard")


def _gen_llm():
    from langchain_openai import ChatOpenAI

    return ChatOpenAI(
        api_key=settings.openai_api_key,
        base_url=settings.openai_base_url,
        model=settings.llm_model,  # qwen3-max
        temperature=0.3,
    )


def _judge_llm():
    """Judge LLM: 同源不同 model (qwen-plus). 后续拓展异源改这里."""
    from langchain_openai import ChatOpenAI

    return ChatOpenAI(
        api_key=settings.openai_api_key,
        base_url=settings.openai_base_url,
        model=JUDGE_MODEL,
        temperature=0,
        max_tokens=JUDGE_MAX_TOKENS,
        timeout=120,  # amp-2 fix: give slow judge calls (faithfulness long output) more headroom
        max_retries=3,  # amp-2 fix: auto-retry DashScope 429/transient timeouts -> fewer NaN cells
    )


def _load_queries(limit):
    with open(META_PATH, encoding="utf-8") as f:
        meta = json.load(f)
    queries = meta["queries"]
    uid_bvids = meta["uid_bvids"]
    doc_uid = meta["doc_uid"]
    qrels = meta["qrels"]
    # Only keep queries whose relevant docs are under a single uid (uid-scope findable).
    eval_queries = []
    for qid, query in queries.items():
        rel = set(qrels.get(qid, {}).keys())
        if not rel:
            continue
        uids = {doc_uid.get(d) for d in rel if doc_uid.get(d)}
        if len(uids) != 1:
            continue
        eval_queries.append((qid, query, uids.pop()))
    return eval_queries[:limit], uid_bvids


def rag_generate(query, store, reranker, uid, uid_bvids, k, hybrid, gen_llm):
    """One RAG turn: uid-scope retrieve -> rerank -> LLM generate answer."""
    scope_bvids = uid_bvids.get(uid, [])
    filter_cond = {"bvid": {"$in": scope_bvids}}
    recall_n = max(k * 6, 30)
    if hybrid:
        docs = store.hybrid_search(query, k=recall_n, filter=filter_cond)
    else:
        docs = store.search(query, k=recall_n, filter=filter_cond)
    docs = reranker.rerank(query, docs, top_k=k, strategy="dashscope")
    # Prefix each chunk with its 【title】 source marker (mirrors production
    # vector_search._format_docs) so the LLM can cite 【title】 per claim and
    # the citation is itself grounded in the context (helps faithfulness).
    # Score omitted vs production - eval probes generation grounding, not
    # retrieval ranking (that's eval_uid's job).
    contexts = [
        f"【{d.metadata.get('title', '未知标题')}】\n{d.page_content}"
        for d in docs
    ]

    context_text = "\n\n".join(contexts)[:6000]
    prompt = (
        "基于以下检索内容回答问题，综合多段相关信息给出切题的答案。\n\n"
        "## 回答规则\n"
        "1. 针对问题作答：整合检索内容中与问题相关的信息，组织成连贯的答案，不要泛泛复述检索内容\n"
        "2. 每条事实陈述后用【标题】标注来源，标题即检索内容开头的【】来源标记\n"
        "3. 不使用检索内容外的知识补充细节，即使你知道答案；但可以基于检索内容做合理归纳与概括\n"
        "4. 检索内容部分覆盖问题时：基于已覆盖的部分给出回答，并简述缺失的方面；"
        "仅当检索内容与问题完全无关时，回复：根据已有内容无法回答该问题\n\n"
        f"## 检索内容\n{context_text}\n\n"
        f"## 问题\n{query}"
    )
    answer = gen_llm.invoke(prompt).content
    return answer, contexts


def main() -> int:
    parser = argparse.ArgumentParser(description="RAGAS 生成质量评测")
    parser.add_argument("--limit", type=int, default=20, help="query 数 (default 20)")
    parser.add_argument("--k", type=int, default=5, help="检索 top_k (default 5)")
    parser.add_argument("--hybrid", action="store_true", help="召回用 hybrid_search")
    parser.add_argument(
        "--full",
        action="store_true",
        help="追加 SummarizationScore (更重, 每行多调 judge LLM)",
    )
    args = parser.parse_args()

    from app.services.rag.rerank import Reranker

    store = _get_store()
    reranker = Reranker.from_settings()
    gen_llm = _gen_llm()
    eval_queries, uid_bvids = _load_queries(args.limit)
    print(
        f"\nRAGAS 生成评测: {len(eval_queries)} query, k={args.k}, hybrid={args.hybrid}\n"
        f"  生成 LLM: {settings.llm_model}\n"
        f"  judge LLM: {JUDGE_MODEL} (同源不同 model, 减偏倚)"
    )

    # 1. RAG: 每个 query 生成答案 + 拿 context
    print("\n[1/2] RAG 生成答案中...")
    # reference_contexts == contexts (SummarizationScore 把它当"应被覆盖的源文"用)
    data = {"question": [], "answer": [], "contexts": [], "reference_contexts": []}
    # Per-query error isolation: a single API error / rate-limit / None content
    # must NOT abort the whole run and waste already-generated answers. Failed
    # queries are skipped (excluded from the RAGAS dataset) and reported at the
    # end; None content is treated as failure because ragas expects str answers.
    failed: list[tuple[int, str, str]] = []
    for i, (qid, query, uid) in enumerate(eval_queries, 1):
        try:
            answer, contexts = rag_generate(
                query, store, reranker, uid, uid_bvids, args.k, args.hybrid, gen_llm
            )
        except Exception as e:  # noqa: BLE001 - isolate per-query failures
            failed.append((i, query, f"{type(e).__name__}: {e}"))
            print(f"  [{i}/{len(eval_queries)}] FAILED (skipped): {type(e).__name__}: {e}")
            continue
        if answer is None:
            failed.append((i, query, "gen_llm returned None content"))
            print(f"  [{i}/{len(eval_queries)}] FAILED (skipped): None content")
            continue
        data["question"].append(query)
        data["answer"].append(answer)
        data["contexts"].append(contexts)
        data["reference_contexts"].append(contexts)
        print(f"  [{i}/{len(eval_queries)}] query: {query[:50]}...")

    if failed:
        print(
            f"\n⚠️ {len(failed)}/{len(eval_queries)} query 生成失败, 已跳过 (不计入 RAGAS):"
        )
        for idx, q, err in failed:
            print(f"  [{idx}] {err}  q={q[:50]!r}")
    if not data["question"]:
        print("\n所有 query 生成失败, 跳过 RAGAS 评估")
        return 1

    # 2. RAGAS 评估
    print("\n[2/2] RAGAS 评估中 (调 judge LLM, 每query多次调用, 可能需几分钟)...")
    try:
        from datasets import Dataset
        from ragas import evaluate

        # RAGAS 0.4.x compat (verified against 0.4.3):
        # - evaluate() only accepts LEGACY ragas.metrics classes (isinstance Metric);
        #   the newer ragas.metrics.collections.* are rejected by evaluate().
        # - Legacy AnswerRelevancy needs embeddings exposing langchain-style
        #   embed_query; LangchainEmbeddingsWrapper exposes both embed_query and
        #   embed_text, so it satisfies the metric regardless of which it calls.
        # - Judge LLM = LangchainLLMWrapper(ChatOpenAI(max_tokens=...)) for full
        #   control of output length (fixes IncompleteOutputException on Faithfulness).
        try:
            from ragas.metrics import (
                AnswerRelevancy,
                Faithfulness,
                LLMContextPrecisionWithoutReference,
            )

            metrics_classes = True
        except (ImportError, AttributeError):
            # v0.1: module-level metric singletons (no ContextPrecisionWithoutReference)
            from ragas.metrics import answer_relevancy, faithfulness

            metrics_classes = False

        # SummarizationScore is heavier (keyphrase extract + Q/A gen per row); opt-in.
        summarization_cls = None
        if args.full:
            try:
                from ragas.metrics import SummarizationScore

                summarization_cls = SummarizationScore
            except (ImportError, AttributeError):
                pass

        # DashScope is OpenAI-compatible; reuse the project's embeddings (text-embedding-v4)
        from app.services.rag import get_rag_service

        rag_embeddings = get_rag_service().embeddings
        try:
            from ragas.embeddings import LangchainEmbeddingsWrapper
            from ragas.llms import LangchainLLMWrapper

            judge_for_ragas = LangchainLLMWrapper(_judge_llm())
            embeddings_for_ragas = LangchainEmbeddingsWrapper(rag_embeddings)
        except (ImportError, AttributeError):
            # Fallback (very old ragas): raw langchain objects
            judge_for_ragas = _judge_llm()
            embeddings_for_ragas = rag_embeddings

        if metrics_classes:
            # All three are no-ground-truth. ContextPrecisionWithoutReference
            # judges retrieved-context relevance using the answer as proxy,
            # directly probing retrieval quality (no embeddings needed).
            metrics_list = [
                Faithfulness(llm=judge_for_ragas),
                AnswerRelevancy(llm=judge_for_ragas, embeddings=embeddings_for_ragas),
                LLMContextPrecisionWithoutReference(llm=judge_for_ragas),
            ]
            if summarization_cls is not None:
                metrics_list.append(summarization_cls(llm=judge_for_ragas))
        else:
            metrics_list = [faithfulness, answer_relevancy]

        ds = Dataset.from_dict(data)
        result = evaluate(
            ds,
            metrics=metrics_list,
            llm=judge_for_ragas,
            embeddings=embeddings_for_ragas,
        )
        print(f"\n{'='*45}")
        print(f"{'指标':<25} {'分数'}")
        print(f"{'-'*45}")
        # Per-cell skipna: a timed-out (NaN) metric cell is excluded from THAT
        # metric's mean (pandas .mean() skipna=True default), never counted as 0.
        # This meets "timeout 不进分母" without dropping whole queries whose other
        # metrics timed out -- per-query exclusion was biased (it dropped the best
        # relevancy rows because detailed answers -> slow faithfulness -> timeout).
        try:
            df = result.to_pandas()
            result_dict = {}
            for c in df.columns:
                try:
                    result_dict[c] = float(df[c].mean())
                except (TypeError, ValueError):
                    pass
        except Exception:
            # Fallback to ragas's own aggregate (per-cell skipna) if to_pandas fails
            result_dict = getattr(result, "_repr_dict", None) or {}
        metrics_float: dict[str, float] = {}
        for mk, mv in result_dict.items():
            try:
                fv = float(mv)
            except (TypeError, ValueError):
                print(f"{mk:<25} {mv}")
                continue
            if not math.isfinite(fv):
                # NaN/inf (e.g. SummarizationScore on a degenerate row) -- show but skip chart
                print(f"{mk:<25} {fv:.4f}  (NaN/inf, 不计入图表)")
                continue
            metrics_float[mk] = fv
            print(f"{mk:<25} {fv:.4f}")
        print(f"{'='*45}")
        print("\n解读: faithfulness 高=少幻觉; answer_relevancy 高=答切题; "
              "llm_context_precision_without_reference 高=检索切题; summarization_score 高=答案覆盖 context")

        # --- Per-row diagnostic + refusal-rate / cohort split (per-cell skipna) ---
        # Zero behavior change: only prints. Per-cell: a row stays in a metric's
        # cohort mean iff that metric computed (NaN cells skipped via _mean). We do
        # NOT drop whole queries when one metric times out -- that biased against
        # detailed (high-relevancy) answers whose slow faithfulness timed out.
        # NOTE: ragas 0.4.x EvaluationResult.to_pandas() returns ONLY metric
        # columns (no question/answer/contexts), so answer text comes from the
        # original `data` dict, aligned by row index with the metric frame.
        try:
            df = result.to_pandas()
            answers = list(data["answer"])
            questions = list(data["question"])
            n = min(len(answers), len(df))

            def _m(idx: int, name: str) -> float:
                try:
                    return float(df.iloc[idx][name])
                except Exception:
                    return float("nan")

            refuse = [
                str(answers[i]).startswith("根据已有内容无法回答") or "无法回答" in str(answers[i])
                for i in range(n)
            ]
            # per-cell NaN counts (transparency only); rows are NOT excluded wholesale
            nan_rel = sum(1 for i in range(n) if not math.isfinite(_m(i, "answer_relevancy")))
            nan_faith = sum(1 for i in range(n) if not math.isfinite(_m(i, "faithfulness")))

            print(f"\n{'-'*45}")
            print(
                f"per-row  (refuse={sum(refuse)}/{n} | "
                f"NaN cells: rel={nan_rel} faith={nan_faith} -> skipped per-cell, not as 0)"
            )
            for i in range(n):
                print(
                    f"[{i}] refuse={refuse[i]} "
                    f"faith={_m(i, 'faithfulness'):.2f} "
                    f"rel={_m(i, 'answer_relevancy'):.3f} "
                    f"q={str(questions[i])[:40]!r} "
                    f"ans={str(answers[i])[:60]!r}"
                )

            # cohorts = all answered / refused rows; _mean skips NaN per-cell
            ans_idx = [i for i in range(n) if not refuse[i]]
            ref_idx = [i for i in range(n) if refuse[i]]

            def _mean(idx_list, name):
                vals = [v for v in (_m(i, name) for i in idx_list) if math.isfinite(v)]
                return sum(vals) / len(vals) if vals else float("nan")

            if ans_idx:
                print(
                    f"answered cohort ({len(ans_idx)}): "
                    f"rel_mean={_mean(ans_idx, 'answer_relevancy'):.3f} "
                    f"faith_mean={_mean(ans_idx, 'faithfulness'):.3f}"
                )
            if ref_idx:
                print(
                    f"refused  cohort ({len(ref_idx)}): "
                    f"rel_mean={_mean(ref_idx, 'answer_relevancy'):.3f}"
                )
            print(f"{'-'*45}")
        except Exception as e:  # noqa: BLE001 - diagnostic must never break the run
            print(f"(per-row diagnostic skipped: {e})")

        # Unified chart via plot_utils
        try:
            from app.test.rag.plot_utils import plot_metrics_bar

            if metrics_float:
                plot_metrics_bar(
                    metrics=metrics_float,
                    title=f"RAGAS 生成评测 (hybrid={args.hybrid})",
                    out_name=f"generation_{'hybrid' if args.hybrid else 'vector'}_k{args.k}",
                )
        except ImportError:
            pass
    except ImportError as e:
        print(f"\n需安装 RAGAS: pip install ragas datasets\n(报错: {e})")
        return 1
    except Exception as e:
        print(f"\nRAGAS 评估失败: {e}")
        print("可能 RAGAS 版本 API 不同, 贴报错给我调")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
