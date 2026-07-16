"""RAG evaluation harness.

Lightweight, offline evaluation framework for the MindBase retrieval +
generation pipeline. See ``app/test/eval/README.md`` for usage.

The harness deliberately avoids heavy frameworks (ragas, langchain-eval,
arize) and depends only on stdlib + the project's existing LLM/embedding
infrastructure.
"""
