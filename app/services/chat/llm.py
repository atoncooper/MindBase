"""LLM construction for chat endpoints.

Builds a LangChain `ChatOpenAI` instance, preferring the user's default
credential and falling back to system defaults.
"""

from typing import Optional

from fastapi import HTTPException
from langchain_openai import ChatOpenAI

from app.config import settings
from app.security.url_validation import validate_public_http_url


def infer_provider(base_url: Optional[str]) -> str:
    """Infer the provider name from a base URL."""
    if not base_url:
        return "openai"
    url = base_url.lower()
    if "anthropic" in url:
        return "anthropic"
    if "deepseek" in url:
        return "deepseek"
    if "openai" in url:
        return "openai"
    return "custom"


def build_llm(uid: Optional[int] = None) -> ChatOpenAI:
    """Build a LangChain LLM instance.

    Reads the user's default credential synchronously from
    ``ApiKeyManager``'s cache. Falls back to the system default API key on
    a cache miss (which incurs cost).
    """
    api_key = settings.openai_api_key
    base_url = settings.openai_base_url
    model = settings.llm_model
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
    )
    setattr(llm, "_credential_id", credential_id)
    setattr(llm, "_provider", infer_provider(base_url))
    return llm
