"""Conversation compression — keeps context within budget via summarization.

Model-agnostic: the caller injects a ``summarize_fn`` that accepts a list of
messages and returns a summary string.  This lets you swap in any LLM /
provider without touching the compression logic.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Protocol

from .models import ConversationMessage, count_turns

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------

#: SummarizeFn(old_messages, recent_messages, previous_summary) -> new_summary
SummarizeFn = Callable[
    [list[ConversationMessage], list[ConversationMessage], str | None],
    Awaitable[str],
]


class CompressCondition(Protocol):
    """Predicate that decides whether compression should fire."""

    def __call__(
        self,
        messages: list[ConversationMessage],
        summary: str | None,
        turns_since_last: int,
        last_compressed_at: float | None,
    ) -> bool: ...


# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------


@dataclass
class CompressionResult:
    """What comes out of a compression pass."""

    summary: str | None
    """Human-readable summary of old messages, or None if nothing was compressed."""

    kept_messages: list[ConversationMessage]
    """Messages that survived compression (recent window)."""

    compressed_count: int
    """How many messages were absorbed into the summary."""

    did_compress: bool = False
    """True if a summarization actually happened this pass."""


# ---------------------------------------------------------------------------
# Built-in conditions
# ---------------------------------------------------------------------------


@dataclass
class TurnThreshold:
    """Trigger when total turn count exceeds *max_turns*.

    Only fires if at least *cooldown_turns* have elapsed since the last
    compression to avoid summarising on every single message.
    """

    max_turns: int = 25
    cooldown_turns: int = 10

    def __call__(
        self,
        messages: list[ConversationMessage],
        summary: str | None,
        turns_since_last: int,
        last_compressed_at: float | None,
    ) -> bool:
        turns = count_turns(messages)
        if turns <= self.max_turns:
            return False
        # Cooldown only applies after the FIRST compression
        if last_compressed_at is not None and turns_since_last < self.cooldown_turns:
            return False
        return True


# ---------------------------------------------------------------------------
# Summarization prompt
# ---------------------------------------------------------------------------

#: Callable that sends messages to an LLM and returns the text response.
LlmInvoke = Callable[[list[dict[str, str]]], Awaitable[str]]

SUMMARIZE_SYSTEM_PROMPT = """\
你是对话历史压缩引擎。你负责将冗长的多轮对话压缩为一份结构化摘要，这份摘要将作为后续对话的上下文记忆注入给另一个 LLM。

## 核心目标
你的输出不是给人看的总结，而是给 LLM 看的记忆。LLM 需要依靠你的摘要来"回忆"之前发生过什么。因此信息密度是第一优先级——宁可多写一句，不可丢掉一个可能在后续被追问的事实。

## 输出格式
严格按以下结构输出（每项必填，无对应内容时写「无」）：

【讨论主题】
本轮旧对话围绕的核心话题，用一句话概括。

【关键实体】
旧对话中出现的具体名称——视频标题、技术名词、人名、项目名、文件名、URL、API 名称、配置项等。用顿号分隔。这些实体可能在后续对话中被用户再次提及，务必完整列出。

【用户意图】
用户在旧对话中想达成什么目标、解决什么问题、了解什么信息。如果用户意图有变化，描述意图的演变过程。

【已确认的事实与决策】
对话中明确确认的信息、数据、结论。用户做出的选择或决定。助手给出的确定性回答。用户对助手回答的反馈（满意/不满意/要求修正）。这些是后续对话不可与之矛盾的硬事实。

【待处理与未完成】
用户提出但尚未得到回答的问题。助手承诺但未执行的操作。用户表示"之后再说""下次处理"的事项。对话中被打断或转移的话题。

【摘要正文】
用 3-5 句话连贯地概述旧对话的完整脉络，包括：起因 → 讨论过程 → 当前进展。让 LLM 能在 5 秒内理解对话走到了哪里。

## 增量更新规则
如果用户消息中包含「历史摘要」章节，说明这不是第一次压缩。你必须将历史摘要中的有效信息与新对话合并，输出一份完整的最新摘要。规则：
- 历史摘要中仍然有效的事实 → 保留并整合到对应章节
- 历史摘要中已被新对话纠正的信息 → 用新信息替换
- 历史摘要中已不再相关的内容 → 移除
- 确保输出是独立完整的，不依赖历史摘要的存在

## 字数限制
总输出控制在 {max_chars} 字以内。优先保留事实性信息（实体、决策、待处理），必要时压缩描述性语言和摘要正文。

## 禁止事项
- 禁止编造旧对话中没有出现的信息
- 禁止总结「近期对话」部分（近期对话会在上下文中原样保留给 LLM，你只需要用它们理解语境）
- 禁止输出格式外的废话（如"好的，以下是你需要的摘要："）
- 如果旧对话仅有寒暄、表情、无意义重复，输出一行「[无实质内容]」
"""

SUMMARIZE_USER_TEMPLATE = """\
{previous_summary_section}
========== 以下旧对话需要压缩 ==========

{old_dialogue}

========== 近期对话（原样保留，仅供理解语境，不需要压缩）==========

{recent_dialogue}

请输出压缩后的结构化摘要："""


PREVIOUS_SUMMARY_SECTION = """\
========== 历史摘要（请与新对话合并更新）==========

{previous_summary}
"""


def _format_dialogue(messages: list[ConversationMessage]) -> str:
    """Format a message list as readable dialogue text."""
    if not messages:
        return "（无）"
    lines: list[str] = []
    for m in messages:
        role = "用户" if m.role == "user" else "助手"
        content = m.content.replace("\n", " ").strip()
        if len(content) > 500:
            content = content[:500] + "…"
        lines.append(f"{role}：{content}")
    return "\n\n".join(lines)


def build_summarize_fn(
    llm_invoke: LlmInvoke,
    *,
    max_chars: int = 550,
) -> SummarizeFn:
    """Build a ``SummarizeFn`` powered by *any* LLM backend.

    Args:
        llm_invoke: Async callable ``([{"role": ..., "content": ...}, ...]) -> str``.
                    Compatible with OpenAI, Anthropic, LangChain, Ollama, etc.
        max_chars: Soft cap on summary length, embedded in the system prompt.

    Returns:
        A ``SummarizeFn`` ready for ``ConversationCompressor.compress()``.
    """

    async def _summarize(
        old: list[ConversationMessage],
        recent: list[ConversationMessage],
        previous_summary: str | None,
    ) -> str:
        system = SUMMARIZE_SYSTEM_PROMPT.replace("{max_chars}", str(max_chars))

        prev_section = ""
        if previous_summary:
            prev_section = PREVIOUS_SUMMARY_SECTION.format(
                previous_summary=previous_summary
            )

        user_content = SUMMARIZE_USER_TEMPLATE.format(
            previous_summary_section=prev_section,
            old_dialogue=_format_dialogue(old),
            recent_dialogue=_format_dialogue(recent),
        )

        try:
            result = await llm_invoke(
                [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user_content},
                ]
            )
            text = result.strip()
            # Strip common LLM preambles
            for prefix in ("好的，", "好的", "以下是", "这是"):
                if text.startswith(prefix) and "\n" in text:
                    text = text.split("\n", 1)[1].strip()
            return text
        except Exception:
            logger.exception("summarize_fn call failed, falling back to truncation")
            return _format_dialogue(old[-6:])

    return _summarize


# ---------------------------------------------------------------------------
# Compressor
# ---------------------------------------------------------------------------


@dataclass
class ConversationCompressor:
    """Compresses old conversation messages into a periodic summary.

    The *recent* window is always preserved verbatim; older messages are
    handed to ``summarize_fn`` and replaced by a single summary string.

    Usage::

        compressor = ConversationCompressor(
            max_recent_turns=10,
            trigger=TurnThreshold(max_turns=25, cooldown_turns=10),
        )

        result = await compressor.compress(messages, summarize_fn)
        # result.summary  → structured summary
        # result.kept_messages → last ~10 turns (raw)
    """

    # ---- config ----------------------------------------------------------
    max_recent_turns: int = 10
    """How many of the *most-recent* turns are kept as raw messages."""

    trigger: CompressCondition = field(
        default_factory=lambda: TurnThreshold(max_turns=25, cooldown_turns=10)
    )
    """Decides *when* compression runs."""

    # ---- internal state --------------------------------------------------
    _summary: str | None = field(default=None, init=False, repr=False)
    _last_compressed_at: float | None = field(default=None, init=False, repr=False)
    _turns_since_last: int = field(default=0, init=False, repr=False)

    # ------------------------------------------------------------------
    # public API
    # ------------------------------------------------------------------

    async def compress(
        self,
        messages: list[ConversationMessage],
        summarize_fn: SummarizeFn,
    ) -> CompressionResult:
        """Run compression if the trigger condition is met.

        Args:
            messages: Full message list (oldest → newest).
            summarize_fn: Async callable that produces a summary.

        Returns:
            CompressionResult with the (possibly compressed) message list.
        """
        if not messages:
            return CompressionResult(
                summary=self._summary,
                kept_messages=[],
                compressed_count=0,
            )

        should = self.trigger(
            messages=messages,
            summary=self._summary,
            turns_since_last=self._turns_since_last,
            last_compressed_at=self._last_compressed_at,
        )

        if not should:
            self._turns_since_last += 1
            return CompressionResult(
                summary=self._summary,
                kept_messages=list(messages),
                compressed_count=0,
            )

        return await self._do_compress(messages, summarize_fn)

    async def force_compress(
        self,
        messages: list[ConversationMessage],
        summarize_fn: SummarizeFn,
    ) -> CompressionResult:
        """Compress regardless of trigger condition."""
        return await self._do_compress(messages, summarize_fn)

    # ------------------------------------------------------------------
    # internal
    # ------------------------------------------------------------------

    async def _do_compress(
        self,
        messages: list[ConversationMessage],
        summarize_fn: SummarizeFn,
    ) -> CompressionResult:
        old, recent = _split_messages(messages, self.max_recent_turns)

        if not old:
            self._turns_since_last = 0
            return CompressionResult(
                summary=self._summary,
                kept_messages=recent,
                compressed_count=0,
            )

        logger.info(
            "compressing old_turns=%s recent_turns=%s has_prev_summary=%s",
            count_turns(old),
            count_turns(recent),
            self._summary is not None,
        )

        # LLM receives previous_summary and handles merging itself
        self._summary = await summarize_fn(old, recent, self._summary)

        self._last_compressed_at = time.time()
        self._turns_since_last = 0

        return CompressionResult(
            summary=self._summary,
            kept_messages=recent,
            compressed_count=len(old),
            did_compress=True,
        )

    @property
    def summary(self) -> str | None:
        """Current accumulated summary (None if no compression has run)."""
        return self._summary

    def reset(self) -> None:
        """Clear internal compression state."""
        self._summary = None
        self._last_compressed_at = None
        self._turns_since_last = 0


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _split_messages(
    messages: list[ConversationMessage],
    recent_turns: int,
) -> tuple[list[ConversationMessage], list[ConversationMessage]]:
    """Split *messages* into (old, recent) by turn count from the end."""
    kept_turns = 0
    cut_idx = len(messages)

    i = len(messages) - 1
    while i >= 0 and kept_turns < recent_turns:
        if (
            messages[i].role == "assistant"
            and i - 1 >= 0
            and messages[i - 1].role == "user"
        ):
            kept_turns += 1
            i -= 2
        else:
            i -= 1

    cut_idx = i + 1

    # Don't split mid-turn
    if 0 < cut_idx < len(messages) and messages[cut_idx].role == "assistant":
        cut_idx += 1

    return messages[:cut_idx], messages[cut_idx:]
