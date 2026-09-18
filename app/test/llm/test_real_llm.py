"""REAL-gateway LLM chain tests (opt-in; consumes real tokens).

Run against the live Higress AI gateway — every test PRINTS its evidence
(model reply, latency, token usage, vector head) in addition to asserting:

    pytest app/test/llm/test_real_llm.py -m real_llm -v -s --real-llm

``--real-llm`` is the cross-shell opt-in (PowerShell/cmd/bash); alternatively
set ``MB_REAL_LLM=1`` (bash prefix syntax, or ``$env:MB_REAL_LLM="1"`` in
PowerShell). ``-s`` shows the printed output of passed tests; failed tests
always show their captured output. Skipped automatically when not opted in.

Requirements: the Higress stack is up and ``AI_GATEWAY__API_KEY`` is set
(mindbase-env / .env).

Host-side runs (outside compose/k8s): the compose-internal hostname
``http://higress:8080`` does NOT resolve on the host — the fixture detects
that and automatically falls back to the mapped loopback
(``http://127.0.0.1:18080/v1``, printed as a notice), so the SAME command
works in and out of containers. It also neutralizes local proxy env vars.
"""

from __future__ import annotations

import time
from dataclasses import replace as dataclasses_replace

import httpx
import pytest
from langchain_openai import OpenAIEmbeddings

from app.config import settings
from app.config.loader import get_config
from app.config.settings import _get
from app.services.llm.factory import build_platform_llm
from app.services.llm.providers import resolve_llm_config

pytestmark = pytest.mark.real_llm


# Reachability probe cache (per process) — an unreachable probe costs ~5s,
# don't pay it once per test.
_probe_cache: dict[str, bool] = {}


def _reachable(base_url: str) -> bool:
    if base_url in _probe_cache:
        return _probe_cache[base_url]
    try:
        # Any HTTP response (even 401 on /models) proves reachability.
        httpx.get(base_url.rstrip("/") + "/models", timeout=5, trust_env=False)
        _probe_cache[base_url] = True
    except httpx.HTTPError:
        _probe_cache[base_url] = False
    return _probe_cache[base_url]


# Host-side entry: compose/k8s map the gateway to 127.0.0.1:18080 (the
# compose-internal hostname "higress" does not resolve on the host).
HOST_FALLBACK_URL = "http://127.0.0.1:18080/v1"


@pytest.fixture()
def gateway_cfg(monkeypatch):
    """Gateway connection config with a reachability pre-flight.

    - Neutralizes local proxy env vars (they hijack egress on host runs).
    - When the configured gateway address is unreachable from this host
      (compose-internal hostname), automatically falls back to the mapped
      loopback entry — so the same command works in and out of containers.
    - Skips with an actionable hint only when nothing is reachable.
    """
    for var in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
                "http_proxy", "https_proxy", "all_proxy"):
        monkeypatch.delenv(var, raising=False)

    cfg = resolve_llm_config()
    if not cfg.api_key:
        pytest.skip("AI_GATEWAY__API_KEY is empty — configure the consumer key first")

    if not _reachable(cfg.base_url):
        if cfg.base_url.rstrip("/") == HOST_FALLBACK_URL or not _reachable(
            HOST_FALLBACK_URL
        ):
            pytest.skip(
                f"AI gateway unreachable at {cfg.base_url} and at {HOST_FALLBACK_URL} "
                "— is the Higress stack up?"
            )
        original = cfg.base_url
        cfg = dataclasses_replace(cfg, base_url=HOST_FALLBACK_URL)
        # build_platform_llm re-resolves internally — patch the cached config
        # so EVERY builder in the test uses the reachable address too.
        monkeypatch.setitem(get_config()["ai_gateway"], "base_url", HOST_FALLBACK_URL)
        print(
            f"\n[gateway] {original} unreachable from this host — "
            f"using mapped loopback {HOST_FALLBACK_URL}"
        )
    print(f"[gateway] base_url={cfg.base_url} provider={cfg.provider}")
    return cfg


def _usage_of(msg) -> dict:
    return getattr(msg, "usage_metadata", None) or (
        getattr(msg, "response_metadata", {}) or {}
    ).get("token_usage") or {}


class TestGatewayAuth:
    def test_unauthenticated_call_is_rejected_401(self, gateway_cfg):
        # The gateway must enforce consumer key-auth on AI routes.
        url = gateway_cfg.base_url.rstrip("/") + "/chat/completions"
        print(f"\nPOST {url} (no Authorization header)")
        resp = httpx.post(
            url,
            json={
                "model": settings.llm_model,
                "messages": [{"role": "user", "content": "ping"}],
            },
            timeout=15,
            trust_env=False,  # never route gateway calls through a local proxy
        )
        print(f"status = {resp.status_code} (expect 401)")
        print(f"body   = {resp.text[:200]}")
        assert resp.status_code == 401


class TestRealChat:
    def test_completion_round_trip(self, gateway_cfg):
        llm = build_platform_llm(purpose="real_test", temperature=0)
        prompt = "What is 2+2? Answer with the number only."
        print(f"\nmodel   = {getattr(llm, '_model', '?')} / purpose=real_test")
        print(f"prompt  = {prompt!r}")

        t0 = time.monotonic()
        msg = llm.invoke(prompt)
        latency = time.monotonic() - t0

        print(f"reply   = {msg.content!r}  (latency {latency:.2f}s)")
        assert isinstance(msg.content, str) and msg.content.strip()
        # Deterministic arithmetic — model-compliance-proof (echoes happen).
        assert "4" in msg.content

    def test_token_usage_flows_back(self, gateway_cfg):
        # Billing prerequisite: usage must reach the response metadata.
        llm = build_platform_llm(purpose="real_test", temperature=0)
        model = getattr(llm, "_model", "?")
        msg = llm.invoke("ping")
        usage = _usage_of(msg)
        print(f"\nusage   = {usage}")
        if isinstance(usage, dict) and usage:
            pretty = {k: usage.get(k) for k in
                      ("input_tokens", "output_tokens", "total_tokens",
                       "prompt_tokens", "completion_tokens", "total_tokens")
                      if usage.get(k) is not None}
            print(f"tokens  = {pretty or usage}")
            p_in = usage.get("input_tokens") or usage.get("prompt_tokens") or 0
            p_out = usage.get("output_tokens") or usage.get("completion_tokens") or 0
            from app.services.llm.pricing import estimate_cost
            cost = estimate_cost("higress", model, p_in, p_out)
            note = "" if cost > 0 else (
                "  ← 价目表无此模型条目（匿名/新模型），按 0 记；"
                "真实价格请查平台后补进 pricing.py"
            )
            print(f"cost(估) = {cost:.6f} 元{note}")
        assert usage, "no token usage in the response — billing would record zeros"

    def test_streaming(self, gateway_cfg):
        llm = build_platform_llm(purpose="real_test", streaming=True, temperature=0)
        prompt = "Count from 1 to 5."
        print(f"\nprompt  = {prompt!r}")
        print("chunks  = ", end="", flush=True)

        pieces: list[str] = []
        t0 = time.monotonic()
        for chunk in llm.stream(prompt):
            if chunk.content:
                pieces.append(chunk.content)
                print(chunk.content, end="", flush=True)
        latency = time.monotonic() - t0
        print()  # newline after streamed chunks

        joined = "".join(pieces).strip()
        print(f"stats   = {len(pieces)} chunks, {len(joined)} chars, {latency:.2f}s")
        assert pieces and joined


class TestRealEmbedding:
    def test_embedding_dimension_matches_milvus(self, gateway_cfg):
        # RED LINE: text-embedding-v4 must keep exactly the dimension Milvus
        # was built with (1024 by default) — a change forces a full rebuild.
        dims = int(_get("embedding", "dimension", default=1024))
        emb = OpenAIEmbeddings(
            api_key=gateway_cfg.api_key,
            base_url=gateway_cfg.base_url,
            model=settings.embedding_model,
            check_embedding_ctx_length=False,
        )
        vec = emb.embed_query("real connection test")
        print(f"\nmodel      = {settings.embedding_model}")
        print(f"dimension  = {len(vec)} (expect {dims})")
        print(f"vector[:5] = {[round(x, 6) for x in vec[:5]]}")
        assert len(vec) == dims
