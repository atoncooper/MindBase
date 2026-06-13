"""
Cloud drive API router — multipart upload, folder tree, file management.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from loguru import logger
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.infra.config import config

if TYPE_CHECKING:
    from app.models import CloudFile
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

# Strong refs for fire-and-forget background tasks. Without this, asyncio
# may garbage-collect the task object mid-flight and the pipeline silently
# disappears (see CPython docs on asyncio.create_task).
_background_tasks: set[asyncio.Task] = set()


def _spawn(coro) -> asyncio.Task:
    task = asyncio.create_task(coro)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return task


def _milvus_escape(value: str) -> str:
    """Escape double-quote and backslash in Milvus expression strings."""
    return value.replace("\\", "\\\\").replace('"', '\\"')


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

        return UploadCompleteResponse(
            uploadUuid=result["uploadUuid"],
            etag=result["etag"],
            status="completed",
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception(f"[CLOUD] complete_upload failed upload_uuid={upload_uuid}")
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
            "[CLOUD] heartbeat failed session_uuid={} err={}",
            body.sessionUuid,
            e,
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
            "[CLOUD] resume_upload failed upload_uuid={}",
            upload_uuid,
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
        # Auto-fix stale video_count (one-time repair for legacy data)
        await folder_repo.recalc_all_counts(uid, db)
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
        logger.exception(f"[CLOUD] update_folder failed folder_id={folder_id}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/folders/{folder_id}", response_model=FolderDeleteResponse)
async def delete_folder(
    folder_id: int,
    force: bool = Query(False),
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """Soft-delete a folder and its files (DB + MinIO).  When ``force=true``,
    also deletes the subtree."""
    try:
        from sqlalchemy import select
        from app.models import CloudFile, CloudFolder

        folder_repo = _get_folder_repo()
        _FOLDER_ALIVE = CloudFolder.deleted_at == None  # noqa: E711
        _FILE_ALIVE = CloudFile.deleted_at == None  # noqa: E711

        # ---- collect folder IDs in subtree (for force mode) ----
        folder_ids = [folder_id]
        if force:
            # BFS/DFS to collect all descendant folder IDs
            queue = [folder_id]
            while queue:
                parent = queue.pop(0)
                child_result = await db.execute(
                    select(CloudFolder.id).where(
                        CloudFolder.parent_id == parent,
                        CloudFolder.uid == uid,
                        _FOLDER_ALIVE,
                    )
                )
                for (cid,) in child_result.all():
                    folder_ids.append(cid)
                    queue.append(cid)

        # ---- collect object_keys from all affected files ----
        result = await db.execute(
            select(CloudFile.object_key).where(
                CloudFile.folder_id.in_(folder_ids),
                CloudFile.uid == uid,
                _FILE_ALIVE,
            )
        )
        object_keys = [row[0] for row in result.all()]

        # ---- soft-delete in DB ----
        affected = await folder_repo.soft_delete(folder_id, uid, force, db)

        # ---- clean up MinIO objects ----
        if config.minio.enabled and object_keys:
            from app.infra.minio import get_minio_client

            minio_cli = get_minio_client()
            for ok in object_keys:
                try:
                    await minio_cli.delete_object(ok)
                except Exception as exc:
                    logger.warning(
                        "[CLOUD] delete_folder minio cleanup failed "
                        "object_key={} err={}",
                        ok,
                        exc,
                    )

        return FolderDeleteResponse(deleted=True, affectedFiles=affected)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except Exception as e:
        logger.exception(
            "[CLOUD] delete_folder failed folder_id={} force={}",
            folder_id,
            force,
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
            uid,
            folderId,
            db,
            page=page,
            page_size=pageSize,
            sort=sort,
            order=order,
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
                    "[CLOUD] mongo asr_preview lookup skipped for upload_uuid={}",
                    upload_uuid,
                )

        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(
            "[CLOUD] get_video_detail failed upload_uuid={}",
            upload_uuid,
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
            "[CLOUD] update_video failed upload_uuid={}",
            upload_uuid,
        )
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/video/{upload_uuid}")
async def delete_video(
    upload_uuid: str,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """Delete an uploaded file and all related data.

    MySQL soft-delete runs first (atomic source-of-truth).
    Storage cleanup (MinIO / MongoDB / Milvus) runs as fire-and-forget
    to avoid inconsistency on crash: if storage cleanup fails, the file
    is already logically deleted and the orphaned data is harmless.
    """
    try:
        file_repo = _get_file_repo()
        file = await file_repo.get_by_uuid(upload_uuid, uid, db)
        if file is None:
            raise HTTPException(status_code=404, detail="File not found")

        # ── 1. Soft-delete MySQL row FIRST (source of truth) ──
        await file_repo.soft_delete(upload_uuid, uid, db)
        _object_key = file.object_key

        # ── 2. Async cleanup: MinIO / MongoDB / Milvus ──
        # TODO: periodic orphan-scan job — scan MinIO objects without
        #       corresponding non-deleted cloud_files rows, and clean up
        #       orphaned MongoDB / Milvus entries.
        async def _cleanup_storage():
            if config.minio.enabled and _object_key:
                try:
                    from app.infra.minio import get_minio_client

                    await get_minio_client().delete_object(_object_key)
                    logger.info(
                        "[CLOUD] minio object deleted upload_uuid={} object_key={}",
                        upload_uuid,
                        _object_key,
                    )
                except Exception as exc:
                    logger.warning(
                        "[CLOUD] minio delete_object failed (orphaned) "
                        "upload_uuid={} object_key={} err={}",
                        upload_uuid,
                        _object_key,
                        exc,
                    )

            if config.mongo.enabled:
                try:
                    from app.infra.mongo import is_enabled as mongo_ok, coll

                    if mongo_ok():
                        result = await coll("asr_documents").delete_many(
                            {"bvid": upload_uuid}
                        )
                        logger.info(
                            "[CLOUD] mongo asr_documents deleted upload_uuid={} count={}",
                            upload_uuid,
                            result.deleted_count,
                        )
                except Exception as exc:
                    logger.warning(
                        "[CLOUD] mongo cleanup failed upload_uuid={} err={}",
                        upload_uuid,
                        exc,
                    )

            if config.milvus.enabled:
                try:
                    from pymilvus import Collection

                    col = Collection(config.milvus.cloud_collection_name)
                    col.delete(f'upload_uuid == "{_milvus_escape(upload_uuid)}"')
                    col.flush()
                    logger.info(
                        "[CLOUD] milvus vectors deleted upload_uuid={}",
                        upload_uuid,
                    )
                except Exception as exc:
                    logger.warning(
                        "[CLOUD] milvus cleanup failed upload_uuid={} err={}",
                        upload_uuid,
                        exc,
                    )

        _spawn(_cleanup_storage())

        return {"deleted": True, "uploadUuid": upload_uuid}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(
            "[CLOUD] delete_video failed upload_uuid={}",
            upload_uuid,
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
    """Fire-and-forget ASR + vectorisation e for an uploaded file."""
    try:
        file_repo = _get_file_repo()
        file: CloudFile | None = await file_repo.get_by_uuid(upload_uuid, uid, db)
        if file is None:
            raise HTTPException(status_code=404, detail="File not found")

        # Enforce mime allowlist on manual reprocess. Without this the
        # caller could re-vectorize blacklisted types (image/*, archives,
        # exes), which would just churn the pipeline before failing
        # downstream. We only flip vectorizable=True when the registry
        # actually has a parser or the mime is on the allowlist.
        from app.services.doc_parser import is_vectorizable

        if not is_vectorizable(file.mime_type, file.original_name):
            raise HTTPException(
                status_code=400,
                detail=f"This mime type is not supported: {file.mime_type}",
            )
        if not file.vectorizable:
            file.vectorizable = True

        # Mark as processing immediately (visible in status + WS push)
        file.asr_status = "processing"
        file.vector_status = "processing"
        await db.commit()

        from app.routers.tasks_ws import broadcast_cloud_status

        _spawn(broadcast_cloud_status(uid, upload_uuid, "processing", 0))

        # Capture primitive values before spawning background task
        # (the request-scoped session + ORM object are invalid after response)
        _upload_uuid: str = upload_uuid
        _uid: int = uid
        _mime_type: str = file.mime_type

        # Fire-and-forget: parse → chunk → embed → verify → mark done
        async def _run_pipeline() -> None:
            from app.database import async_session_factory

            async with async_session_factory() as bg_db:
                try:
                    logger.info(
                        f"[CLOUD] pipeline started upload_uuid={_upload_uuid} "
                        f"uid={_uid} type={_mime_type}",
                    )
                    from app.services.doc_parser.vectorize import (
                        vectorize_cloud_document,
                    )

                    chunk_count = await vectorize_cloud_document(
                        _upload_uuid, _uid, bg_db
                    )
                    logger.info(
                        f"[CLOUD] pipeline done upload_uuid={_upload_uuid} "
                        f"chunks={chunk_count}",
                    )
                except Exception:
                    logger.exception(
                        f"[CLOUD] pipeline failed upload_uuid={_upload_uuid}",
                    )
                    # Ensure DB reflects failure even if vectorize_cloud_document
                    # couldn't set it (e.g. import error before its try/except)
                    try:
                        from app.repository.cloud.file_repository import (
                            get_cloud_file_repository,
                        )

                        file_repo = get_cloud_file_repository()
                        file = await file_repo.get_by_uuid(_upload_uuid, _uid, bg_db)
                        if file is not None and file.vector_status != "failed":
                            file.vector_status = "failed"
                            await bg_db.commit()
                    except Exception:
                        logger.exception(
                            f"[CLOUD] failed to mark vector_status=failed for {_upload_uuid}",
                        )

        _spawn(_run_pipeline())

        return VideoProcessResponse(uploadUuid=upload_uuid)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"[CLOUD] trigger_processing failed upload_uuid={upload_uuid}")
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

                col = Collection(config.milvus.cloud_collection_name)
                results = col.query(
                    expr=f'upload_uuid == "{_milvus_escape(upload_uuid)}"',
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
            "[CLOUD] get_video_status failed upload_uuid={}",
            upload_uuid,
        )
        raise HTTPException(status_code=500, detail=str(e))


# ── Plan 0023: Document support endpoints ──────────────────────


@router.post("/video/{upload_uuid}/reprocess")
async def reprocess_document(
    upload_uuid: str,
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """Re-parse and re-vectorize a cloud document (for content changes)."""
    try:
        file_repo = _get_file_repo()
        file = await file_repo.get_by_uuid(upload_uuid, uid, db)
        if file is None:
            raise HTTPException(status_code=404, detail="File not found")
        if not file.vectorizable:
            raise HTTPException(
                status_code=400, detail="This file type is not vectorizable"
            )

        if config.milvus.enabled:
            try:
                from pymilvus import Collection

                col = Collection(config.milvus.cloud_collection_name)
                col.delete(f'upload_uuid == "{_milvus_escape(upload_uuid)}"')
                col.flush()
            except Exception as e:
                logger.warning(f"[CLOUD] reprocess: delete old vectors failed: {e}")

        file.vector_status = "pending"
        file.vector_chunk_count = 0
        file.content_hash = None
        await db.commit()

        import uuid as _uuid
        from app.services.async_task.tracker import TaskTracker

        task_id = str(_uuid.uuid4())
        tracker = TaskTracker()
        await tracker.start(task_id, task_type="cloud_doc")

        _spawn(_run_doc_reprocess(task_id, upload_uuid, uid))
        return {"uploadUuid": upload_uuid, "taskId": task_id}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"[CLOUD] reprocess failed upload_uuid={upload_uuid}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/video/{upload_uuid}/preview")
async def get_document_preview(
    upload_uuid: str = Path(
        ...,
        min_length=8,
        max_length=64,
        pattern=r"^[A-Za-z0-9_-]+$",
        description="Upload UUID — alphanumeric, underscore, dash only.",
    ),
    offset: int = Query(0, ge=0, le=10_000_000, description="Starting char index"),
    limit: int = Query(5000, ge=1, le=20000, description="Max chars per slice"),
    uid: int = Depends(get_current_uid),
    db: AsyncSession = Depends(get_db),
):
    """Get a paginated text preview of a parsed cloud document.

    FastAPI validates upload_uuid format and offset/limit ranges before this
    body runs — out-of-range params return 422 with a structured error.
    """
    try:
        file_repo = _get_file_repo()
        file = await file_repo.get_by_uuid(upload_uuid, uid, db)
        if file is None:
            raise HTTPException(status_code=404, detail="File not found")

        preview = ""
        total_chars = 0
        doc_meta = None
        try:
            from app.infra.mongo import get_database

            mongo_db = get_database()
            if mongo_db is not None:
                doc = await mongo_db["cloud_drive_documents"].find_one(
                    {"upload_uuid": upload_uuid, "uid": uid},
                    {"content": 1, "doc_meta": 1, "_id": 0},
                )
                if doc:
                    raw = doc.get("content", "")
                    # Strip any residual HTML tags before returning
                    import re as _re

                    cleaned = _re.sub(r"<[^>]*>", "", raw)
                    total_chars = len(cleaned)
                    preview = cleaned[offset : offset + limit]
                    doc_meta = doc.get("doc_meta")
        except Exception as e:
            # Audit log only — do not surface internal errors to client.
            logger.warning("[CLOUD] preview mongo lookup failed: %s", e)

        next_offset = offset + len(preview)
        has_more = next_offset < total_chars

        # Audit trail for private document access (uid + uuid + slice).
        logger.info(
            "[CLOUD][AUDIT] preview uid=%s upload_uuid=%s offset=%s len=%s total=%s",
            uid,
            upload_uuid,
            offset,
            len(preview),
            total_chars,
        )

        return {
            "uploadUuid": upload_uuid,
            "fileName": file.original_name,
            "mimeType": file.mime_type,
            "vectorizable": file.vectorizable,
            "preview": preview,
            "docMeta": doc_meta,
            "offset": offset,
            "limit": limit,
            "totalChars": total_chars,
            "hasMore": has_more,
            "nextOffset": next_offset if has_more else None,
        }
    except HTTPException:
        raise
    except Exception:
        # Log full stack server-side; return generic message to client.
        logger.exception("[CLOUD] preview failed upload_uuid=%s", upload_uuid)
        raise HTTPException(status_code=500, detail="Preview unavailable")


async def _run_doc_reprocess(task_id: str, upload_uuid: str, uid: int):
    """Background task: re-parse + re-vectorize a cloud document."""
    from app.services.async_task.tracker import TaskTracker
    from app.database import async_session_factory

    tracker = TaskTracker()
    log = logger
    try:
        async with async_session_factory() as bg_db:
            await tracker.step(task_id, "parse", "processing", 0)
            from app.services.doc_parser.vectorize import vectorize_cloud_document

            chunk_count = await vectorize_cloud_document(upload_uuid, uid, bg_db)
            await tracker.step(task_id, "parse", "done", 100)
            await tracker.complete(task_id, {"chunk_count": chunk_count})
    except Exception as e:
        log.exception("[CLOUD] _run_doc_reprocess failed task_id={}", task_id)
        await tracker.fail(task_id, str(e))


# ── Admin utils ────────────────────────────────────────────────────


@router.post("/admin/reset-vector-collection")
async def reset_vector_collection(
    uid: int = Depends(get_current_uid),
):
    """Drop and recreate the cloud_drive Milvus collection.
    Use after changing embedding model or when dimension mismatch occurs."""
    try:
        from app.services.rag import get_rag_service

        rag = get_rag_service()
        if rag.cloud_backend is None:
            raise HTTPException(status_code=503, detail="cloud_backend not available")
        rag.cloud_backend.reset()
        # Also reset vector_status on all files so they can be re-processed
        return {"message": "cloud_drive collection dropped and recreated"}
    except Exception as e:
        logger.exception("[CLOUD] reset_vector_collection failed")
        raise HTTPException(status_code=500, detail=str(e))
