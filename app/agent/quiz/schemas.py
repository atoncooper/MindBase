from typing import Annotated, Literal

from pydantic import BaseModel, Field, model_validator


class QuizRubricItemOutput(BaseModel):
    step: str = Field(min_length=1, max_length=80)
    points: int | float = Field(gt=0, le=10)
    keywords: list[str] = Field(min_length=1, max_length=5)


class BaseQuizQuestionOutput(BaseModel):
    difficulty: Literal["easy", "medium", "hard"]
    source_chunk_index: int = Field(ge=0)
    question: str = Field(min_length=1, max_length=300)
    explanation: str = Field(min_length=1, max_length=500)


class SingleChoiceQuestionOutput(BaseQuizQuestionOutput):
    type: Literal["single_choice"]
    options: list[str] = Field(min_length=4, max_length=4)
    correct_answer: str = Field(min_length=1, max_length=120)


class MultiChoiceQuestionOutput(BaseQuizQuestionOutput):
    type: Literal["multi_choice"]
    options: list[str] = Field(min_length=4, max_length=6)
    correct_answer: list[str] = Field(min_length=2, max_length=4)


class ShortAnswerQuestionOutput(BaseQuizQuestionOutput):
    type: Literal["short_answer"]
    keywords: list[str] = Field(min_length=3, max_length=5)
    answer_template: str = Field(min_length=30, max_length=100)
    correct_answer: str = ""


class EssayQuestionOutput(BaseQuizQuestionOutput):
    type: Literal["essay"]
    model_answer: str = Field(min_length=30, max_length=800)
    scoring_rubric: list[QuizRubricItemOutput] = Field(min_length=1, max_length=6)
    correct_answer: str = ""


QuizQuestionOutput = Annotated[
    SingleChoiceQuestionOutput
    | MultiChoiceQuestionOutput
    | ShortAnswerQuestionOutput
    | EssayQuestionOutput,
    Field(discriminator="type"),
]


class QuizBatchOutput(BaseModel):
    questions: list[QuizQuestionOutput] = Field(min_length=1, max_length=20)


class EssayStepScore(BaseModel):
    step: str
    max_points: int | float = Field(ge=0)
    score: int | float = Field(ge=0)
    reason: str

    @model_validator(mode="after")
    def validate_score_bounds(self) -> "EssayStepScore":
        if self.score > self.max_points:
            raise ValueError("essay step score cannot exceed max_points")
        return self


class EssayGradingOutput(BaseModel):
    total_score: int | float = Field(ge=0)
    max_score: int | float = Field(ge=0)
    step_scores: list[EssayStepScore]
    overall_feedback: str
    strengths: list[str] = Field(default_factory=list)
    weaknesses: list[str] = Field(default_factory=list)
