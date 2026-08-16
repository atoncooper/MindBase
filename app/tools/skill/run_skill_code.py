"""RunSkillCodeTool - execute a skill code tool in an isolated Daytona sandbox.

Skills whose manifest declares ``has_code_tools`` (and carry a ``tools/``
directory in their zip) expose runnable scripts. This tool loads the skill,
uploads its ``tools/`` files into a short-lived Daytona sandbox, runs the
entrypoint (``manifest.entry`` or ``main.py`` by default), and returns
stdout + exit code. The sandbox is always deleted (even on timeout/failure).

Registered only when BOTH conditions hold:
  * ``config.daytona.enabled`` (``DAYTONA__ENABLED=true``)
  * a ``SkillManager`` is available in ``ToolDeps``
Otherwise ``from_deps`` returns ``None`` and the tool is not exposed.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from app.infra.config import config
from app.skills import Skill, SkillManager
from app.tools import ToolDeps, register_tool

logger = logging.getLogger(__name__)

# Total per-call timeout (sandbox creation alone can take 10-40s on the
# cloud, plus execution). Must stay under the chat request budget; the
# sandbox is force-deleted when this fires.
RUN_SKILL_CODE_TIMEOUT = 90.0


@register_tool
class RunSkillCodeTool:
    """Run one of a skill code tools in a Daytona sandbox."""

    def __init__(
        self,
        skill_manager: SkillManager,
        api_key: str,
        api_url: str,
        org_id: str = "",
        network_block_all: bool = True,
        domain_allow_list: str = "",
    ) -> None:
        from daytona_sdk import Daytona, DaytonaConfig

        self._skill_manager = skill_manager
        cfg_kwargs: dict[str, Any] = {"api_key": api_key, "api_url": api_url}
        if org_id:
            cfg_kwargs["organization_id"] = org_id
        self._daytona = Daytona(DaytonaConfig(**cfg_kwargs))
        self._network_block_all = network_block_all
        self._domain_allow_list = domain_allow_list

    @classmethod
    def from_deps(cls, deps: ToolDeps) -> "RunSkillCodeTool | None":
        # Both the skills system and the Daytona sandbox must be available.
        if deps.skill_manager is None:
            return None
        if not config.daytona.enabled:
            logger.info("[RUN_SKILL_CODE] daytona disabled - tool not registered")
            return None
        try:
            return cls(
                skill_manager=deps.skill_manager,
                api_key=config.daytona.api_key.get_secret_value(),
                api_url=config.daytona.api_url,
                org_id=config.daytona.org_id,
                network_block_all=config.daytona.network_block_all,
                domain_allow_list=config.daytona.domain_allow_list,
            )
        except Exception as exc:
            logger.warning("[RUN_SKILL_CODE] daytona-sdk init failed: %s", exc)
            return None

    @property
    def name(self) -> str:
        return "run_skill_code"

    @property
    def description(self) -> str:
        return (
            "在 Daytona 沙箱中执行已安装技能(skill)的代码工具，返回 stdout 和 exitCode。"
            "用于执行带代码工具的技能。entry 为 tools/ 下入口文件名（默认 main.py），"
            "args 为可选命令行参数。"
        )

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "skill_id": {"type": "string", "description": "技能 ID（见技能索引）"},
                "entry": {
                    "type": "string",
                    "description": "tools/ 下要执行的入口文件名，默认 main.py",
                },
                "args": {
                    "type": "string",
                    "description": "传给入口脚本的可选命令行参数",
                },
            },
            "required": ["skill_id"],
        }

    async def run(
        self,
        *,
        skill_id: str,
        entry: str = "",
        args: str = "",
        **kwargs: Any,
    ) -> dict[str, Any]:
        uid = kwargs.get("_uid")
        if uid is None:
            return {"content": "无法执行技能代码：缺少用户上下文（_uid）。", "exit_code": -1}

        skill = await self._skill_manager.load_skill(uid, skill_id)
        if skill is None:
            return {"content": f"未知技能 '{skill_id}'，或技能加载失败。", "exit_code": -1}
        if not skill.has_code_tools or not skill.code_tools:
            return {
                "content": f"技能 '{skill_id}' 不含可执行的代码工具（tools/ 为空）。",
                "exit_code": -1,
            }

        entry = entry.strip() or (skill.entry or "main.py")
        entry = entry.removeprefix("tools/")
        if entry not in skill.code_tools:
            available = ", ".join(sorted(skill.code_tools)) or "无"
            return {
                "content": f"入口 '{entry}' 不存在。可用代码工具: {available}",
                "exit_code": -1,
            }

        logger.info(
            "[RUN_SKILL_CODE] uid=%s skill='%s' entry='%s' args='%s'",
            uid, skill_id, entry, args[:100],
        )
        try:
            sandbox = await asyncio.to_thread(self._create_sandbox)
        except Exception as exc:
            logger.warning("[RUN_SKILL_CODE] sandbox creation failed: %s", exc)
            return {"content": f"沙箱创建失败: {exc}", "exit_code": -1}

        try:
            try:
                result = await asyncio.wait_for(
                    asyncio.to_thread(
                        self._run_skill_sync, sandbox, skill, entry, args
                    ),
                    timeout=RUN_SKILL_CODE_TIMEOUT,
                )
            except asyncio.TimeoutError:
                logger.warning(
                    "[RUN_SKILL_CODE] timed out after %ss, deleting sandbox",
                    RUN_SKILL_CODE_TIMEOUT,
                )
                return {
                    "content": f"技能代码运行超时(>{RUN_SKILL_CODE_TIMEOUT}s),已终止",
                    "exit_code": -1,
                    "timeout": True,
                }
            return {
                "content": result.get("content", ""),
                "exit_code": result.get("exit_code", 0),
            }
        finally:
            await asyncio.to_thread(self._delete_sandbox, sandbox)

    def _create_sandbox(self) -> Any:
        # Python runtime + the same network policy as run_code (block-all
        # by default; allow-list opens specific domains).
        from daytona_sdk import CreateSandboxFromSnapshotParams

        params_kwargs: dict[str, Any] = {"language": "python"}
        if self._domain_allow_list:
            params_kwargs["domain_allow_list"] = self._domain_allow_list
        elif self._network_block_all:
            params_kwargs["network_block_all"] = True
        try:
            return self._daytona.create(
                CreateSandboxFromSnapshotParams(**params_kwargs)
            )
        except Exception as exc:
            logger.warning(
                "[RUN_SKILL_CODE] create() rejected structured params (%s); "
                "falling back to default sandbox (network restrictions dropped)",
                exc,
            )
            return self._daytona.create()

    def _run_skill_sync(
        self, sandbox: Any, skill: Skill, entry: str, args: str
    ) -> dict[str, Any]:
        try:
            # Upload every tools/ file (entry + any helpers it imports),
            # then run the entrypoint from the sandbox working directory.
            wd = sandbox.get_work_dir() or ""
            for rel, src in skill.code_tools.items():
                dst = f"tools/{rel}" if not wd else f"{wd}/tools/{rel}"
                sandbox.fs.upload_file(src.encode("utf-8"), dst)
            cmd = f"python tools/{entry}"
            if args.strip():
                cmd = f"{cmd} {args.strip()}"
            resp = sandbox.process.exec(cmd, cwd=wd or None)
            output = getattr(resp, "result", None) or ""
            if not output and getattr(resp, "artifacts", None):
                output = getattr(resp.artifacts, "stdout", None) or ""
            exit_code = getattr(resp, "exit_code", None)
            if exit_code is None:
                exit_code = 0
            return {
                "content": f"exitCode={exit_code}\n{output}",
                "exit_code": exit_code,
            }
        except Exception as exc:
            logger.warning("[RUN_SKILL_CODE] execution failed: %s", exc)
            return {"content": f"运行失败: {exc}", "exit_code": -1}

    def _delete_sandbox(self, sandbox: Any) -> None:
        try:
            self._daytona.delete(sandbox)
        except Exception:
            pass
