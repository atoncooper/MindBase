from __future__ import annotations

from typing import Any

from loguru import logger
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db_context
from app.models import QuizAnswer, QuizSet, QuizSubmission
from app.repository import mongo_quiz_repository as mongo_quiz


class QuizDeleteError(Exception):
    def __init__(self, status_code: int, detail: str) -> None:
        self.status_code = status_code
        self.detail = detail
        super().__init__(detail)


class QuizDeleteService:
    async def delete_quiz(self, *, quiz_uuid: str, uid: int) -> dict[str, Any]:
        async with get_db_context() as db:
            return await self._delete_from_stores(db=db, quiz_uuid=quiz_uuid, uid=uid)

    async def _delete_from_stores(
        self,
        *,
        db: AsyncSession | Any,
        quiz_uuid: str,
        uid: int,
    ) -> dict[str, Any]:
        quiz_set = await self._get_owned_quiz_set(db, quiz_uuid, uid)
        if not quiz_set:
            raise QuizDeleteError(404, "题目集不存在")
        if quiz_set.status == "generating":
            raise QuizDeleteError(409, "题目正在生成中，暂不能删除，请稍后再试")

        previous_status = quiz_set.status
        await self._mark_deleting(db, quiz_set)

        try:
            deleted_questions = await mongo_quiz.delete_by_quiz(
                quiz_uuid,
                uid=uid,
                require_enabled=True,
            )
        except Exception as e:
            await self._restore_status(db, quiz_set, previous_status)
            logger.exception(
                f"[QUIZ] failed to delete Mongo questions quiz_uuid={quiz_uuid} uid={uid}"
            )
            raise QuizDeleteError(503, "题目数据删除失败，请稍后重试") from e

        try:
            submission_uuids = await self._get_submission_uuids(db, quiz_uuid)
            deleted_answers = await self._delete_answers(db, submission_uuids)
            deleted_submissions = await self._delete_submissions(db, quiz_uuid)
            await self._delete_quiz_set(db, quiz_uuid, uid)
            await db.commit()
        except Exception as e:
            await db.rollback()
            await self._mark_delete_failed(quiz_uuid, uid)
            logger.exception(
                f"[QUIZ] failed to delete SQL rows quiz_uuid={quiz_uuid} uid={uid}"
            )
            raise QuizDeleteError(503, "题目记录删除失败，请稍后重试") from e

        logger.info(
            f"[QUIZ] hard deleted quiz_uuid={quiz_uuid} uid={uid} "
            f"questions={deleted_questions} submissions={deleted_submissions} "
            f"answers={deleted_answers}"
        )
        return {
            "deleted": True,
            "quiz_uuid": quiz_uuid,
            "deleted_questions": deleted_questions,
            "deleted_submissions": deleted_submissions,
            "deleted_answers": deleted_answers,
        }

    async def _get_owned_quiz_set(
        self,
        db: AsyncSession,
        quiz_uuid: str,
        uid: int,
    ) -> QuizSet | None:
        result = await db.execute(
            select(QuizSet).where(QuizSet.quiz_uuid == quiz_uuid, QuizSet.uid == uid)
        )
        return result.scalar_one_or_none()

    async def _mark_deleting(self, db: AsyncSession, quiz_set: QuizSet) -> None:
        quiz_set.status = "deleting"
        await db.commit()

    async def _restore_status(
        self, db: AsyncSession, quiz_set: QuizSet, status: str
    ) -> None:
        quiz_set.status = status
        await db.commit()

    async def _mark_delete_failed(self, quiz_uuid: str, uid: int) -> None:
        async with get_db_context() as db:
            result = await db.execute(
                select(QuizSet).where(
                    QuizSet.quiz_uuid == quiz_uuid, QuizSet.uid == uid
                )
            )
            quiz_set = result.scalar_one_or_none()
            if quiz_set:
                quiz_set.status = "failed"
                quiz_set.error_message = "删除未完成，请重试删除"
                await db.commit()

    async def _get_submission_uuids(
        self,
        db: AsyncSession,
        quiz_uuid: str,
    ) -> list[str]:
        result = await db.execute(
            select(QuizSubmission.submission_uuid).where(
                QuizSubmission.quiz_uuid == quiz_uuid,
            )
        )
        return list(result.scalars().all())

    async def _delete_answers(
        self, db: AsyncSession, submission_uuids: list[str]
    ) -> int:
        if not submission_uuids:
            return 0

        result = await db.execute(
            delete(QuizAnswer).where(QuizAnswer.submission_uuid.in_(submission_uuids))
        )
        return result.rowcount or 0

    async def _delete_submissions(
        self,
        db: AsyncSession,
        quiz_uuid: str,
    ) -> int:
        result = await db.execute(
            delete(QuizSubmission).where(QuizSubmission.quiz_uuid == quiz_uuid)
        )
        return result.rowcount or 0

    async def _delete_quiz_set(
        self, db: AsyncSession, quiz_uuid: str, uid: int
    ) -> None:
        await db.execute(
            delete(QuizSet).where(QuizSet.quiz_uuid == quiz_uuid, QuizSet.uid == uid)
        )
