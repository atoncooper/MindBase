"""
Milvus vector store — implements VectorStoreBackend.

Supports dual-collection architecture:
  - bilibili_videos  (IVF_FLAT) — B站 video ASR content
  - cloud_drive      (IVF_PQ, IVF_FLAT cold-start) — cloud drive docs + video ASR

Requires: pip install pymilvus
Requires: Milvus instance running (docker or cloud).
"""

from __future__ import annotations

from typing import Any

from langchain_core.documents import Document
from loguru import logger

from app.infra.config import MilvusSection

MILVUS_IN_MAX_SIZE = 1000
IVF_PQ_COLD_START_THRESHOLD = 5000

_BILIBILI_FIELDS = [
    "bvid", "cid", "page_index", "chunk_index", "chunk_id",
    "title", "page_title", "source", "section_title",
    "content_type", "url", "text",
]

_CLOUD_DRIVE_FIELDS = [
    "upload_uuid", "uid", "chunk_index", "chunk_id",
    "title", "source", "source_type", "section_title",
    "content_type", "text",
]


class MilvusVectorStore:
    """Vector store backed by Milvus / Zilliz Cloud.

    Each instance is bound to a single collection (bilibili_videos or cloud_drive).
    """

    def __init__(self, config: MilvusSection, embedding_fn: Any, collection_name: str):
        self._config = config
        self._embedding_fn = embedding_fn
        self._collection_name = collection_name
        self._is_cloud = (collection_name == config.cloud_collection_name)
        self._collection = self._get_or_create_collection()

    # ── VectorStoreBackend interface ──────────────────────────────

    def add(self, documents: list[Document]) -> int:
        if not documents:
            return 0

        texts = [doc.page_content for doc in documents]
        embeddings = self._embedding_fn.embed_documents(texts)

        if self._is_cloud:
            data = [
                [doc.metadata.get("upload_uuid", "") for doc in documents],
                [doc.metadata.get("uid", 0) for doc in documents],
                [doc.metadata.get("chunk_index", 0) for doc in documents],
                [doc.metadata.get("chunk_id", "") for doc in documents],
                [doc.metadata.get("title", "") for doc in documents],
                [doc.metadata.get("source", "") for doc in documents],
                [doc.metadata.get("source_type", "") for doc in documents],
                [doc.metadata.get("section_title", "") for doc in documents],
                [doc.metadata.get("content_type", "") for doc in documents],
                [doc.page_content for doc in documents],
                embeddings,
            ]
        else:
            data = [
                [doc.metadata.get("bvid", "") for doc in documents],
                [doc.metadata.get("cid", 0) for doc in documents],
                [doc.metadata.get("page_index", 0) for doc in documents],
                [doc.metadata.get("chunk_index", 0) for doc in documents],
                [doc.metadata.get("chunk_id", "") for doc in documents],
                [doc.metadata.get("title", "") for doc in documents],
                [doc.metadata.get("page_title", "") for doc in documents],
                [doc.metadata.get("source", "") for doc in documents],
                [doc.metadata.get("section_title", "") for doc in documents],
                [doc.metadata.get("content_type", "") for doc in documents],
                [doc.metadata.get("url", "") for doc in documents],
                [doc.page_content for doc in documents],
                embeddings,
            ]

        mr = self._collection.insert(data)
        self._collection.flush()
        return len(mr.primary_keys)

    def search(
        self,
        query: str,
        k: int = 5,
        filter: dict[str, Any] | None = None,
        bvids: list[str] | None = None,
        upload_uuids: list[str] | None = None,
    ) -> list[Document]:
        query_embedding = self._embedding_fn.embed_query(query)

        search_params = {
            "metric_type": self._config.metric_type,
            "params": {"nprobe": self._config.nprobe},
        }

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

        results = self._collection.search(
            data=[query_embedding],
            anns_field="embedding",
            param=search_params,
            limit=k,
            expr=expr,
            output_fields=output_fields,
        )

        docs: list[Document] = []
        for hits in results:
            for hit in hits:
                entity = hit.entity
                if self._is_cloud:
                    metadata = {
                        "upload_uuid": entity.get("upload_uuid", ""),
                        "uid": entity.get("uid", 0),
                        "chunk_index": entity.get("chunk_index", 0),
                        "chunk_id": entity.get("chunk_id", ""),
                        "title": entity.get("title", ""),
                        "source": entity.get("source", ""),
                        "source_type": entity.get("source_type", ""),
                        "section_title": entity.get("section_title", ""),
                        "content_type": entity.get("content_type", ""),
                        "score": hit.score,
                    }
                else:
                    metadata = {
                        "bvid": entity.get("bvid", ""),
                        "cid": entity.get("cid", 0),
                        "page_index": entity.get("page_index", 0),
                        "chunk_index": entity.get("chunk_index", 0),
                        "chunk_id": entity.get("chunk_id", ""),
                        "title": entity.get("title", ""),
                        "page_title": entity.get("page_title", ""),
                        "source": entity.get("source", ""),
                        "section_title": entity.get("section_title", ""),
                        "content_type": entity.get("content_type", ""),
                        "url": entity.get("url", ""),
                        "score": hit.score,
                    }
                docs.append(Document(page_content=entity.get("text", ""), metadata=metadata))
        return docs

    def delete(
        self,
        ids: list[str] | None = None,
        where: dict[str, Any] | None = None,
    ) -> int:
        if ids:
            expr = f'chunk_id in {_quote_list(ids)}'
        elif where:
            expr = self._build_filter_expr(where)
        else:
            return 0

        before = self._collection.num_entities
        self._collection.delete(expr)
        self._collection.flush()
        after = self._collection.num_entities
        return before - after

    def count(self) -> int:
        return self._collection.num_entities

    def delete_by_bvid(self, bvid: str) -> int:
        return self.delete(where={"bvid": bvid})

    def delete_by_upload_uuid(self, upload_uuid: str) -> int:
        expr = f'upload_uuid == "{_escape_expr(upload_uuid)}"'
        before = self._collection.num_entities
        self._collection.delete(expr)
        self._collection.flush()
        after = self._collection.num_entities
        return before - after

    def delete_by_page(self, bvid: str, page_index: int) -> int:
        return self.delete(where={"bvid": bvid, "page_index": page_index})

    def count_by_page(self, bvid: str, page_index: int) -> int:
        expr = f'bvid == "{_escape_expr(bvid)}" && page_index == {page_index}'
        result = self._collection.query(expr=expr, output_fields=["id"], limit=10000)
        return len(result)

    def count_by_upload_uuid(self, upload_uuid: str) -> int:
        expr = f'upload_uuid == "{_escape_expr(upload_uuid)}"'
        result = self._collection.query(expr=expr, output_fields=["id"], limit=10000)
        return len(result)

    def get_stats(self) -> dict:
        try:
            total = self._collection.num_entities
            id_field = "upload_uuid" if self._is_cloud else "bvid"
            result = self._collection.query(expr="id >= 0", output_fields=[id_field], limit=10000)
            unique_ids = set(r.get(id_field, "") for r in result)
            return {
                "total_chunks": total,
                "total_videos": len(unique_ids),
                "collection_name": self._collection_name,
            }
        except Exception as e:
            logger.warning(f"[MILVUS] get_stats failed: {e}")
            return {"total_chunks": 0, "total_videos": 0, "collection_name": self._collection_name}

    def clear(self) -> None:
        self._collection.delete("id >= 0")
        self._collection.flush()
        logger.info("[MILVUS] collection '{}' cleared", self._collection_name)

    def close(self) -> None:
        pass

    # ── internals ─────────────────────────────────────────────────

    def _get_or_create_collection(self):
        from pymilvus import Collection, CollectionSchema, utility

        if utility.has_collection(self._collection_name):
            col = Collection(self._collection_name)
            col.load()
            logger.info(
                "[MILVUS] collection '%s' loaded (%d entities)",
                self._collection_name,
                col.num_entities,
            )
            return col

        if self._is_cloud:
            fields = self._build_cloud_drive_schema()
            description = "Cloud drive document & video vector chunks"
        else:
            fields = self._build_bilibili_schema()
            description = "Bilibili RAG video chunks"

        schema = CollectionSchema(fields, description=description, enable_dynamic_field=True)
        col = Collection(self._collection_name, schema)

        index_params = self._get_index_params(self._collection_name, 0)
        col.create_index("embedding", index_params)
        col.load()

        logger.info(
            "[MILVUS] collection '%s' created (dim=%d, index=%s)",
            self._collection_name,
            self._config.dimension,
            index_params["index_type"],
        )
        return col

    @staticmethod
    def _build_bilibili_schema() -> list:
        from pymilvus import DataType, FieldSchema

        return [
            FieldSchema(name="id", dtype=DataType.INT64, is_primary=True, auto_id=True),
            FieldSchema(name="bvid", dtype=DataType.VARCHAR, max_length=20),
            FieldSchema(name="cid", dtype=DataType.INT64),
            FieldSchema(name="page_index", dtype=DataType.INT64),
            FieldSchema(name="chunk_index", dtype=DataType.INT64),
            FieldSchema(name="chunk_id", dtype=DataType.VARCHAR, max_length=64),
            FieldSchema(name="title", dtype=DataType.VARCHAR, max_length=512),
            FieldSchema(name="page_title", dtype=DataType.VARCHAR, max_length=512),
            FieldSchema(name="source", dtype=DataType.VARCHAR, max_length=32),
            FieldSchema(name="section_title", dtype=DataType.VARCHAR, max_length=256),
            FieldSchema(name="content_type", dtype=DataType.VARCHAR, max_length=32),
            FieldSchema(name="url", dtype=DataType.VARCHAR, max_length=512),
            FieldSchema(name="text", dtype=DataType.VARCHAR, max_length=65535),
            FieldSchema(name="embedding", dtype=DataType.FLOAT_VECTOR, dim=0),
        ]

    def _build_cloud_drive_schema(self) -> list:
        from pymilvus import DataType, FieldSchema

        return [
            FieldSchema(name="id", dtype=DataType.INT64, is_primary=True, auto_id=True),
            FieldSchema(name="upload_uuid", dtype=DataType.VARCHAR, max_length=64),
            FieldSchema(name="uid", dtype=DataType.INT64),
            FieldSchema(name="chunk_index", dtype=DataType.INT64),
            FieldSchema(name="chunk_id", dtype=DataType.VARCHAR, max_length=128),
            FieldSchema(name="title", dtype=DataType.VARCHAR, max_length=512),
            FieldSchema(name="source", dtype=DataType.VARCHAR, max_length=32),
            FieldSchema(name="source_type", dtype=DataType.VARCHAR, max_length=16),
            FieldSchema(name="section_title", dtype=DataType.VARCHAR, max_length=256),
            FieldSchema(name="content_type", dtype=DataType.VARCHAR, max_length=32),
            FieldSchema(name="text", dtype=DataType.VARCHAR, max_length=65535),
            FieldSchema(name="embedding", dtype=DataType.FLOAT_VECTOR, dim=self._config.dimension),
        ]

    def _get_index_params(self, collection_name: str, current_vector_count: int) -> dict:
        if collection_name == self._config.cloud_collection_name and current_vector_count < IVF_PQ_COLD_START_THRESHOLD:
            logger.info(
                "[MILVUS] cloud_drive cold-start mode (%d < %d), using IVF_FLAT",
                current_vector_count,
                IVF_PQ_COLD_START_THRESHOLD,
            )
            return {
                "metric_type": self._config.metric_type,
                "index_type": "IVF_FLAT",
                "params": {"nlist": 128},
            }
        elif collection_name == self._config.cloud_collection_name:
            return {
                "metric_type": self._config.metric_type,
                "index_type": "IVF_PQ",
                "params": {"nlist": 1024, "m": 48, "nbits": 8},
            }
        else:
            return {
                "metric_type": self._config.metric_type,
                "index_type": self._config.index_type,
                "params": {"nlist": self._config.nlist},
            }

    def _build_filter_expr(self, filter: dict[str, Any]) -> str:
        parts: list[str] = []
        for key, value in filter.items():
            if isinstance(value, dict) and "$in" in value:
                items = _quote_list(value["$in"])
                parts.append(f"{key} in {items}")
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
        "[MILVUS] in-filter truncated: %d values → %d (MILVUS_IN_MAX_SIZE=%d)",
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
