"""
Pydantic response models for credentials, settings, billing, and LLM configs.
"""

from datetime import date as date_type, datetime
from typing import Optional
from pydantic import BaseModel, field_validator

from app.security.url_validation import validate_public_http_url


# ── Credentials ─────────────────────────────────────────────────


class CredentialResponse(BaseModel):
    """Credential list item (API key masked)."""

    id: int
    name: str
    provider: str
    masked_key: str  # "sk-abc...4f2a"
    base_url: Optional[str] = None
    default_model: Optional[str] = None
    is_default: bool
    created_at: datetime
    updated_at: datetime
    last_test_status: Optional[str] = None  # None | "ok" | "error"
    last_test_error: Optional[str] = None
    last_test_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class TestResultResponse(BaseModel):
    """Test result for a single config."""

    status: str  # "ok" | "error"
    error: Optional[str] = None
    latency_ms: float = 0.0


# ── Embedding / ASR configs ─────────────────────────────────────


class EmbeddingConfigResponse(BaseModel):
    """Embedding config item (API key masked)."""

    id: int
    name: str
    provider: str
    masked_key: str
    base_url: Optional[str] = None
    model: Optional[str] = None
    is_default: bool = False
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    last_test_status: Optional[str] = None
    last_test_error: Optional[str] = None
    last_test_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class ASRConfigResponse(BaseModel):
    """ASR config item (API key masked)."""

    id: int
    name: str
    provider: str
    masked_key: str
    base_url: Optional[str] = None
    model: Optional[str] = None
    is_default: bool = False
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    last_test_status: Optional[str] = None
    last_test_error: Optional[str] = None
    last_test_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class ApiKeyStatusResponse(BaseModel):
    """Legacy settings status (keys masked, no full values)."""

    llm_is_configured: bool = False
    llm_masked_key: Optional[str] = None
    llm_base_url: Optional[str] = None
    llm_model: Optional[str] = None
    embedding_is_configured: bool = False
    embedding_masked_key: Optional[str] = None
    embedding_base_url: Optional[str] = None
    embedding_model: Optional[str] = None
    asr_is_configured: bool = False
    asr_masked_key: Optional[str] = None
    asr_base_url: Optional[str] = None
    asr_model: Optional[str] = None
    updated_at: Optional[datetime] = None


# ── Billing / Usage ─────────────────────────────────────────────


class ProviderUsage(BaseModel):
    """Per-provider aggregated usage."""

    provider: str
    total_tokens: int
    prompt_tokens: int = 0
    completion_tokens: int = 0
    api_calls: int
    cost_estimate: float = 0.0


class CredentialUsageItem(BaseModel):
    """Per-credential aggregated usage."""

    credential_id: Optional[int] = None  # None = system default
    name: str
    provider: str
    total_tokens: int
    prompt_tokens: int = 0
    completion_tokens: int = 0
    api_calls: int
    cost_estimate: float = 0.0


class ModelUsage(BaseModel):
    """Per-model aggregated usage."""

    model: str
    provider: str
    total_tokens: int
    prompt_tokens: int = 0
    completion_tokens: int = 0
    api_calls: int
    cost_estimate: float = 0.0


class UsageTimeseriesPoint(BaseModel):
    """Single day in a usage time series."""

    date: date_type
    total_tokens: int
    prompt_tokens: int = 0
    completion_tokens: int = 0
    api_calls: int = 0
    cost_estimate: float = 0.0


class UsageSummary(BaseModel):
    """Billing usage summary (top-level response)."""

    total_tokens: int
    total_prompt_tokens: int = 0
    total_completion_tokens: int = 0
    total_api_calls: int
    total_cost: float = 0.0
    avg_cost_per_call: float = 0.0
    by_provider: list[ProviderUsage]
    by_credential: list[CredentialUsageItem]
    by_model: list[ModelUsage] = []


# ── Credential Create / Update (requests) ─────────────────────────


class BaseUrlRequest(BaseModel):
    base_url: Optional[str] = None

    @field_validator("base_url")
    @classmethod
    def validate_base_url(cls, value: Optional[str]) -> Optional[str]:
        return validate_public_http_url(value)


class CredentialCreate(BaseUrlRequest):
    """POST /credentials request."""

    name: str
    provider: str  # openai | anthropic | deepseek | custom
    api_key: str
    base_url: Optional[str] = None
    default_model: Optional[str] = None
    is_default: bool = False


class CredentialUpdate(BaseUrlRequest):
    """PATCH /credentials/{id} request (partial update)."""

    name: Optional[str] = None
    api_key: Optional[str] = None
    base_url: Optional[str] = None
    default_model: Optional[str] = None
    is_default: Optional[bool] = None


# ── Embedding / ASR config Create / Update (requests) ──────────────


class EmbeddingConfigCreate(BaseUrlRequest):
    """POST /settings/embedding-configs request."""

    name: str
    provider: str = "openai"
    api_key: str
    base_url: Optional[str] = None
    model: Optional[str] = None
    is_default: bool = False


class EmbeddingConfigUpdate(BaseUrlRequest):
    """PATCH /settings/embedding-configs/{id} request."""

    name: Optional[str] = None
    api_key: Optional[str] = None
    base_url: Optional[str] = None
    model: Optional[str] = None
    is_default: Optional[bool] = None


class ASRConfigCreate(BaseUrlRequest):
    """POST /settings/asr-configs request."""

    name: str
    provider: str = "dashscope"
    api_key: str
    base_url: Optional[str] = None
    model: Optional[str] = None
    is_default: bool = False


class ASRConfigUpdate(BaseUrlRequest):
    """PATCH /settings/asr-configs/{id} request."""

    name: Optional[str] = None
    api_key: Optional[str] = None
    base_url: Optional[str] = None
    model: Optional[str] = None
    is_default: Optional[bool] = None


class ApiKeySetRequest(BaseModel):
    """POST /settings/credentials request (legacy compat)."""

    llm_api_key: Optional[str] = None
    llm_base_url: Optional[str] = None
    llm_model: Optional[str] = None
    embedding_api_key: Optional[str] = None
    embedding_base_url: Optional[str] = None
    embedding_model: Optional[str] = None
    asr_api_key: Optional[str] = None
    asr_base_url: Optional[str] = None
    asr_model: Optional[str] = None

    @field_validator("llm_base_url", "embedding_base_url", "asr_base_url")
    @classmethod
    def validate_base_urls(cls, value: Optional[str]) -> Optional[str]:
        return validate_public_http_url(value)
