"""
Milvus vector store — implements VectorStoreBackend.

Uses the modern ``MilvusClient`` function-style API (PyMilvus 2.4+).
The legacy ORM-style ``Collection`` / ``utility`` API is deprecated and
will be removed in PyMilvus 3.1.

Supports dual-collection architecture:
  - bilibili_videos  (IVF_FLAT) — B站 video ASR content
  - cloud_drive      (IVF_PQ, IVF_FLAT cold-start) — cloud drive docs + video ASR

Requires: pip install pymilvus
Requires: Milvus instance running (docker or cloud).
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from langchain_core.documents import Document
from loguru import logger

from app.infra.config import MilvusSection

MILVUS_IN_MAX_SIZE = 1000
IVF_PQ_COLD_START_THRESHOLD = 5000

_BILIBILI_FIELDS = [
    "bvid",
    "cid",
    "page_index",
    "chunk_index",
    "chunk_id",
    "title",
    "page_title",
    "source",
    "section_title",
    "content_type",
    "url",
    "text",
]

_CLOUD_DRIVE_FIELDS = [
    "upload_uuid",
    "uid",
    "chunk_index",
    "chunk_id",
    "title",
    "source",
    "source_type",
    "section_title",
    "content_type",
    "text",
]


class MilvusVectorStore:
    """Vector store backed by Milvus / Zilliz Cloud.

    Each instance is bound to a single collection (bilibili_videos or cloud_drive).
    """

    def __init__(self, config: MilvusSection, embedding_fn: Any, collection_name: str):
        self._config = config
        self._embedding_fn = embedding_fn
        self._collection_name = collection_name
        self._is_cloud = collection_name == config.cloud_collection_name
        # Set to True by _ensure_collection when an existing collection was
        # dropped + recreated (e.g. embedding dim mismatch after model
        # change).  Callers (RAGService startup) check this flag to reset
        # DB vectorization statuses — otherwise files stay marked "done"
        # while their vectors are gone, and the idempotency check in
        # vectorize.py prevents self-healing.
        self.was_recreated = False
        self._client = self._build_client()
        self._ensure_collection()

    # ── VectorStoreBackend interface ──────────────────────────────

    EMBED_BATCH_SIZE = 10  # DashScope / some OpenAI-compatible APIs limit batch size

    def add(
        self,
        documents: list[Document],
        partition_dt: datetime | None = None,
    ) -> int:
        if not documents:
            return 0
        if self._client is None:
            logger.error(
                "[MILVUS] add called on uninitialized client — skipping collection='{}'",
                self._collection_name,
            )
            return 0

        partition_name: str | None = None
        if partition_dt is not None:
            partition_name = partition_dt.strftime("_%Y_%m")
            self._ensure_partition(partition_name)

        total = 0
        for i in range(0, len(documents), self.EMBED_BATCH_SIZE):
            batch = documents[i : i + self.EMBED_BATCH_SIZE]
            texts = [doc.page_content for doc in batch]
            embeddings = self._embedding_fn.embed_documents(texts)

            if self._is_cloud:
                rows = [
                    {
                        "upload_uuid": doc.metadata.get("upload_uuid", ""),
                        "uid": doc.metadata.get("uid", 0),
                        "chunk_index": doc.metadata.get("chunk_index", 0),
                        "chunk_id": doc.metadata.get("chunk_id", ""),
                        "title": doc.metadata.get("title", ""),
                        "source": doc.metadata.get("source", ""),
                        "source_type": doc.metadata.get("source_type", ""),
                        "section_title": doc.metadata.get("section_title", ""),
                        "content_type": doc.metadata.get("content_type", ""),
                        "text": doc.page_content,
                        "embedding": emb,
                    }
                    for doc, emb in zip(batch, embeddings)
                ]
            else:
                rows = [
                    {
                        "bvid": doc.metadata.get("bvid", ""),
                        "cid": doc.metadata.get("cid", 0),
                        "page_index": doc.metadata.get("page_index", 0),
                        "chunk_index": doc.metadata.get("chunk_index", 0),
                        "chunk_id": doc.metadata.get("chunk_id", ""),
                        "title": doc.metadata.get("title", ""),
                        "page_title": doc.metadata.get("page_title", ""),
                        "source": doc.metadata.get("source", ""),
                        "section_title": doc.metadata.get("section_title", ""),
                        "content_type": doc.metadata.get("content_type", ""),
                        "url": doc.metadata.get("url", ""),
                        "text": doc.page_content,
                        "embedding": emb,
                    }
                    for doc, emb in zip(batch, embeddings)
                ]

            self._client.insert(
                collection_name=self._collection_name,
                data=rows,
                partition_name=partition_name,
            )
            total += len(rows)

        # Flush so that subsequent num_entities / stats reflect the new rows.
        self._safe_flush()

        logger.info(
            "[MILVUS] added {} chunks to collection '{}' partition={}",
            total,
            self._collection_name,
            partition_name or "_default",
        )
        return total

    def search(
        self,
        query: str,
        k: int = 5,
        filter: dict[str, Any] | None = None,
        bvids: list[str] | None = None,
        upload_uuids: list[str] | None = None,
        partition_dt_start: datetime | None = None,
        partition_dt_end: datetime | None = None,
    ) -> list[Document]:
        if self._client is None:
            logger.error(
                "[MILVUS] search called on uninitialized client — returning empty results collection='{}'",
                self._collection_name,
            )
            return []
        query_embedding = self._embedding_fn.embed_query(query)

        search_params = {
            "metric_type": self._config.metric_type,
            "params": {"nprobe": self._config.nprobe},
        }

        # Build partition list from date range
        partition_names: list[str] | None = None
        if partition_dt_start is not None and partition_dt_end is not None:
            names = []
            cur = partition_dt_start.replace(day=1)
            end = partition_dt_end.replace(day=1)
            while cur <= end:
                names.append(cur.strftime("_%Y_%m"))
                # next month
                if cur.month == 12:
                    cur = cur.replace(year=cur.year + 1, month=1)
                else:
                    cur = cur.replace(month=cur.month + 1)
            partition_names = self._filter_existing_partitions(names)

        # Build filter expression
        if bvids and self._is_cloud:
            expr = _build_in_filter("upload_uuid", bvids)
        elif bvids:
            expr = _build_in_filter("bvid", bvids)
        elif upload_uuids:
            expr = _build_in_filter("upload_uuid", upload_uuids)
        elif filter:
            expr = self._build_filter_expr(filter)
        else:
            expr = None

        output_fields = _CLOUD_DRIVE_FIELDS if self._is_cloud else _BILIBILI_FIELDS

        search_kwargs: dict[str, Any] = {
            "collection_name": self._collection_name,
            "data": [query_embedding],
            "anns_field": "embedding",
            "search_params": search_params,
            "limit": k,
            "output_fields": output_fields,
        }
        if expr:
            search_kwargs["filter"] = expr
        if partition_names:
            search_kwargs["partition_names"] = partition_names

        logger.info(
            "[MILVUS] search collection='{}' k={} expr='{}'",
            self._collection_name,
            k,
            expr,
        )
        results = self._client.search(**search_kwargs)

        docs: list[Document] = []
        # MilvusClient search returns list[list[Hit]]; each Hit is a dict
        # subclass supporting direct field access via hit.get(field).
        for topk in results:
            for hit in topk:
                score = hit.get("distance", 0.0)
                if self._is_cloud:
                    metadata = {
                        "upload_uuid": hit.get("upload_uuid", ""),
                        "uid": hit.get("uid", 0),
                        "chunk_index": hit.get("chunk_index", 0),
                        "chunk_id": hit.get("chunk_id", ""),
                        "title": hit.get("title", ""),
                        "source": hit.get("source", ""),
                        "source_type": hit.get("source_type", ""),
                        "section_title": hit.get("section_title", ""),
                        "content_type": hit.get("content_type", ""),
                        "score": score,
                    }
                else:
                    metadata = {
                        "bvid": hit.get("bvid", ""),
                        "cid": hit.get("cid", 0),
                        "page_index": hit.get("page_index", 0),
                        "chunk_index": hit.get("chunk_index", 0),
                        "chunk_id": hit.get("chunk_id", ""),
                        "title": hit.get("title", ""),
                        "page_title": hit.get("page_title", ""),
                        "source": hit.get("source", ""),
                        "section_title": hit.get("section_title", ""),
                        "content_type": hit.get("content_type", ""),
                        "url": hit.get("url", ""),
                        "score": score,
                    }
                docs.append(
                    Document(page_content=hit.get("text", ""), metadata=metadata)
                )
        return docs

    def delete(
        self,
        ids: list[str] | None = None,
        where: dict[str, Any] | None = None,
    ) -> int:
        if self._client is None:
            return 0
        if ids:
            expr = f"chunk_id in {_quote_list(ids)}"
        elif where:
            expr = self._build_filter_expr(where)
        else:
            return 0

        before = self._row_count()
        self._client.delete(collection_name=self._collection_name, filter=expr)
        self._safe_flush()
        after = self._row_count()
        return max(0, before - after)

    def count(self) -> int:
        return self._row_count()

    def delete_by_bvid(self, bvid: str) -> int:
        return self.delete(where={"bvid": bvid})

    def delete_by_upload_uuid(self, upload_uuid: str) -> int:
        if self._client is None:
            return 0
        expr = f'upload_uuid == "{_escape_expr(upload_uuid)}"'
        before = self._row_count()
        self._client.delete(collection_name=self._collection_name, filter=expr)
        self._safe_flush()
        after = self._row_count()
        return max(0, before - after)

    def delete_by_page(self, bvid: str, page_index: int) -> int:
        return self.delete(where={"bvid": bvid, "page_index": page_index})

    def count_by_page(self, bvid: str, page_index: int) -> int:
        if self._client is None:
            return 0
        expr = f'bvid == "{_escape_expr(bvid)}" && page_index == {page_index}'
        result = self._client.query(
            collection_name=self._collection_name,
            filter=expr,
            output_fields=["id"],
            limit=10000,
            consistency_level="Strong",
        )
        return len(result)

    def count_by_upload_uuid(self, upload_uuid: str) -> int:
        if self._client is None:
            return 0
        expr = f'upload_uuid == "{_escape_expr(upload_uuid)}"'
        result = self._client.query(
            collection_name=self._collection_name,
            filter=expr,
            output_fields=["id"],
            limit=10000,
            consistency_level="Strong",
        )
        return len(result)

    def get_stats(self) -> dict:
        if self._client is None:
            return {
                "total_chunks": 0,
                "total_videos": 0,
                "collection_name": self._collection_name,
            }
        try:
            total = self._row_count()
            id_field = "upload_uuid" if self._is_cloud else "bvid"
            result = self._client.query(
                collection_name=self._collection_name,
                filter="id >= 0",
                output_fields=[id_field],
                limit=10000,
            )
            unique_ids = set(r.get(id_field, "") for r in result)
            return {
                "total_chunks": total,
                "total_videos": len(unique_ids),
                "collection_name": self._collection_name,
            }
        except Exception as e:
            logger.warning(f"[MILVUS] get_stats failed: {e}")
            return {
                "total_chunks": 0,
                "total_videos": 0,
                "collection_name": self._collection_name,
            }

    def clear(self) -> None:
        if self._client is None:
            return
        self._client.delete(
            collection_name=self._collection_name, filter="id >= 0"
        )
        self._safe_flush()
        logger.info("[MILVUS] collection '{}' cleared", self._collection_name)

    def reset(self) -> None:
        """Drop and recreate the collection (e.g. after embedding model change)."""
        if self._client is None:
            return
        if self._client.has_collection(self._collection_name):
            self._client.drop_collection(self._collection_name)
            logger.info(
                "[MILVUS] collection '{}' dropped for reset", self._collection_name
            )
        self._ensure_collection()

    def close(self) -> None:
        if self._client is not None:
            try:
                self._client.close()
            except Exception:
                pass
            self._client = None

    def _ensure_partition(self, name: str) -> None:
        """Create a partition if it doesn't already exist."""
        if self._client is None:
            return
        if not self._client.has_partition(self._collection_name, name):
            self._client.create_partition(self._collection_name, name)
            logger.info(
                "[MILVUS] partition '{}' created in collection '{}'",
                name,
                self._collection_name,
            )

    def _filter_existing_partitions(self, names: list[str]) -> list[str] | None:
        """Keep only partitions that actually exist in the collection.

        Returns ``None`` if no requested partitions exist (falls back to
        searching the default partition) or the filtered list otherwise.
        """
        if self._client is None or not names:
            return None
        existing = [
            n for n in names if self._client.has_partition(self._collection_name, n)
        ]
        if not existing:
            logger.warning(
                "[MILVUS] none of the requested partitions {} exist in '{}', "
                "falling back to default partition",
                names,
                self._collection_name,
            )
            return None
        if len(existing) < len(names):
            missing = set(names) - set(existing)
            logger.debug(
                "[MILVUS] skipping missing partitions {} in '{}'",
                missing,
                self._collection_name,
            )
        return existing

    # ── internals ─────────────────────────────────────────────────

    def _build_client(self):
        from pymilvus import MilvusClient

        kwargs: dict[str, Any] = {"uri": self._config.uri}
        if self._config.token:
            kwargs["token"] = self._config.token
        try:
            return MilvusClient(**kwargs)
        except Exception as e:
            logger.error(
                "[MILVUS] failed to connect '{}': {} — vector search will return empty results",
                self._config.uri,
                str(e),
            )
            return None

    def _row_count(self) -> int:
        if self._client is None:
            return 0
        try:
            stats = self._client.get_collection_stats(self._collection_name)
            return int(stats.get("row_count", 0))
        except Exception as e:
            logger.debug("[MILVUS] get_collection_stats failed: {}", e)
            return 0

    def _safe_flush(self) -> None:
        """Best-effort flush so counts/stats reflect pending writes."""
        if self._client is None:
            return
        try:
            self._client.flush(self._collection_name)
        except Exception as e:
            logger.debug("[MILVUS] flush failed (ignored): {}", e)

    def _ensure_collection(self) -> None:
        """Load or create the target collection, auto-fixing dim mismatch."""
        if self._client is None:
            return

        try:
            if self._client.has_collection(self._collection_name):
                # Auto-fix: if existing collection dim doesn't match configured dim,
                # drop and recreate (e.g. after embedding model change).
                desc = self._client.describe_collection(self._collection_name)
                expected_dim = self._config.dimension
                for field in desc.get("fields", []):
                    if field.get("name") == "embedding":
                        params = field.get("params") or field.get("typeParams") or {}
                        try:
                            existing_dim = int(params.get("dim", 0))
                        except (TypeError, ValueError):
                            existing_dim = 0
                        if existing_dim not in (0, expected_dim):
                            logger.warning(
                                "[MILVUS] collection '{}' has dim={}, expected={}, dropping to recreate",
                                self._collection_name,
                                existing_dim,
                                expected_dim,
                            )
                            self._client.drop_collection(self._collection_name)
                            # Signal callers that all prior vectors are gone
                            # — DB vectorization statuses must be reset so
                            # files get re-vectorized instead of being
                            # skipped by the idempotency check.
                            self.was_recreated = True
                            break
                else:
                    self._client.load_collection(self._collection_name)
                    logger.info(
                        "[MILVUS] collection '{}' loaded ({} entities)",
                        self._collection_name,
                        self._row_count(),
                    )
                    return

            # Create new collection
            if self._is_cloud:
                schema = self._build_cloud_drive_schema()
            else:
                schema = self._build_bilibili_schema()

            index_params = self._get_index_params(self._collection_name, 0)
            self._client.create_collection(
                collection_name=self._collection_name,
                schema=schema,
                index_params=index_params,
            )

            logger.info(
                "[MILVUS] collection '{}' created (dim={}, index={})",
                self._collection_name,
                self._config.dimension,
                self._index_type_for_logging(self._collection_name, 0),
            )

        except Exception as e:
            logger.error(
                "[MILVUS] failed to init collection '{}': {} — vector search will return empty results",
                self._collection_name,
                str(e),
            )

    def _build_bilibili_schema(self):
        from pymilvus import DataType

        schema = self._client.create_schema(enable_dynamic_field=True)
        schema.add_field(field_name="id", datatype=DataType.INT64, is_primary=True, auto_id=True)
        schema.add_field(field_name="bvid", datatype=DataType.VARCHAR, max_length=20)
        schema.add_field(field_name="cid", datatype=DataType.INT64)
        schema.add_field(field_name="page_index", datatype=DataType.INT64)
        schema.add_field(field_name="chunk_index", datatype=DataType.INT64)
        schema.add_field(field_name="chunk_id", datatype=DataType.VARCHAR, max_length=64)
        schema.add_field(field_name="title", datatype=DataType.VARCHAR, max_length=512)
        schema.add_field(field_name="page_title", datatype=DataType.VARCHAR, max_length=512)
        schema.add_field(field_name="source", datatype=DataType.VARCHAR, max_length=32)
        schema.add_field(field_name="section_title", datatype=DataType.VARCHAR, max_length=256)
        schema.add_field(field_name="content_type", datatype=DataType.VARCHAR, max_length=32)
        schema.add_field(field_name="url", datatype=DataType.VARCHAR, max_length=512)
        schema.add_field(field_name="text", datatype=DataType.VARCHAR, max_length=65535)
        schema.add_field(
            field_name="embedding",
            datatype=DataType.FLOAT_VECTOR,
            dim=self._config.dimension,
        )
        return schema

    def _build_cloud_drive_schema(self):
        from pymilvus import DataType

        schema = self._client.create_schema(enable_dynamic_field=True)
        schema.add_field(field_name="id", datatype=DataType.INT64, is_primary=True, auto_id=True)
        schema.add_field(field_name="upload_uuid", datatype=DataType.VARCHAR, max_length=64)
        schema.add_field(field_name="uid", datatype=DataType.INT64)
        schema.add_field(field_name="chunk_index", datatype=DataType.INT64)
        schema.add_field(field_name="chunk_id", datatype=DataType.VARCHAR, max_length=128)
        schema.add_field(field_name="title", datatype=DataType.VARCHAR, max_length=512)
        schema.add_field(field_name="source", datatype=DataType.VARCHAR, max_length=32)
        schema.add_field(field_name="source_type", datatype=DataType.VARCHAR, max_length=16)
        schema.add_field(field_name="section_title", datatype=DataType.VARCHAR, max_length=256)
        schema.add_field(field_name="content_type", datatype=DataType.VARCHAR, max_length=32)
        schema.add_field(field_name="text", datatype=DataType.VARCHAR, max_length=65535)
        schema.add_field(
            field_name="embedding",
            datatype=DataType.FLOAT_VECTOR,
            dim=self._config.dimension,
        )
        return schema

    def _get_index_params(self, collection_name: str, current_vector_count: int):
        """Build an ``IndexParams`` object for the embedding field."""
        index_type, params = self._resolve_index_config(collection_name, current_vector_count)
        index_params = self._client.prepare_index_params()
        index_params.add_index(
            field_name="embedding",
            index_type=index_type,
            metric_type=self._config.metric_type,
            params=params,
        )
        return index_params

    def _index_type_for_logging(self, collection_name: str, current_vector_count: int) -> str:
        index_type, _ = self._resolve_index_config(collection_name, current_vector_count)
        return index_type

    def _resolve_index_config(
        self, collection_name: str, current_vector_count: int
    ) -> tuple[str, dict[str, Any]]:
        if (
            collection_name == self._config.cloud_collection_name
            and current_vector_count < IVF_PQ_COLD_START_THRESHOLD
        ):
            logger.info(
                "[MILVUS] cloud_drive cold-start mode ({} < {}), using IVF_FLAT",
                current_vector_count,
                IVF_PQ_COLD_START_THRESHOLD,
            )
            return "IVF_FLAT", {"nlist": 128}
        elif collection_name == self._config.cloud_collection_name:
            return "IVF_PQ", {"nlist": 1024, "m": 48, "nbits": 8}
        else:
            return self._config.index_type, {"nlist": self._config.nlist}

    def _build_filter_expr(self, filter: dict[str, Any]) -> str:
        parts: list[str] = []
        for key, value in filter.items():
            if isinstance(value, dict) and "$in" in value:
                items = _quote_list(value["$in"])
                parts.append(f"{key} in {items}")
            elif isinstance(value, dict) and "$like" in value:
                parts.append(f'{key} like "{_escape_expr(value["$like"])}"')
            elif isinstance(value, str):
                parts.append(f'{key} == "{_escape_expr(value)}"')
            elif isinstance(value, (int, float)):
                parts.append(f"{key} == {value}")
        return " && ".join(parts) if parts else ""


def _build_in_filter(field: str, values: list[str]) -> str | None:
    """Build Milvus in-filter, auto-batching for values > MILVUS_IN_MAX_SIZE."""
    if not values:
        return None
    if len(values) <= MILVUS_IN_MAX_SIZE:
        items = _quote_list(values)
        return f"{field} in {items}"
    # Take first batch; caller should batch at a higher level for full results
    batch = values[:MILVUS_IN_MAX_SIZE]
    items = _quote_list(batch)
    logger.warning(
        "[MILVUS] in-filter truncated: {} values → {} (MILVUS_IN_MAX_SIZE={})",
        len(values),
        len(batch),
        MILVUS_IN_MAX_SIZE,
    )
    return f"{field} in {items}"


def _escape_expr(value: str) -> str:
    """Escape double-quote and backslash in Milvus expression strings."""
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _quote_list(items: list) -> str:
    if not items:
        return "[]"
    sample = items[0]
    if isinstance(sample, str):
        quoted = ", ".join(f'"{i}"' for i in items)
    else:
        quoted = ", ".join(str(i) for i in items)
    return f"[{quoted}]"
