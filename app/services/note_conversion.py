"""Cloud document → note conversion (button-triggered).

Orchestrates the ``note`` agent over a cloud-drive document's parsed full
text. Layering mirrors ``services/session_summary.py``: the router passes
the harness handle, this service does validation + lifecycle invocation and
maps failures to HTTP status codes.

The agent receives the document text as part of its input state (injected
as a ``<document>`` block by the note graph) and saves the note itself via
the ``save_note`` tool — so persistence, sanitization, and MySQL+Mongo
split storage all reuse the existing note pipeline.
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from loguru import logger

from app.services.cloud.document_text import (
    CloudDocumentNotFoundError,
    read_cloud_document_text,
)

# The note agent runs a ReAct loop (organize + save_note); large documents
# need more than the default 60s window.
_CONVERT_TIMEOUT = 120.0

_QUERY_TEMPLATE = (
    "请把这篇云盘文档整理成一篇结构化 Markdown 笔记并保存。"
    "文档全文见 <document> 标签，标题基于文档主题生成。"
)


async def convert_cloud_document_to_note(
    uid: int,
    upload_uuid: str,
    agent_harness: Any,
) -> dict[str, Any]:
    """Convert one cloud document into a saved Markdown note.

    Returns ``{"message": str}`` — the note agent's confirmation text.
    Raises HTTPException(404/409/503/502).
    """
    if not (agent_harness and getattr(agent_harness, "started", False)):
        raise HTTPException(status_code=503, detail="Agent 服务未启动")

    try:
        doc = await read_cloud_document_text(upload_uuid, uid)
    except CloudDocumentNotFoundError:
        raise HTTPException(
            status_code=409,
            detail="文档尚未解析完成或没有可用的文本内容，请先完成入库处理",
        )

    result_state = await agent_harness.lifecycle.invoke(
        "note",
        f"notedoc:{upload_uuid}",
        timeout=_CONVERT_TIMEOUT,
        uid=uid,
        query=_QUERY_TEMPLATE,
        cloud_upload_uuid=upload_uuid,
        cloud_file_name=doc["file_name"],
        cloud_doc_text=doc["content"],
        cloud_doc_truncated=bool(doc.get("truncated")),
    )
    result_state = result_state or {}

    error = str(result_state.get("error") or "").strip()
    message = str(result_state.get("result") or "").strip()
    if error or not message:
        logger.error(
            "[NOTE_CONVERT] failed uid=%s upload=%s error=%s",
            uid,
            upload_uuid[:8],
            error or "empty result",
        )
        raise HTTPException(
            status_code=502,
            detail=f"笔记生成失败: {error or 'Agent 未返回结果'}"[:300],
        )

    logger.info(
        "[NOTE_CONVERT] ok uid=%s upload=%s truncated=%s",
        uid,
        upload_uuid[:8],
        doc.get("truncated"),
    )
    return {"message": message}
