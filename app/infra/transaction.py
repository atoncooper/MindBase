"""Transaction scope manager with retry logic for PostgreSQL.

Provides a decorator and context manager that handle commit / rollback
automatically. The decorator can retry transient PG errors (deadlock,
serialization failure, connection loss).

Usage:
    # Decorator — most common in service layer
    from app.infra.transaction import transactional

    @transactional()
    async def create_user(db: AsyncSession, name: str) -> User:
        user = User(name=name)
        db.add(user)
        return user   # commit is automatic on success

    # Context manager — explicit blocks
    from app.infra.transaction import transactional_scope

    async with transactional_scope() as db:
        await db.execute(...)
        # commit on clean exit, rollback on exception

    # Read-only hint
    async with transactional_scope(readonly=True) as db:
        row = await db.execute(text("SELECT ..."))
"""

from __future__ import annotations

import asyncio
import functools
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Callable, TypeVar

from loguru import logger
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.infra.config import config
from app.database import get_db_context

# PG error codes considered transient and safe to retry:
#   40001  serialization_failure
#   40P01  deadlock_detected
#   08006  connection_failure
#   08003  connection_does_not_exist
_RETRY_PG_CODES = {"40001", "40P01", "08006", "08003"}

F = TypeVar("F", bound=Callable[..., Any])


def _is_retryable(exc: Exception) -> bool:
    """Return True if *exc* is a transient PG error worth retrying."""
    if isinstance(exc, DBAPIError):
        pgcode = getattr(exc.orig, "pgcode", None) if exc.orig else None
        if pgcode in _RETRY_PG_CODES:
            return True
    return False


@asynccontextmanager
async def transactional_scope(
    *,
    readonly: bool = False,
    max_retries: int | None = None,
    retry_delay_base: float | None = None,
) -> AsyncIterator[AsyncSession]:
    """Explicit transaction context.

    Commits on clean exit and rolls back on exception. Context managers cannot
    safely retry the caller body after ``yield``; use ``@transactional`` when
    retrying the whole callable is required.
    """
    _ = max_retries, retry_delay_base
    async with get_db_context() as db:
        if readonly:
            await db.execute(text("SET TRANSACTION READ ONLY"))
        try:
            yield db
            await db.commit()
        except Exception:
            await db.rollback()
            raise


def transactional(
    *,
    readonly: bool = False,
    max_retries: int | None = None,
    retry_delay_base: float | None = None,
) -> Callable[[F], F]:
    """Decorator that wraps an async function in a transaction.

    Supports nesting: if the first positional argument is already an
    ``AsyncSession`` with an active transaction, the function runs
    inside that existing transaction (savepoint semantics).

    Usage:
        @transactional()
        async def create_user(db: AsyncSession, name: str) -> User:
            ...
    """

    def decorator(func: F) -> F:
        @functools.wraps(func)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            # Detect nested call: first arg is an active session
            db = args[0] if args and isinstance(args[0], AsyncSession) else None
            if db is not None and db.in_transaction():
                return await func(*args, **kwargs)

            _max_retries = (
                max_retries
                if max_retries is not None
                else config.transaction.max_retries
            )
            _delay = (
                retry_delay_base
                if retry_delay_base is not None
                else config.transaction.retry_delay_base
            )

            attempt = 0
            while True:
                async with get_db_context() as db:
                    if readonly:
                        await db.execute(text("SET TRANSACTION READ ONLY"))
                    try:
                        if db not in args:
                            result = await func(db, *args, **kwargs)
                        else:
                            result = await func(*args, **kwargs)
                        await db.commit()
                        return result
                    except Exception as exc:
                        await db.rollback()
                        if not _is_retryable(exc) or attempt >= _max_retries:
                            raise
                        attempt += 1
                        delay = _delay * (2**attempt)
                        logger.warning(
                            "[TX] retryable error in {}, attempt {}/{}, sleep {:.2f}s",
                            func.__name__,
                            attempt,
                            _max_retries,
                            delay,
                        )
                        await asyncio.sleep(delay)

        return wrapper  # type: ignore[return-value]

    return decorator
