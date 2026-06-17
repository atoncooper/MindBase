"""SSE encoding helper for chat streams."""

import json
from typing import Any


def sse_event(payload: dict[str, Any]) -> str:
    """Encode an event dict as a single SSE ``data:`` frame."""
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
