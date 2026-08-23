"""KgSearchTool - 知识图谱检索（实体链接 + 子图扩展 + 证据回捞）。

Plan 1.0.5：与 vector_search 输出协议同构 —— 返回
``{"content": <text>, "sources": [<source dict>]}``，
sources 经 AgentRuntime 提升进 ToolMessage.additional_kwargs 并最终进入
SSE sources 帧。依赖不可用时 from_deps 返回 None，工具不注册。
"""

from __future__ import annotations

import logging
from typing import Any

from app.tools import ToolDeps, register_tool

logger = logging.getLogger(__name__)


@register_tool
class KgSearchTool:
    """知识图谱语义检索。

    LLM 在遇到「实体关联/多视频聚合/关系路径」类问题时调用；
    具体内容细节类问题仍应使用 vector_search。
    """

    def __init__(self, kg_service: Any) -> None:
        self._kg = kg_service

    @classmethod
    def from_deps(cls, deps: ToolDeps) -> "KgSearchTool | None":
        if deps.kg is None:
            return None
        try:
            if not deps.kg.retriever.is_available():
                return None
        except Exception:
            return None
        return cls(deps.kg)

    @property
    def name(self) -> str:
        return "kg_search"

    @property
    def description(self) -> str:
        return (
            "在用户收藏内容的**知识图谱**中检索实体及其关联。"
            "适合回答「某概念/人物/技术在哪些视频中出现过」「A 和 B 有什么关系/区别"
            "」「XX 相关的内容有哪些」这类需要跨视频聚合或关系路径的问题。\n"
            "不适合查具体细节内容（那请用 vector_search）；两者可配合："
            "先用本工具定位相关视频和实体关系，再用 vector_search 深挖内容。\n"
            "query 传入具体实体名或概念词，效果最好。"
        )

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "检索词，应为具体实体名或概念（如 'RAG'、'LangChain 和 LlamaIndex 的对比'）",
                },
                "k": {
                    "type": "integer",
                    "description": "返回实体卡片数量上限，默认8",
                },
            },
            "required": ["query"],
        }

    async def run(self, *, query: str, k: int = 8, **kwargs: Any) -> dict[str, Any]:
        """执行图谱检索；失败降级为提示文本（ReAct 循环可改用其他工具）。"""
        k = min(max(k, 1), 20)
        # 隐式注入的用户可见范围（与 vector_search 一致）
        bvids = kwargs.get("_bvids")

        try:
            result = await self._kg.retriever.retrieve(
                query, bvids=bvids or [], k=k
            )
        except Exception as e:
            logger.warning("[kg_search] retrieve failed: %s", e, exc_info=True)
            return {"content": "知识图谱检索暂时不可用。", "sources": []}

        if not result.has_results:
            return {
                "content": "知识图谱中没有找到相关实体（可能该主题尚未构建图谱）。",
                "sources": [],
            }
        return {"content": result.content, "sources": result.sources}
