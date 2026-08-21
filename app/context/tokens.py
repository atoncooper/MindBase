"""Lightweight token estimator for pre-flight context budgeting.

The project's real token numbers come from provider usage metadata
(``app/services/chat/token_count.py``) — but those only exist AFTER a call.
Compression triggering happens BEFORE the call, so it needs an estimate.

This is a deliberately conservative heuristic, not a tokenizer:

- CJK chars (Chinese)  ≈ 0.75 tokens/char   (qwen-family tokenizers pack
  common Chinese at ~1.5 chars/token; we over-estimate slightly so the
  budget fires early rather than late — the safe direction)
- non-CJK text          ≈ 4 chars/token     (English/code经验值)
- +4 tokens per message for role/formatting overhead

Accuracy target is ±30%, which is plenty for a budget threshold; do NOT use
it for billing.  If tighter estimates are ever needed, calibrate against the
real ``prompt_tokens`` of the previous turn (its history overlaps ~100%).
"""

from __future__ import annotations

from .models import ConversationMessage

# Per-message framing overhead (role tags, separators in chat templates).
_MESSAGE_OVERHEAD_TOKENS = 4


def _is_cjk(ch: str) -> bool:
    """True for CJK ideographs, CJK punctuation, and fullwidth forms."""
    code = ord(ch)
    return (
        0x4E00 <= code <= 0x9FFF  # CJK Unified Ideographs
        or 0x3400 <= code <= 0x4DBF  # Extension A
        or 0x3000 <= code <= 0x303F  # CJK punctuation
        or 0xFF00 <= code <= 0xFFEF  # fullwidth forms
    )


def estimate_tokens(text: str) -> int:
    """Estimate token count for a piece of text (CJK-aware, conservative)."""
    if not text:
        return 0
    cjk = 0
    total = 0
    for ch in text:
        total += 1
        if _is_cjk(ch):
            cjk += 1
    other = total - cjk
    return max(1, round(cjk * 0.75 + other / 4))


def estimate_message_tokens(msg: ConversationMessage) -> int:
    """Estimate tokens for one stored message (content + framing overhead)."""
    return _MESSAGE_OVERHEAD_TOKENS + estimate_tokens(msg.content or "")


def estimate_messages_tokens(messages: list[ConversationMessage]) -> int:
    """Estimate total tokens for a message list (what the next prompt would
    carry if this history were sent verbatim)."""
    return sum(estimate_message_tokens(m) for m in messages)
