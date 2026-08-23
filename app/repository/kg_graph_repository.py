"""KgGraphRepository — 全部 Neo4j 访问封装（Plan 1.0.5 知识图谱）。

Graph schema::

    (:Entity {eid, name, name_lower, type, description, aliases,
              mention_count, created_at, updated_at})
    (:Video  {bvid})
    (a:Entity)-[:RELATES     {rel_type, weight, quotes}]->(b:Entity)
    (e:Entity)-[:APPEARS_IN  {page_index, quote}]->(v:Video)

设计要点：
- ``eid`` 由 ``sha1(name_lower)[:16]`` 确定性生成，跨重建稳定（供 Milvus 同步）
- Entity 以 ``name_lower`` MERGE、Video 以 ``bvid`` MERGE —— 天然幂等
- APPEARS_IN 按 ``(entity, video, page_index)`` 建边；重抽某分P 前
  先按 ``(bvid, page_index)`` 删旧边再写新边（delete-before-write 幂等）
- 关系统一用 RELATES 类型 + rel_type 属性（Cypher 无法参数化关系类型）

定位：纯数据访问，不感知 uid/收藏夹/HTTP。被 services/kg 调用。
"""

from __future__ import annotations

import hashlib
from typing import Any

from loguru import logger

from app.infra import neo4j

# 每条 RELATES 边保留的证据引文上限（防属性膨胀）
MAX_RELATION_QUOTES = 3


def normalize_name(name: str) -> str:
    """实体名归一化键：小写 + 去首尾空白 + 合并内部空白。"""
    return " ".join((name or "").split()).lower()


def eid_for_name(name: str) -> str:
    """由归一化名称确定性生成实体 ID。"""
    return hashlib.sha1(normalize_name(name).encode("utf-8")).hexdigest()[:16]


class KgGraphRepository:
    """Neo4j 图数据访问。所有方法在 Neo4j 不可用时抛 RuntimeError，
    调用方（services/kg）负责先检查 :func:`app.infra.neo4j.is_enabled`。
    """

    # ------------------------------------------------------------------
    # 写入：实体 / 视频 / 证据 / 关系
    # ------------------------------------------------------------------

    async def upsert_entities(self, entities: list[dict[str, Any]]) -> list[str]:
        """批量 MERGE 实体。

        每行字段: name(必填) / type / description / alias(可选别名)。
        description 非空才覆盖（避免 stub 清空已有描述）；
        mention_count 每次 upsert 自增（近似热度指标）。
        返回涉及的全部 eid。
        """
        if not entities:
            return []
        rows = [
            {
                "name": e["name"],
                "name_lower": normalize_name(e["name"]),
                "eid": e.get("eid") or eid_for_name(e["name"]),
                "type": e.get("type") or "other",
                "description": (e.get("description") or "").strip(),
                "alias": (e.get("alias") or "").strip(),
            }
            for e in entities
        ]
        cypher = """
        UNWIND $rows AS row
        MERGE (e:Entity {name_lower: row.name_lower})
        ON CREATE SET e.eid = row.eid, e.created_at = timestamp(),
                      e.aliases = [], e.mention_count = 0
        SET e.name = row.name,
            e.updated_at = timestamp(),
            e.type = CASE WHEN coalesce(row.type,'') <> ''
                          THEN row.type ELSE coalesce(e.type, 'other') END,
            e.description = CASE WHEN coalesce(row.description,'') <> ''
                                 THEN row.description ELSE coalesce(e.description,'') END,
            e.mention_count = coalesce(e.mention_count, 0) + 1
        FOREACH (_ IN CASE WHEN coalesce(row.alias,'') <> ''
                            AND NOT row.alias IN coalesce(e.aliases, [])
                           THEN [1] ELSE [] END |
          SET e.aliases = coalesce(e.aliases, []) + row.alias
        )
        RETURN DISTINCT e.eid AS eid
        """
        async with neo4j.session() as s:
            result = await neo4j.run(s, cypher, rows=rows)
        return [r["eid"] for r in result]

    async def link_appearances(
        self, bvid: str, page_index: int, appearances: list[dict[str, Any]]
    ) -> int:
        """为 (bvid, page_index) 写入实体证据边 APPEARS_IN。

        appearances 每项: {eid, quote}。MERGE 键含 page_index，
        同一实体的不同分P 证据互不覆盖。
        """
        rows = [
            {"eid": a["eid"], "quote": (a.get("quote") or "").strip()}
            for a in appearances
            if a.get("eid")
        ]
        if not rows:
            return 0
        # 同页同实体去重，保留最短非空引文（更聚焦）
        dedup: dict[str, str] = {}
        for r in rows:
            cur = dedup.get(r["eid"])
            if cur is None or (r["quote"] and len(r["quote"]) < len(cur)):
                dedup[r["eid"]] = r["quote"] or (cur or "")
        rows = [{"eid": k, "quote": v} for k, v in dedup.items()]

        cypher = """
        MERGE (v:Video {bvid: $bvid})
        WITH v
        UNWIND $rows AS row
        MATCH (e:Entity {eid: row.eid})
        MERGE (e)-[ev:APPEARS_IN {page_index: $page_index}]->(v)
        ON CREATE SET ev.created_at = timestamp()
        SET ev.quote = row.quote, ev.updated_at = timestamp()
        RETURN count(ev) AS linked
        """
        async with neo4j.session() as s:
            result = await neo4j.run(
                s, cypher, bvid=bvid, page_index=page_index, rows=rows
            )
        return int(result[0]["linked"]) if result else 0

    async def upsert_relations(self, relations: list[dict[str, Any]]) -> None:
        """批量 MERGE 关系边。

        每行字段: src_eid / dst_eid / rel_type / quote。
        weight 自增；quotes 保留最近 MAX_RELATION_QUOTES 条去重样本。
        """
        seen: set[tuple[str, str, str]] = set()
        rows: list[dict[str, str]] = []
        for rel in relations:
            key = (rel["src_eid"], rel["dst_eid"], rel["rel_type"])
            if key in seen:
                continue
            seen.add(key)
            rows.append(
                {
                    "src_eid": rel["src_eid"],
                    "dst_eid": rel["dst_eid"],
                    "rel_type": rel["rel_type"],
                    "quote": (rel.get("quote") or "").strip(),
                }
            )
        if not rows:
            return
        cypher = """
        UNWIND $rows AS row
        MATCH (a:Entity {eid: row.src_eid})
        MATCH (b:Entity {eid: row.dst_eid})
        MERGE (a)-[r:RELATES {rel_type: row.rel_type}]->(b)
        SET r.weight = coalesce(r.weight, 0) + 1,
            r.updated_at = timestamp(),
            r.quotes = CASE
                WHEN coalesce(row.quote,'') = '' THEN coalesce(r.quotes, [])
                WHEN row.quote IN coalesce(r.quotes, []) THEN r.quotes
                WHEN size(coalesce(r.quotes, [])) < $max_quotes
                    THEN coalesce(r.quotes, []) + row.quote
                ELSE coalesce(r.quotes, [])[1..] + row.quote
            END
        """
        async with neo4j.session() as s:
            await neo4j.run(s, cypher, rows=rows, max_quotes=MAX_RELATION_QUOTES)

    # ------------------------------------------------------------------
    # 删除与清理
    # ------------------------------------------------------------------

    async def delete_page_evidence(self, bvid: str, page_index: int) -> int:
        """删除某分P 的全部证据边（重抽前的 delete-before-write）。"""
        cypher = """
        MATCH (:Video {bvid: $bvid})<-[ev:APPEARS_IN]-(:Entity)
        WHERE ev.page_index = $page_index
        DELETE ev
        RETURN count(ev) AS deleted
        """
        async with neo4j.session() as s:
            result = await neo4j.run(s, cypher, bvid=bvid, page_index=page_index)
        return int(result[0]["deleted"]) if result else 0

    async def delete_video(self, bvid: str) -> dict[str, int]:
        """级联删除视频节点的全部图谱痕迹，并回收孤儿节点。

        返回 {"entities_removed", "videos_removed"}。
        """
        del_video = """
        MATCH (v:Video {bvid: $bvid})
        DETACH DELETE v
        RETURN count(v) AS deleted
        """
        cleanup_entity = """
        MATCH (e:Entity) WHERE NOT (e)--()
        DELETE e
        RETURN count(e) AS removed
        """
        cleanup_video = """
        MATCH (v:Video) WHERE NOT ()-[:APPEARS_IN]->(v)
        DELETE v
        RETURN count(v) AS removed
        """
        entities_removed = videos_removed = 0
        async with neo4j.session() as s:
            res = await neo4j.run(s, del_video, bvid=bvid)
            videos_removed += int(res[0]["deleted"]) if res else 0
            res = await neo4j.run(s, cleanup_entity)
            entities_removed += int(res[0]["removed"]) if res else 0
            res = await neo4j.run(s, cleanup_video)
            videos_removed += int(res[0]["removed"]) if res else 0
        if entities_removed or videos_removed:
            logger.info(
                "[KG_REPO] delete_video bvid={} entities_removed={} videos_removed={}",
                bvid,
                entities_removed,
                videos_removed,
            )
        return {"entities_removed": entities_removed, "videos_removed": videos_removed}

    # ------------------------------------------------------------------
    # 检索：邻居扩展 / 证据回捞 / 实体详情
    # ------------------------------------------------------------------

    async def neighbors(
        self, eids: list[str], exclude_eids: list[str], limit: int
    ) -> list[dict[str, Any]]:
        """一跳邻居展开（BFS 单步），返回邻居实体及连接关系信息。"""
        if not eids:
            return []
        cypher = """
        UNWIND $eids AS eid
        MATCH (e:Entity {eid: eid})-[r:RELATES]-(n:Entity)
        WHERE n.eid <> eid AND NOT n.eid IN $exclude
        RETURN DISTINCT n.eid AS eid, n.name AS name, n.type AS type,
               n.description AS description, r.rel_type AS rel_type,
               e.eid AS from_eid
        LIMIT $limit
        """
        async with neo4j.session() as s:
            return await neo4j.run(
                s, cypher, eids=eids, exclude=exclude_eids, limit=limit
            )

    async def fetch_evidence(
        self, eids: list[str], bvids: list[str], limit: int
    ) -> list[dict[str, Any]]:
        """回捞证据边。bvids 为空表示不过滤作用域（仅限管理/调试用途）。"""
        if not eids:
            return []
        cypher = """
        UNWIND $eids AS eid
        MATCH (e:Entity {eid: eid})-[ev:APPEARS_IN]->(v:Video)
        WHERE size($bvids) = 0 OR v.bvid IN $bvids
        RETURN e.eid AS eid, e.name AS name, e.type AS type,
               v.bvid AS bvid, ev.page_index AS page_index, ev.quote AS quote
        LIMIT $limit
        """
        async with neo4j.session() as s:
            return await neo4j.run(
                s, cypher, eids=eids, bvids=bvids or [], limit=limit
            )

    async def relations_among(self, eids: list[str]) -> list[dict[str, Any]]:
        """子图成员之间的关系边（双向各查一次由 UNWIND 全量覆盖）。"""
        if len(eids) < 2:
            return []
        cypher = """
        UNWIND $eids AS eid
        MATCH (a:Entity {eid: eid})-[r:RELATES]->(b:Entity)
        WHERE b.eid IN $eids
        RETURN DISTINCT a.eid AS src_eid, a.name AS src_name,
               r.rel_type AS rel_type, b.eid AS dst_eid, b.name AS dst_name,
               coalesce(r.weight, 1) AS weight, coalesce(r.quotes, []) AS quotes
        """
        async with neo4j.session() as s:
            return await neo4j.run(s, cypher, eids=eids)

    async def entities_by_eids(self, eids: list[str]) -> list[dict[str, Any]]:
        if not eids:
            return []
        cypher = """
        UNWIND $eids AS eid
        MATCH (e:Entity {eid: eid})
        RETURN e.eid AS eid, e.name AS name, e.type AS type,
               e.description AS description, coalesce(e.aliases, []) AS aliases
        """
        async with neo4j.session() as s:
            return await neo4j.run(s, cypher, eids=eids)

    async def find_entities_by_names(
        self, names: list[str], limit: int = 20
    ) -> list[dict[str, Any]]:
        """按名称/别名的精确匹配兜底查询（Milvus 语义链接失败时使用）。"""
        cleaned = [normalize_name(n) for n in names if n and n.strip()]
        if not cleaned:
            return []
        cypher = """
        UNWIND $names AS nm
        MATCH (e:Entity)
        WHERE e.name_lower = nm OR nm IN coalesce(e.aliases, [])
        RETURN DISTINCT e.eid AS eid, e.name AS name, e.type AS type,
               e.description AS description
        LIMIT $limit
        """
        async with neo4j.session() as s:
            return await neo4j.run(s, cypher, names=cleaned, limit=limit)

    async def entity_exposure(
        self, bvids: list[str], limit: int = 500
    ) -> list[dict[str, Any]]:
        """Blind-spot map exposure aggregation (Plan 1.0.6): APPEARS_IN page
        count per entity within scope.

        Returns head entities sorted by pages desc; each item carries up to 5
        evidence samples for review-path rendering. Empty bvids returns [] --
        callers must ensure a non-empty scope (different semantics from
        fetch_evidence where empty means "no filter").
        """
        if not bvids:
            return []
        cypher = """
        MATCH (e:Entity)-[ev:APPEARS_IN]->(v:Video)
        WHERE v.bvid IN $bvids
        WITH e, count(ev) AS pages,
             collect({bvid: v.bvid, page_index: ev.page_index, quote: ev.quote})[..5]
             AS evidence_sample
        RETURN e.eid AS eid, e.name AS name, e.type AS type,
               e.description AS description,
               pages, evidence_sample
        ORDER BY pages DESC
        LIMIT $limit
        """
        async with neo4j.session() as s:
            return await neo4j.run(s, cypher, bvids=bvids, limit=limit)

    async def entity_appearances(
        self, eid: str, bvids: list[str], limit: int = 50
    ) -> list[dict[str, Any]]:
        """All appearances of one entity (entity-detail review path)."""
        cypher = """
        MATCH (e:Entity {eid: $eid})-[ev:APPEARS_IN]->(v:Video)
        WHERE size($bvids) = 0 OR v.bvid IN $bvids
        RETURN v.bvid AS bvid, ev.page_index AS page_index,
               ev.quote AS quote
        ORDER BY v.bvid, ev.page_index
        LIMIT $limit
        """
        async with neo4j.session() as s:
            return await neo4j.run(
                s, cypher, eid=eid, bvids=bvids or [], limit=limit
            )

    async def top_entities(self, limit: int = 80) -> list[dict[str, Any]]:
        """Head entities ranked by RELATES degree (graph overview mode)."""
        cypher = """
        MATCH (e:Entity)-[r:RELATES]-()
        RETURN e.eid AS eid, e.name AS name, e.type AS type,
               e.description AS description, count(r) AS degree
        ORDER BY degree DESC
        LIMIT $limit
        """
        async with neo4j.session() as s:
            return await neo4j.run(s, cypher, limit=limit)

    async def edges_among(self, eids: list[str]) -> list[dict[str, Any]]:
        """Directed relation edges inside an entity set (undirected dedup is
        the caller's job)."""
        if len(eids) < 2:
            return []
        cypher = """
        UNWIND $eids AS eid
        MATCH (a:Entity {eid: eid})-[r:RELATES]->(b:Entity)
        WHERE b.eid IN $eids
        RETURN DISTINCT a.eid AS src_eid, b.eid AS dst_eid,
               r.rel_type AS rel_type
        """
        async with neo4j.session() as s:
            return await neo4j.run(s, cypher, eids=eids)

    # ------------------------------------------------------------------
    # 统计 / 运维
    # ------------------------------------------------------------------

    async def stats(self) -> dict[str, int]:
        # CALL () { ... }: Neo4j 5.23+ requires the scope clause; bare CALL {} is deprecated
        cypher = """
        CALL () {
            MATCH (e:Entity) RETURN count(e) AS entities
        }
        CALL () {
            MATCH ()-[r:RELATES]->() RETURN count(r) AS relations
        }
        CALL () {
            MATCH ()-[a:APPEARS_IN]->() RETURN count(a) as evidence
        }
        CALL () {
            MATCH (v:Video) RETURN count(v) AS videos
        }
        RETURN entities, relations, evidence, videos
        """
        async with neo4j.session() as s:
            rows = await neo4j.run(s, cypher)
        row = rows[0] if rows else {}
        return {
            "entities": int(row.get("entities", 0)),
            "relations": int(row.get("relations", 0)),
            "evidence": int(row.get("evidence", 0)),
            "videos": int(row.get("videos", 0)),
        }

    async def clear_all(self) -> None:
        """清空图谱（危险操作，仅管理端点/测试使用）。"""
        async with neo4j.session() as s:
            await neo4j.run(s, "MATCH (n) WHERE n:Entity OR n:Video DETACH DELETE n")
        logger.warning("[KG_REPO] graph cleared (all Entity/Video nodes)")


_repo: KgGraphRepository | None = None


def get_kg_graph_repository() -> KgGraphRepository:
    """模块级懒加载单例（与 note_repository 的工厂模式一致）。"""
    global _repo
    if _repo is None:
        _repo = KgGraphRepository()
    return _repo
