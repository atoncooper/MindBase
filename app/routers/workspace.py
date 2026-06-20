"""Plan 0023: Workspace management API."""

from __future__ import annotations

import logging
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.routers.auth import get_current_uid
from app.repository.workspace_repository import WorkspaceRepository
from app.response.workspace import (
    WorkspaceResponse,
    WorkspaceCreateRequest,
    WorkspaceUpdateRequest,
    BindingResponse,
    BindingCreateRequest,
    WorkspaceFileItem,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/workspaces", tags=["工作区"])


def _get_ws_repo() -> WorkspaceRepository:
    # Runtime attribute access — `from app.infra.redis import redis_client`
    # would bind the pre-init None at import time and never see the
    # post-init value.  See app/infra/redis.py header for the rationale.
    from app.infra import redis as _redis

    return WorkspaceRepository(redis=_redis.redis_client)


def _workspace_to_response(ws, bindings: list = None) -> WorkspaceResponse:
    binding_responses = []
    if bindings is not None:
        for b in bindings:
            binding_responses.append(BindingResponse(
                id=b.id,
                bindType=b.bind_type,
                folderId=b.folder_id,
                folderName=None,
                uploadUuid=b.upload_uuid,
                fileName=None,
                includeSubfolders=b.include_subfolders,
            ))
    return WorkspaceResponse(
        id=ws.id,
        name=ws.name,
        description=ws.description,
        icon=ws.icon,
        color=ws.color,
        fileCount=ws.file_count,
        chunkCount=ws.chunk_count,
        bindings=binding_responses,
        createdAt=ws.created_at.isoformat() if ws.created_at else "",
        updatedAt=ws.updated_at.isoformat() if ws.updated_at else "",
    )


@router.get("", response_model=list[WorkspaceResponse])
async def list_workspaces(
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    repo = _get_ws_repo()
    workspaces = await repo.list_by_uid(uid, db)
    result = []
    for ws in workspaces:
        bindings = await repo.get_bindings(ws.id, uid, db)
        result.append(_workspace_to_response(ws, bindings))
    return result


@router.post("", response_model=WorkspaceResponse, status_code=201)
async def create_workspace(
    body: WorkspaceCreateRequest,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    repo = _get_ws_repo()
    ws = await repo.create(
        uid=uid,
        name=body.name,
        db=db,
        description=body.description,
        icon=body.icon,
        color=body.color,
    )
    return _workspace_to_response(ws, [])


@router.get("/{workspace_id}", response_model=WorkspaceResponse)
async def get_workspace(
    workspace_id: int,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    repo = _get_ws_repo()
    ws = await repo.get_by_id(workspace_id, uid, db)
    if ws is None:
        raise HTTPException(status_code=404, detail="工作区不存在")
    bindings = await repo.get_bindings(workspace_id, uid, db)
    return _workspace_to_response(ws, bindings)


@router.patch("/{workspace_id}", response_model=WorkspaceResponse)
async def update_workspace(
    workspace_id: int,
    body: WorkspaceUpdateRequest,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    repo = _get_ws_repo()
    ws = await repo.update(
        workspace_id, uid, db,
        name=body.name,
        description=body.description,
        icon=body.icon,
        color=body.color,
    )
    if ws is None:
        raise HTTPException(status_code=404, detail="工作区不存在")
    bindings = await repo.get_bindings(workspace_id, uid, db)
    return _workspace_to_response(ws, bindings)


@router.delete("/{workspace_id}")
async def delete_workspace(
    workspace_id: int,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    repo = _get_ws_repo()
    ok = await repo.soft_delete(workspace_id, uid, db)
    if not ok:
        raise HTTPException(status_code=404, detail="工作区不存在")
    return {"deleted": True}


@router.post("/{workspace_id}/bindings", response_model=WorkspaceResponse)
async def add_binding(
    workspace_id: int,
    body: BindingCreateRequest,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    repo = _get_ws_repo()
    ws = await repo.get_by_id(workspace_id, uid, db)
    if ws is None:
        raise HTTPException(status_code=404, detail="工作区不存在")

    # Verify ownership of bound target
    from app.repository.cloud.folder_repository import get_cloud_folder_repository
    from app.repository.cloud.file_repository import get_cloud_file_repository

    if body.bindType == "folder" and body.folderId:
        folder_repo = get_cloud_folder_repository()
        folder = await folder_repo.get_by_id(body.folderId, uid, db)
        if folder is None:
            raise HTTPException(status_code=403, detail="文件夹不存在或不属于你")

    if body.bindType == "file" and body.uploadUuid:
        file_repo = get_cloud_file_repository()
        file = await file_repo.get_by_uuid(body.uploadUuid, uid, db)
        if file is None:
            raise HTTPException(status_code=403, detail="文件不存在或不属于你")

    await repo.add_binding(
        workspace_id, uid, db,
        bind_type=body.bindType,
        folder_id=body.folderId,
        upload_uuid=body.uploadUuid,
        include_subfolders=body.includeSubfolders,
    )
    bindings = await repo.get_bindings(workspace_id, uid, db)
    return _workspace_to_response(ws, bindings)


@router.delete("/{workspace_id}/bindings/{binding_id}")
async def remove_binding(
    workspace_id: int,
    binding_id: int,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    repo = _get_ws_repo()
    ok = await repo.remove_binding(binding_id, workspace_id, uid, db)
    if not ok:
        raise HTTPException(status_code=404, detail="绑定不存在")
    return {"deleted": True}


@router.get("/{workspace_id}/files", response_model=list[WorkspaceFileItem])
async def list_workspace_files(
    workspace_id: int,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    repo = _get_ws_repo()
    ws = await repo.get_by_id(workspace_id, uid, db)
    if ws is None:
        raise HTTPException(status_code=404, detail="工作区不存在")
    files = await repo.get_files_in_workspace(workspace_id, uid, db)
    return [
        WorkspaceFileItem(
            uploadUuid=f.upload_uuid,
            originalName=f.original_name,
            mimeType=f.mime_type,
            vectorizable=f.vectorizable,
            vectorStatus=f.vector_status,
            vectorChunkCount=f.vector_chunk_count,
        )
        for f in files
    ]
