"""Plan 0023: Document vectorization pipeline — with WebSocket status push."""

from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from langchain_core.documents import Document

from app.services.doc_parser import get_parser, MAX_DOC_SIZE
from app.services.doc_parser.cleaner import clean_document_text
from app.services.doc_parser.pdf_parser import (
    EmptyPdfTextError,
    PdfEncryptedError,
)

logger = logging.getLogger(__name__)


# Aggregate parser-level "permanent skip" exceptions. Anything in this
# tuple maps to vector_status='not_supported' instead of 'failed', and
# does not re-raise — the pipeline is fire-and-forget so an unhandled
# raise would only end up in logs anyway.
_NotSupportedDocError = (EmptyPdfTextError, PdfEncryptedError)


async def _push_status(
    uid: int, upload_uuid: str, status: str, chunk_count: int = 0, error: str = ""
):
    """Fire-and-forget WebSocket push — never blocks the pipeline on failure."""
    try:
        from app.services.ws_registry import broadcast_cloud_status

        await broadcast_cloud_status(uid, upload_uuid, status, chunk_count, error)
    except Exception:
        logger.debug("[VECTORIZE] WS push skipped (registry unavailable)")


async def vectorize_cloud_document(
    upload_uuid: str,
    uid: int,
    db: AsyncSession,
) -> int:
    """Full parse → clean → chunk → embed pipeline for a cloud drive document.

    Idempotent: skips if vector_status='done' and content hash unchanged.
    Returns chunk count written to Milvus cloud_drive.
    """
    from app.repository.cloud.file_repository import get_cloud_file_repository
    from app.services.rag import get_rag_service

    file_repo = get_cloud_file_repository()
    file = await file_repo.get_by_uuid(upload_uuid, uid, db)
    if file is None:
        raise ValueError(f"Cloud file not found: {upload_uuid}")

    if not file.vectorizable:
        logger.info(
            "[VECTORIZE] file %s not vectorizable (mime=%s), skipping",
            upload_uuid,
            file.mime_type,
        )
        file.vector_status = "not_supported"
        await db.commit()
        return 0

    try:
        # Download from MinIO
        from app.infra.minio import get_minio_client

        minio_client = get_minio_client()
        content_bytes = await minio_client.get_object(file.object_key)

        if len(content_bytes) > MAX_DOC_SIZE:
            logger.warning(
                "[VECTORIZE] file %s too large (%s bytes > %s), marking non-vectorizable",
                upload_uuid,
                len(content_bytes),
                MAX_DOC_SIZE,
            )
            file.vectorizable = False
            file.vector_status = "failed"
            await db.commit()
            return 0

        # Content hash for idempotency.
        # Hash is only persisted *after* the pipeline succeeds, so a crash
        # mid-flight cannot poison the dedup check on retry.
        content_hash = hashlib.sha256(content_bytes).hexdigest()
        if file.vector_status == "done" and file.content_hash == content_hash:
            # DB says done — but verify Milvus actually still has the
            # vectors.  The cloud_drive collection may have been dropped
            # +recreated by _ensure_collection on an embedding dim
            # mismatch (e.g. after switching embedding models), which
            # silently loses all vectors while the DB status stays
            # "done".  Without this check the idempotency guard would
            # skip re-vectorization forever and the file would be
            # unsearchable.
            rag = get_rag_service()
            if rag.cloud_backend is not None:
                actual = rag.cloud_backend.count_by_upload_uuid(upload_uuid)
                if actual == 0:
                    logger.warning(
                        "[VECTORIZE] file %s marked done but Milvus has 0 chunks "
                        "(collection likely recreated) — re-vectorizing",
                        upload_uuid,
                    )
                    # Fall through to re-run the full pipeline.
                else:
                    logger.info(
                        "[VECTORIZE] file %s already vectorized, content unchanged",
                        upload_uuid,
                    )
                    return file.vector_chunk_count or 0
            else:
                logger.info(
                    "[VECTORIZE] file %s already vectorized, content unchanged",
                    upload_uuid,
                )
                return file.vector_chunk_count or 0

        file.vector_status = "processing"
        await db.commit()
        await _push_status(uid, upload_uuid, "processing", 0)

        mime_type = file.mime_type
        is_video = mime_type.startswith("video/")
        source_type = "drive" if is_video else "doc"

        # ── Phase 1: Extract text → MongoDB ──
        cleaned_text, source, headings = await _extract_text(
            upload_uuid,
            uid,
            content_bytes,
            mime_type,
            file.original_name,
            content_hash,
            source_type if not is_video else None,
        )

        # ── Phase 2: Chunking ──
        from app.services.rag.chunking import SemanticChunker

        chunker = SemanticChunker()
        chunks = chunker.chunk(
            cleaned_text,
            video_title=file.title or file.original_name,
            outline=headings if headings else None,
        )
        if not chunks:
            raise RuntimeError(f"Chunking produced no chunks for {upload_uuid}")

        # ── Phase 3: Embedding → write Milvus ──
        docs = _build_documents(
            upload_uuid,
            uid,
            file.title or file.original_name,
            source,
            source_type,
            chunks,
        )
        rag = get_rag_service()
        if rag.cloud_backend is None:
            raise RuntimeError("cloud_backend not available (Milvus not configured)")

        # Clean residual chunks from prior failed runs before re-adding,
        # otherwise the consistency check would see stale data and the
        # collection would accumulate orphan vectors across retries.
        try:
            rag.cloud_backend.delete_by_upload_uuid(upload_uuid)
        except Exception:
            logger.warning(
                "[VECTORIZE] failed to delete stale chunks for %s (continuing)",
                upload_uuid,
                exc_info=True,
            )

        # Use file.created_at (not now()) so retries always land in the
        # same partition — required for idempotent verification and
        # to keep partition count bounded.
        partition_dt = file.created_at or datetime.now(timezone.utc)
        if partition_dt.tzinfo is None:
            partition_dt = partition_dt.replace(tzinfo=timezone.utc)
        chunk_count = rag.cloud_backend.add(docs, partition_dt=partition_dt)

        # ── Phase 4: Update MySQL metadata ──
        file.doc_parser = source
        file.doc_meta = (
            json.dumps(
                {"headings": headings, "source": source, "source_type": source_type},
                ensure_ascii=False,
            )
            if headings
            else None
        )
        await db.flush()

        # ── Phase 5: Three-layer consistency check ──
        verified = await _verify_consistency(upload_uuid, uid, chunk_count, db)
        if not verified:
            # Roll back Milvus so MySQL `failed` status reflects reality.
            # Otherwise the next retry's idempotency check would compare
            # against stale Milvus data and the collection would accumulate
            # orphan vectors that still leak into search results.
            try:
                rag.cloud_backend.delete_by_upload_uuid(upload_uuid)
            except Exception:
                logger.exception(
                    "[VECTORIZE] failed to roll back Milvus for %s after verify miss",
                    upload_uuid,
                )
            raise RuntimeError(
                f"Consistency check failed for {upload_uuid}: "
                "data mismatch across MongoDB / Milvus / MySQL"
            )

        # ── Phase 6: Mark done ──
        # Persist content_hash only on success — a half-finished run must not
        # poison future idempotency checks.
        file.vector_status = "done"
        file.content_hash = content_hash
        file.vector_chunk_count = chunk_count
        await db.commit()
        logger.info(
            "[VECTORIZE] file %s done: %s chunks (3-layer verified)",
            upload_uuid,
            chunk_count,
        )
        await _push_status(uid, upload_uuid, "done", chunk_count)
        return chunk_count

    except _NotSupportedDocError as e:
        # Encrypted / scanned / image-only PDF (or future similar formats).
        # Treat as a permanent skip rather than a retryable failure: flip
        # vectorizable=False so the file stops re-entering the pipeline,
        # and surface a distinct status to the UI.
        logger.warning(
            "[VECTORIZE] file %s marked not_supported: %s", upload_uuid, e
        )
        try:
            file.vectorizable = False
            file.vector_status = "not_supported"
            await db.commit()
        except Exception:
            logger.exception(
                "[VECTORIZE] failed to persist not_supported state for %s",
                upload_uuid,
            )
        await _push_status(uid, upload_uuid, "not_supported", 0, error=str(e))
        return 0

    except Exception as e:
        logger.exception("[VECTORIZE] pipeline failed for %s", upload_uuid)
        file.vector_status = "failed"
        await db.commit()
        await _push_status(uid, upload_uuid, "failed", 0, error=str(e))
        raise


async def _extract_text(
    upload_uuid, uid, content_bytes, mime_type, filename, content_hash, source_type
) -> tuple[str, str, list[dict]]:
    """Extract text from a cloud file. Returns (cleaned_text, source_name, headings)."""
    from app.infra.mongo import get_database

    is_video = mime_type.startswith("video/")
    if is_video:
        from app.repository.mongo_asr_repository import get_latest as mongo_get_latest

        # Cloud-uploaded videos use upload_uuid as cid=0 placeholder
        asr_doc = await mongo_get_latest(upload_uuid, 0)
        if not asr_doc or not asr_doc.get("content"):
            raise ValueError(f"No ASR content for video {upload_uuid}. Run ASR first.")
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
            {
                "$set": {
                    "upload_uuid": upload_uuid,
                    "uid": uid,
                    "title": filename,
                    "source_type": source_type,
                    "content_source": parser.name,
                    "content": cleaned,
                    "content_hash": content_hash,
                    "doc_meta": {
                        "headings": [
                            {"level": h["level"], "text": h["text"]}
                            for h in parsed.headings
                        ],
                        "image_count": len(parsed.images),
                        "code_blocks": len(parsed.code_blocks),
                        "tables": len(parsed.tables),
                    },
                    "updated_at": datetime.now(timezone.utc),
                }
            },
            upsert=True,
        )

    return cleaned, parser.name, parsed.headings


async def _verify_consistency(
    upload_uuid: str,
    uid: int,
    expected_chunks: int,
    db: AsyncSession,
) -> bool:
    """Verify data exists across all three layers before marking done.

    Returns True only if:
      - MongoDB cloud_drive_documents has the content record
      - Milvus cloud_drive has the expected number of vectors
      - MySQL cloud_files has the metadata (doc_parser set)
    """
    from app.infra.mongo import get_database
    from app.repository.cloud.file_repository import get_cloud_file_repository

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
        # Strict equality: stale chunks must be cleaned before add(),
        # so any drift means the write didn't land cleanly.
        ok_milvus = actual == expected_chunks
        if not ok_milvus:
            logger.error(
                "[VERIFY] Milvus mismatch for %s: expected=%s actual=%s",
                upload_uuid,
                expected_chunks,
                actual,
            )

    # 3. MySQL
    file_repo = get_cloud_file_repository()
    file = await file_repo.get_by_uuid(upload_uuid, uid, db)
    if file is not None:
        ok_mysql = file.doc_parser is not None
        if not ok_mysql:
            logger.error("[VERIFY] MySQL doc_parser not set for %s", upload_uuid)

    result = ok_mongo and ok_milvus and ok_mysql
    logger.info(
        "[VERIFY] %s mongo=%s milvus=%s mysql=%s → %s",
        upload_uuid,
        ok_mongo,
        ok_milvus,
        ok_mysql,
        "PASS" if result else "FAIL",
    )
    return result


def _build_documents(upload_uuid, uid, title, source, source_type, chunks) -> list:
    """Build LangChain Documents from chunked text."""
    docs = []
    for i, chunk in enumerate(chunks):
        docs.append(
            Document(
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
            )
        )
    return docs
