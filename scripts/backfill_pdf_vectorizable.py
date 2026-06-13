"""One-shot backfill: re-flag historical PDF cloud_files as vectorizable.

Context:
  Before PDF parser support landed, ``cloud_files.vectorizable`` was set
  to ``False`` for every uploaded PDF (the mime was on the deny-list).
  Now that we have a parser, the flag must flip back to ``True`` so the
  pipeline picks them up — but only for actual ``application/pdf`` rows.

Behaviour:
  - Default is **dry-run**: prints the count and a sample of affected
    upload_uuids without modifying anything.
  - Pass ``--apply`` to actually run the UPDATE.
  - Sets ``vector_status='pending'`` so the UI shows them as queued
    rather than ``failed``/``not_supported``. We deliberately do NOT
    auto-trigger the pipeline here — the user must reprocess from the UI
    or a separate batch job to avoid mass spawn.

Usage:
  python -m scripts.backfill_pdf_vectorizable          # dry-run
  python -m scripts.backfill_pdf_vectorizable --apply  # really update
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from sqlalchemy import func, select, update

from app.database import async_session_factory
from app.models import CloudFile


async def _run(apply: bool) -> int:
    async with async_session_factory() as db:
        sample_stmt = (
            select(CloudFile.upload_uuid)
            .where(
                CloudFile.mime_type == "application/pdf",
                CloudFile.vectorizable.is_(False),
            )
            .limit(10)
        )
        sample = (await db.execute(sample_stmt)).scalars().all()

        # Use COUNT(*) instead of materialising every row — production
        # tables can hold thousands of PDFs and the previous len(...)
        # approach would OOM.
        count_stmt = (
            select(func.count())
            .select_from(CloudFile)
            .where(
                CloudFile.mime_type == "application/pdf",
                CloudFile.vectorizable.is_(False),
            )
        )
        count = (await db.execute(count_stmt)).scalar_one()

        print(f"[backfill] PDF rows to backfill: {count}")
        if sample:
            print("[backfill] sample upload_uuids:")
            for uid in sample:
                print(f"   - {uid}")

        if not apply:
            print("[backfill] dry-run only; pass --apply to actually update.")
            return 0

        if count == 0:
            print("[backfill] nothing to do.")
            return 0

        upd = (
            update(CloudFile)
            .where(
                CloudFile.mime_type == "application/pdf",
                CloudFile.vectorizable.is_(False),
            )
            .values(vectorizable=True, vector_status="pending")
        )
        result = await db.execute(upd)
        await db.commit()
        print(f"[backfill] updated rows: {result.rowcount}")
        return result.rowcount or 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually run the UPDATE (default is dry-run).",
    )
    args = parser.parse_args()
    asyncio.run(_run(apply=args.apply))
    return 0


if __name__ == "__main__":
    sys.exit(main())
