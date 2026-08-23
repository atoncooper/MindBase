"""知识图谱服务包（Plan 1.0.5）。

模块划分：
- extractor: LLM structured output 抽取（实体/关系/引文）
- resolver:  归一化与校验（纯函数，防幻觉边的核心防线）
- service:   build 编排 / 幂等状态机 / 删除级联 / 统计
- retriever: 查询期 实体链接 → 子图扩展 → 证据回捞

用法::

    from app.services.kg import get_kg_service

    svc = get_kg_service()
    if svc.is_available():
        result = await svc.try_start_build(uid=1, folder_ids=[123])
"""

from app.services.kg.extractor import ExtractionResult, KgExtractor
from app.services.kg.retriever import KgRetrievalResult, KgRetriever
from app.services.kg.service import KgService, get_kg_service

__all__ = [
    "ExtractionResult",
    "KgExtractor",
    "KgRetrievalResult",
    "KgRetriever",
    "KgService",
    "get_kg_service",
]
