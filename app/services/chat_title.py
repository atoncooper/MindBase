import asyncio
import re
from typing import Callable, Optional, Protocol

from langchain_core.messages import HumanMessage, SystemMessage
from loguru import logger
from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.infra.transaction import transactional_scope
from app.models import ChatSession

MAX_TITLE_LENGTH = 18
TITLE_GENERATION_TIMEOUT_SECONDS = 8
DEFAULT_TITLES = {"", "新对话", "未命名对话", "Untitled", "New Chat"}


class TitleLlm(Protocol):
    async def ainvoke(self, messages: list) -> object: ...


LlmFactory = Callable[[Optional[int]], TitleLlm]


def should_generate_title(title: Optional[str]) -> bool:
    return (title or "").strip() in DEFAULT_TITLES


def sanitize_generated_title(value: str) -> str:
    title = (value or "").strip()
    title = re.sub(r"^\s*(标题|title)\s*[:：]\s*", "", title, flags=re.IGNORECASE)
    title = title.strip().strip("'\"“”‘’《》【】[]()（）.,，。:：;；!！?？")
    title = re.sub(r"\s+", "", title)
    return title[:MAX_TITLE_LENGTH]


def fallback_title(first_message: str) -> str:
    text = re.sub(r"\s+", "", first_message.strip())
    return text[:MAX_TITLE_LENGTH] or "新对话"


def build_title_messages(first_message: str) -> list:
    return [
        SystemMessage(
            content=(
                "你是聊天标题生成器。请根据用户的第一条消息生成一个简短中文标题。"
                "只输出标题本身，不要解释，不要引号，不超过18个中文字符。"
                "如果是代码或技术问题，突出技术对象。"
            )
        ),
        HumanMessage(content=first_message),
    ]


async def update_title_if_default(
    db: AsyncSession,
    *,
    chat_session_id: str,
    uid: int,
    title: str,
) -> bool:
    result = await db.execute(
        update(ChatSession)
        .where(
            ChatSession.chat_session_id == chat_session_id,
            ChatSession.uid == uid,
            ChatSession.status == "active",
            or_(
                ChatSession.title.is_(None),
                func.trim(ChatSession.title).in_(DEFAULT_TITLES),
            ),
        )
        .values(title=title)
    )
    await db.flush()
    return result.rowcount > 0


async def session_allows_title_generation(
    db: AsyncSession,
    *,
    chat_session_id: str,
    uid: int,
) -> bool:
    result = await db.execute(
        select(ChatSession.title).where(
            ChatSession.chat_session_id == chat_session_id,
            ChatSession.uid == uid,
            ChatSession.status == "active",
        )
    )
    title = result.scalar_one_or_none()
    return should_generate_title(title)


async def generate_title_text(
    *,
    uid: int,
    first_message: str,
    llm_factory: LlmFactory,
) -> str:
    title = fallback_title(first_message)
    try:
        llm = llm_factory(uid)
        response = await asyncio.wait_for(
            llm.ainvoke(build_title_messages(first_message)),
            timeout=TITLE_GENERATION_TIMEOUT_SECONDS,
        )
        generated = sanitize_generated_title(
            str(getattr(response, "content", "") or "")
        )
        if generated:
            title = generated
    except Exception:
        logger.exception("[CHAT_TITLE] title generation failed uid={}", uid)
    return title


async def generate_chat_title_from_first_message(
    db: AsyncSession,
    *,
    chat_session_id: str,
    uid: int,
    first_message: str,
    llm_factory: LlmFactory,
) -> None:
    if not await session_allows_title_generation(
        db,
        chat_session_id=chat_session_id,
        uid=uid,
    ):
        return

    title = await generate_title_text(
        uid=uid,
        first_message=first_message,
        llm_factory=llm_factory,
    )
    updated = await update_title_if_default(
        db,
        chat_session_id=chat_session_id,
        uid=uid,
        title=title,
    )
    if updated:
        logger.info("[CHAT_TITLE] updated title chat_session_id={}", chat_session_id)


async def generate_chat_title_background(
    *,
    chat_session_id: str,
    uid: int,
    first_message: str,
    llm_factory: LlmFactory,
) -> None:
    async with transactional_scope() as db:
        should_generate = await session_allows_title_generation(
            db,
            chat_session_id=chat_session_id,
            uid=uid,
        )
    if not should_generate:
        return

    title = await generate_title_text(
        uid=uid,
        first_message=first_message,
        llm_factory=llm_factory,
    )

    async with transactional_scope() as db:
        updated = await update_title_if_default(
            db,
            chat_session_id=chat_session_id,
            uid=uid,
            title=title,
        )
    if updated:
        logger.info("[CHAT_TITLE] updated title chat_session_id={}", chat_session_id)
