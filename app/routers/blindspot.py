"""Knowledge blind-spot map routes (Plan 1.0.6).

Param parsing + auth + delegation to BlindspotService / the existing quiz
pipeline. No business logic here.
"""

import logging
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Body, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.routers.auth import get_current_uid

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/blindspot", tags=["知识盲区"])


def _parse_folder_ids(folder_ids: Optional[str]) -> list[int]:
    """Comma-separated folder IDs -> list[int] (same rule as /quiz/generate)."""
    if not folder_ids:
        return []
    out: list[int] = []
    for part in folder_ids.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            out.append(int(part))
        except ValueError:
            raise HTTPException(400, f"非法的 folder_id: {part}")
    return out


@router.get("/map")
async def blindspot_map(
    folder_ids: Optional[str] = Query(None, description="comma-separated folder IDs"),
    uid: int = Depends(get_current_uid),
):
    """Five-quadrant entity map (exposure/verification/probing signals).

    available=false when Neo4j is down; quadrants are empty without synced
    videos.
    """
    from app.services.blindspot import get_blindspot_service

    service = get_blindspot_service()
    try:
        return await service.map(uid=uid, folder_ids=_parse_folder_ids(folder_ids))
    except Exception as e:
        logger.warning("[BLINDSPOT] map failed uid=%s: %s", uid, e)
        raise HTTPException(500, "盲区地图加载失败，请稍后重试")


@router.get("/entity/{eid}")
async def blindspot_entity(eid: str, uid: int = Depends(get_current_uid)):
    """Entity detail: review path (evidence quotes) + quiz stats."""
    if not eid or len(eid) > 128:
        raise HTTPException(400, "非法实体 ID")
    from app.services.blindspot import get_blindspot_service

    service = get_blindspot_service()
    try:
        detail = await service.entity_detail(uid=uid, eid=eid)
    except Exception as e:
        logger.warning("[BLINDSPOT] entity detail failed eid=%s: %s", eid, e)
        raise HTTPException(500, "实体详情加载失败，请稍后重试")
    if detail is None:
        raise HTTPException(404, "实体不存在或图谱不可用")
    return detail


class EntityQuizRequest(BaseModel):
    question_count: int = Field(default=5, ge=1, le=20)
    difficulty: str = Field(default="medium", pattern="^(easy|medium|hard)$")


@router.post("/{eid}/quiz")
async def generate_entity_quiz(
    eid: str,
    req: EntityQuizRequest = Body(default=EntityQuizRequest()),
    uid: int = Depends(get_current_uid),
    background_tasks: BackgroundTasks = BackgroundTasks(),
):
    """One-click quiz generation targeting a weak entity.

    Uses the entity's APPEARS_IN pages as source_pages and runs the exact
    same pipeline as POST /quiz/generate
    (preflight -> quota -> create row -> background generation).
    Frontend polls GET /quiz/{quiz_uuid} with the returned quiz_uuid.
    """
    if not eid or len(eid) > 128:
        raise HTTPException(400, "非法实体 ID")

    from app.services.blindspot import get_blindspot_service

    resolved = await get_blindspot_service().entity_quiz_pages(
        uid=uid, eid=eid, question_count=req.question_count
    )
    if resolved is None:
        raise HTTPException(404, "实体不存在或图谱不可用")
    pages = resolved["pages"]
    if not pages:
        raise HTTPException(400, resolved.get("message") or "该实体无可出题的视频出处")

    # ---- Same flow as routers/quiz.py generate_quiz (pages mode) ----
    from app.services.quiz_preflight import preflight_check

    preflight = await preflight_check(pages=pages, question_count=req.question_count)
    if not preflight.ok:
        raise HTTPException(400, preflight.reason)

    from app.services.llm.quiz_quota import (
        QuizQuotaExceeded,
        check_and_consume,
        check_quota,
    )

    try:
        await check_quota(uid, "generate")
    except QuizQuotaExceeded as e:
        raise HTTPException(429, f"今日出题次数已达上限（{e.limit} 次/天）")

    from app.services.quiz_generator import QuizGeneratorService
    from app.services.quiz_queue import enqueue_generation

    entity_name = (resolved.get("entity") or {}).get("name", "")
    title = f"薄弱点特训 · {entity_name}"[:200]

    service = QuizGeneratorService()
    quiz_uuid = await service.create_quiz_set(
        uid=uid,
        pages=pages,
        question_count=req.question_count,
        difficulty=req.difficulty,
        title=title,
    )

    try:
        await check_and_consume(uid, "generate")
    except QuizQuotaExceeded:
        logger.warning("[BLINDSPOT] quota race after row creation quiz_uuid=%s", quiz_uuid)

    enqueue_generation(
        background_tasks,
        quiz_uuid=quiz_uuid,
        uid=uid,
        folder_ids=None,
        pages=pages,
        question_count=req.question_count,
        difficulty=req.difficulty,
        title=title,
    )
    return {"quiz_uuid": quiz_uuid, "status": "generating", "title": title}
