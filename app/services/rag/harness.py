"""Agent-driven chat harness.

Replaces keyword-based routing in the chat router with a planner LLM that
decides — at each step — whether to (a) call the ``search_knowledge`` tool
to gather more context, or (b) emit the final answer.  The harness:

  * Loops up to ``max_hops`` times.  When the budget is exhausted the
    planner is forced into ``answer_directly`` mode.
  * Honours retrieval scope hints (cloud only / bilibili only / both) but
    treats them as suggestions — when the planner does not pick one, the
    underlying ``RAGService.search`` will search every available backend.
  * Injects recent chat history so multi-turn references ("rate my CV
    again") work without keyword matching.
  * Records a ``ReasoningStep`` trail for the agentic endpoint.

The planner JSON contract is intentionally tiny so cheaper models can
follow it reliably:

    {"action": "search", "query": "...", "scope": "cloud|video|both", "reason": "..."}
    {"action": "answer", "reason": "..."}

Anything else is treated as ``answer`` (fail-closed: never loop forever).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, AsyncGenerator, Optional

from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.documents import Document
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.outputs import LLMResult
from loguru import logger

from app.services.rag.legacy import RAGService


_PLANNER_SYSTEM_PROMPT = """You are the dispatcher of a personal knowledge-base assistant.
The user's knowledge base may contain Bilibili video transcripts and uploaded
cloud-drive documents (PDF, Word, markdown, …).  At every step you decide ONE
action to take.

Reply with a single JSON object — no prose, no markdown — using exactly one of
these schemas:

  {"action": "search", "query": "<query string>", "scope": "<cloud|video|both>", "reason": "<short rationale>"}
  {"action": "answer", "reason": "<short rationale>"}

Guidelines:
- Use ``search`` when the answer plausibly depends on the user's stored
  videos or documents (mentions of "my CV / 简历 / 文件 / docx / 视频 /
  收藏夹 / up主" all qualify, but DO NOT keyword-match — judge holistically).
- Use ``answer`` for greetings, thanks, generic knowledge questions that
  clearly do not need the knowledge base, OR after enough context has been
  collected, OR when prior search hops returned nothing relevant.
- Reformulate the query when previous hops missed — try a different angle,
  a synonym, or a sub-question.  Do not repeat an identical query.
- Pick ``scope=cloud`` for document/file-style questions, ``scope=video``
  for transcript-style questions, ``scope=both`` when unsure.
- Never invent metadata about the user.  Reasoning should stay short.
"""


_FINAL_ANSWER_SYSTEM_PROMPT = """You are the user's knowledge-base assistant.

You have already decided to answer.  Use the retrieved context blocks if
they are relevant; otherwise answer from general knowledge and clearly note
the knowledge base did not contain related material.  Always reply in the
user's language (default: Chinese).  Do NOT fabricate citations.
"""


@dataclass
class HistoryTurn:
    role: str
    content: str


@dataclass
class HarnessReasoningStep:
    step: int
    action: str
    query: str = ""
    scope: str = ""
    reason: str = ""
    sources: list[dict[str, Any]] = field(default_factory=list)
    content_preview: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "step": self.step,
            "action": self.action,
            "query": self.query,
            "scope": self.scope,
            "reason": self.reason,
            "sources": self.sources,
            "content_preview": self.content_preview,
        }


@dataclass
class HarnessResult:
    answer: str
    sources: list[dict[str, Any]]
    reasoning_steps: list[HarnessReasoningStep]
    hops_used: int
    total_tokens: int
    final_messages: list[Any]


class _TokenCapture(BaseCallbackHandler):
    """LangChain callback that totals tokens across multiple LLM invocations."""

    def __init__(self) -> None:
        self.total_tokens = 0

    def on_llm_end(self, response: LLMResult, **_: Any) -> None:
        if response.llm_output:
            tu = response.llm_output.get("token_usage") or {}
            t = tu.get("total_tokens", 0)
            if t:
                self.total_tokens += t
                return
        try:
            msg = response.generations[0][0].message
            um = getattr(msg, "usage_metadata", None) or {}
            t = um.get("total_tokens", 0)
            if t:
                self.total_tokens += t
        except (IndexError, AttributeError, TypeError):
            pass


def _format_history(history: list[HistoryTurn], limit: int = 6) -> str:
    if not history:
        return "(none)"
    recent = history[-limit:]
    lines: list[str] = []
    for turn in recent:
        role = "User" if turn.role == "user" else "Assistant"
        snippet = (turn.content or "").strip().replace("\n", " ")
        if len(snippet) > 400:
            snippet = snippet[:400] + "…"
        lines.append(f"{role}: {snippet}")
    return "\n".join(lines)


def _format_collected_context(blocks: list[str], limit_chars: int = 1600) -> str:
    if not blocks:
        return "(no retrieved context yet)"
    joined = "\n\n---\n\n".join(blocks)
    if len(joined) > limit_chars:
        joined = joined[-limit_chars:]
    return joined


_PLAN_JSON_RE = re.compile(r"\{.*\}", re.DOTALL)


def _parse_plan(raw: str) -> dict[str, Any]:
    if not raw:
        return {"action": "answer", "reason": "empty plan response"}
    match = _PLAN_JSON_RE.search(raw)
    if not match:
        return {"action": "answer", "reason": "no JSON in plan response"}
    try:
        plan = json.loads(match.group(0))
    except json.JSONDecodeError:
        return {"action": "answer", "reason": "plan JSON malformed"}
    if not isinstance(plan, dict):
        return {"action": "answer", "reason": "plan not an object"}
    action = plan.get("action")
    if action not in {"search", "answer"}:
        return {"action": "answer", "reason": "unknown action"}
    return plan


def _docs_to_context(
    docs: list[Document],
) -> tuple[str, list[dict[str, Any]]]:
    parts: list[str] = []
    sources: list[dict[str, Any]] = []
    seen_keys: set[str] = set()
    for doc in docs:
        meta = doc.metadata or {}
        title = meta.get("title") or meta.get("filename") or "未知来源"
        bvid = meta.get("bvid") or ""
        upload_uuid = meta.get("upload_uuid") or ""
        key = upload_uuid or bvid
        content = (doc.page_content or "").strip()
        if content:
            parts.append(f"【{title}】\n{content}")
        if key and key not in seen_keys:
            seen_keys.add(key)
            entry: dict[str, Any] = {"title": title}
            if bvid:
                entry["bvid"] = bvid
                entry["url"] = meta.get(
                    "url", f"https://www.bilibili.com/video/{bvid}"
                )
            if upload_uuid:
                entry["upload_uuid"] = upload_uuid
            sources.append(entry)
    return "\n\n".join(parts), sources


class ChatHarness:
    """Planner-driven RAG dispatcher.

    The harness owns no router state on its own — callers (the chat
    endpoints) hand in the preconfigured ``RAGService``, the LLM, optional
    bvid / workspace scope, and the history.  Everything else (which tool
    to call, how many hops to run, when to stop) is decided by the planner.
    """

    def __init__(
        self,
        *,
        rag: RAGService,
        planner_llm: Any,
        answer_llm: Any,
        max_hops: int = 3,
        retrieval_k: int = 5,
    ) -> None:
        self.rag = rag
        self.planner_llm = planner_llm
        self.answer_llm = answer_llm
        self.max_hops = max(1, max_hops)
        self.retrieval_k = retrieval_k

    async def _plan(
        self,
        question: str,
        history: list[HistoryTurn],
        collected: list[str],
        prev_steps: list[HarnessReasoningStep],
        force_answer: bool,
        token_cb: _TokenCapture,
    ) -> dict[str, Any]:
        if force_answer:
            return {
                "action": "answer",
                "reason": "max hop budget reached, answering with whatever was collected",
            }

        history_block = _format_history(history)
        context_block = _format_collected_context(collected)
        prior_block = "\n".join(
            f"- step {s.step} {s.action}: query={s.query!r} scope={s.scope!r} reason={s.reason!r}"
            for s in prev_steps
        ) or "(none)"

        user_prompt = (
            f"Recent conversation:\n{history_block}\n\n"
            f"Current user question:\n{question}\n\n"
            f"Previously executed steps:\n{prior_block}\n\n"
            f"Context retrieved so far:\n{context_block}\n\n"
            "Decide the next action."
        )
        messages = [
            SystemMessage(content=_PLANNER_SYSTEM_PROMPT),
            HumanMessage(content=user_prompt),
        ]
        try:
            resp = await self.planner_llm.ainvoke(
                messages, config={"callbacks": [token_cb]}
            )
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("[HARNESS] planner call failed: {}", exc)
            return {"action": "answer", "reason": f"planner error: {exc}"}
        return _parse_plan(getattr(resp, "content", "") or "")

    def _run_search(
        self,
        query: str,
        scope: str,
        bvids: Optional[list[str]],
        workspace_pages: Optional[list[dict[str, Any]]],
        uid: Optional[int],
    ) -> tuple[str, list[dict[str, Any]]]:
        """Run a search hop.  ``scope`` is advisory — currently the
        underlying ``RAGService.search`` searches all configured backends
        and we filter the result list to the requested scope post-hoc."""

        try:
            docs = self.rag.search(
                query,
                k=self.retrieval_k,
                bvids=bvids,
                workspace_pages=workspace_pages,
                uid=uid,
            )
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("[HARNESS] search failed: {}", exc)
            return "", []

        if scope == "cloud":
            docs = [d for d in docs if (d.metadata or {}).get("upload_uuid")]
        elif scope == "video":
            docs = [d for d in docs if (d.metadata or {}).get("bvid")]

        return _docs_to_context(docs)

    def _build_final_messages(
        self,
        question: str,
        history: list[HistoryTurn],
        collected: list[str],
    ) -> list[Any]:
        history_block = _format_history(history)
        context_block = _format_collected_context(collected)
        system = (
            f"{_FINAL_ANSWER_SYSTEM_PROMPT}\n\n"
            f"Recent conversation:\n{history_block}\n\n"
            f"Knowledge-base context:\n{context_block}"
        )
        return [
            SystemMessage(content=system),
            HumanMessage(content=question),
        ]

    async def run(
        self,
        *,
        question: str,
        history: Optional[list[HistoryTurn]] = None,
        bvids: Optional[list[str]] = None,
        workspace_pages: Optional[list[dict[str, Any]]] = None,
        uid: Optional[int] = None,
        stream_answer: bool = False,
    ) -> HarnessResult:
        """Execute the planner loop.

        When ``stream_answer`` is ``True`` the final synthesis is NOT
        executed here; the caller is expected to consume
        ``result.final_messages`` via ``llm.astream(...)``.  ``answer``
        will be empty in that case.
        """

        history = history or []
        collected_blocks: list[str] = []
        all_sources: list[dict[str, Any]] = []
        seen_source_keys: set[str] = set()
        steps: list[HarnessReasoningStep] = []
        token_cb = _TokenCapture()

        attempted_queries: set[str] = set()
        force_answer = False

        for hop in range(self.max_hops):
            plan = await self._plan(
                question=question,
                history=history,
                collected=collected_blocks,
                prev_steps=steps,
                force_answer=force_answer,
                token_cb=token_cb,
            )
            action = plan.get("action", "answer")
            reason = str(plan.get("reason", "") or "")

            if action == "answer":
                steps.append(
                    HarnessReasoningStep(
                        step=hop + 1,
                        action="answer",
                        reason=reason,
                    )
                )
                break

            query = str(plan.get("query") or question).strip() or question
            scope = str(plan.get("scope") or "both").lower()
            if scope not in {"cloud", "video", "both"}:
                scope = "both"

            if query in attempted_queries:
                steps.append(
                    HarnessReasoningStep(
                        step=hop + 1,
                        action="skip",
                        query=query,
                        scope=scope,
                        reason="duplicate query rejected",
                    )
                )
                force_answer = True
                continue
            attempted_queries.add(query)

            context, sources = self._run_search(
                query, scope, bvids, workspace_pages, uid
            )
            if context:
                collected_blocks.append(context)
            for src in sources:
                key = src.get("upload_uuid") or src.get("bvid")
                if key and key not in seen_source_keys:
                    seen_source_keys.add(key)
                    all_sources.append(src)

            preview = (context or "").strip().replace("\n", " ")
            if len(preview) > 240:
                preview = preview[:240] + "…"
            steps.append(
                HarnessReasoningStep(
                    step=hop + 1,
                    action="search",
                    query=query,
                    scope=scope,
                    reason=reason,
                    sources=sources[:3],
                    content_preview=preview,
                )
            )

            # If we are out of hop budget and still have not chosen
            # ``answer``, the next iteration will be forced.
            if hop + 1 >= self.max_hops:
                force_answer = True

        final_messages = self._build_final_messages(
            question, history, collected_blocks
        )

        if stream_answer:
            return HarnessResult(
                answer="",
                sources=all_sources,
                reasoning_steps=steps,
                hops_used=len(steps),
                total_tokens=token_cb.total_tokens,
                final_messages=final_messages,
            )

        try:
            resp = await self.answer_llm.ainvoke(
                final_messages, config={"callbacks": [token_cb]}
            )
            answer_text = str(getattr(resp, "content", "") or "")
        except Exception as exc:  # pragma: no cover - defensive
            logger.exception("[HARNESS] answer LLM call failed: {}", exc)
            answer_text = "抱歉，回答生成失败，请稍后重试。"

        return HarnessResult(
            answer=answer_text,
            sources=all_sources,
            reasoning_steps=steps,
            hops_used=len(steps),
            total_tokens=token_cb.total_tokens,
            final_messages=final_messages,
        )

    async def stream(
        self,
        *,
        question: str,
        history: Optional[list[HistoryTurn]] = None,
        bvids: Optional[list[str]] = None,
        workspace_pages: Optional[list[dict[str, Any]]] = None,
        uid: Optional[int] = None,
    ) -> AsyncGenerator[dict[str, Any], None]:
        """Yield streaming events.

        Events:
            {"type": "step", "step": HarnessReasoningStep.to_dict()}
            {"type": "chunk", "content": str}
            {"type": "sources", "sources": [...]}
            {"type": "done", "total_tokens": int}
        """

        result = await self.run(
            question=question,
            history=history,
            bvids=bvids,
            workspace_pages=workspace_pages,
            uid=uid,
            stream_answer=True,
        )
        for step in result.reasoning_steps:
            yield {"type": "step", "step": step.to_dict()}

        token_cb = _TokenCapture()
        try:
            async for chunk in self.answer_llm.astream(
                result.final_messages, config={"callbacks": [token_cb]}
            ):
                text = getattr(chunk, "content", "") or ""
                if text:
                    yield {"type": "chunk", "content": text}
        except Exception as exc:  # pragma: no cover - defensive
            logger.exception("[HARNESS] streaming answer failed: {}", exc)
            yield {"type": "error", "message": str(exc)}
            return

        yield {"type": "sources", "sources": result.sources}
        yield {
            "type": "done",
            "total_tokens": result.total_tokens + token_cb.total_tokens,
            "reasoning_steps": [s.to_dict() for s in result.reasoning_steps],
            "hops_used": result.hops_used,
        }
