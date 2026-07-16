"""Markdown safety — strip raw HTML / dangerous schemes before persistence.

BlockNote already sanitises on the editor side, but defence-in-depth: the
backend re-cleans before writing to MongoDB so a hand-crafted API request
cannot inject ``<script>`` or ``javascript:`` URLs into shared notes.
"""

from __future__ import annotations

import re

# Tags bleach should strip entirely (raw HTML is not allowed in MD source).
_FORBIDDEN_HTML = re.compile(
    r"<\s*(script|iframe|object|embed|style|link|meta|base|form|input|button)[^>]*>.*?<\s*/\s*\1\s*>",
    re.IGNORECASE | re.DOTALL,
)

# Any remaining raw <...> tag (open or close) — BlockNote exports pure MD,
# so legitimate angle brackets in code blocks are fenced by ``` which we
# do not touch here.
_RAW_TAG = re.compile(r"<[^>]+>")

# javascript: / vbscript: / data: (non-image) URL schemes.
_DANGEROUS_URL = re.compile(
    r"(javascript|vbscript|file):", re.IGNORECASE
)


def sanitize_markdown(text: str) -> str:
    """Strip dangerous HTML / URL schemes from a markdown source string.

    - Removes ``<script>`` / ``<iframe>`` / ... blocks entirely.
    - Strips any remaining raw HTML tags.
    - Replaces ``javascript:`` / ``vbscript:`` / ``file:`` URLs with ``#``.

    Markdown syntax (``[text](url)``, ```` ``` ````, ``# heading``) is
    preserved — we only touch raw HTML and URL schemes.
    """
    if not text:
        return ""

    cleaned = _FORBIDDEN_HTML.sub("", text)
    cleaned = _RAW_TAG.sub("", cleaned)
    cleaned = _DANGEROUS_URL.sub("#", cleaned)
    return cleaned
