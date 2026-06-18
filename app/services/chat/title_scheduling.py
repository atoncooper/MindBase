"""Schedule background generation of chat-session titles."""

from typing import Callable, Optional

from fastapi import BackgroundTasks

from app.response import ChatSessionResponse
from app.services.chat.llm import build_llm
from app.services.chat_title import (
    generate_chat_title_background,
    should_generate_title,
)


def schedule_title_generation(
    background_tasks: BackgroundTasks,
    chat_session: ChatSessionResponse,
    *,
    uid: int,
    first_message: str,
    llm_factory: Optional[Callable] = None,
) -> None:
    """Enqueue background title generation if the session still has the default title."""
    if chat_session.last_message_at is not None or not should_generate_title(
        chat_session.title
    ):
        return
    background_tasks.add_task(
        generate_chat_title_background,
        chat_session_id=chat_session.chat_session_id,
        uid=uid,
        first_message=first_message,
        llm_factory=llm_factory or build_llm,
    )
