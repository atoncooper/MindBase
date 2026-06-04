"""Plan 0023: Document vectorization pipeline — with WebSocket status push."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from langchain_core.documents import Document

from app.services.doc_parser import get_parser, MAX_DOC_SIZE
from app.services.doc_parser.cleaner import clean_document_text

logger = logging.getLogger(__name__)


async def _push_status(uid: int, upload_uuid: str, status: str, chunk_count: int = 0, error: str = ""):
    """Fire-and-forget WebSocket push — never blocks the pipeline on failure."""
    try:
        from app.routers.tasks_ws import broadcast_cloud_status
        await broadcast_cloud_status(uid, upload_uuid, status, chunk_count, error)
    except Exception:
        logger.debug("[VECTORIZE] WS push skipped (no router loaded yet)")


async def vectorize_cloud_document(
    upload_uuid: str,
    uid: int,
    db: AsyncSession,
) -> int:
    """Full parse → clean → chunk → embed pipeline for a cloud drive document.

    Idempotent: skips if vector_status='done' and content hash unchanged.
    Returns chunk count written to Milvus cloud_drive.
    """
    from app.repository.cloud.file_repository import FileRepository
    from app.services.rag import get_rag_service

    file_repo = FileRepository()
    file = await file_repo.get_by_uuid(upload_uuid, uid, db)
    if file is None:
        raise ValueError(f"Cloud file not found: {upload_uuid}")

    if not file.vectorizable:
        logger.info("[VECTORIZE] file %s not vectorizable, skipping", upload_uuid)
        file.vector_status = "done"
        await db.commit()
        return 0

    # Download from MinIO
    from app.services.cloud.minio_client import get_minio_client
    minio_client = get_minio_client()
    content_bytes = await asyncio.get_event_loop().run_in_executor(
        None, minio_client.get_object, file.object_key
    )

    if len(content_bytes) > MAX_DOC_SIZE:
        logger.warning("[VECTORIZE] file %s too large (%d bytes > %d), marking non-vectorizable",
                       upload_uuid, len(content_bytes), MAX_DOC_SIZE)
        file.vectorizable = False
        file.vector_status = "failed"
        await db.commit()
        return 0

    # Content hash for idempotency
    content_hash = hashlib.sha256(content_bytes).hexdigest()
    if file.vector_status == "done" and file.content_hash == content_hash:
        logger.info("[VECTORIZE] file %s already vectorized, content unchanged", upload_uuid)
        return file.vector_chunk_count or 0

    file.vector_status = "processing"
    file.content_hash = content_hash
    await db.commit()
    await _push_status(uid, upload_uuid, "processing", 0)

    try:
        mime_type = file.mime_type
        is_video = mime_type.startswith("video/")
        source_type = "drive" if is_video else "doc"

        # ── Phase 1: Extract text → MongoDB ──
        cleaned_text, source, headings = await _extract_text(
            upload_uuid, uid, content_bytes, mime_type, file.original_name, content_hash,
            source_type if not is_video else None,
        )

        # ── Phase 2: Chunking ──
        from app.services.rag.chunking import SemanticChunker
        chunker = SemanticChunker()
        chunks = chunker.chunk(
            cleaned_text,
            video_title=file.title or file.original_name,
            doc_headings=headings if headings else None,
        )
        if not chunks:
            raise RuntimeError(f"Chunking produced no chunks for {upload_uuid}")

        # ── Phase 3: Embedding → write Milvus ──
        docs = _build_documents(upload_uuid, uid, file.title or file.original_name,
                                source, source_type, chunks)
        rag = get_rag_service()
        if rag.cloud_backend is None:
            raise RuntimeError("cloud_backend not available (Milvus not configured)")
        chunk_count = rag.cloud_backend.add(docs)

        # ── Phase 4: Update MySQL metadata ──
        file.doc_parser = source
        file.doc_meta = json.dumps(
            {"headings": headings, "source": source, "source_type": source_type},
            ensure_ascii=False,
        ) if headings else None
        await db.flush()

        # ── Phase 5: Three-layer consistency check ──
        verified = await _verify_consistency(upload_uuid, uid, chunk_count, db)
        if not verified:
            raise RuntimeError(
                f"Consistency check failed for {upload_uuid}: "
                "data mismatch across MongoDB / Milvus / MySQL"
            )

        # ── Phase 6: Mark done ──
        file.vector_status = "done"
        file.vector_chunk_count = chunk_count
        await db.commit()
        logger.info("[VECTORIZE] file %s done: %d chunks (3-layer verified)", upload_uuid, chunk_count)
        await _push_status(uid, upload_uuid, "done", chunk_count)
        return chunk_count

    except Exception as e:
        logger.exception("[VECTORIZE] pipeline failed for %s", upload_uuid)
        file.vector_status = "failed"
        await db.commit()
        await _push_status(uid, upload_uuid, "failed", 0, error=str(e))
        raise


async def _extract_text(upload_uuid, uid, content_bytes, mime_type, filename,
                        content_hash, source_type) -> tuple[str, str, list[dict]]:
    """Extract text from a cloud file. Returns (cleaned_text, source_name, headings)."""
    from app.repository.mongo_asr_repository import AsrDocumentRepository
    from app.infra.mongo import get_database

    is_video = mime_type.startswith("video/")
    if is_video:
        asr_repo = AsrDocumentRepository()
        asr_doc = await asr_repo.get_latest_by_bvid(upload_uuid)
        if not asr_doc or not asr_doc.get("content"):
            raise ValueError(f"No ASR content for video {upload_uuid}")
        return clean_document_text(asr_doc["content"]), "asr", []

    parser = get_parser(mime_type, filename)
    if parser is None:
        raise ValueError(f"No parser for {filename} ({mime_type})")

    parsed = await parser.parse(content_bytes, filename)
    cleaned = clean_document_text(parsed.text)

    mongo_db = get_database()
    if mongo_db is not None:
        await mongo_db["cloud_drive_documents"].update_one(
            {"upload_uuid": upload_uuid},
            {"$set": {
                "upload_uuid": upload_uuid,
                "uid": uid,
                "title": filename,
                "source_type": source_type,
                "content_source": parser.name,
                "content": cleaned,
                "content_hash": content_hash,
                "doc_meta": {
                    "headings": [{"level": h["level"], "text": h["text"]} for h in parsed.headings],
                    "image_count": len(parsed.images),
                    "code_blocks": len(parsed.code_blocks),
                    "tables": len(parsed.tables),
                },
                "updated_at": datetime.utcnow(),
            }},
            upsert=True,
        )

    return cleaned, parser.name, parsed.headings


async def _verify_consistency(
    upload_uuid: str, uid: int, expected_chunks: int, db: AsyncSession,
) -> bool:
    """Verify data exists across all three layers before marking done.

    Returns True only if:
      - MongoDB cloud_drive_documents has the content record
      - Milvus cloud_drive has the expected number of vectors
      - MySQL cloud_files has the metadata (doc_parser set)
    """
    from app.infra.mongo import get_database
    from app.repository.cloud.file_repository import FileRepository

    ok_mongo = False
    ok_milvus = False
    ok_mysql = False

    # 1. MongoDB
    mongo_db = get_database()
    if mongo_db is not None:
        doc = await mongo_db["cloud_drive_documents"].find_one(
            {"upload_uuid": upload_uuid, "uid": uid},
            {"_id": 1},
        )
        ok_mongo = doc is not None
        if not ok_mongo:
            logger.error("[VERIFY] MongoDB missing for %s", upload_uuid)

    # 2. Milvus
    from app.services.rag import get_rag_service
    rag = get_rag_service()
    if rag.cloud_backend is not None:
        actual = rag.cloud_backend.count_by_upload_uuid(upload_uuid)
        ok_milvus = actual >= expected_chunks
        if not ok_milvus:
            logger.error(
                "[VERIFY] Milvus mismatch for %s: expected=%d actual=%d",
                upload_uuid, expected_chunks, actual,
            )

    # 3. MySQL
    file_repo = FileRepository()
    file = await file_repo.get_by_uuid(upload_uuid, uid, db)
    if file is not None:
        ok_mysql = file.doc_parser is not None
        if not ok_mysql:
            logger.error("[VERIFY] MySQL doc_parser not set for %s", upload_uuid)

    result = ok_mongo and ok_milvus and ok_mysql
    logger.info(
        "[VERIFY] %s mongo=%s milvus=%s mysql=%s → %s",
        upload_uuid, ok_mongo, ok_milvus, ok_mysql,
        "PASS" if result else "FAIL",
    )
    return result


def _build_documents(upload_uuid, uid, title, source, source_type, chunks) -> list:
    """Build LangChain Documents from chunked text."""
    docs = []
    for i, chunk in enumerate(chunks):
        docs.append(Document(
            page_content=chunk.embedding_text,
            metadata={
                "upload_uuid": upload_uuid,
                "uid": uid,
                "chunk_index": i,
                "chunk_id": f"{upload_uuid}:{i}",
                "title": title,
                "source": source,
                "source_type": source_type,
                "section_title": chunk.section_title or "",
                "content_type": chunk.content_type or "paragraph",
            },
        ))
    return docs
