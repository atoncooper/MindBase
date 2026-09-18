"""LLM construction for chat endpoints.

Builds a LangChain `ChatOpenAI` instance, preferring the user's default
credential and falling back to system defaults.
"""

import uuid
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
    through the provider layer (the Higress AI gateway is the only platform
    entry) — on a cache miss (which incurs cost).

    BYOK (user-supplied credentials): a user's key always goes straight to
    the user's own endpoint — never through the AI gateway (a vendor key
    cannot authenticate against the gateway's consumer key-auth).  A user
    credential without a stored base_url is rejected with a 400: legacy
    direct-connection fallbacks have been removed.  SSRF validation applies
    only to user-provided URLs (the platform-configured gateway address is
    trusted ops territory; public-URL validation would wrongly reject
    http://higress:8080).
    """
    cfg = resolve_llm_config()
    api_key = cfg.api_key
    base_url = cfg.base_url
    model = cfg.model
    credential_id: Optional[int] = None  # None = system default
    user_base_url: Optional[str] = None
    using_user_credential = False

    if uid is not None:
        from app.main import app

        manager = getattr(app.state, "api_key_manager", None)
        if manager and manager.is_enabled:
            user_creds = manager.get_default_credential_sync(uid)
            if user_creds and user_creds.api_key:
                using_user_credential = True
                api_key = user_creds.api_key
                if user_creds.base_url:
                    base_url = user_creds.base_url
                    user_base_url = user_creds.base_url
                else:
                    raise HTTPException(
                        status_code=400,
                        detail="用户凭证未配置 LLM API 地址",
                    )
                if user_creds.model:
                    model = user_creds.model
                credential_id = getattr(user_creds, "credential_id", None)

    if not api_key:
        raise HTTPException(status_code=400, detail="未配置 LLM API Key")

    if not base_url:
        raise HTTPException(status_code=400, detail="未配置 LLM API 地址")

    if user_base_url:
        try:
            validated = validate_public_http_url(user_base_url)
        except ValueError:
            raise HTTPException(status_code=400, detail="LLM API 地址不安全或无效")
        if validated is None:
            raise HTTPException(status_code=400, detail="未配置 LLM API 地址")
        base_url = validated

    request_id = uuid.uuid4().hex

    llm = ChatOpenAI(
        api_key=api_key,
        base_url=base_url,
        model=model,
        temperature=0.5,
        stream_usage=True,
        # The gateway path carries no extra attribution headers (kept for
        # forward compatibility)
        **({"default_headers": dict(cfg.default_headers)} if cfg.default_headers else {}),
    )
    # User credentials point at all kinds of endpoints — infer the provider
    # from the URL. For the platform path use the provider layer's verdict
    # (the base_url is the gateway address there; URL inference would
    # mislabel it as custom)
    provider = infer_provider(base_url) if using_user_credential else cfg.provider
    setattr(llm, "_credential_id", credential_id)
    setattr(llm, "_provider", provider)
    setattr(llm, "_model", model)
    setattr(llm, "_request_id", request_id)

    if uid is not None:
        attach_usage_tracking(
            llm,
            uid=uid,
            credential_id=credential_id,
            provider=provider,
            model=model,
            writer=get_buffered_usage_writer(),
            purpose="chat",
            request_id=getattr(llm, "_request_id", None) or uuid.uuid4().hex,
        )

    return llm
