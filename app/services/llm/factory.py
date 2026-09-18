"""Platform LLM construction — the single construction point for all
platform-initiated ``ChatOpenAI`` instances (quiz, task-quiz, KG extraction,
metadata, query rewriting, RAG summary...).

Division of responsibilities:
- ``providers.resolve_llm_config`` only resolves the connection (where to
  connect and with which key — the AI gateway is the only platform entry);
- ``chat.llm.build_llm`` serves the conversational main path (user
  credentials first + SSRF validation + HTTPException semantics);
- this module is the unified construction point for every other
  platform-side call: never scatter-build ``ChatOpenAI(settings.openai_*)``,
  always use ``build_platform_llm(purpose=..., ...)`` so the instance
  automatically gets the gateway-only connection plus usage metering
  attached when ``uid`` is available.

``purpose`` is a business-dimension label for the request
(quiz / task_quiz / kg / rewrite / ...) attached to the instance as
``_purpose`` for billing aggregation (``ai_usage_daily.purpose``).
"""

from __future__ import annotations

import uuid
from typing import Optional

from langchain_openai import ChatOpenAI

from app.services.llm.providers import resolve_llm_config
from app.services.llm.usage_tracker import attach_usage_tracking


def build_platform_llm(
    *,
    purpose: str = "chat",
    model: Optional[str] = None,
    uid: Optional[int] = None,
    **chat_openai_kwargs,
) -> ChatOpenAI:
    """Build a platform-owned ChatOpenAI instance.

    - ``base_url`` / ``api_key`` come from ``resolve_llm_config()`` (the AI
      gateway is the only platform entry); the model name defaults to
      ``llm.model``, site-specific models (e.g. ``kg.extract_model``)
      override it via ``model``.
    - Call-site generation parameters (temperature / streaming / timeout /
      ...) pass through ``**chat_openai_kwargs`` untouched; this module
      makes no default-value decisions.
    - Usage tracking is attached when ``uid`` is available; without it the
      instance is built untracked (same as before the consolidation).
      Per architecture the RAG layer never knows the uid — no metering
      there.
    """
    cfg = resolve_llm_config()
    if not cfg.api_key:
        raise RuntimeError(
            f"AI gateway consumer key not configured (purpose={purpose}; "
            "set AI_GATEWAY__API_KEY in .env — vendor keys live only in the "
            "Higress console)"
        )

    effective_model = model or cfg.model
    request_id = uuid.uuid4().hex
    # Egress attribution headers: x-uid lets the gateway attribute usage per
    # user (usage-logger / reconciliation); X-Request-Id correlates with
    # credential_usage.request_id — uid attribution rides the backend channel
    extra_headers: dict[str, str] = {"X-Request-Id": request_id}
    if uid is not None:
        extra_headers["x-uid"] = str(uid)
    caller_headers = chat_openai_kwargs.pop("default_headers", None) or {}
    chat_openai_kwargs["default_headers"] = {**extra_headers, **caller_headers}

    llm = ChatOpenAI(
        api_key=cfg.api_key,
        base_url=cfg.base_url or None,
        model=effective_model,
        **chat_openai_kwargs,
    )
    setattr(llm, "_purpose", purpose)
    setattr(llm, "_provider", cfg.provider)
    setattr(llm, "_model", effective_model)
    setattr(llm, "_request_id", request_id)

    if uid is not None:
        from app.services.llm.buffered_usage_writer import get_buffered_usage_writer

        attach_usage_tracking(
            llm,
            uid=uid,
            credential_id=None,  # None = platform default key (not BYOK)
            provider=cfg.provider,
            model=effective_model,
            writer=get_buffered_usage_writer(),
            purpose=purpose,
            request_id=request_id,
        )

    return llm
