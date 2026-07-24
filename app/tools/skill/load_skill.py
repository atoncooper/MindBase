"""load_skill tool - lets an agent pull a Skill's full instructions on demand.

The agent sees a skill *index* in its system prompt (built by
``SkillManager.index_text()``). When a user task matches a skill, the agent
calls ``load_skill(name)`` to retrieve the full SKILL.md body, then follows
those instructions (and uses the skill's dedicated tools if any).
"""

from __future__ import annotations

import logging
from typing import Any

from app.skills.manager import SkillManager
from app.tools import ToolDeps, register_tool

logger = logging.getLogger(__name__)


@register_tool
class LoadSkillTool:
    """Load a named skill's detailed instructions into the conversation."""

    def __init__(self, skill_manager: SkillManager) -> None:
        self._skill_manager = skill_manager

    @classmethod
    def from_deps(cls, deps: ToolDeps) -> "LoadSkillTool | None":
        if deps.skill_manager is None:
            return None
        return cls(deps.skill_manager)

    @property
    def name(self) -> str:
        return "load_skill"

    @property
    def description(self) -> str:
        return (
            "加载指定技能的详细指令。可用技能见 system prompt 的技能索引。"
            "当用户任务匹配某技能时调用，获取该技能的执行步骤与指引。"
        )

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "技能名称（见技能索引）",
                }
            },
            "required": ["name"],
        }

    async def run(self, name: str, **kwargs: Any) -> str:
        uid = kwargs.get("_uid")
        if uid is None:
            return "无法加载技能：缺少用户上下文（_uid）。"
        skill = await self._skill_manager.load_skill(uid, name)
        if skill is None:
            installed = await self._skill_manager.list_installed(uid)
            available = (
                ", ".join(s.skill_id for s in installed) or "无"
            )
            return f"未知技能 '{name}'。可用技能: {available}"
        logger.info("[LOAD_SKILL] uid=%s loaded skill='%s'", uid, name)
        msg = f"# 技能: {skill.name}\n\n{skill.body}"
        if skill.has_code_tools:
            msg += (
                "\n\n⚠️ 该技能含代码工具，需沙箱支持，当前暂不可执行。"
                "请仅按上述指令使用已有工具完成任务。"
            )
        return msg
