"""KgService — 知识图谱构建与查询编排（Plan 1.0.5）。

入库管道（独立触发，复刻「ASR/向量化解耦」模式）::

    POST /knowledge/kg/build
      └► try_start_build(uid, folder_ids)
           ├─ folder_ids → media_ids → bvids（MySQL，scope 辅助）
           ├─ 单活跃任务守卫（同进程同时最多一个 build）
           ├─ task_type="kg_extract" 进 async_tasks（TaskTracker）
           └─ 并发信号量逐分P：process_page（幂等）
                Mongo 正文 → LLM 抽取 → resolver 校验 → Cypher MERGE
                → 实体向量 upsert Milvus → video.kg_status='done'

幂等：``video.kg_version`` 记录抽取时的 content version，
内容未变则跳过；重抽前 delete-before-write 清旧证据边。

失败隔离：单分P 失败置 kg_status='failed' 可重试，不影响其他分P；
Neo4j/Milvus 不可用时端点报 unavailable，绝不阻塞主链路。
"""

from __future__ import annotations

import asyncio
from typing import Any

from loguru import logger
from sqlalchemy import or_, select

from app.infra.config import config
from app.infra.neo4j import is_enabled as neo4j_ok
from app.repository.kg_entity_index import KgEntityIndex
from app.repository.kg_graph_repository import get_kg_graph_repository
from app.services.async_task.tracker import TaskTracker
from app.services.kg.extractor import KgExtractor
from app.services.kg.resolver import resolve_extraction
from app.services.kg.retriever import KgRetriever

# 后台任务强引用，防 GC（同 vector_page_service 模式）
_background_tasks: set[asyncio.Task] = set()


class KgService:
    """知识图谱服务：build 编排 + 删除级联 + 统计 + 检索入口。"""

    def __init__(self) -> None:
        self._tracker = TaskTracker()
        self._extractor = KgExtractor()
        self._retriever = KgRetriever()
        self._graph = get_kg_graph_repository()
        self._entity_index: KgEntityIndex | None = None
        self._active_lock = asyncio.Lock()
        self._active_task_id: str | None = None

    # ------------------------------------------------------------------
    # 可用性 / 依赖
    # ------------------------------------------------------------------

    def is_available(self) -> bool:
        """Neo4j 已连接即可构建；实体索引（Milvus）缺失仅影响语义链接。"""
        return neo4j_ok()

    @property
    def retriever(self) -> KgRetriever:
        return self._retriever

    def _get_entity_index(self) -> KgEntityIndex | None:
        if self._entity_index is None:
            try:
                from app.services.rag import get_rag_service

                rag = get_rag_service()
                if rag.embeddings is None:
                    return None
                self._entity_index = KgEntityIndex(rag.embeddings)
            except Exception as e:
                logger.warning("[KG] entity index unavailable: {}", e)
                return None
        return self._entity_index

    def get_active_task_id(self) -> str | None:
        return self._active_task_id

    # ------------------------------------------------------------------
    # 构建入口
    # ------------------------------------------------------------------

    async def try_start_build(
        self, uid: int, folder_ids: list[int] | None = None
    ) -> dict[str, Any]:
        """为用户收藏夹触发 KG 构建。已有活跃任务时复用其 task_id。

        返回 {"task_id": str, "reused": bool}。
        Raises ValueError 当范围内无已同步数据或 Neo4j 不可用。
        """
        if not self.is_available():
            raise RuntimeError("知识图谱存储不可用（Neo4j 未连接）")

        async with self._active_lock:
            if self._active_task_id is not None:
                return {"task_id": self._active_task_id, "reused": True}

            bvids = await self._resolve_bvids(uid, folder_ids)
            if not bvids:
                raise ValueError("未找到已同步的收藏夹视频，请先执行收藏夹同步")

            task_id = await self._tracker.create(
                uid=uid,
                task_type="kg_extract",
                target={"folder_ids": folder_ids or [], "bvid_count": len(bvids)},
            )
            self._active_task_id = task_id

        task = asyncio.create_task(self._run_build(task_id, uid, bvids))
        _background_tasks.add(task)
        task.add_done_callback(_background_tasks.discard)
        logger.info("[KG] build started task_id={} uid={} bvids={}", task_id, uid, len(bvids))
        return {"task_id": task_id, "reused": False}

    async def _resolve_bvids(
        self, uid: int, folder_ids: list[int] | None
    ) -> list[str]:
        """收藏夹范围解析（复用 chat 链路的 scope 辅助，纯 DB 查询）。"""
        from app.database import get_db_context
        from app.services.chat.scope import (
            get_bvids_by_media_ids,
            get_media_ids_for_uid,
        )

        async with get_db_context() as db:
            media_ids = await get_media_ids_for_uid(db, uid, folder_ids or None)
            if not media_ids:
                return []
            return await get_bvids_by_media_ids(db, media_ids)

    async def _select_pending_pages(self, bvids: list[str]) -> list[dict[str, Any]]:
        """圈定待抽取分P：ASR 完成且（从未抽取 / 失败可重试 / 内容已变更）。"""
        from app.database import get_db_context
        from app.models import Video

        stmt = (
            select(Video.bvid, Video.cid, Video.page_index, Video.page_title, Video.version)
            .where(
                Video.bvid.in_(bvids),
                Video.is_processed.is_(True),
                or_(
                    Video.kg_version.is_(None),
                    Video.kg_status == "failed",
                    Video.kg_version != Video.version,
                ),
            )
            .limit(config.kg.page_batch_size)
        )
        async with get_db_context() as db:
            rows = (await db.execute(stmt)).fetchall()
        return [
            {
                "bvid": r.bvid,
                "cid": r.cid,
                "page_index": r.page_index,
                "page_title": r.page_title,
                "version": r.version,
            }
            for r in rows
        ]

    async def _run_build(
        self, task_id: str, uid: int, bvids: list[str]
    ) -> None:
        """后台执行整轮构建；单分P 失败隔离，最终 complete（带错误摘要）。"""
        try:
            await self._tracker.start(task_id)
            await self._tracker.step(
                task_id, name="init", status="processing", progress=0
            )

            pages = await self._select_pending_pages(bvids)
            total = len(pages)
            logger.info("[KG] pending pages={} task_id={}", total, task_id)
            if not pages:
                await self._tracker.complete(
                    task_id, result={"total": 0, "message": "所有分P已是最新"}
                )
                return

            sem = asyncio.Semaphore(max(config.kg.concurrency, 1))
            counters = {"ok": 0, "failed": 0}
            progress_lock = asyncio.Lock()

            async def _one(page: dict[str, Any]) -> None:
                async with sem:
                    try:
                        await self.process_page(
                            bvid=page["bvid"],
                            cid=page["cid"],
                            page_index=page["page_index"],
                            page_title=page.get("page_title"),
                            expected_version=page["version"],
                        )
                        counters["ok"] += 1
                    except Exception as exc:
                        counters["failed"] += 1
                        logger.error(
                            "[KG] page failed bvid={} p{}: {}",
                            page["bvid"],
                            page["page_index"],
                            exc,
                        )
                    finally:
                        async with progress_lock:
                            done = counters["ok"] + counters["failed"]
                            await self._tracker.set_progress(
                                task_id, int(done * 100 / total)
                            )
                            await self._tracker.step(
                                task_id,
                                name=f"extract:{page['bvid']}:p{page['page_index']}",
                                status="done",
                                progress=int(done * 100 / total),
                            )

            await asyncio.gather(*[_one(p) for p in pages])

            await self._tracker.complete(
                task_id,
                result={
                    "total": total,
                    "ok": counters["ok"],
                    "failed": counters["failed"],
                },
            )
            logger.info(
                "[KG] build done task_id={} ok={} failed={}",
                task_id,
                counters["ok"],
                counters["failed"],
            )
        except Exception as e:
            logger.exception("[KG] build failed task_id={}", task_id)
            await self._tracker.fail(task_id, str(e))
        finally:
            self._active_task_id = None

    # ------------------------------------------------------------------
    # 单分P 幂等管道
    # ------------------------------------------------------------------

    async def process_page(
        self,
        bvid: str,
        cid: int,
        page_index: int,
        page_title: str | None = None,
        expected_version: int | None = None,
    ) -> dict[str, Any]:
        """抽取单个分P并写图。幂等：内容未变直接跳过。

        Raises 异常由调用方决定如何标记状态（build 内捕获计数）。
        """
        from app.models import Video
        from app.database import get_db_context
        from app.repository.mongo_asr_repository import get_latest
        from app.infra.mongo import is_enabled as mongo_ok

        # ---- Phase 1: 幂等检查 + 置 processing ----
        async with get_db_context() as db:
            row = (
                await db.execute(
                    select(Video).where(Video.bvid == bvid, Video.cid == cid)
                )
            ).scalar_one_or_none()
            if not row:
                raise ValueError(f"Video not found: bvid={bvid}, cid={cid}")
            if not row.is_processed:
                raise ValueError(f"ASR not done yet: bvid={bvid}, cid={cid}")

            content_version = (
                expected_version if expected_version is not None else row.version
            )
            if (
                row.kg_status == "done"
                and row.kg_version == content_version
                and expected_version is None
            ):
                return {"skipped": True, "reason": "up to date"}

            row.kg_status = "processing"
            await db.commit()

        try:
            # ---- Phase 2: 读正文 ----
            text = ""
            if mongo_ok():
                doc = await get_latest(bvid, cid)
                if doc:
                    text = doc.get("content", "")
            if not text:
                raise ValueError(f"no ASR content in MongoDB: bvid={bvid}, cid={cid}")

            title = page_title or f"P{page_index + 1}"

            # ---- Phase 3: 删旧证据边（delete-before-write）----
            removed = await self._graph.delete_page_evidence(bvid, page_index)
            if removed:
                logger.debug(
                    "[KG] removed {} stale evidence edges bvid={} p{}",
                    removed,
                    bvid,
                    page_index,
                )

            # ---- Phase 4: 抽取 + 校验 ----
            raw = await self._extractor.extract(text, title=title)
            resolved = resolve_extraction(raw)
            if not resolved.entities:
                logger.info("[KG] no entities extracted bvid={} p{}", bvid, page_index)

            # ---- Phase 5: 写图 ----
            if resolved.entities:
                await self._graph.upsert_entities(resolved.entities)
                appearances = [
                    {"eid": ent["eid"], "quote": ent.get("quote", "")}
                    for ent in resolved.entities
                ]
                await self._graph.link_appearances(bvid, page_index, appearances)
            if resolved.relations:
                await self._graph.upsert_relations(resolved.relations)

            # ---- Phase 6: 实体向量 upsert（best-effort，Milvus 故障不回滚）----
            if resolved.entities:
                index = self._get_entity_index()
                if index is not None:
                    try:
                        await asyncio.to_thread(index.upsert, resolved.entities)
                    except Exception as exc:
                        logger.warning("[KG] entity index upsert failed: {}", exc)

            # ---- Phase 7: 确认 done ----
            async with get_db_context() as db:
                row = (
                    await db.execute(
                        select(Video).where(Video.bvid == bvid, Video.cid == cid)
                    )
                ).scalar_one_or_none()
                if row:
                    row.kg_status = "done"
                    row.kg_version = content_version
                    await db.commit()

            result = {
                "entities": len(resolved.entities),
                "relations": len(resolved.relations),
                "dropped_relations": resolved.dropped_relations,
            }
            logger.info(
                "[KG] page done bvid={} p{} entities={} relations={}",
                bvid,
                page_index,
                result["entities"],
                result["relations"],
            )
            return result

        except Exception:
            # 失败路径：标记 failed，保留重试机会（不影响其他分P）
            try:
                async with get_db_context() as db:
                    row = (
                        await db.execute(
                            select(Video).where(Video.bvid == bvid, Video.cid == cid)
                        )
                    ).scalar_one_or_none()
                    if row:
                        row.kg_status = "failed"
                        await db.commit()
            except Exception as db_err:
                logger.error("[KG] failed to mark failed status: {}", db_err)
            raise

    # ------------------------------------------------------------------
    # 删除级联 / 统计
    # ------------------------------------------------------------------

    # ------------------------------------------------------------------
    # Graph visualization subgraph (added in Plan 1.0.6)
    # ------------------------------------------------------------------

    async def subgraph(
        self,
        center_eid: str | None = None,
        depth: int = 2,
        max_nodes: int = 80,
    ) -> dict[str, Any]:
        """Visualization subgraph. Without center: overview (head entities +
        their internal edges); with center: BFS expansion.

        Returns {available, center, nodes: [{eid,name,type,description,degree}],
        edges: [{src,dst,rel_type}]}.
        """
        if not self.is_available():
            return {"available": False, "center": None, "nodes": [], "edges": []}
        if center_eid:
            return await self._subgraph_centered(center_eid, depth, max_nodes)
        return await self._subgraph_overview(max_nodes)

    async def _subgraph_overview(self, max_nodes: int) -> dict[str, Any]:
        tops = await self._graph.top_entities(limit=max_nodes)
        if not tops:
            return {"available": True, "center": None, "nodes": [], "edges": []}
        eids = [t["eid"] for t in tops]
        rows = await self._graph.edges_among(eids)
        nodes = [
            {
                "eid": t["eid"],
                "name": t["name"],
                "type": t.get("type") or "other",
                "description": t.get("description") or "",
                "degree": 0,
            }
            for t in tops
        ]
        edges = [
            {
                "src": r["src_eid"],
                "dst": r["dst_eid"],
                "rel_type": r.get("rel_type") or "关联",
            }
            for r in rows
        ]
        return self._finalize_subgraph(None, nodes, edges)

    async def _subgraph_centered(
        self, center_eid: str, depth: int, max_nodes: int
    ) -> dict[str, Any]:
        base = await self._graph.entities_by_eids([center_eid])
        if not base:
            return {"available": True, "center": None, "nodes": [], "edges": []}

        node_info: dict[str, dict[str, Any]] = {
            center_eid: {
                "eid": center_eid,
                "name": base[0].get("name", ""),
                "type": base[0].get("type") or "other",
                "description": base[0].get("description") or "",
                "degree": 0,
            }
        }
        edge_set: set[tuple[str, str, str]] = set()
        visited = {center_eid}
        frontier = [center_eid]

        for _ in range(max(depth, 0)):
            if not frontier or len(visited) >= max_nodes:
                break
            rows = await self._graph.neighbors(frontier, list(visited), limit=max_nodes)
            next_frontier: list[str] = []
            for r in rows:
                pair_key = tuple(sorted((r["from_eid"], r["eid"]))) + (
                    (r.get("rel_type") or "关联"),
                )
                edge_set.add(pair_key)
                if r["eid"] not in visited and len(visited) < max_nodes:
                    visited.add(r["eid"])
                    node_info[r["eid"]] = {
                        "eid": r["eid"],
                        "name": r.get("name", ""),
                        "type": r.get("type") or "other",
                        "description": r.get("description") or "",
                        "degree": 0,
                    }
                    next_frontier.append(r["eid"])
            frontier = next_frontier

        nodes = list(node_info.values())
        edges = [
            {"src": s, "dst": d, "rel_type": rt} for s, d, rt in edge_set
        ]
        return self._finalize_subgraph(center_eid, nodes, edges)

    @staticmethod
    def _finalize_subgraph(
        center: str | None, nodes: list[dict[str, Any]], edges: list[dict[str, Any]]
    ) -> dict[str, Any]:
        """Overwrite node degrees with in-subgraph connection counts (drives
        frontend node sizing)."""
        degree: dict[str, int] = {}
        for e in edges:
            degree[e["src"]] = degree.get(e["src"], 0) + 1
            degree[e["dst"]] = degree.get(e["dst"], 0) + 1
        for n in nodes:
            n["degree"] = degree.get(n["eid"], 0)
        nodes.sort(key=lambda x: -x["degree"])
        return {"available": True, "center": center, "nodes": nodes, "edges": edges}

    async def delete_video_data(self, bvid: str) -> dict[str, int]:
        """视频删除时的图谱级联清理（best-effort，不抛异常）。"""
        if not neo4j_ok():
            return {"entities_removed": 0, "videos_removed": 0}
        try:
            return await self._graph.delete_video(bvid)
        except Exception as e:
            logger.error("[KG] delete cascade failed bvid={}: {}", bvid, e)
            return {"entities_removed": 0, "videos_removed": 0}

    async def stats(self) -> dict[str, Any]:
        """图谱统计：Neo4j 计数 + Milvus 实体向量数 + 待抽取分P数。"""
        result: dict[str, Any] = {
            "available": self.is_available(),
            "graph": {"entities": 0, "relations": 0, "evidence": 0, "videos": 0},
            "entity_vectors": 0,
            "pending_pages": 0,
        }
        if not self.is_available():
            return result
        try:
            result["graph"] = await self._graph.stats()
        except Exception as e:
            logger.warning("[KG] graph stats failed: {}", e)
        index = self._get_entity_index()
        if index is not None:
            try:
                result["entity_vectors"] = await asyncio.to_thread(index.count)
            except Exception as e:
                logger.warning("[KG] entity vector stats failed: {}", e)
        try:
            from app.database import get_db_context
            from app.models import Video
            from sqlalchemy import func

            async with get_db_context() as db:
                cnt = await db.execute(
                    select(func.count(Video.id)).where(
                        Video.is_processed.is_(True),
                        or_(
                            Video.kg_version.is_(None),
                            Video.kg_status == "failed",
                            Video.kg_version != Video.version,
                        ),
                    )
                )
                result["pending_pages"] = int(cnt.scalar() or 0)
        except Exception as e:
            logger.warning("[KG] pending count failed: {}", e)
        return result


_service: KgService | None = None


def get_kg_service() -> KgService:
    """模块级懒加载单例。"""
    global _service
    if _service is None:
        _service = KgService()
    return _service
