from datetime import datetime

import pytest
from fastapi import HTTPException

from app.models import QuizSet
from app.routers import quiz as quiz_router
from app.services.quiz_delete import QuizDeleteError, QuizDeleteService
from app.services.quiz_grader import QuizGraderService


class _ScalarResult:
    def __init__(self, value):
        self._value = value

    def scalar_one_or_none(self):
        return self._value


class _DbContext:
    def __init__(self, quiz_set):
        self.quiz_set = quiz_set

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def execute(self, _statement):
        return _ScalarResult(self.quiz_set)


@pytest.mark.asyncio
async def test_get_quiz_requires_owner(monkeypatch):
    quiz_set = QuizSet(
        quiz_uuid="quiz-owned-by-other",
        uid=200,
        title="Private quiz",
        question_count=1,
        difficulty="medium",
        status="done",
    )

    async def fake_get_quiz_set(_quiz_uuid):
        return quiz_set

    async def fake_get_quiz_questions(_quiz_uuid):
        return []

    monkeypatch.setattr(quiz_router, "get_quiz_set", fake_get_quiz_set)
    monkeypatch.setattr(quiz_router, "get_quiz_questions", fake_get_quiz_questions)

    with pytest.raises(HTTPException) as exc:
        await quiz_router.get_quiz("quiz-owned-by-other", uid=100)

    assert exc.value.status_code == 404


@pytest.mark.asyncio
async def test_submit_quiz_rejects_quiz_owned_by_another_user(monkeypatch):
    quiz_set = QuizSet(
        quiz_uuid="quiz-owned-by-other",
        uid=200,
        title="Private quiz",
        question_count=1,
        difficulty="medium",
        status="done",
    )

    async def fake_get_quiz_set(_quiz_uuid):
        return quiz_set

    monkeypatch.setattr("app.services.quiz_grader.get_quiz_set", fake_get_quiz_set)

    service = QuizGraderService()
    with pytest.raises(ValueError, match="题目集不存在"):
        await service.submit_and_grade(
            quiz_uuid="quiz-owned-by-other",
            uid=100,
            answers=[{"question_uuid": "q1", "answer": "A"}],
        )


@pytest.mark.asyncio
async def test_get_quiz_rejects_deleting_quiz(monkeypatch):
    quiz_set = QuizSet(
        quiz_uuid="quiz-deleting",
        uid=100,
        title="Deleting quiz",
        question_count=1,
        difficulty="medium",
        status="deleting",
    )

    async def fake_get_quiz_set(_quiz_uuid):
        return quiz_set

    async def fake_get_quiz_questions(_quiz_uuid):
        return []

    monkeypatch.setattr(quiz_router, "get_quiz_set", fake_get_quiz_set)
    monkeypatch.setattr(quiz_router, "get_quiz_questions", fake_get_quiz_questions)

    with pytest.raises(HTTPException) as exc:
        await quiz_router.get_quiz("quiz-deleting", uid=100)

    assert exc.value.status_code == 404


@pytest.mark.asyncio
async def test_submit_quiz_rejects_deleting_quiz(monkeypatch):
    quiz_set = QuizSet(
        quiz_uuid="quiz-deleting",
        uid=100,
        title="Deleting quiz",
        question_count=1,
        difficulty="medium",
        status="deleting",
    )

    async def fake_get_quiz_set(_quiz_uuid):
        return quiz_set

    monkeypatch.setattr("app.services.quiz_grader.get_quiz_set", fake_get_quiz_set)

    service = QuizGraderService()
    with pytest.raises(ValueError, match="题目集不存在"):
        await service.submit_and_grade(
            quiz_uuid="quiz-deleting",
            uid=100,
            answers=[{"question_uuid": "q1", "answer": "A"}],
        )


class _FakeQuizDeleteService:
    def __init__(self, result=None, error: Exception | None = None):
        self.result = result or {
            "deleted": True,
            "quiz_uuid": "quiz-1",
            "deleted_questions": 2,
            "deleted_submissions": 1,
            "deleted_answers": 3,
        }
        self.error = error
        self.calls = []

    async def delete_quiz(self, *, quiz_uuid: str, uid: int):
        self.calls.append((quiz_uuid, uid))
        if self.error:
            raise self.error
        return self.result


@pytest.mark.asyncio
async def test_delete_quiz_delegates_to_owner_scoped_service(monkeypatch):
    fake_service = _FakeQuizDeleteService()
    monkeypatch.setattr(quiz_router, "QuizDeleteService", lambda: fake_service)

    result = await quiz_router.delete_quiz("quiz-1", uid=100)

    assert result["deleted"] is True
    assert result["deleted_questions"] == 2
    assert fake_service.calls == [("quiz-1", 100)]


@pytest.mark.asyncio
async def test_delete_quiz_returns_404_for_non_owner(monkeypatch):
    fake_service = _FakeQuizDeleteService(error=QuizDeleteError(404, "题目集不存在"))
    monkeypatch.setattr(quiz_router, "QuizDeleteService", lambda: fake_service)

    with pytest.raises(HTTPException) as exc:
        await quiz_router.delete_quiz("quiz-owned-by-other", uid=100)

    assert exc.value.status_code == 404
    assert exc.value.detail == "题目集不存在"
    assert fake_service.calls == [("quiz-owned-by-other", 100)]


@pytest.mark.asyncio
async def test_delete_quiz_rejects_generating_quiz(monkeypatch):
    fake_service = _FakeQuizDeleteService(
        error=QuizDeleteError(409, "题目正在生成中，暂不能删除，请稍后再试")
    )
    monkeypatch.setattr(quiz_router, "QuizDeleteService", lambda: fake_service)

    with pytest.raises(HTTPException) as exc:
        await quiz_router.delete_quiz("quiz-generating", uid=100)

    assert exc.value.status_code == 409
    assert exc.value.detail == "题目正在生成中，暂不能删除，请稍后再试"


@pytest.mark.asyncio
async def test_delete_quiz_aborts_when_question_store_delete_fails(monkeypatch):
    fake_service = _FakeQuizDeleteService(
        error=QuizDeleteError(503, "题目数据删除失败，请稍后重试")
    )
    monkeypatch.setattr(quiz_router, "QuizDeleteService", lambda: fake_service)

    with pytest.raises(HTTPException) as exc:
        await quiz_router.delete_quiz("quiz-1", uid=100)

    assert exc.value.status_code == 503
    assert exc.value.detail == "题目数据删除失败，请稍后重试"


class _CommitOnlyDb:
    def __init__(self):
        self.commit_count = 0
        self.rollback_count = 0

    async def commit(self):
        self.commit_count += 1

    async def rollback(self):
        self.rollback_count += 1


class _RecordingDbContext:
    def __init__(self):
        self.calls = []
        self.commit_count = 0

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def execute(self, statement, params):
        self.calls.append((statement, params))

    async def commit(self):
        self.commit_count += 1


class _RecordingQuizDeleteService(QuizDeleteService):
    def __init__(self, quiz_set: QuizSet, submission_uuids: list[str]):
        self.quiz_set = quiz_set
        self.submission_uuids = submission_uuids
        self.deleted_answers_for: list[list[str]] = []
        self.deleted_submissions_for: list[str] = []
        self.deleted_quiz_sets_for: list[tuple[str, int]] = []
        self.marked_deleting: list[str] = []
        self.marked_delete_failed: list[tuple[str, int]] = []

    async def _get_owned_quiz_set(self, db, quiz_uuid: str, uid: int):
        return (
            self.quiz_set
            if self.quiz_set.quiz_uuid == quiz_uuid and self.quiz_set.uid == uid
            else None
        )

    async def _mark_deleting(self, db, quiz_set: QuizSet) -> None:
        quiz_set.status = "deleting"
        self.marked_deleting.append(quiz_set.quiz_uuid)
        await db.commit()

    async def _restore_status(self, db, quiz_set: QuizSet, status: str) -> None:
        quiz_set.status = status
        await db.commit()

    async def _mark_delete_failed(self, quiz_uuid: str, uid: int) -> None:
        self.marked_delete_failed.append((quiz_uuid, uid))
        self.quiz_set.status = "failed"
        self.quiz_set.error_message = "删除未完成，请重试删除"

    async def _get_submission_uuids(self, db, quiz_uuid: str) -> list[str]:
        return list(self.submission_uuids)

    async def _delete_answers(self, db, submission_uuids: list[str]) -> int:
        self.deleted_answers_for.append(list(submission_uuids))
        return 3

    async def _delete_submissions(self, db, quiz_uuid: str) -> int:
        self.deleted_submissions_for.append(quiz_uuid)
        return len(self.submission_uuids)

    async def _delete_quiz_set(self, db, quiz_uuid: str, uid: int) -> None:
        self.deleted_quiz_sets_for.append((quiz_uuid, uid))


@pytest.mark.asyncio
async def test_quiz_submission_uses_mysql_compatible_datetimes(monkeypatch):
    fake_db = _RecordingDbContext()
    monkeypatch.setattr("app.services.quiz_grader.get_db_context", lambda: fake_db)

    service = QuizGraderService()
    await service._create_submission(
        submission_uuid="sub-1",
        quiz_uuid="quiz-1",
        uid=100,
        total_question_count=1,
        passing_score=60,
        time_spent_seconds=None,
    )

    params = fake_db.calls[0][1]
    assert isinstance(params["started_at"], datetime)
    assert isinstance(params["submitted_at"], datetime)
    assert params["started_at"].tzinfo is None
    assert params["submitted_at"].tzinfo is None
    assert fake_db.commit_count == 1


@pytest.mark.asyncio
async def test_delete_service_deletes_answers_through_owner_submissions(monkeypatch):
    quiz_set = QuizSet(
        quiz_uuid="quiz-1",
        uid=100,
        title="Owned quiz",
        question_count=2,
        difficulty="medium",
        status="done",
    )
    fake_db = _CommitOnlyDb()

    async def fake_delete_questions(
        _quiz_uuid: str,
        *,
        uid: int | None = None,
        require_enabled: bool = False,
    ):
        assert _quiz_uuid == "quiz-1"
        assert uid == 100
        assert require_enabled is True
        return 2

    monkeypatch.setattr(
        "app.services.quiz_delete.mongo_quiz.delete_by_quiz",
        fake_delete_questions,
    )

    service = _RecordingQuizDeleteService(quiz_set, ["sub-owned-1", "sub-owned-2"])
    result = await service._delete_from_stores(
        db=fake_db,
        quiz_uuid="quiz-1",
        uid=100,
    )

    assert result == {
        "deleted": True,
        "quiz_uuid": "quiz-1",
        "deleted_questions": 2,
        "deleted_submissions": 2,
        "deleted_answers": 3,
    }
    assert quiz_set.status == "deleting"
    assert service.marked_deleting == ["quiz-1"]
    assert service.deleted_answers_for == [["sub-owned-1", "sub-owned-2"]]
    assert service.deleted_submissions_for == ["quiz-1"]
    assert service.deleted_quiz_sets_for == [("quiz-1", 100)]
    assert fake_db.commit_count == 2


@pytest.mark.asyncio
async def test_delete_service_restores_status_when_question_delete_fails(monkeypatch):
    quiz_set = QuizSet(
        quiz_uuid="quiz-1",
        uid=100,
        title="Owned quiz",
        question_count=2,
        difficulty="medium",
        status="done",
    )
    fake_db = _CommitOnlyDb()

    async def fake_delete_questions(
        _quiz_uuid: str,
        *,
        uid: int | None = None,
        require_enabled: bool = False,
    ):
        raise RuntimeError("mongo down")

    monkeypatch.setattr(
        "app.services.quiz_delete.mongo_quiz.delete_by_quiz",
        fake_delete_questions,
    )

    service = _RecordingQuizDeleteService(quiz_set, ["sub-owned-1"])
    with pytest.raises(QuizDeleteError) as exc:
        await service._delete_from_stores(
            db=fake_db,
            quiz_uuid="quiz-1",
            uid=100,
        )

    assert exc.value.status_code == 503
    assert quiz_set.status == "done"
    assert service.deleted_answers_for == []
    assert service.deleted_submissions_for == []
    assert service.deleted_quiz_sets_for == []
    assert fake_db.commit_count == 2


@pytest.mark.asyncio
async def test_delete_service_marks_failed_when_sql_delete_fails(monkeypatch):
    quiz_set = QuizSet(
        quiz_uuid="quiz-1",
        uid=100,
        title="Owned quiz",
        question_count=2,
        difficulty="medium",
        status="done",
    )
    fake_db = _CommitOnlyDb()

    async def fake_delete_questions(
        _quiz_uuid: str,
        *,
        uid: int | None = None,
        require_enabled: bool = False,
    ):
        assert uid == 100
        return 2

    monkeypatch.setattr(
        "app.services.quiz_delete.mongo_quiz.delete_by_quiz",
        fake_delete_questions,
    )

    service = _RecordingQuizDeleteService(quiz_set, ["sub-owned-1"])

    async def fail_delete_answers(db, submission_uuids: list[str]) -> int:
        raise RuntimeError("sql down")

    service._delete_answers = fail_delete_answers

    with pytest.raises(QuizDeleteError) as exc:
        await service._delete_from_stores(
            db=fake_db,
            quiz_uuid="quiz-1",
            uid=100,
        )

    assert exc.value.status_code == 503
    assert quiz_set.status == "failed"
    assert quiz_set.error_message == "删除未完成，请重试删除"
    assert service.marked_delete_failed == [("quiz-1", 100)]
    assert service.deleted_submissions_for == []
    assert service.deleted_quiz_sets_for == []
    assert fake_db.commit_count == 1
    assert fake_db.rollback_count == 1
