"""Chat service package.

Encapsulates everything that the chat router used to do inline:
LLM construction, search-scope resolution, harness construction, title
scheduling, message lifecycle, SSE encoding, and endpoint orchestration.

Routers should depend only on this package's public API.
"""

from app.services.chat.llm import build_llm, infer_provider
from app.services.chat.scope import (
    get_bvids_by_media_ids,
    get_media_ids_for_uid,
    resolve_search_scope,
)
from app.services.chat.title_scheduling import schedule_title_generation

__all__ = [
    "build_llm",
    "get_bvids_by_media_ids",
    "get_media_ids_for_uid",
    "infer_provider",
    "resolve_search_scope",
    "schedule_title_generation",
]
