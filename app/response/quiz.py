"""
Pydantic schemas for quiz API — request / response models.
"""

from datetime import datetime
from enum import Enum
from typing import Optional
from pydantic import BaseModel


class QuestionType(str, Enum):
    SINGLE_CHOICE = "single_choice"
    MULTI_CHOICE = "multi_choice"
    SHORT_ANSWER = "short_answer"
    ESSAY = "essay"


class QuizGenerateRequest(BaseModel):
    """POST /quiz/generate request."""
    folder_ids: Optional[list[int]] = None
    pages: Optional[list[dict]] = None
    question_count: int = 10
    type_distribution: Optional[dict[str, int]] = None
    difficulty: str = "medium"  # easy | medium | hard
    title: Optional[str] = None


class QuizGenerateResponse(BaseModel):
    """POST /quiz/generate response."""
    quiz_uuid: str
    question_count: int
    estimated_cost_tokens: int


class QuizQuestionResponse(BaseModel):
    """Quiz question (answers excluded)."""
    question_uuid: str
    question_type: str
    difficulty: str
    question_text: str
    options: Optional[list[str]] = None


class QuizSetResponse(BaseModel):
    """GET /quiz/{uuid} response."""
    quiz_uuid: str
    title: str
    status: str
    question_count: int
    type_distribution: Optional[dict] = None
    difficulty: str
    total_score: int
    passing_score: int
    created_at: datetime
    questions: list[QuizQuestionResponse] = []


class QuizAnswerItem(BaseModel):
    """One answer in a submission."""
    question_uuid: str
    answer: str | list[str]


class QuizSubmissionRequest(BaseModel):
    """POST /quiz/submit request."""
    quiz_uuid: str
    answers: list[QuizAnswerItem]
    time_spent_seconds: Optional[int] = None


class QuizAnswerResult(BaseModel):
    """Single-question grading result."""
    question_uuid: str
    is_correct: Optional[bool] = None
    auto_score: Optional[int] = None
    correct_answer: str | list[str]
    grading_note: Optional[str] = None


class QuizSubmissionResponse(BaseModel):
    """POST /quiz/submit response."""
    submission_uuid: str
    score: Optional[int] = None
    passed: Optional[bool] = None
    correct_count: int
    total_count: int
    results: list[QuizAnswerResult]


class QuizHistoryItem(BaseModel):
    """Answer history item."""
    submission_uuid: str
    quiz_uuid: str
    title: str
    score: Optional[int] = None
    passed: Optional[bool] = None
    correct_count: int
    total_question_count: int
    time_spent_seconds: Optional[int] = None
    submitted_at: str


class QuizHistoryResponse(BaseModel):
    """GET /quiz/history response."""
    submissions: list[QuizHistoryItem]
    total: int
    page: int
    page_size: int
    has_more: bool


class WrongAnswerItem(BaseModel):
    """Wrong-answer (study notebook) item."""
    question_uuid: str
    quiz_uuid: str
    question_type: str
    question_text: str
    options: Optional[list[str]] = None
    user_answer: str | list[str]
    correct_answer: str | list[str]
    explanation: Optional[str] = None
    times_wrong: int
    last_attempt_at: str


class WrongAnswerResponse(BaseModel):
    """GET /quiz/wrong-answers response."""
    wrong_answers: list[WrongAnswerItem]
    total: int
