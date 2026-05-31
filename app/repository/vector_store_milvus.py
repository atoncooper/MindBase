"""
Milvus vector store — implements VectorStoreBackend.

Requires: pip install pymilvus
Requires: Milvus instance running (docker or cloud).
"""

from __future__ import annotations

from typing import Any

from langchain_core.documents import Document
from loguru import logger

from app.infra.config import MilvusSection


class MilvusVectorStore:
    """Vector store backed by Milvus / Zilliz Cloud."""

    def __init__(self, config: MilvusSection, embedding_fn: Any):
        self._config = config
        self._embedding_fn = embedding_fn
        self._collection = self._get_or_create_collection()

    # ── VectorStoreBackend interface ──────────────────────────────

    def add(self, documents: list[Document]) -> int:
        """Insert documents with embeddings. Returns chunk count."""
        if not documents:
            return 0

        texts = [doc.page_content for doc in documents]
        embeddings = self._embedding_fn.embed_documents(texts)

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
    ) -> list[Document]:
        """Semantic search with optional scalar filter."""
        query_embedding = self._embedding_fn.embed_query(query)

        search_params = {
            "metric_type": self._config.metric_type,
            "params": {"nprobe": self._config.nprobe},
        }

        expr = self._build_filter_expr(filter) if filter else None

        results = self._collection.search(
            data=[query_embedding],
            anns_field="embedding",
            param=search_params,
            limit=k,
            expr=expr,
            output_fields=[
                "bvid", "cid", "page_index", "chunk_index", "chunk_id",
                "title", "page_title", "source", "section_title",
                "content_type", "url", "text",
            ],
        )

        docs: list[Document] = []
        for hits in results:
            for hit in hits:
                entity = hit.entity
                docs.append(Document(
                    page_content=entity.get("text", ""),
                    metadata={
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
                    },
                ))
        return docs

    def delete(
        self,
        ids: list[str] | None = None,
        where: dict[str, Any] | None = None,
    ) -> int:
        """Delete by chunk_ids or metadata filter."""
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
        """Return total vector count."""
        return self._collection.num_entities

    def delete_by_bvid(self, bvid: str) -> int:
        """Delete all vectors for a bvid."""
        return self.delete(where={"bvid": bvid})

    def delete_by_page(self, bvid: str, page_index: int) -> int:
        """Delete vectors for a bvid + page_index."""
        return self.delete(where={"bvid": bvid, "page_index": page_index})

    def count_by_page(self, bvid: str, page_index: int) -> int:
        """Count vectors for a bvid + page_index."""
        expr = f'bvid == "{bvid}" && page_index == {page_index}'
        result = self._collection.query(expr=expr, output_fields=["id"], limit=10000)
        return len(result)

    def get_stats(self) -> dict:
        """Collection stats: total_chunks, total_videos, collection_name."""
        try:
            total = self._collection.num_entities
            # Sample metadata to count unique bvids
            result = self._collection.query(expr="id >= 0", output_fields=["bvid"], limit=10000)
            bvids = set(r.get("bvid", "") for r in result)
            return {
                "total_chunks": total,
                "total_videos": len(bvids),
                "collection_name": self._config.collection_name,
            }
        except Exception as e:
            logger.warning(f"[MILVUS] get_stats failed: {e}")
            return {"total_chunks": 0, "total_videos": 0, "collection_name": self._config.collection_name}

    def clear(self) -> None:
        """Delete all vectors in the collection."""
        self._collection.delete("id >= 0")
        self._collection.flush()
        logger.info("[MILVUS] collection cleared")

    def close(self) -> None:
        """Release resources (connection handled by infra/milvus.py)."""
        pass

    # ── internals ─────────────────────────────────────────────────

    def _get_or_create_collection(self):
        from pymilvus import Collection, CollectionSchema, DataType, FieldSchema

        collection_name = self._config.collection_name

        # Check if collection already exists
        from pymilvus import utility
        if utility.has_collection(collection_name):
            col = Collection(collection_name)
            col.load()
            logger.info(
                "[MILVUS] collection '%s' loaded (%d entities)",
                collection_name,
                col.num_entities,
            )
            return col

        # Define schema
        fields = [
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
            FieldSchema(name="embedding", dtype=DataType.FLOAT_VECTOR, dim=self._config.dimension),
        ]

        schema = CollectionSchema(fields, description="Bilibili RAG video chunks")
        col = Collection(collection_name, schema)

        # Create index
        index_params = {
            "metric_type": self._config.metric_type,
            "index_type": self._config.index_type,
            "params": {"nlist": self._config.nlist},
        }
        col.create_index("embedding", index_params)
        col.load()

        logger.info(
            "[MILVUS] collection '%s' created (dim=%d, index=%s)",
            collection_name,
            self._config.dimension,
            self._config.index_type,
        )
        return col

    def _build_filter_expr(self, filter: dict[str, Any]) -> str:
        """Convert ChromaDB-style metadata filter to Milvus boolean expression."""
        parts: list[str] = []

        for key, value in filter.items():
            if isinstance(value, dict) and "$in" in value:
                items = _quote_list(value["$in"])
                parts.append(f"{key} in {items}")
            elif isinstance(value, str):
                parts.append(f'{key} == "{value}"')
            elif isinstance(value, (int, float)):
                parts.append(f"{key} == {value}")

        return " && ".join(parts) if parts else ""


def _quote_list(items: list) -> str:
    """Quote a list of values for Milvus expression."""
    if not items:
        return "[]"
    sample = items[0]
    if isinstance(sample, str):
        quoted = ", ".join(f'"{i}"' for i in items)
    else:
        quoted = ", ".join(str(i) for i in items)
    return f"[{quoted}]"
