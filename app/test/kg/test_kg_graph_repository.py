"""KgGraphRepository 集成测试（需真实 Neo4j，未连接自动跳过）。

运行前：docker compose up -d neo4j（或本地 bolt://localhost:7687）。
"""

import pytest
import pytest_asyncio

from app.infra import neo4j
from app.repository.kg_graph_repository import (
    eid_for_name,
    get_kg_graph_repository,
)

pytestmark = pytest.mark.asyncio


async def _neo4j_ready() -> bool:
    if not neo4j.is_enabled():
        try:
            await neo4j.init()
        except Exception:
            return False
    return neo4j.is_enabled()


@pytest_asyncio.fixture
async def graph_repo():
    if not await _neo4j_ready():
        pytest.skip("Neo4j 未连接（docker compose up -d neo4j 启动后重跑）")
    repo = get_kg_graph_repository()
    yield repo
    await repo.clear_all()
    await neo4j.close()


BVID = "BV1kgTest000"


class TestEntityUpsert:
    async def test_merge_idempotent(self, graph_repo):
        ents = [{"name": "RAG", "type": "tech", "description": "检索增强生成", "quote": ""}]
        eids1 = await graph_repo.upsert_entities(ents)
        # 重复 upsert 同名实体：MERGE 幂等，不产生新节点
        eids2 = await graph_repo.upsert_entities(ents)
        assert eids1 == eids2 == [eid_for_name("RAG")]
        stats = await graph_repo.stats()
        assert stats["entities"] == 1

        rows = await graph_repo.entities_by_eids(eids1)
        assert rows[0]["type"] == "tech"
        assert rows[0]["description"] == "检索增强生成"

    async def test_alias_accumulates(self, graph_repo):
        await graph_repo.upsert_entities(
            [{"name": "RAG", "alias": "检索增强生成"}]
        )
        await graph_repo.upsert_entities([{"name": "RAG", "alias": "Retrieval-Augmented Generation"}])
        rows = await graph_repo.find_entities_by_names(["检索增强生成"])
        assert len(rows) == 1 and rows[0]["eid"] == eid_for_name("RAG")


class TestEvidenceAndRelations:
    async def test_appears_in_per_page(self, graph_repo):
        await graph_repo.upsert_entities([{"name": "RAG", "quote": ""}])
        eid = eid_for_name("RAG")
        n1 = await graph_repo.link_appearances(
            BVID, 0, [{"eid": eid, "quote": "第一页引文，足够长"}]
        )
        n2 = await graph_repo.link_appearances(
            BVID, 1, [{"eid": eid, "quote": "第二页引文，也够长"}]
        )
        assert n1 == 1 and n2 == 1

        ev = await graph_repo.fetch_evidence([eid], [BVID], limit=10)
        assert {e["page_index"] for e in ev} == {0, 1}

        # 作用域过滤：不在范围内的 bvid 查不到
        ev_other = await graph_repo.fetch_evidence([eid], ["BV9other9999"], limit=10)
        assert ev_other == []

    async def test_delete_before_write(self, graph_repo):
        await graph_repo.upsert_entities([{"name": "RAG", "quote": ""}])
        eid = eid_for_name("RAG")
        await graph_repo.link_appearances(BVID, 0, [{"eid": eid, "quote": "旧引文，会被替换"}])
        removed = await graph_repo.delete_page_evidence(BVID, 0)
        assert removed == 1
        assert await graph_repo.fetch_evidence([eid], [BVID], limit=10) == []

    async def test_relations_weight_and_quotes(self, graph_repo):
        await graph_repo.upsert_entities([{"name": "A"}, {"name": "B"}])
        a, b = eid_for_name("A"), eid_for_name("B")
        for quote in ("第一次提到的原文证据内容", "第二次提到的原文证据内容"):
            await graph_repo.upsert_relations(
                [{"src_eid": a, "dst_eid": b, "rel_type": "依赖于", "quote": quote}]
            )
        rels = await graph_repo.relations_among([a, b])
        assert len(rels) == 1
        assert rels[0]["weight"] == 2
        assert len(rels[0]["quotes"]) == 2

    async def test_neighbors_expansion(self, graph_repo):
        await graph_repo.upsert_entities([{"name": "A"}, {"name": "B"}, {"name": "C"}])
        a, b, c = eid_for_name("A"), eid_for_name("B"), eid_for_name("C")
        await graph_repo.upsert_relations(
            [
                {"src_eid": a, "dst_eid": b, "rel_type": "讲解了", "quote": "A 讲解了 B 的原文证据"},
                {"src_eid": b, "dst_eid": c, "rel_type": "依赖于", "quote": "B 依赖于 C 的原文证据"},
            ]
        )
        hop1 = await graph_repo.neighbors([a], exclude_eids=[a], limit=10)
        assert {r["eid"] for r in hop1} == {b}

    async def test_delete_video_cascade_and_orphans(self, graph_repo):
        await graph_repo.upsert_entities(
            [{"name": "孤儿实体", "quote": ""}, {"name": "共享实体", "quote": ""}]
        )
        orphan, shared = eid_for_name("孤儿实体"), eid_for_name("共享实体")
        await graph_repo.link_appearances(BVID, 0, [{"eid": orphan, "quote": ""}])
        # 「共享」= 同时挂在两个视频上；只挂一个的话删除后即成孤儿被回收
        await graph_repo.link_appearances(BVID, 0, [{"eid": shared, "quote": ""}])
        await graph_repo.link_appearances("BV1anchor00000", 0, [{"eid": shared, "quote": ""}])
        await graph_repo.upsert_entities([{"name": "锚点实体"}])
        anchor = eid_for_name("锚点实体")
        await graph_repo.link_appearances("BV1anchor00000", 0, [{"eid": anchor, "quote": ""}])

        result = await graph_repo.delete_video(BVID)
        assert result["videos_removed"] >= 1
        # 孤儿实体被回收；仍被其他视频引用的实体保留
        remaining = await graph_repo.entities_by_eids([orphan, shared, anchor])
        ids = {r["eid"] for r in remaining}
        assert orphan not in ids
        assert shared in ids and anchor in ids
