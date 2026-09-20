"""Board Agent — create, explain and refine mind-map / whiteboard boards.

Tools are MCP proxies (app/tools/board/) talking to app-board-mcp in service
mode; the acting uid is injected as ``_uid`` by the graph and never exposed to
the LLM.
"""

from app.agent.board.graph import build_board_agent

__all__ = ["build_board_agent"]
