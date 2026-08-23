"""KgEntityIndex — Milvus 实体向量索引（KG 查询期语义实体链接）。

独立小 collection（默认 ``kg_entities``），与 bilibili_videos/cloud_drive 平级：
查询期把用户 query 向量化，检索最相似的实体（name+type+description 文本），
得到种子实体 eid 集合后再去 Neo4j 做子图扩展。

Schema::

    id INT64 auto_id PK ｜ eid VARCHAR(64) ｜ name VARCHAR(256)
    type VARCHAR(32)     ｜ text VARCHAR(2048) ｜ embedding FLOAT_VECTOR(dim)

索引：IVF_FLAT nlist=128 COSINE（实体量级远小于文档块，小 nlist 足够）。

⚠️ 同步客户端（与 vector_store_milvus 一致）——异步调用方必须用
``asyncio.to_thread`` 包装，禁止在事件循环内直接调用。
"""

from __future__ import annotations

from typing import Any

from loguru import logger

from app.infra.config import config


class KgEntityIndex:
    """Milvus 实体向量索引。纯数据访问，embedding_fn 由上层注入。"""

    def __init__(self, embedding_fn: Any, collection_name: str | None = None):
        self._embedding_fn = embedding_fn
        self._collection_name = (
            collection_name or config.kg.entity_collection_name
        )
        self._client: Any | None = None
        self._dimension: int | None = None

    # ------------------------------------------------------------------
    # 连接与建表
    # ------------------------------------------------------------------

    def _build_client(self) -> Any | None:
        from pymilvus import MilvusClient

        kwargs: dict[str, Any] = {"uri": config.milvus.uri}
        if config.milvus.token:
            kwargs["token"] = config.milvus.token
        try:
            return MilvusClient(**kwargs)
        except Exception as e:
            logger.error(
                "[KG_INDEX] failed to connect '{}': {}", config.milvus.uri, e
            )
            return None

    def _probe_dimension(self) -> int:
        if self._dimension is None:
            self._dimension = len(self._embedding_fn.embed_query("dim-probe"))
            logger.info("[KG_INDEX] detected entity embedding dim={}", self._dimension)
        return self._dimension

    def _ensure_collection(self) -> bool:
        """惰性建表。dim 与存量不一致时 drop+recreate（同 RAGService 自愈策略）。

        返回 False 表示不可用（连接失败）。
        """
        if self._client is not None:
            return True
        if not config.milvus.enabled:
            return False
        self._client = self._build_client()
        if self._client is None:
            return False

        dim = self._probe_dimension()
        try:
            if self._client.has_collection(self._collection_name):
                desc = self._client.describe_collection(self._collection_name)
                existing_dim = 0
                for field in desc.get("fields", []):
                    if field.get("name") == "embedding":
                        params = field.get("params") or field.get("typeParams") or {}
                        try:
                            existing_dim = int(params.get("dim", 0))
                        except (TypeError, ValueError):
                            existing_dim = 0
                if existing_dim not in (0, dim):
                    logger.warning(
                        "[KG_INDEX] collection '{}' dim mismatch "
                        "(existing={}, expected={}) — recreating",
                        self._collection_name,
                        existing_dim,
                        dim,
                    )
                    self._client.drop_collection(self._collection_name)

            if not self._client.has_collection(self._collection_name):
                from pymilvus import DataType

                schema = self._client.create_schema(enable_dynamic_field=True)
                schema.add_field(
                    field_name="id",
                    datatype=DataType.INT64,
                    is_primary=True,
                    auto_id=True,
                )
                schema.add_field(
                    field_name="eid", datatype=DataType.VARCHAR, max_length=64
                )
                schema.add_field(
                    field_name="name", datatype=DataType.VARCHAR, max_length=256
                )
                schema.add_field(
                    field_name="type", datatype=DataType.VARCHAR, max_length=32
                )
                schema.add_field(
                    field_name="text", datatype=DataType.VARCHAR, max_length=2048
                )
                schema.add_field(
                    field_name="embedding",
                    datatype=DataType.FLOAT_VECTOR,
                    dim=dim,
                )
                index_params = self._client.prepare_index_params()
                index_params.add_index(
                    field_name="embedding",
                    index_type="IVF_FLAT",
                    metric_type="COSINE",
                    params={"nlist": 128},
                )
                self._client.create_collection(
                    self._collection_name, schema=schema, index_params=index_params
                )
                logger.info(
                    "[KG_INDEX] created collection '{}'", self._collection_name
                )

            self._client.load_collection(self._collection_name)
            return True
        except Exception as e:
            logger.error("[KG_INDEX] ensure_collection failed: {}", e)
            self._client = None
            return False

    # ------------------------------------------------------------------
    # 写入 / 删除
    # ------------------------------------------------------------------

    @staticmethod
    def build_embedding_text(entity: dict[str, Any]) -> str:
        """实体向量化文本：name | type | description。"""
        parts = [
            entity.get("name", ""),
            f"({entity['type']})" if entity.get("type") else "",
            (entity.get("description") or "").strip()[:1500],
        ]
        return " ".join(p for p in parts if p)

    def upsert(self, entities: list[dict[str, Any]]) -> int:
        """按 eid 先删后插（Milvus auto_id 下 upsert 的等价实现）。

        entities 每项: {eid, name, type, description}。
        """
        if not entities or not self._ensure_collection():
            return 0
        rows: list[dict[str, Any]] = []
        for ent in entities:
            text = self.build_embedding_text(ent)[:2000]
            if not text.strip():
                continue
            rows.append(
                {
                    "eid": ent["eid"],
                    "name": ent["name"][:250],
                    "type": (ent.get("type") or "other")[:30],
                    "text": text,
                    "embedding": self._embedding_fn.embed_documents([text])[0],
                }
            )
        if not rows:
            return 0
        self.delete_by_eids([r["eid"] for r in rows])
        try:
            res = self._client.insert(self._collection_name, data=rows)
            inserted = int(res.get("insert_count", len(rows)))
            logger.info(
                "[KG_INDEX] upserted {} entity vectors", inserted
            )
            return inserted
        except Exception as e:
            logger.error("[KG_INDEX] insert failed: {}", e)
            return 0

    def delete_by_eids(self, eids: list[str]) -> int:
        if not eids or not self._ensure_collection():
            return 0
        quoted = ", ".join(f"'{e}'" for e in eids)
        expr = f"eid in [{quoted}]"
        try:
            res = self._client.delete(self._collection_name, filter=expr)
            return int(res if isinstance(res, int) else 0)
        except Exception as e:
            logger.warning("[KG_INDEX] delete failed: {}", e)
            return 0

    # ------------------------------------------------------------------
    # 检索
    # ------------------------------------------------------------------

    def search(self, query: str, top_n: int = 5) -> list[dict[str, Any]]:
        """query→实体链接。返回 [{eid, name, type, score}]（score=COSINE 相似度）。"""
        if not self._ensure_collection():
            return []
        query_embedding = self._embedding_fn.embed_query(query)
        try:
            results = self._client.search(
                collection_name=self._collection_name,
                data=[query_embedding],
                anns_field="embedding",
                search_params={
                    "metric_type": "COSINE",
                    "params": {"nprobe": 16},
                },
                limit=max(top_n, 1),
                output_fields=["eid", "name", "type"],
            )
        except Exception as e:
            logger.error("[KG_INDEX] search failed: {}", e)
            return []
        hits: list[dict[str, Any]] = []
        for topk in results:
            for hit in topk:
                entity = hit.get("entity", {}) or {}
                hits.append(
                    {
                        "eid": hit.get("eid", ""),
                        "name": entity.get("name", ""),
                        "type": entity.get("type", ""),
                        "score": float(hit.get("distance", 0.0)),
                    }
                )
        return hits

    # ------------------------------------------------------------------
    # 统计 / 运维
    # ------------------------------------------------------------------

    def count(self) -> int:
        if not self._ensure_collection():
            return 0
        try:
            stats = self._client.get_collection_stats(self._collection_name)
            return int(stats.get("row_count", 0))
        except Exception as e:
            logger.debug("[KG_INDEX] get stats failed: {}", e)
            return 0

    def clear(self) -> None:
        """清空实体向量（危险操作，配合图谱重建使用）。"""
        if self._ensure_collection():
            self._client.drop_collection(self._collection_name)
            self._client = None
            logger.warning("[KG_INDEX] collection dropped")

    def close(self) -> None:
        if self._client is not None:
            try:
                self._client.close()
            except Exception as exc:
                logger.debug("[KG_INDEX] close error (ignored): {}", exc)
            self._client = None
