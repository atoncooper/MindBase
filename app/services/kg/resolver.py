"""KgResolver — 抽取结果的归一化与校验（纯函数，可独立单测）。

职责：
1. 实体名归一化（复用 repository 的 normalize_name/eid_for_name 单一实现）
2. 实体类型白名单映射（中文别名 → 规范英文枚举）
3. 关系校验：**quote 必填且达到最小长度**（防幻觉边的核心防线）、
   端点必须可解析到已知实体（未知端点自动创建 stub 实体）、去自环
4. 批内去重与数量上限

本模块不依赖 LLM / 数据库 / 网络。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.repository.kg_graph_repository import eid_for_name, normalize_name
from app.services.kg.extractor import ExtractionResult

# 规范实体类型枚举（与 Neo4j Entity.type 对齐）
CANONICAL_TYPES = {
    "person",
    "org",
    "concept",
    "tech",
    "tool",
    "book",
    "event",
    "method",
    "place",
    "other",
}

# 中文/英文别名 → 规范类型
_TYPE_ALIAS_MAP: dict[str, str] = {
    "人物": "person", "人名": "person", "人": "person", "作者": "person",
    "up主": "person", "up": "person", "专家": "person", "讲师": "person",
    "组织": "org", "机构": "org", "公司": "org", "团队": "org", "企业": "org",
    "概念": "concept", "理论": "concept", "术语": "concept", "学科": "concept",
    "技术": "tech", "框架": "tech", "语言": "tech", "协议": "tech",
    "算法": "tech", "模型": "tech", "架构": "tech", "标准": "tech",
    "工具": "tool", "软件": "tool", "库": "tool", "平台": "tool",
    "产品": "tool", "服务": "tool", "网站": "tool",
    "书": "book", "书籍": "book", "论文": "book", "著作": "book", "教材": "book",
    "事件": "event", "会议": "event", "历史事件": "event",
    "方法": "method", "方法论": "method", "流程": "method", "实践": "method",
    "技巧": "method", "策略": "method",
    "地点": "place", "位置": "place", "国家": "place", "城市": "place",
    "其他": "other",
    # English aliases
    "people": "person", "company": "org", "organization": "org",
    "technology": "tech", "framework": "tech", "library": "tool",
    "software": "tool", "paper": "book", "conference": "event",
}

# 校验参数默认值（测试可覆盖）
DEFAULT_MIN_QUOTE_CHARS = 8
DEFAULT_MAX_ENTITIES = 30
DEFAULT_MAX_RELATIONS = 40
MAX_NAME_LEN = 100


def normalize_entity_type(raw: str | None) -> str:
    """任意输入映射到规范实体类型；无法识别时回退 other。"""
    key = (raw or "").strip().lower()
    if not key:
        return "other"
    if key in CANONICAL_TYPES:
        return key
    mapped = _TYPE_ALIAS_MAP.get(key)
    if mapped in CANONICAL_TYPES:
        return mapped
    return "other"


@dataclass
class ResolvedExtraction:
    """校验后、可直接写图的结构化结果。

    entities 每项: {eid, name, type, description}
    relations 每项: {src_eid, dst_eid, rel_type, quote}
    """

    entities: list[dict] = field(default_factory=list)
    relations: list[dict] = field(default_factory=list)
    dropped_relations: int = 0  # 因缺引文/自环等被丢弃的关系数（观测用）


def resolve_extraction(
    result: ExtractionResult,
    *,
    min_quote_chars: int = DEFAULT_MIN_QUOTE_CHARS,
    max_entities: int = DEFAULT_MAX_ENTITIES,
    max_relations: int = DEFAULT_MAX_RELATIONS,
) -> ResolvedExtraction:
    """把 LLM 原始抽取结果清洗为可直接入库的形态。

    步骤：实体清洗去重 → 关系端点解析（stub 补全）→ 引文校验 → 上限裁剪。
    """
    resolved = ResolvedExtraction()

    # ---- 实体清洗：按归一化键去重，保留首个非空描述/引文 ----
    by_key: dict[str, dict] = {}
    for ent in result.entities:
        name = (ent.name or "").strip()
        if not name or len(name) > MAX_NAME_LEN:
            continue
        key = normalize_name(name)
        if not key:
            continue
        existing = by_key.get(key)
        desc = (ent.description or "").strip()
        quote = (ent.quote or "").strip()[:300]
        if existing is None:
            by_key[key] = {
                "eid": eid_for_name(name),
                "name": name,
                "type": normalize_entity_type(ent.type),
                "description": desc,
                "quote": quote,
            }
        else:
            if not existing["description"] and desc:
                existing["description"] = desc
            if not existing["quote"] and quote:
                existing["quote"] = quote
    resolved.entities = list(by_key.values())[:max_entities]

    def _entity_eid(raw_name: str) -> str | None:
        """端点解析：命中已知实体；未命中则创建 stub（保住关系召回）。"""
        name = (raw_name or "").strip()
        key = normalize_name(name)
        if not key or len(name) > MAX_NAME_LEN:
            return None
        ent = by_key.get(key)
        if ent is not None:
            return ent["eid"]
        stub = {
            "eid": eid_for_name(name),
            "name": name,
            "type": "other",
            "description": "",
            "quote": "",
        }
        by_key[key] = stub
        resolved.entities.append(stub)
        return stub["eid"]

    # ---- 关系校验：端点解析 + 自环剔除 + 引文强制 ----
    seen_rel: set[tuple[str, str, str]] = set()
    for rel in result.relations:
        if len(resolved.relations) >= max_relations:
            break
        src_eid = _entity_eid(rel.src)
        dst_eid = _entity_eid(rel.dst)
        quote = (rel.quote or "").strip()[:300]
        rel_type = (rel.relation_type or "").strip()[:50]
        if (
            src_eid is None
            or dst_eid is None
            or src_eid == dst_eid
            or not rel_type
            or len(quote) < min_quote_chars
        ):
            resolved.dropped_relations += 1
            continue
        dedup_key = (src_eid, dst_eid, rel_type)
        if dedup_key in seen_rel:
            continue
        seen_rel.add(dedup_key)
        resolved.relations.append(
            {
                "src_eid": src_eid,
                "dst_eid": dst_eid,
                "rel_type": rel_type,
                "quote": quote,
            }
        )

    return resolved
