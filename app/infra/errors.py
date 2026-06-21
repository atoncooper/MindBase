"""HTTP error helpers — prevent internal exception leakage.

Production 5xx responses MUST NOT include raw exception text, SQL fragments,
file paths, or stack traces. Use :func:`internal_error` to log the full
detail server-side and return a generic message to the client.

4xx responses may safely echo user-facing error messages from service-layer
ValueErrors (e.g. "ASR not completed — cannot vectorize"), so those are left
alone.
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from loguru import logger


def internal_error(
    exc: BaseException,
    *,
    context: str = "",
    status_code: int = 500,
    logger_ctx: Any = None,
) -> HTTPException:
    """Return an HTTPException with a generic client message.

    Logs the full exception server-side with optional `context` tag, then
    returns a 500 (or overridden status) with a non-revealing detail string.

    Usage in a router:
        except Exception as e:
            logger.exception("...")
            raise internal_error(e, context="sync_folders")
    """
    if context:
        logger.exception("[{}] internal error", context)
    else:
        logger.exception("internal error")
    return HTTPException(
        status_code=status_code,
        detail="服务器内部错误，请稍后重试",
    )
