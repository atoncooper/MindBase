"""RunCodeTool - execute code in an isolated Daytona sandbox.

The code agent calls this to run user-requested code. Each call creates a
short-lived sandbox (auto-deleted), runs the code, and returns stdout + exit
code. Auth is handled by the daytona-sdk client (a singleton held by the tool)
using the static API key from config - no per-call auth fetch.

Sandbox lifecycle is managed by ``run()`` so a per-step timeout can be
enforced and the sandbox is always deleted (even on timeout/failure).
"""

from __future__ import annotations

import asyncio
import base64
import logging
import mimetypes
import os
import re
import uuid
from typing import Any

from app.infra.config import config
from app.tools import ToolDeps, register_tool

logger = logging.getLogger(__name__)

# Per-step timeout for code execution. Must be < delegate_to_agent timeout
# (30s) so the sandbox gets deleted before the delegate gives up.
RUN_CODE_TIMEOUT = 20.0

# Max size of a single extracted artifact (base64-decoded bytes). Oversized
# artifacts are skipped to avoid blowing up stdout / MinIO uploads.
ARTIFACT_MAX_BYTES = 10 * 1024 * 1024

# Filesystem harvest: after a successful run, auto-discover generated files in
# the sandbox working dir so a plain plt.savefig() comes back as a URL without
# relying on the LLM to emit the <<ARTIFACT_START>> marker protocol. Images are
# the primary target; csv/pdf included as common "show me the result" artifacts.
_HARVEST_EXTENSIONS = frozenset({
    ".png", ".jpg", ".jpeg", ".svg", ".gif", ".webp", ".bmp",
    ".csv", ".pdf",
})
_HARVEST_SCAN_PATH = "."   # sandbox working dir (where code_run executes)
_HARVEST_SCAN_DEPTH = 2    # workdir + one level of subdirs
# Upper bound for the filesystem harvest (list_files + downloads). Keeps a
# hung SDK call from delaying sandbox deletion; well under the delegate timeout.
HARVEST_TIMEOUT = 10.0

# Marker protocol: the code agent's prompt instructs the LLM to emit
# <<ARTIFACT_START:name.png>>{base64}<<ARTIFACT_END>> for binary artifacts
# (images, files) so run_code can extract them from stdout and persist to
# MinIO instead of letting them die with the ephemeral sandbox.
_ARTIFACT_RE = re.compile(
    r"<<ARTIFACT_START:(?P<name>[^>\n]+)>>(?P<data>.*?)<<ARTIFACT_END>>",
    re.DOTALL,
)


def _extract_artifacts(stdout: str) -> tuple[str, list[dict]]:
    """Parse artifact markers from stdout.

    Returns ``(cleaned_stdout, artifacts)`` where each artifact is
    ``{"name", "data"(bytes), "content_type", "size"}``. Markers are
    replaced in the cleaned stdout with a short placeholder so the LLM
    doesn't see megabytes of base64. Oversized or unparseable markers are
    skipped with a warning, never raised.
    """
    artifacts: list[dict] = []

    def _replace(match: re.Match) -> str:
        name = match.group("name").strip()
        raw = match.group("data").strip()
        try:
            data = base64.b64decode(raw)
        except Exception as exc:
            logger.warning(
                "[RUN_CODE] artifact %r base64 decode failed: %s", name, exc
            )
            return f"[产物解析失败: {name}]"
        size = len(data)
        if size > ARTIFACT_MAX_BYTES:
            logger.warning(
                "[RUN_CODE] artifact %r too large (%d bytes), skipped",
                name, size,
            )
            return f"[产物过大已跳过: {name} ({size} bytes)]"
        content_type = mimetypes.guess_type(name)[0] or "application/octet-stream"
        artifacts.append(
            {"name": name, "data": data, "content_type": content_type, "size": size}
        )
        return f"[已提取产物: {name}]"

    cleaned = _ARTIFACT_RE.sub(_replace, stdout)
    return cleaned, artifacts


@register_tool
class RunCodeTool:
    """Run code in an isolated Daytona sandbox."""

    def __init__(
        self,
        api_key: str,
        api_url: str,
        org_id: str = "",
        network_block_all: bool = True,
        domain_allow_list: str = "",
    ) -> None:
        from daytona_sdk import Daytona, DaytonaConfig

        # SDK client is a singleton held by the tool; it carries the API key
        # and adds Authorization headers to every request automatically.
        # daytona-sdk >=0.169 dropped the api_key=/server_url= kwargs in favor
        # of a DaytonaConfig object (fields: api_key, api_url, organization_id).
        cfg_kwargs: dict[str, Any] = {"api_key": api_key, "api_url": api_url}
        if org_id:
            cfg_kwargs["organization_id"] = org_id
        self._daytona = Daytona(DaytonaConfig(**cfg_kwargs))
        self._network_block_all = network_block_all
        self._domain_allow_list = domain_allow_list

    @classmethod
    def from_deps(cls, deps: ToolDeps) -> "RunCodeTool | None":
        # Opt out entirely when Daytona is not configured - the tool won't
        # appear in any agent's tool list.
        if not config.daytona.enabled:
            return None
        try:
            return cls(
                api_key=config.daytona.api_key.get_secret_value(),
                api_url=config.daytona.api_url,
                org_id=config.daytona.org_id,
                network_block_all=config.daytona.network_block_all,
                domain_allow_list=config.daytona.domain_allow_list,
            )
        except Exception as exc:
            logger.warning("[RUN_CODE] daytona-sdk init failed: %s", exc)
            # loguru mirror so this is visible in logs/app.log - otherwise the
            # tool silently fails to register and code agent gets no tools,
            # which looks like "LLM refuses to call run_code" (silent failure).
            from loguru import logger as _log
            _log.warning(
                "[RUN_CODE] daytona-sdk init failed: {} -- run_code tool NOT "
                "registered; code agent will have no execution tool and can "
                "only fabricate results. Fix: pip install daytona-sdk",
                exc,
            )
            return None

    @property
    def name(self) -> str:
        return "run_code"

    @property
    def description(self) -> str:
        return (
            "在 Daytona 沙箱中运行代码(Python/JavaScript/TypeScript),"
            "返回 stdout 和 exitCode。用于执行用户要求的代码。"
        )

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "code": {"type": "string", "description": "要运行的代码"},
                "language": {
                    "type": "string",
                    "enum": ["python", "javascript", "typescript"],
                    "default": "python",
                    "description": "代码语言",
                },
            },
            "required": ["code"],
        }

    async def run(
        self,
        *,
        code: str,
        language: str = "python",
        **kwargs: Any,
    ) -> dict[str, Any]:
        # daytona-sdk is synchronous; run each step in a thread. Sandbox
        # lifecycle is managed here so we can enforce a per-step timeout and
        # guarantee cleanup even when the run is cancelled/times out.
        uid = kwargs.get("_uid") or 0
        try:
            sandbox = await asyncio.to_thread(self._create_sandbox, language)
        except Exception as exc:
            logger.warning("[RUN_CODE] sandbox creation failed: %s", exc)
            return {"content": f"沙箱创建失败: {exc}", "exit_code": -1}

        try:
            try:
                result = await asyncio.wait_for(
                    asyncio.to_thread(self._run_code_sync, sandbox, code, language),
                    timeout=RUN_CODE_TIMEOUT,
                )
            except asyncio.TimeoutError:
                logger.warning(
                    "[RUN_CODE] execution timed out after %ss, deleting sandbox",
                    RUN_CODE_TIMEOUT,
                )
                return {
                    "content": f"代码运行超时(>{RUN_CODE_TIMEOUT}s),已终止",
                    "exit_code": -1,
                    "timeout": True,
                }

            # Extract artifacts while the sandbox is still alive (before the
            # finally deletes it). Two sources, merged and deduped by name:
            #  1. <<ARTIFACT_START:name>>base64<<ARTIFACT_END>> markers the
            #     LLM was instructed to emit in stdout (explicit surfacing).
            #  2. Filesystem harvest - auto-discover generated image/data
            #     files in the sandbox workdir so a plain plt.savefig() still
            #     comes back as a URL without relying on LLM compliance.
            cleaned_stdout, raw_artifacts = _extract_artifacts(result.get("content", ""))
            if result.get("exit_code", 0) == 0:
                try:
                    harvested = await asyncio.wait_for(
                        self._harvest_artifacts(
                            sandbox,
                            exclude_names={a["name"] for a in raw_artifacts},
                        ),
                        timeout=HARVEST_TIMEOUT,
                    )
                except asyncio.TimeoutError:
                    logger.warning(
                        "[RUN_CODE] artifact harvest timed out after %ss",
                        HARVEST_TIMEOUT,
                    )
                    harvested = []
                except Exception as exc:
                    logger.warning("[RUN_CODE] artifact harvest failed: %s", exc)
                    harvested = []
            else:
                harvested = []
            all_artifacts = raw_artifacts + harvested
            uploaded = (
                await self._upload_artifacts(all_artifacts, uid=uid)
                if all_artifacts
                else []
            )
            return {
                "content": cleaned_stdout,
                "exit_code": result.get("exit_code", 0),
                "artifacts": uploaded,
                **{
                    k: v
                    for k, v in result.items()
                    if k not in ("content", "exit_code")
                },
            }
        finally:
            # Always delete the sandbox. The run thread (if still running)
            # cannot be cancelled directly (asyncio cannot cancel ThreadPool
            # threads), but destroying the sandbox makes the SDK call error
            # out and the thread exits.
            await asyncio.to_thread(self._delete_sandbox, sandbox)

    async def _upload_artifacts(
        self, artifacts: list[dict], *, uid: int
    ) -> list[dict]:
        """Upload extracted artifacts to MinIO and return metadata records.

        Each input artifact carries raw ``data`` bytes; the returned records
        drop ``data`` and carry ``minio_key`` + presigned ``url`` instead, so
        they are safe to persist and forward to the LLM/SSE. MinIO disabled
        or upload failures degrade gracefully (artifact skipped, never raised).
        """
        from app.infra.minio import get_minio_client
        from app.infra.minio import is_enabled as minio_enabled

        if not minio_enabled():
            logger.info(
                "[RUN_CODE] minio disabled - %d artifact(s) not persisted",
                len(artifacts),
            )
            return []
        client = get_minio_client()
        uploaded: list[dict] = []
        for art in artifacts:
            try:
                key = f"code-artifacts/{uid}/{uuid.uuid4()}/{art['name']}"
                await client.put_object(key, art["data"], art["content_type"])
                url = await client.presigned_get(key)
                uploaded.append(
                    {
                        "name": art["name"],
                        "minio_key": key,
                        "url": url,
                        "content_type": art["content_type"],
                        "size": art["size"],
                    }
                )
            except Exception as exc:
                logger.warning(
                    "[RUN_CODE] artifact upload failed name=%s: %s",
                    art.get("name"), exc,
                )
        return uploaded

    async def _harvest_artifacts(
        self, sandbox: Any, *, exclude_names: set[str]
    ) -> list[dict]:
        """Auto-discover generated artifacts in the sandbox working dir.

        Lists files under the workdir, downloads those with harvestable
        extensions (skipping names already surfaced via the marker protocol),
        and returns artifact dicts in the same shape as ``_extract_artifacts``
        (``{"name", "data"(bytes), "content_type", "size"}``). Best-effort:
        any error is logged and an empty/partial list returned. Runs the
        synchronous SDK filesystem calls in a worker thread.
        """

        def _harvest_sync() -> list[dict]:
            found: list[dict] = []
            try:
                entries = sandbox.fs.list_files(
                    _HARVEST_SCAN_PATH, depth=_HARVEST_SCAN_DEPTH
                )
            except Exception as exc:
                logger.warning("[RUN_CODE] harvest list_files failed: %s", exc)
                return found
            # Guard against non-list responses (e.g. mocked sandboxes) so
            # harvest degrades to "nothing found" rather than raising.
            if not isinstance(entries, list):
                return found
            for fi in entries:
                if getattr(fi, "is_dir", False):
                    continue
                name = getattr(fi, "name", "") or ""
                ext = os.path.splitext(name)[1].lower()
                if ext not in _HARVEST_EXTENSIONS:
                    continue
                if name in exclude_names:
                    continue
                size = getattr(fi, "size", 0) or 0
                if size > ARTIFACT_MAX_BYTES:
                    logger.info(
                        "[RUN_CODE] harvest skip oversized %s (%d bytes)",
                        name, size,
                    )
                    continue
                path = getattr(fi, "path", None) or name
                try:
                    data = sandbox.fs.download_file(path)
                except Exception as exc:
                    logger.warning(
                        "[RUN_CODE] harvest download %s failed: %s", name, exc,
                    )
                    continue
                if not data:
                    continue
                content_type = (
                    mimetypes.guess_type(name)[0] or "application/octet-stream"
                )
                found.append(
                    {
                        "name": name,
                        "data": data,
                        "content_type": content_type,
                        "size": len(data),
                    }
                )
            return found

        return await asyncio.to_thread(_harvest_sync)

    def _create_sandbox(self, language: str = "python") -> Any:
        # Create sandbox with the requested language runtime and network
        # restrictions (default: block all network to prevent data exfiltration;
        # allow-list opens specific domains). daytona-sdk >=0.169 moved create()
        # params into a CreateSandboxFromSnapshotParams object.
        from daytona_sdk import CreateSandboxFromSnapshotParams

        params_kwargs: dict[str, Any] = {}
        if language in ("python", "javascript", "typescript"):
            params_kwargs["language"] = language
        # Network policy: domain_allow_list and network_block_all are mutually
        # exclusive in the SDK - an allow-list alone already restricts traffic
        # to the listed domains (blocks the rest), which is the "block all
        # except these" intent. Prefer the allow-list when set so the config
        # combo (network_block_all=true + domain_allow_list=...) doesn't trip
        # the SDK guard and silently fall back to an unconstrained sandbox.
        if self._domain_allow_list:
            params_kwargs["domain_allow_list"] = self._domain_allow_list
        elif self._network_block_all:
            params_kwargs["network_block_all"] = True
        try:
            return self._daytona.create(
                CreateSandboxFromSnapshotParams(**params_kwargs)
            )
        except Exception as exc:
            # Fallback to a default sandbox if structured params are rejected
            # (e.g. unsupported language, or SDK version mismatch). NB: this
            # drops network restrictions, so the warning is surfaced in logs.
            logger.warning(
                "[RUN_CODE] create() rejected structured params (%s); "
                "falling back to default sandbox (network restrictions dropped)",
                exc,
            )
            return self._daytona.create()

    def _run_code_sync(self, sandbox: Any, code: str, language: str) -> dict[str, Any]:
        if language not in ("python", "javascript", "typescript"):
            return {"content": f"不支持的语言: {language}", "exit_code": -1}
        try:
            # daytona-sdk >=0.169 exposes code execution via the Process
            # interface (sandbox.process.code_run); the runtime language is
            # selected at sandbox creation, so one call path serves all langs.
            resp = sandbox.process.code_run(code)
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
            logger.warning("[RUN_CODE] execution failed: %s", exc)
            return {"content": f"运行失败: {exc}", "exit_code": -1}

    def _delete_sandbox(self, sandbox: Any) -> None:
        try:
            self._daytona.delete(sandbox)
        except Exception:
            pass
