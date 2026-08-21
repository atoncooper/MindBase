import pytest
from pydantic import ValidationError

from app.response.credentials import (
    ASRConfigCreate,
    ASRConfigUpdate,
    ApiKeySetRequest,
    CredentialCreate,
    CredentialUpdate,
    EmbeddingConfigCreate,
    EmbeddingConfigUpdate,
)
from app.security import url_validation
from app.security.url_validation import validate_public_http_url
from app.services.asr import ASRService


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "gopher://example.com",
        "http://example.com",
        "http://localhost:8000",
        "https://localhost:8000",
        "https://127.0.0.1:8000",
        "https://0.0.0.0:8000",
        "https://10.0.0.1",
        "https://100.64.0.1",
        "https://172.16.0.1",
        "https://192.168.1.1",
        "https://169.254.169.254/latest/meta-data",
        "https://[::1]:8000",
        "https://[fe80::1]",
        "https://2130706433",
        "https://127.1",
        "https://0x7f000001",
    ],
)
def test_validate_public_http_url_rejects_ssrf_targets(url):
    with pytest.raises(ValueError):
        validate_public_http_url(url)


@pytest.mark.parametrize(
    "url",
    [
        "https://api.openai.com/v1",
        "https://dashscope.aliyuncs.com/api/v1",
        "https://example.com",
    ],
)
def test_validate_public_http_url_accepts_public_http_urls(url):
    assert validate_public_http_url(url) == url


@pytest.mark.parametrize("resolved_ip", ["10.0.0.1", "100.64.0.1"])
def test_validate_public_http_url_rejects_hostname_resolving_to_non_public_ip(
    monkeypatch, resolved_ip
):
    monkeypatch.setattr(
        url_validation.socket,
        "getaddrinfo",
        lambda *args, **kwargs: [(None, None, None, None, (resolved_ip, 443))],
    )

    with pytest.raises(ValueError):
        validate_public_http_url("https://internal.example.com")


@pytest.mark.parametrize(
    "model_cls, field_name",
    [
        (CredentialCreate, "base_url"),
        (CredentialUpdate, "base_url"),
        (EmbeddingConfigCreate, "base_url"),
        (EmbeddingConfigUpdate, "base_url"),
        (ASRConfigCreate, "base_url"),
        (ASRConfigUpdate, "base_url"),
    ],
)
def test_credential_models_reject_localhost_base_url(model_cls, field_name):
    payload = {
        "name": "test",
        "provider": "openai",
        "api_key": "sk-test",
        field_name: "http://127.0.0.1:8000",
    }
    if model_cls is ASRConfigCreate:
        payload["provider"] = "openai"

    with pytest.raises(ValidationError):
        model_cls(**payload)


@pytest.mark.parametrize(
    "field_name",
    ["llm_base_url", "embedding_base_url", "asr_base_url"],
)
def test_api_key_set_request_rejects_private_base_urls(field_name):
    with pytest.raises(ValidationError):
        ApiKeySetRequest(**{field_name: "http://127.0.0.1:8000"})


def test_asr_transcription_download_rejects_private_url(monkeypatch):
    def fail_urlopen(*args, **kwargs):
        raise AssertionError("urlopen should not be called for unsafe URLs")

    monkeypatch.setattr("app.services.asr.urlrequest.urlopen", fail_urlopen)

    assert (
        ASRService()._download_transcription("http://127.0.0.1/transcript.json") is None
    )
