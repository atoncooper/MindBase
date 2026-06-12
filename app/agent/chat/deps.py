"""Dependency protocols for the Chat Agent.

Nodes receive their I/O dependencies through the graph builder rather
than importing them directly.  This keeps nodes testable and decoupled.

The graph builder injects concrete implementations at build time.
"""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable


@runtime_checkable
class ChatDeps(Protocol):
    """Dependencies for inject_context, query_db, and build_messages nodes."""

    async def get_media_ids(self, uid: int | None, folder_ids: list[int]) -> list[int]: ...
    async def get_bvids(self, media_ids: list[int]) -> list[str]: ...
    def has_cloud_backend(self) -> bool: ...
    async def get_conversation_context(self, session_id: str) -> str: ...
    async def get_video_context(
        self, media_ids: list[int], *, include_content: bool = False,
    ) -> tuple[str, list[dict]]: ...
    async def get_video_titles_context(self, media_ids: list[int]) -> str: ...
    async def is_related_to_collection(
        self, media_ids: list[int], question: str,
    ) -> bool: ...
