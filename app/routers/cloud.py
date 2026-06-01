"""
Cloud drive API router — multipart upload, folder tree, file management.
"""

from __future__ import annotations

import asyncio
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from loguru import logger
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.infra.config import config
from app.routers.auth import get_current_uid
from app.response.cloud import (
    UploadInitRequest,
    UploadInitResponse,
    UploadCompleteRequest,
    UploadCompleteResponse,
    HeartbeatRequest,
    HeartbeatResponse,
    ResumeResponse,
    FolderTreeResponse,
    FolderTreeItem,
    FolderCreateRequest,
    FolderResponse,
    FolderUpdateRequest,
    FolderDeleteResponse,
    VideoItem,
    VideoListResponse,
    VideoDetailResponse,
    VideoUpdateRequest,
    VideoProcessResponse,
    VideoStatusResponse,
)

router = APIRouter(prefix="/cloud", tags=["cloud-drive"])


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _check_minio() -> None:
    if not config.minio.enabled:
        raise HTTPException(status_code=503, detail="MinIO is not enabled")


def _get_upload_service():
    from app.services.cloud.upload_service import get_cloud_upload_service
    return get_cloud_upload_service()


def _get_folder_repo():
    from app.repository.cloud.folder_repository import get_cloud_folder_repository
    return get_cloud_folder_repository()


def _get_file_repo():
    from app.repository.cloud.file_repository import get_cloud_file_repository
    return get_cloud_file_repository()


# ---------------------------------------------------------------------------
# upload endpoints
# ---------------------------------------------------------------------------


@router.post("/upload/init", response_model=UploadInitResponse)
async def init_upload(
    body: UploadInitRequest,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """Start a new multipart upload.  Returns presigned URLs for each chunk."""
    _check_minio()
    try:
        svc = _get_upload_service()
        result = await svc.init_upload(
            uid=uid,
            filename=body.filename,
            file_size=body.fileSize,
            mime_type=body.mimeType,
            folder_id=body.folderId,
            db=db,
        )
        return UploadInitResponse(**result)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("[CLOUD] init_upload failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/upload/{upload_uuid}/complete", response_model=UploadCompleteResponse)
async def complete_upload(
    upload_uuid: str,
    body: UploadCompleteRequest,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """Finalise a multipart upload with the list of completed parts."""
    _check_minio()
    try:
        parts = [{"PartNumber": p.PartNumber, "ETag": p.ETag} for p in body.parts]
        svc = _get_upload_service()
        result = await svc.complete_upload(upload_uuid, parts, uid, db)

        # Generate a presigned file URL for the completed object
        file_url = ""
        try:
            file_repo = _get_file_repo()
            file = await file_repo.get_by_uuid(upload_uuid, uid, db)
            if file is not None:
                from app.services.cloud.minio_client import get_minio_client
                file_url = await get_minio_client().presigned_get(file.object_key)
        except Exception:
            logger.warning(
                "[CLOUD] presigned_get failed for upload_uuid=%s", upload_uuid,
            )

        return UploadCompleteResponse(
            uploadUuid=result["uploadUuid"],
            status="completed",
            fileUrl=file_url,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("[CLOUD] complete_upload failed upload_uuid=%s", upload_uuid)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/upload/heartbeat", response_model=HeartbeatResponse)
async def heartbeat(
    body: HeartbeatRequest,
    uid: int = Depends(get_current_uid),
):
    """Send a heartbeat to keep the upload session alive (5-min TTL)."""
    _check_minio()
    try:
        svc = _get_upload_service()
        result = await svc.heartbeat(body.sessionUuid)
        return HeartbeatResponse(ack=(result.get("status") == "alive"))
    except Exception as e:
        logger.warning(
            "[CLOUD] heartbeat failed session_uuid=%s err=%s",
            body.sessionUuid, e,
        )
        return HeartbeatResponse(ack=False)


@router.post("/upload/{upload_uuid}/resume", response_model=ResumeResponse)
async def resume_upload(
    upload_uuid: str,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """Resume an interrupted upload.  Returns presigned URLs for pending chunks."""
    _check_minio()
    try:
        svc = _get_upload_service()
        result = await svc.resume_upload(upload_uuid, uid, db)

        pending = result.get("pendingChunks", [])
        from app.response.cloud import ResumeChunk
        pending_models = [
            ResumeChunk(
                chunkIndex=c["chunkIndex"],
                chunkSize=c["chunkSize"],
                url=c.get("presignedUrl", c.get("url", "")),
            )
            for c in pending
        ]

        return ResumeResponse(
            uploadUuid=result["uploadUuid"],
            minioUploadId=result.get("minioUploadId", ""),
            pendingChunks=pending_models,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception(
            "[CLOUD] resume_upload failed upload_uuid=%s", upload_uuid,
        )
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# folder endpoints
# ---------------------------------------------------------------------------


@router.get("/folders", response_model=FolderTreeResponse)
async def list_folders(
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """Return the full folder tree for the current user."""
    try:
        folder_repo = _get_folder_repo()
        tree = await folder_repo.get_tree(uid, db)
        folders = [FolderTreeItem.model_validate(item) for item in tree]
        return FolderTreeResponse(folders=folders)
    except Exception as e:
        logger.exception("[CLOUD] list_folders failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/folders", response_model=FolderResponse, status_code=201)
async def create_folder(
    body: FolderCreateRequest,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """Create a new folder."""
    try:
        folder_repo = _get_folder_repo()
        folder = await folder_repo.create(
            uid=uid,
            name=body.name,
            parent_id=body.parentId,
            db=db,
        )
        return FolderResponse.model_validate(folder)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("[CLOUD] create_folder failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/folders/{folder_id}", response_model=FolderResponse)
async def update_folder(
    folder_id: int,
    body: FolderUpdateRequest,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """Rename or move a folder."""
    try:
        folder_repo = _get_folder_repo()

        # Distinguish "not provided" from "explicitly set to None"
        kwargs: dict = {}
        if body.name is not None:
            kwargs["name"] = body.name
        explicit = body.model_dump(exclude_unset=True)
        if "parentId" in explicit:
            kwargs["parent_id"] = body.parentId

        folder = await folder_repo.update(folder_id, uid, **kwargs, db=db)  # type: ignore[arg-type]
        return FolderResponse.model_validate(folder)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("[CLOUD] update_folder failed folder_id=%d", folder_id)
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/folders/{folder_id}", response_model=FolderDeleteResponse)
async def delete_folder(
    folder_id: int,
    force: bool = Query(False),
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """Soft-delete a folder.  When ``force=true``, also deletes the subtree."""
    try:
        folder_repo = _get_folder_repo()
        affected = await folder_repo.soft_delete(folder_id, uid, force, db)
        return FolderDeleteResponse(deleted=True, affectedFiles=affected)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except Exception as e:
        logger.exception(
            "[CLOUD] delete_folder failed folder_id=%d force=%s", folder_id, force,
        )
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# video / file endpoints
# ---------------------------------------------------------------------------


@router.get("/videos", response_model=VideoListResponse)
async def list_videos(
    folderId: Optional[int] = Query(None),
    page: int = Query(1, ge=1),
    pageSize: int = Query(50, ge=1, le=200),
    sort: str = Query("created_at"),
    order: str = Query("desc", pattern="^(asc|desc)$"),
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """Paginated list of files in a folder (root when ``folderId`` is omitted)."""
    try:
        file_repo = _get_file_repo()
        files, total = await file_repo.list_by_folder(
            uid, folderId, db,
            page=page, page_size=pageSize, sort=sort, order=order,
        )
        videos = [VideoItem.model_validate(f) for f in files]
        return VideoListResponse(
            videos=videos,
            total=total,
            page=page,
            pageSize=pageSize,
            hasMore=(page * pageSize) < total,
        )
    except Exception as e:
        logger.exception("[CLOUD] list_videos failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/video/{upload_uuid}", response_model=VideoDetailResponse)
async def get_video_detail(
    upload_uuid: str,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """Get full detail for a single uploaded file."""
    try:
        file_repo = _get_file_repo()
        file = await file_repo.get_by_uuid(upload_uuid, uid, db)
        if file is None:
            raise HTTPException(status_code=404, detail="File not found")

        # Build base response from ORM model
        result = VideoDetailResponse.model_validate(file)

        # Attach folder name
        if file.folder_id is not None:
            try:
                folder_repo = _get_folder_repo()
                folder = await folder_repo.get_by_id(file.folder_id, uid, db)
                if folder is not None:
                    result.folderName = folder.name
            except Exception:
                pass

        # Attach ASR preview from MongoDB
        if config.mongo.enabled:
            try:
                from app.infra.mongo import is_enabled as mongo_ok, coll
                if mongo_ok():
                    doc = await coll("asr_documents").find_one(
                        {"bvid": upload_uuid},
                        sort=[("version", -1)],
                    )
                    if doc:
                        content = doc.get("content", "")
                        if isinstance(content, str) and content:
                            result.asrPreview = content[:500]
            except Exception:
                logger.debug(
                    "[CLOUD] mongo asr_preview lookup skipped for upload_uuid=%s",
                    upload_uuid,
                )

        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(
            "[CLOUD] get_video_detail failed upload_uuid=%s", upload_uuid,
        )
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/video/{upload_uuid}", response_model=VideoDetailResponse)
async def update_video(
    upload_uuid: str,
    body: VideoUpdateRequest,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """Update file metadata (title, description, tags, folder)."""
    try:
        file_repo = _get_file_repo()

        kwargs: dict = {}
        if body.title is not None:
            kwargs["title"] = body.title
        if body.description is not None:
            kwargs["description"] = body.description
        if body.tags is not None:
            kwargs["tags"] = body.tags

        explicit = body.model_dump(exclude_unset=True)
        if "folderId" in explicit:
            kwargs["folder_id"] = body.folderId

        updated = await file_repo.update_meta(upload_uuid, uid, **kwargs, db=db)  # type: ignore[arg-type]

        result = VideoDetailResponse.model_validate(updated)
        if updated.folder_id is not None:
            try:
                folder_repo = _get_folder_repo()
                folder = await folder_repo.get_by_id(updated.folder_id, uid, db)
                if folder is not None:
                    result.folderName = folder.name
            except Exception:
                pass
        return result
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.exception(
            "[CLOUD] update_video failed upload_uuid=%s", upload_uuid,
        )
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/video/{upload_uuid}")
async def delete_video(
    upload_uuid: str,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """Delete an uploaded file and all related data (MinIO, MongoDB, Milvus, MySQL)."""
    try:
        file_repo = _get_file_repo()
        file = await file_repo.get_by_uuid(upload_uuid, uid, db)
        if file is None:
            raise HTTPException(status_code=404, detail="File not found")

        # 1. Clean up MinIO object
        if config.minio.enabled:
            try:
                from app.services.cloud.minio_client import get_minio_client
                await get_minio_client().delete_object(file.object_key)
                logger.info(
                    "[CLOUD] minio object deleted upload_uuid=%s object_key=%s",
                    upload_uuid, file.object_key,
                )
            except Exception as exc:
                logger.warning(
                    "[CLOUD] minio delete_object failed upload_uuid=%s err=%s",
                    upload_uuid, exc,
                )

        # 2. Clean up MongoDB ASR documents
        if config.mongo.enabled:
            try:
                from app.infra.mongo import is_enabled as mongo_ok, coll
                if mongo_ok():
                    result = await coll("asr_documents").delete_many(
                        {"bvid": upload_uuid}
                    )
                    logger.info(
                        "[CLOUD] mongo asr_documents deleted upload_uuid=%s count=%d",
                        upload_uuid, result.deleted_count,
                    )
            except Exception as exc:
                logger.warning(
                    "[CLOUD] mongo cleanup failed upload_uuid=%s err=%s",
                    upload_uuid, exc,
                )

        # 3. Clean up Milvus vectors
        if config.milvus.enabled:
            try:
                from pymilvus import Collection
                col = Collection(config.milvus.collection_name)
                col.delete(f'bvid == "{upload_uuid}"')
                col.flush()
                logger.info(
                    "[CLOUD] milvus vectors deleted upload_uuid=%s", upload_uuid,
                )
            except Exception as exc:
                logger.warning(
                    "[CLOUD] milvus cleanup failed upload_uuid=%s err=%s",
                    upload_uuid, exc,
                )

        # 4. Soft-delete MySQL row
        await file_repo.soft_delete(upload_uuid, uid, db)

        return {"deleted": True, "uploadUuid": upload_uuid}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(
            "[CLOUD] delete_video failed upload_uuid=%s", upload_uuid,
        )
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# processing endpoints
# ---------------------------------------------------------------------------


@router.post("/video/{upload_uuid}/process", response_model=VideoProcessResponse)
async def trigger_processing(
    upload_uuid: str,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """Fire-and-forget ASR + vectorisation pipeline for an uploaded file."""
    try:
        file_repo = _get_file_repo()
        file = await file_repo.get_by_uuid(upload_uuid, uid, db)
        if file is None:
            raise HTTPException(status_code=404, detail="File not found")

        # Fire-and-forget pipeline trigger (same pattern as upload completion)
        async def _run_pipeline() -> None:
            try:
                logger.info(
                    "[CLOUD] pipeline triggered upload_uuid=%s uid=%d",
                    upload_uuid, uid,
                )
                # TODO: wire up actual ASR + vectorisation for cloud files
                # from app.services.asr import asr_service
                # await asr_service.process_cloud_file(upload_uuid, uid)
            except Exception:
                logger.exception(
                    "[CLOUD] pipeline failed upload_uuid=%s", upload_uuid,
                )

        asyncio.create_task(_run_pipeline())

        return VideoProcessResponse(uploadUuid=upload_uuid)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(
            "[CLOUD] trigger_processing failed upload_uuid=%s", upload_uuid,
        )
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/video/{upload_uuid}/status", response_model=VideoStatusResponse)
async def get_video_status(
    upload_uuid: str,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """Get ASR / vectorisation processing status for an uploaded file."""
    try:
        file_repo = _get_file_repo()
        file = await file_repo.get_by_uuid(upload_uuid, uid, db)
        if file is None:
            raise HTTPException(status_code=404, detail="File not found")

        # Check Milvus for actual chunk count (authoritative)
        milvus_chunk_count = file.vector_chunk_count or 0
        if config.milvus.enabled and milvus_chunk_count == 0:
            try:
                from pymilvus import Collection
                col = Collection(config.milvus.collection_name)
                results = col.query(
                    expr=f'bvid == "{upload_uuid}"',
                    output_fields=["chunk_index"],
                )
                milvus_chunk_count = len(results)
            except Exception:
                pass

        return VideoStatusResponse(
            asrStatus=file.asr_status,
            asrProgress=0,
            vectorStatus=file.vector_status,
            vectorChunkCount=milvus_chunk_count,
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(
            "[CLOUD] get_video_status failed upload_uuid=%s", upload_uuid,
        )
        raise HTTPException(status_code=500, detail=str(e))
