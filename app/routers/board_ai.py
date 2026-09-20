"""Board AI endpoints — mounted under /chat so the existing nginx /chat/ and
APISIX chat routes carry them (a /board/* prefix would collide with the
app-board wildcard route)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.response.board import BoardCompleteRequest, BoardCompleteResponse
from app.routers.auth import get_current_uid
from app.services.board import AnchorNotFound, BoardMCPError, CompletionRateLimited, complete_board

router = APIRouter(prefix="/chat", tags=["board-ai"])


@router.post("/board/complete", response_model=BoardCompleteResponse)
async def board_complete(
    req: BoardCompleteRequest,
    uid: int = Depends(get_current_uid),
) -> BoardCompleteResponse:
    """AI 补全：为锚点节点建议 children / siblings（编辑器幽灵 chips）。"""
    try:
        return await complete_board(uid, req)
    except CompletionRateLimited as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    except AnchorNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except BoardMCPError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
