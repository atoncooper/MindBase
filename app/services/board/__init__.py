"""Board services — everything the main app needs to operate mind-map boards
through app-board-mcp.

- ``mcp``: service-mode MCP client (short-lived streamable-http sessions)
- ``completion``: editor inline completion (single structured LLM call)

Import surface: prefer the re-exports on the package (``from app.services.board
import get_board_mcp_client``) so internal layout can evolve freely.
"""

from app.services.board.completion import (
    AnchorNotFound,
    CompletionRateLimited,
    complete_board,
)
from app.services.board.mcp import (
    BoardMCPClient,
    BoardMCPError,
    BoardMCPUnavailableError,
    get_board_mcp_client,
)

__all__ = [
    "AnchorNotFound",
    "BoardMCPClient",
    "BoardMCPError",
    "BoardMCPUnavailableError",
    "CompletionRateLimited",
    "complete_board",
    "get_board_mcp_client",
]
