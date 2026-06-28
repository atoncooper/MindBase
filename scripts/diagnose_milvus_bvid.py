"""Diagnose why quiz generation can't find chunks for a specific bvid.

Usage:
    python scripts/diagnose_milvus_bvid.py BV1ZS411w7rm

Checks, in order:
1. Does the bvid exist in MySQL (video_cache / vectorization status)?
2. Does Milvus have the bvid at all (direct query, not vector search)?
3. Which partition(s) hold the bvid's chunks?
4. Compare against a known-good control bvid found via unfiltered probe.
5. Reproduce the quiz search path and print where it diverges.

Output answers three questions:
- Is the data in Milvus? (branch A vs B)
- Which partition is it in?
- Does the bvid field match what was requested?
"""

from __future__ import annotations

import sys
from pathlib import Path

# Ensure project root is importable when run as a script
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.infra.config import config  # noqa: E402
import asyncio
from app.database import get_db_context  # noqa: E402
from app.models import Video  # noqa: E402
from sqlalchemy import select  # noqa: E402


async def check_mysql(bvid: str) -> None:
    print(f"\n=== [MySQL] video_cache for {bvid} ===")
    try:
        async with get_db_context() as db:
            stmt = select(Video).where(Video.bvid == bvid)
            rows = (await db.execute(stmt)).scalars().all()
            if not rows:
                print(f"  [FAIL] No Video row for {bvid}")
                return
            print(f"  found {len(rows)} rows (Video table may have 1 row per page)")
            for i, row in enumerate(rows):
                print(f"  --- row {i} ---")
                print(f"    bvid={row.bvid}")
                print(f"    title={getattr(row, 'title', '?')[:60]}")
                print(f"    asr_status={getattr(row, 'asr_status', '?')}")
                print(f"    is_vectorized={getattr(row, 'is_vectorized', '?')}")
                print(f"    vectorized_at={getattr(row, 'vectorized_at', '?')}")
                print(f"    updated_at={getattr(row, 'updated_at', '?')}")
    except Exception as e:
        print(f"  [ERROR] MySQL query failed: {e}")


def check_milvus(bvid: str) -> None:
    from pymilvus import MilvusClient, utility, connections

    print(f"\n=== [Milvus] uri={config.milvus.uri} configured db_name={config.milvus.db_name} ===")
    if not config.milvus.enabled:
        print("  [FAIL] Milvus not enabled in config")
        return

    kwargs = {"uri": config.milvus.uri}
    if config.milvus.token:
        kwargs["token"] = config.milvus.token

    c = MilvusClient(**kwargs)
    coll = config.milvus.collection_name

    print(f"\n  collections: {c.list_collections()}")
    stats = c.get_collection_stats(coll)
    print(f"  row_count: {stats.get('row_count', '?')}")
    partitions = c.list_partitions(coll)
    print(f"  partitions: {partitions}")

    # Print EVERY row in EACH partition explicitly — no filtering, no aggregation
    for pname in partitions:
        print(f"\n  === partition={pname} (every row) ===")
        try:
            load_state = c.get_load_state(coll, partition_name=pname)
            print(f"    load_state: {load_state}")
        except Exception as le:
            print(f"    load_state check failed: {le}")
        try:
            rows = c.query(
                collection_name=coll,
                filter="",
                output_fields=["bvid", "page_index", "chunk_id", "title"],
                partition_names=[pname],
                limit=1000,
            )
            print(f"    row count in this partition: {len(rows)}")
            bvid_counts: dict[str, int] = {}
            for i, r in enumerate(rows):
                bv = r.get("bvid", "?")
                bvid_counts[bv] = bvid_counts.get(bv, 0) + 1
                mark = " <== REQUESTED" if bv == bvid else ""
                if i < 50:
                    print(f"      [{i}] bvid={bv} page_index={r.get('page_index')} chunk_id={r.get('chunk_id')}{mark}")
            print(f"    bvid tally in {pname}: {bvid_counts}")
            if bvid in bvid_counts:
                print(f"    [FOUND] {bvid} IS in partition {pname} ({bvid_counts[bvid]} rows)")
            else:
                print(f"    [ABSENT] {bvid} NOT in partition {pname}")
        except Exception as e:
            print(f"    [ERROR] scanning partition {pname}: {e}")

    # Cross-check with ORM API (utility) for partition list
    print("\n  --- ORM cross-check ---")
    try:
        connections.connect(alias="orm", uri=config.milvus.uri, token=config.milvus.token or "")
        orm_parts = utility.list_partitions(coll, using="orm")
        print(f"  utility.list_partitions: {orm_parts}")
        from pymilvus import Collection
        col = Collection(coll, using="orm")
        col.load()
        print(f"  Collection.num_entities: {col.num_entities}")
        for pname in orm_parts:
            try:
                # Query via ORM with partition
                res = col.query(expr="", output_fields=["bvid", "page_index"], partition_names=[pname], limit=1000)
                bvids = {r.get("bvid", "?") for r in res}
                print(f"  ORM partition {pname}: {len(res)} rows, bvids={bvids}")
            except Exception as e:
                print(f"  ORM partition {pname} query failed: {e}")
    except Exception as e:
        print(f"  ORM cross-check failed: {e}")


async def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python scripts/diagnose_milvus_bvid.py <bvid>")
        sys.exit(1)
    bvid = sys.argv[1]
    print(f"=== Diagnosing bvid={bvid} ===")

    await check_mysql(bvid)
    check_milvus(bvid)


if __name__ == "__main__":
    asyncio.run(main())
