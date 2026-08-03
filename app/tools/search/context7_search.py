"""Context7SearchTool - search library/framework docs via Context7 HTTP API.

No MCP SDK needed - Context7 exposes a public HTTP API:
  - GET /api/v1/search?query=react  -> library list (id, title, description)
  - GET /api/v1{libraryId}?query=hooks  -> Markdown docs text

The tool resolves the library name to an ID, then fetches docs for the query.
"""

from __future__ import annotations

import logging
from typing import Any

from app.tools import ToolDeps, register_tool

logger = logging.getLogger(__name__)

CONTEXT7_API = "https://context7.com/api/v1"
_MAX_DOCS_CHARS = 8000


@register_tool
class Context7SearchTool:
    """Search technical library/framework documentation via Context7."""

    @classmethod
    def from_deps(cls, deps: ToolDeps) -> "Context7SearchTool | None":
        return cls()

    @property
    def name(self) -> str:
        return "search_docs"

    @property
    def description(self) -> str:
        return (
            "搜索技术库/框架的官方文档（如 React, Vue, FastAPI, Next.js, LangChain）。"
            "传入库名和查询主题，返回相关文档内容（Markdown）。"
            "用于查找 API 用法、配置方法、最佳实践。"
        )

    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "library_name": {
                    "type": "string",
                    "description": "库名或框架名（如 React, FastAPI, Next.js）",
                },
                "query": {
                    "type": "string",
                    "description": "要查找的主题（如 useEffect, 路由配置, 认证中间件）",
                },
            },
            "required": ["library_name", "query"],
        }

    async def run(
        self,
        *,
        library_name: str,
        query: str,
        **kwargs: Any,
    ) -> dict[str, Any]:
        import httpx

        try:
            async with httpx.AsyncClient(timeout=30) as client:
                # 1. Resolve library ID
                r = await client.get(
                    f"{CONTEXT7_API}/search", params={"query": library_name}
                )
                r.raise_for_status()
                results = r.json().get("results", [])
                if not results:
                    return {"content": f"未找到库 '{library_name}'。"}

                best = results[0]
                library_id = best["id"]
                title = best.get("title", library_name)

                # 2. Query docs
                r2 = await client.get(
                    f"{CONTEXT7_API}{library_id}", params={"query": query}
                )
                r2.raise_for_status()
                docs = r2.text

                if len(docs) > _MAX_DOCS_CHARS:
                    docs = docs[:_MAX_DOCS_CHARS] + "\n\n... (文档过长，已截断)"

                return {
                    "content": f"库：{title}（{library_id}）\n查询：{query}\n\n{docs}",
                }
        except httpx.HTTPError as e:
            logger.warning("[SEARCH_DOCS] HTTP error: %s", e)
            return {"content": f"搜索失败（网络错误）：{e}"}
        except Exception as e:
            logger.warning("[SEARCH_DOCS] failed: %s", e)
            return {"content": f"搜索失败：{e}"}
