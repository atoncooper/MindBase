"""KgRetriever — 查询期知识图谱检索。

流程：query → Milvus 实体链接（种子实体）→ Neo4j BFS 子图扩展
（RELATES 边，≤ max_hops）→ APPEARS_IN 证据回捞（按用户 bvids 作用域过滤）
→ 组装实体卡片 + sources（与 vector_search 同构，复用 SSE 协议）。

Milvus 客户端为同步实现，经 ``asyncio.to_thread`` 调用；
Neo4j 为原生异步驱动。
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

from loguru import logger

from app.infra import neo4j
from app.infra.config import config
from app.repository.kg_entity_index import KgEntityIndex
from app.repository.kg_graph_repository import get_kg_graph_repository


@dataclass
class KgRetrievalResult:
    """检索结果。content 供 LLM 阅读；sources 进 SSE sources 帧。"""

    content: str = ""
    sources: list[dict[str, Any]] = field(default_factory=list)
    entity_count: int = 0
    evidence_count: int = 0

    @property
    def has_results(self) -> bool:
        return bool(self.sources)


class KgRetriever:
    """KG 查询编排。依赖不可用时返回空结果（不抛异常）。"""

    def __init__(self) -> None:
        self._graph = get_kg_graph_repository()
        self._entity_index: KgEntityIndex | None = None

    # ------------------------------------------------------------------
    # 依赖惰性获取
    # ------------------------------------------------------------------

    def _get_entity_index(self) -> KgEntityIndex | None:
        if self._entity_index is None:
            try:
                from app.services.rag import get_rag_service

                rag = get_rag_service()
                if rag.embeddings is None:
                    return None
                self._entity_index = KgEntityIndex(rag.embeddings)
            except Exception as e:
                logger.warning("[KG_RETRIEVER] entity index unavailable: {}", e)
                return None
        return self._entity_index

    def is_available(self) -> bool:
        """Neo4j 已连接且实体索引可构建（Milvus 开启）。"""
        if not neo4j.is_enabled():
            return False
        return self._get_entity_index() is not None

    # ------------------------------------------------------------------
    # 主入口
    # ------------------------------------------------------------------

    async def retrieve(
        self,
        query: str,
        bvids: list[str] | None = None,
        k: int = 8,
    ) -> KgRetrievalResult:
        """执行一次 KG 检索。

        bvids 为用户可见范围（来自 _bvids 隐式注入）；None/空 表示
        不过滤作用域（仅限管理调试，工具链路始终传入用户范围）。
        """
        empty = KgRetrievalResult()
        if not neo4j.is_enabled():
            return empty
        index = self._get_entity_index()
        if index is None:
            return empty

        # ---- 1. 实体链接（Milvus，同步客户端走线程池）----
        try:
            seeds = await asyncio.to_thread(
                index.search, query, config.kg.seed_top_n
            )
        except Exception as e:
            logger.error("[KG_RETRIEVER] entity linking failed: {}", e)
            return empty
        threshold = config.kg.link_score_threshold
        seeds = [s for s in seeds if s.get("score", 0.0) >= threshold]
        if not seeds:
            logger.info(
                "[KG_RETRIEVER] no linked entities above threshold={} query='{}'",
                threshold,
                query[:50],
            )
            return empty

        seed_scores = {s["eid"]: s["score"] for s in seeds}
        seed_eids = list(seed_scores)

        try:
            # ---- 2. BFS 子图扩展（Neo4j 异步）----
            visited: set[str] = set(seed_eids)
            frontier = list(seed_eids)
            for _hop in range(max(config.kg.max_hops, 0)):
                if not frontier:
                    break
                rows = await self._graph.neighbors(
                    frontier,
                    exclude_eids=list(visited),
                    limit=config.kg.expand_limit_per_hop,
                )
                new_ids = [r["eid"] for r in rows if r["eid"] not in visited]
                visited.update(new_ids)
                frontier = new_ids
            all_eids = list(visited)

            # ---- 3. 证据 + 关系 + 实体详情 ----
            evidence = await self._graph.fetch_evidence(
                all_eids, bvids or [], config.kg.evidence_limit
            )
            relations = await self._graph.relations_among(all_eids)
            entities = await self._graph.entities_by_eids(all_eids)
        except Exception as e:
            logger.error("[KG_RETRIEVER] graph traversal failed: {}", e)
            return empty

        if not evidence and not relations:
            return empty

        # ---- 4. 标题解析（MySQL video 表）----
        ev_bvids = sorted({e["bvid"] for e in evidence})
        titles = await _page_titles(ev_bvids)

        content = _format_content(
            entities=entities,
            relations=relations,
            evidence=evidence,
            titles=titles,
            seed_names=[s["name"] for s in seeds],
            limit=k,
        )
        sources = _build_sources(evidence, seed_scores, titles)
        logger.info(
            "[KG_RETRIEVER] done query='{}' entities={} evidence={} sources={}",
            query[:50],
            len(entities),
            len(evidence),
            len(sources),
        )
        return KgRetrievalResult(
            content=content,
            sources=sources,
            entity_count=len(entities),
            evidence_count=len(evidence),
        )


# ---------------------------------------------------------------------------
# 辅助：标题解析 / 内容组装 / 来源构建
# ---------------------------------------------------------------------------


async def _page_titles(bvids: list[str]) -> dict[tuple[str, int], str]:
    """(bvid, page_index) -> page_title，供来源标注使用。"""
    if not bvids:
        return {}
    from sqlalchemy import select

    from app.database import get_db_context
    from app.models import Video

    mapping: dict[tuple[str, int], str] = {}
    try:
        async with get_db_context() as db:
            rows = await db.execute(
                select(Video.bvid, Video.page_index, Video.page_title).where(
                    Video.bvid.in_(bvids)
                )
            )
            for bvid, page_index, page_title in rows.fetchall():
                mapping[(bvid, int(page_index))] = (
                    page_title or f"P{page_index + 1}"
                )
    except Exception as e:
        logger.warning("[KG_RETRIEVER] title lookup failed: {}", e)
    return mapping


def _format_content(
    *,
    entities: list[dict],
    relations: list[dict],
    evidence: list[dict],
    titles: dict[tuple[str, int], str],
    seed_names: list[str],
    limit: int,
) -> str:
    """组装 LLM 可读的实体卡片文本。"""
    rel_by_src: dict[str, list[dict]] = {}
    for rel in relations:
        rel_by_src.setdefault(rel["src_eid"], []).append(rel)

    ev_by_eid: dict[str, list[dict]] = {}
    for ev in evidence:
        ev_by_eid.setdefault(ev["eid"], []).append(ev)

    # 命中证据的实体优先展示，其次是无证据的关联实体
    ordered = [e for e in entities if e["eid"] in ev_by_eid]
    ordered += [e for e in entities if e["eid"] not in ev_by_eid]

    parts: list[str] = [
        f"知识图谱检索结果（核心实体：{'、'.join(seed_names[:3])}）"
    ]
    shown = 0
    for ent in ordered:
        if shown >= limit:
            break
        lines = [f"\n## {ent['name']}（{ent['type']}）"]
        if ent.get("description"):
            lines.append(f"描述：{ent['description']}")

        rels = rel_by_src.get(ent["eid"], [])
        if rels:
            rel_strs = [
                f"{r['src_name']} --{r['rel_type']}--> {r['dst_name']}"
                for r in rels[:5]
            ]
            lines.append("关系：" + "；".join(rel_strs))

        for ev in ev_by_eid.get(ent["eid"], [])[:5]:
            title = titles.get((ev["bvid"], int(ev.get("page_index") or 0)), ev["bvid"])
            quote = (ev.get("quote") or "").strip()
            if quote:
                lines.append(f'出处：【{title}】"{quote}"')
            else:
                lines.append(f"出处：【{title}】")
        parts.append("\n".join(lines))
        shown += 1

    if not evidence:
        parts.append("\n（注意：以下实体在你的当前范围内暂无视频出处证据）")
    return "\n\n".join(parts)


def _build_sources(
    evidence: list[dict],
    seed_scores: dict[str, float],
    titles: dict[tuple[str, int], str],
) -> list[dict[str, Any]]:
    """按 bvid 去重构建 sources，字段与 vector_search 的输出同构。"""
    seen: set[str] = set()
    sources: list[dict[str, Any]] = []
    for ev in evidence:
        bvid = ev.get("bvid") or ""
        if not bvid or bvid in seen:
            continue
        seen.add(bvid)
        page_index = ev.get("page_index")
        title = titles.get((bvid, int(page_index or 0)), bvid)
        source: dict[str, Any] = {
            "title": title,
            "score": round(float(seed_scores.get(ev.get("eid"), 0.0)), 4),
            "bvid": bvid,
            "url": f"https://www.bilibili.com/video/{bvid}",
        }
        if page_index is not None:
            source["page_index"] = page_index
        sources.append(source)
    return sources
