"""SaveNoteTool - persist a Markdown note via NoteService.

The note agent calls this after composing Markdown content. Delegates to
``NoteService.create_note``, which applies sanitization, MySQL+Mongo split
storage, and orphan cleanup automatically - so the tool never touches
repositories directly.
"""

from __future__ import annotations

import logging
from typing import Any

from app.tools import ToolDeps, register_tool

logger = logging.getLogger(__name__)


@register_tool
class SaveNoteTool:
    """Save a Markdown note to the user's notebook."""

    @classmethod
    def from_deps(cls, deps: ToolDeps) -> "SaveNoteTool | None":
        # No external deps: NoteService is a module-level singleton and db
        # sessions are opened via get_db_context() inside run().
        return cls()

    @property
    def name(self) -> str:
        return "save_note"

    @property
    def description(self) -> str:
        return (
            "保存一篇 Markdown 笔记到用户的笔记库。content_md 必须是 Markdown 格式。"
            "调用后笔记即持久化，无需再输出笔记正文。"
        )

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "笔记标题"},
                "target_type": {
                    "type": "string",
                    "enum": ["video", "cloud_file"],
                    "description": "笔记关联的对象类型",
                },
                "target_id": {
                    "type": "string",
                    "description": "关联对象 ID。video 用 bvid:cid（如 BV1xx:123）；cloud_file 用文档 id",
                },
                "content_md": {
                    "type": "string",
                    "description": "笔记正文，必须是 Markdown 格式（≤256KB）",
                },
            },
            "required": ["title", "target_type", "target_id", "content_md"],
        }

    async def run(
        self,
        *,
        title: str,
        target_type: str,
        target_id: str,
        content_md: str,
        **kwargs: Any,
    ) -> dict[str, str]:
        uid = kwargs.get("_uid")
        if uid is None:
            return {"content": "保存失败：未识别用户身份"}

        from app.database import get_db_context
        from app.services.notes.service import get_note_service

        try:
            async with get_db_context() as db:
                meta = await get_note_service().create_note(
                    db,
                    uid=uid,
                    title=title,
                    target_type=target_type,
                    target_id=target_id,
                    content_md=content_md,
                )
            saved_title = meta.get("title", title) if isinstance(meta, dict) else title
            saved_uuid = meta.get("uuid", "") if isinstance(meta, dict) else ""
            return {
                "content": f"已保存笔记《{saved_title}》（uuid={saved_uuid}）"
            }
        except (RuntimeError, ValueError) as e:
            # RuntimeError: Mongo not enabled; ValueError: validation failure
            logger.warning("[SAVE_NOTE] failed uid=%s err=%s", uid, e)
            return {"content": f"保存失败：{e}"}
