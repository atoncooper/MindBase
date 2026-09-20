"""Board tools — MCP-backed board operations for the board agent.

Five thin proxies over app-board-mcp (list/get/create/update/delete). The
acting uid is injected by the agent graph as the ``_uid`` kwarg (note-agent
pattern) and forwarded as the service-mode ``X-Uid`` header; the LLM never
sees or chooses it.
"""
