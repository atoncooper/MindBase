"""Document parser protocol and ParsedDocument dataclass."""

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

logger = logging.getLogger(__name__)


@dataclass
class ParsedDocument:
    """Standardized output from any document parser."""

    text: str
    headings: list[dict] = field(default_factory=list)
    images: list[dict] = field(default_factory=list)
    tables: list[dict] = field(default_factory=list)
    code_blocks: list[dict] = field(default_factory=list)
    metadata: dict = field(default_factory=dict)


@runtime_checkable
class DocParser(Protocol):
    """Document parser protocol — input bytes, output ParsedDocument."""

    @property
    def name(self) -> str: ...

    def can_parse(self, mime_type: str, filename: str) -> bool: ...

    async def parse(self, content: bytes, filename: str) -> ParsedDocument: ...


class BaseDocParser:
    """Base class with CPU-offloading for sync parsers."""

    name: str = "base"

    def can_parse(self, mime_type: str, filename: str) -> bool:
        raise NotImplementedError

    async def parse(self, content: bytes, filename: str) -> ParsedDocument:
        """Offload sync parsing to thread pool to avoid blocking the event loop."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, self._parse_sync, content, filename)

    def _parse_sync(self, content: bytes, filename: str) -> ParsedDocument:
        raise NotImplementedError
