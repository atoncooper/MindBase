"""LLM construction for chat endpoints.

Builds a LangChain `ChatOpenAI` instance, preferring the user's default
credential and falling back to system defaults.
"""

from typing import Optional

from fastapi import HTTPException
from langchain_openai import ChatOpenAI

from app.security.url_validation import validate_public_http_url
from app.services.llm.buffered_usage_writer import get_buffered_usage_writer
from app.services.llm.providers import infer_provider as _infer_provider
from app.services.llm.providers import resolve_llm_config
from app.services.llm.usage_tracker import attach_usage_tracking


def infer_provider(base_url: Optional[str]) -> str:
    """Infer the provider name from a base URL.

    Thin delegate to the canonical implementation in
    ``app.services.llm.providers`` (kept here so existing import paths
    ``app.services.chat.llm`` / ``app.services.chat`` keep working).
    """
    return _infer_provider(base_url)


def build_llm(uid: Optional[int] = None) -> ChatOpenAI:
    """Build a LangChain LLM instance.

    Reads the user's default credential synchronously from
    ``ApiKeyManager``'s cache. Falls back to the system default — resolved
    through the provider layer (``llm.provider`` selects DashScope or
    OpenRouter) — on a cache miss (which incurs cost).
    """
    cfg = resolve_llm_config()
    api_key = cfg.api_key
    base_url = cfg.base_url
    model = cfg.model
    credential_id: Optional[int] = None  # None = system default

    if uid is not None:
        from app.main import app

        manager = getattr(app.state, "api_key_manager", None)
        if manager and manager.is_enabled:
            user_creds = manager.get_default_credential_sync(uid)
            if user_creds and user_creds.api_key:
                api_key = user_creds.api_key
                if user_creds.base_url:
                    base_url = user_creds.base_url
                if user_creds.model:
                    model = user_creds.model
                credential_id = getattr(user_creds, "credential_id", None)

    if not api_key:
        raise HTTPException(status_code=400, detail="未配置 LLM API Key")

    try:
        base_url = validate_public_http_url(base_url)
    except ValueError:
        raise HTTPException(status_code=400, detail="LLM API 地址不安全或无效")
    if base_url is None:
        raise HTTPException(status_code=400, detail="未配置 LLM API 地址")

    llm = ChatOpenAI(
        api_key=api_key,
        base_url=base_url,
        model=model,
        temperature=0.5,
        stream_usage=True,
        # OpenRouter attribution headers (empty for DashScope)
        **({"default_headers": dict(cfg.default_headers)} if cfg.default_headers else {}),
    )
    provider = infer_provider(base_url)
    setattr(llm, "_credential_id", credential_id)
    setattr(llm, "_provider", provider)
    setattr(llm, "_model", model)

    if uid is not None:
        attach_usage_tracking(
            llm,
            uid=uid,
            credential_id=credential_id,
            provider=provider,
            model=model,
            writer=get_buffered_usage_writer(),
        )

    return llm
