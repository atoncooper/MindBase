"""KG resolver 单测：归一化 / 别名合并 / 防幻觉边校验 / 数量上限。

纯函数测试，不依赖 Neo4j / Milvus / LLM。
"""

import pytest

from app.repository.kg_graph_repository import eid_for_name, normalize_name
from app.services.kg.extractor import ExtractedEntity, ExtractedRelation, ExtractionResult
from app.services.kg.resolver import resolve_extraction


def _mk(
    entities: list[tuple[str, str, str, str]],
    relations: list[tuple[str, str, str, str]],
) -> ExtractionResult:
    return ExtractionResult(
        entities=[ExtractedEntity(name=n, type=t, description=d, quote=q) for n, t, d, q in entities],
        relations=[
            ExtractedRelation(src=s, dst=t2, relation_type=r, quote=q)
            for s, t2, r, q in relations
        ],
    )


class TestNormalize:
    def test_normalize_name(self):
        assert normalize_name("  RAG  ") == "rag"
        assert normalize_name("LangChain   框架") == "langchain 框架"
        assert normalize_name("") == ""
        assert normalize_name(None) == ""

    def test_eid_deterministic(self):
        assert eid_for_name("RAG") == eid_for_name(" rag ")
        assert len(eid_for_name("RAG")) == 16
        assert eid_for_name("A") != eid_for_name("B")

    def test_entity_type_mapping(self):
        from app.services.kg.resolver import normalize_entity_type

        assert normalize_entity_type("人物") == "person"
        assert normalize_entity_type("框架") == "tech"
        assert normalize_entity_type("工具") == "tool"
        assert normalize_entity_type("PERSON") == "person"
        assert normalize_entity_type("不存在的类型") == "other"
        assert normalize_entity_type("") == "other"


class TestResolveExtraction:
    def test_dedup_and_alias_merge(self):
        out = resolve_extraction(
            _mk(
                [
                    ("RAG", "技术", "检索增强生成", "q1"),
                    ("rag ", "", "", ""),  # 归一化后同名 → 合并，描述保留首个非空
                    ("LangChain", "框架", "框架", "q2"),
                ],
                [],
            )
        )
        names = {e["name"] for e in out.entities}
        assert names == {"RAG", "LangChain"}
        rag = next(e for e in out.entities if e["name"] == "RAG")
        assert rag["description"] == "检索增强生成"  # 空描述不清空已有值
        assert rag["type"] == "tech"

    def test_hallucinated_relations_dropped(self):
        """防幻觉边核心防线：无引文/短引文/自环全部丢弃。"""
        out = resolve_extraction(
            _mk(
                [("A", "概念", "", ""), ("B", "概念", "", "")],
                [
                    ("A", "B", "依赖于", "这是一段足够长的原文证据引文"),  # 合法
                    ("A", "B", "无证据", ""),  # 空 quote → 弃
                    ("A", "B", "短引文", "太短"),  # < min_quote_chars → 弃
                    ("A", "A", "自环", "这是一段足够长的原文证据引文"),  # 自环 → 弃
                ],
            )
        )
        assert len(out.relations) == 1
        assert out.relations[0]["rel_type"] == "依赖于"
        assert out.dropped_relations == 3

    def test_unknown_endpoint_creates_stub(self):
        """关系端点未在实体列表中时自动创建 stub，保住关系召回。"""
        out = resolve_extraction(
            _mk(
                [("A", "概念", "", "")],
                [("A", "未知实体XYZ", "提到了", "这是一段足够长的原文证据引文")],
            )
        )
        stubs = [e for e in out.entities if e["name"] == "未知实体XYZ"]
        assert len(stubs) == 1
        assert stubs[0]["type"] == "other"
        rel = out.relations[0]
        assert rel["dst_eid"] == stubs[0]["eid"]

    def test_relation_dedup_within_batch(self):
        out = resolve_extraction(
            _mk(
                [("A", "", "", ""), ("B", "", "", "")],
                [
                    ("A", "B", "使用了", "第一条足够长的原文证据"),
                    ("A", "B", "使用了", "第二条足够长的原文证据"),
                ],
            )
        )
        assert len(out.relations) == 1
        # 权重去重靠 Neo4j MERGE 自增；批内只保留一条

    def test_count_caps(self):
        ents = [(f"E{i}", "", "", "") for i in range(50)]
        rels = [(f"E{i}", f"E{i+1}", "关联", "这是一段足够长的原文证据引文") for i in range(49)]
        out = resolve_extraction(_mk(ents, rels), max_entities=10, max_relations=5)
        assert len(out.entities) <= 10
        assert len(out.relations) <= 5

    def test_empty_input(self):
        out = resolve_extraction(ExtractionResult(entities=[], relations=[]))
        assert out.entities == []
        assert out.relations == []
