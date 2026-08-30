"""Cloud document full-text reader.

Reads the persisted parsed text of a cloud-drive document from MongoDB
``cloud_drive_documents`` (written by ``doc_parser.vectorize._extract_text``
during the processing pipeline). Used by the note-conversion flow to feed a
document's full text into the note agent — no MinIO download or re-parsing
needed.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

# Upper bound on characters fed to the note agent. A single LLM prompt can
# absorb ~50k CJK chars comfortably; larger documents are truncated (the
# agent still produces a faithful note over the leading content).
MAX_DOC_TEXT_CHARS = 50_000

COLLECTION = "cloud_drive_documents"


class CloudDocumentNotFoundError(Exception):
    """No parsed document exists for this upload_uuid (wrong uid or not parsed yet)."""


async def read_cloud_document_text(upload_uuid: str, uid: int) -> dict[str, Any]:
    """Return ``{"file_name", "content", "parser", "truncated"}`` for a document.

    Ownership is enforced by filtering on ``uid`` (stored alongside the
    document when it was parsed). Raises :class:`CloudDocumentNotFoundError`
    when the document is missing, not owned, or its text is empty.
    """
    from app.infra.mongo import get_database

    db = get_database()
    if db is None:
        raise RuntimeError("MongoDB 未启用")

    doc = await db[COLLECTION].find_one(
        {"upload_uuid": upload_uuid, "uid": uid},
        {"title": 1, "content": 1, "content_source": 1, "_id": 0},
    )
    raw_text = str((doc or {}).get("content") or "").strip()
    if doc is None or not raw_text:
        raise CloudDocumentNotFoundError(upload_uuid)

    truncated = len(raw_text) > MAX_DOC_TEXT_CHARS
    if truncated:
        logger.warning(
            "[CLOUD_DOC_TEXT] truncating upload=%s chars=%d cap=%d",
            upload_uuid[:8],
            len(raw_text),
            MAX_DOC_TEXT_CHARS,
        )
    return {
        "file_name": str(doc.get("title") or ""),
        "content": raw_text[:MAX_DOC_TEXT_CHARS],
        "parser": str(doc.get("content_source") or ""),
        "truncated": truncated,
    }
