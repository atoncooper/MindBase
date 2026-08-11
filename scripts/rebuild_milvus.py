"""Rebuild Milvus collections and reset vectorization statuses.

Drop + recreate both bilibili_videos and cloud_drive collections so they pick
up the current schema (dense-only by default; BM25 sparse_embedding fields
when MILVUS__HYBRID_SEARCH=true, which requires Milvus 2.5+), then reset
every video page and cloud file back to "pending" so the next build
re-vectorizes them.

DESTRUCTIVE: all existing vectors are lost. Run only when switching chunker /
embedding model / toggling hybrid_search / recovering a broken collection.

Usage:
    python scripts/rebuild_milvus.py

Requires Milvus + MySQL running. Does NOT re-vectorize automatically - after
running, trigger re-vectorization via POST /knowledge/build (server must be
running) or the frontend knowledge-base panel.
"""
import asyncio

from sqlalchemy import update

from app.database import engine, get_db_context
from app.models import CloudFile, Video
from app.services.rag import RAGService


async def rebuild() -> None:
    print("=== Rebuilding Milvus collections ===")
    rag = RAGService()

    if rag.vectorstore is None:
        print("[FAIL] bilibili_videos store not initialized (Milvus down?)")
        return
    print("-> dropping + recreating bilibili_videos ...")
    rag.vectorstore.reset()

    if rag.cloud_backend is not None:
        print("-> dropping + recreating cloud_drive ...")
        rag.cloud_backend.reset()
    else:
        print("[WARN] cloud_backend not initialized - skipping cloud_drive reset")

    print("\n=== Resetting vectorization statuses ===")
    async with get_db_context() as db:
        video_res = await db.execute(
            update(Video).values(
                is_vectorized="pending",
                vector_chunk_count=0,
                vector_asr_version=None,
            )
        )
        cloud_res = await db.execute(
            update(CloudFile).values(
                vector_status="pending",
                vector_chunk_count=0,
                content_hash=None,
            )
        )
        await db.commit()
    print(f"-> reset {video_res.rowcount} video pages to pending")
    print(f"-> reset {cloud_res.rowcount} cloud files to pending")

    print("\n=== Done ===")
    print("Next steps:")
    print("  1. Re-vectorize: start the server, then POST /knowledge/build")
    print("     (or use the frontend knowledge-base panel)")
    print("  2. (Optional) Enable hybrid search: set MILVUS__HYBRID_SEARCH=true")
    print("     (requires Milvus 2.5+; add 'hybrid_search: true' under milvus: in config.yaml)")
    print("  3. Verify: python -m app.test.rag.diagnose_rag")


async def main() -> None:
    try:
        await rebuild()
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
