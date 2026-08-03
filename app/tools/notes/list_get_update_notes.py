"""Note query/update tools - list, read, and modify existing notes.

These complement ``save_note`` (create) so the note agent can analyze and
modify existing notes, not just create new ones. All delegate to NoteService
which handles sanitization, MySQL/Mongo split storage, and optimistic locking.
"""

from __future__ import annotations

import logging
from typing import Any

from app.tools import ToolDeps, register_tool

logger = logging.getLogger(__name__)


@register_tool
class ListNotesTool:
    """List the user's notes (metadata only, no content)."""

    @classmethod
    def from_deps(cls, deps: ToolDeps) -> "ListNotesTool | None":
        return cls()

    @property
    def name(self) -> str:
        return "list_notes"

    @property
    def description(self) -> str:
        return (
            "列出用户的笔记（仅元数据：标题/uuid/目标/更新时间，不含正文）。"
            "用于查看用户有哪些笔记、找到要分析或修改的笔记。"
        )

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "target_type": {
                    "type": "string",
                    "enum": ["video", "cloud_file"],
                    "description": "按关联类型过滤（可选）",
                },
            },
        }

    async def run(self, *, target_type: str = "", **kwargs: Any) -> dict[str, Any]:
        uid = kwargs.get("_uid")
        if uid is None:
            return {"content": "查询失败：未识别用户身份"}

        from app.database import get_db_context
        from app.services.notes.service import get_note_service

        try:
            async with get_db_context() as db:
                notes, total = await get_note_service().list_notes(
                    db,
                    uid,
                    target_type=target_type or None,
                    page=1,
                    page_size=50,
                )
            if not notes:
                return {"content": "暂无笔记。"}
            lines = [f"共 {total} 篇笔记："]
            for n in notes:
                lines.append(
                    f"- 《{n['title']}》uuid={n['uuid']} "
                    f"target={n.get('target_type', '')}:{n.get('target_id', '')} "
                    f"updated={n.get('updated_at', '')}"
                )
            return {"content": "\n".join(lines)}
        except Exception as e:
            logger.warning("[LIST_NOTES] failed uid=%s err=%s", uid, e)
            return {"content": f"查询失败：{e}"}


@register_tool
class GetNoteTool:
    """Fetch the full content of a single note by uuid."""

    @classmethod
    def from_deps(cls, deps: ToolDeps) -> "GetNoteTool | None":
        return cls()

    @property
    def name(self) -> str:
        return "get_note"

    @property
    def description(self) -> str:
        return (
            "获取指定笔记的完整正文（Markdown）。用于分析笔记内容、"
            "查看笔记详情后再决定如何修改。需要 note_uuid（可从 list_notes 获取）。"
        )

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "note_uuid": {
                    "type": "string",
                    "description": "笔记的 UUID（从 list_notes 获取）",
                },
            },
            "required": ["note_uuid"],
        }

    async def run(self, *, note_uuid: str, **kwargs: Any) -> dict[str, Any]:
        uid = kwargs.get("_uid")
        if uid is None:
            return {"content": "查询失败：未识别用户身份"}

        from app.database import get_db_context
        from app.services.notes.service import get_note_service

        try:
            async with get_db_context() as db:
                note = await get_note_service().get_note(
                    db, note_uuid, uid=uid,
                )
            content = note.get("content_md", "")
            title = note.get("title", "")
            return {
                "content": f"笔记《{title}》正文：\n\n{content}",
            }
        except Exception as e:
            logger.warning("[GET_NOTE] failed uid=%s uuid=%s err=%s", uid, note_uuid, e)
            return {"content": f"获取失败：{e}"}


@register_tool
class UpdateNoteTool:
    """Update an existing note's content (Markdown)."""

    @classmethod
    def from_deps(cls, deps: ToolDeps) -> "UpdateNoteTool | None":
        return cls()

    @property
    def name(self) -> str:
        return "update_note"

    @property
    def description(self) -> str:
        return (
            "修改已有笔记的正文或标题。content_md 必须是完整的 Markdown 正文"
            "（会替换原有正文，不是追加）。修改前建议先用 get_note 查看原内容。"
        )

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "note_uuid": {
                    "type": "string",
                    "description": "笔记 UUID",
                },
                "content_md": {
                    "type": "string",
                    "description": "新的 Markdown 正文（完整内容，非追加）",
                },
                "title": {
                    "type": "string",
                    "description": "新标题（可选，不传则不改标题）",
                },
            },
            "required": ["note_uuid", "content_md"],
        }

    async def run(
        self,
        *,
        note_uuid: str,
        content_md: str,
        title: str = "",
        **kwargs: Any,
    ) -> dict[str, Any]:
        uid = kwargs.get("_uid")
        if uid is None:
            return {"content": "修改失败：未识别用户身份"}

        from app.database import get_db_context
        from app.services.notes.service import get_note_service

        try:
            async with get_db_context() as db:
                note = await get_note_service().update_note(
                    db,
                    note_uuid,
                    uid=uid,
                    content_md=content_md,
                    title=title or None,
                )
            return {
                "content": f"已修改笔记《{note.get('title', '')}》（uuid={note_uuid}）",
            }
        except Exception as e:
            logger.warning("[UPDATE_NOTE] failed uid=%s uuid=%s err=%s", uid, note_uuid, e)
            return {"content": f"修改失败：{e}"}
