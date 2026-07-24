"""Skills HTTP endpoints - per-user install / list / uninstall + store browse.

Skills are stored in MinIO (never local) at ``skills/{uid}/{skill_id}.zip``;
each user manages their own installed skills. Any logged-in user can browse
the store, install, and uninstall - this is NOT admin-gated.

The agent sees the user's installed skills via ``SkillManager.index_text``
in its system prompt and loads them on demand with the ``load_skill`` tool.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, UploadFile, File
from pydantic import BaseModel

from app.routers.auth import get_current_uid
from app.skills.store import SkillStoreClient, StoreRepo, get_skill_store_client
from app.skills.zip_parser import read_manifest

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/skills", tags=["skills"])


class InstalledSkillResponse(BaseModel):
    skill_id: str
    name: str
    description: str | None = None
    version: str | None = None
    source_store: str | None = None
    has_code_tools: bool = False
    enabled: bool = True


class StoreInstallRequest(BaseModel):
    repo: str  # "owner/repo" to install from
    branch: str = "main"


def _harness(request: Request) -> Any:
    harness = getattr(request.app.state, "agent_harness", None)
    if harness is None or not getattr(harness, "started", False):
        raise HTTPException(status_code=503, detail="Agent 服务暂不可用")
    return harness


# ---------------------------------------------------------------------------
# Installed skills (per-user)
# ---------------------------------------------------------------------------


@router.get("/installed", response_model=list[InstalledSkillResponse])
async def list_installed(
    request: Request,
    uid: int = Depends(get_current_uid),
) -> list[InstalledSkillResponse]:
    """List the caller's installed skills (drives the agent's skill index)."""
    harness = _harness(request)
    skills = await harness.skill_manager.list_installed(uid)
    out: list[InstalledSkillResponse] = []
    for s in skills:
        manifest = s.manifest or {}
        out.append(
            InstalledSkillResponse(
                skill_id=s.skill_id,
                name=s.name,
                description=s.description,
                version=s.version,
                source_store=s.source_store,
                has_code_tools=bool(manifest.get("has_code_tools", False)),
                enabled=s.enabled,
            )
        )
    return out


@router.post("/install", response_model=InstalledSkillResponse)
async def install_skill(
    request: Request,
    file: UploadFile = File(...),
    uid: int = Depends(get_current_uid),
) -> InstalledSkillResponse:
    """Install a skill zip for the caller (upload -> MinIO + installed_skills row)."""
    harness = _harness(request)
    zip_bytes = await file.read()
    if not zip_bytes:
        raise HTTPException(status_code=400, detail="空文件")

    manifest = read_manifest(zip_bytes)
    skill_id = (
        manifest.get("skill_id")
        or (file.filename.rsplit(".", 1)[0] if file.filename else "")
    )
    if not skill_id:
        raise HTTPException(status_code=400, detail="无法确定 skill_id（manifest 缺失且无文件名）")

    name = manifest.get("name") or skill_id
    description = manifest.get("description")
    version = manifest.get("version")
    has_code_tools = bool(manifest.get("has_code_tools", False))

    try:
        await harness.skill_manager.install(
            uid=uid,
            skill_id=skill_id,
            name=name,
            description=description,
            version=version,
            source_store="upload",
            zip_bytes=zip_bytes,
            manifest=manifest,
        )
    except Exception as exc:
        logger.exception("[SKILLS] install failed uid=%s skill=%s", uid, skill_id)
        raise HTTPException(status_code=502, detail=f"安装失败: {exc}") from exc

    return InstalledSkillResponse(
        skill_id=skill_id,
        name=name,
        description=description,
        version=version,
        source_store="upload",
        has_code_tools=has_code_tools,
        enabled=True,
    )


@router.delete("/{skill_id}")
async def uninstall_skill(
    skill_id: str,
    request: Request,
    uid: int = Depends(get_current_uid),
) -> dict:
    """Uninstall one of the caller's skills (deletes MinIO object + MySQL row)."""
    harness = _harness(request)
    ok = await harness.skill_manager.uninstall(uid, skill_id)
    if not ok:
        raise HTTPException(status_code=404, detail=f"未安装的技能: {skill_id}")
    return {"deleted": skill_id}


@router.get("/{skill_id}/preview")
async def preview_installed_skill(
    skill_id: str,
    request: Request,
    uid: int = Depends(get_current_uid),
) -> dict:
    """Preview an installed skill's content (SKILL.md body + manifest + file list)."""
    harness = _harness(request)
    result = await harness.skill_manager.preview_skill(uid, skill_id)
    if result is None:
        raise HTTPException(status_code=404, detail=f"未安装或不可访问: {skill_id}")
    return result


# ---------------------------------------------------------------------------
# Skill store (external third-party registry) - browse + install from store
# ---------------------------------------------------------------------------


def _store_or_503() -> SkillStoreClient:
    store = get_skill_store_client()
    if not store.enabled:
        raise HTTPException(status_code=503, detail="Skill store 未配置")
    return store


@router.get("/store/list", response_model=list[StoreRepo])
async def list_store_repos(
    request: Request,
    q: str | None = None,
    uid: int = Depends(get_current_uid),
) -> list[StoreRepo]:
    """Search GitHub for skill repos (marketplace). No query -> topic default."""
    store = _store_or_503()
    try:
        return await store.list_repos(q)
    except Exception as exc:
        logger.warning("[SKILLS] store list failed: %s", exc)
        raise HTTPException(status_code=502, detail=f"store 访问失败: {exc}") from exc


@router.get("/store/contents")
async def get_store_contents(
    request: Request,
    repo: str = Query(..., description="owner/repo to browse"),
    path: str = Query("", description="path within the repo; empty = root"),
    branch: str = Query("main"),
    _uid: int = Depends(get_current_uid),
) -> dict:
    """Browse a repo's directory tree or read a file before installing."""
    store = _store_or_503()
    try:
        return await store.get_contents(repo, path, branch)
    except Exception as exc:
        logger.warning(
            "[SKILLS] store contents failed repo=%s path=%s: %s", repo, path, exc
        )
        raise HTTPException(status_code=502, detail=f"访问仓库内容失败: {exc}") from exc


@router.post("/store/install", response_model=InstalledSkillResponse)
async def install_from_store(
    request: Request,
    body: StoreInstallRequest,
    uid: int = Depends(get_current_uid),
) -> InstalledSkillResponse:
    """Download a repo as ONE skill pack (zipball) and install it for the caller.

    The whole repo becomes a single skill (skill_id = repo name, or
    manifest.skill_id if present) - it is NOT split per subdirectory.
    """
    harness = _harness(request)
    store = _store_or_503()
    try:
        zip_bytes, manifest = await store.download_repo(body.repo, body.branch)
    except Exception as exc:
        logger.warning(
            "[SKILLS] store download failed uid=%s repo=%s: %s", uid, body.repo, exc
        )
        raise HTTPException(status_code=502, detail=f"下载失败: {exc}") from exc

    repo_name = body.repo.rsplit("/", 1)[-1]
    skill_id = manifest.get("skill_id") or repo_name
    name = manifest.get("name") or repo_name
    description = manifest.get("description")
    version = manifest.get("version")
    has_code_tools = bool(manifest.get("has_code_tools", False))

    try:
        await harness.skill_manager.install(
            uid=uid,
            skill_id=skill_id,
            name=name,
            description=description,
            version=version,
            source_store=body.repo,
            zip_bytes=zip_bytes,
            manifest=manifest,
        )
    except Exception:
        logger.exception(
            "[SKILLS] install from store failed uid=%s skill=%s", uid, skill_id
        )
        raise HTTPException(status_code=502, detail=f"安装失败: {skill_id}")

    return InstalledSkillResponse(
        skill_id=skill_id,
        name=name,
        description=description,
        version=version,
        source_store=body.repo,
        has_code_tools=has_code_tools,
        enabled=True,
    )
