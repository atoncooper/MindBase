"""
ConfigTester — minimal API connectivity test for LLM, Embedding, and ASR.

Each test sends the smallest possible payload to verify credentials.
Results are returned as TestResult dataclasses (never written to DB here).
"""

import asyncio
import time
from dataclasses import dataclass
from typing import Optional

import httpx
from loguru import logger
from openai import AuthenticationError

from app.security.url_validation import validate_public_http_url


@dataclass
class TestResult:
    status: str  # "ok" | "error"
    error: Optional[str] = None  # human-readable (Chinese)
    latency_ms: float = 0.0


class ConfigTester:
    """Test API connectivity with minimal token consumption."""

    LLM_TEST_TIMEOUT = 8.0
    EMBEDDING_TEST_TIMEOUT = 8.0
    ASR_TEST_TIMEOUT = 5.0

    # ── LLM ────────────────────────────────────────────────────

    async def test_llm(self, api_key: str, base_url: str, model: str) -> TestResult:
        """Send 'Hi' with max_tokens=5. ~3-5 tokens consumed."""
        from langchain_core.messages import HumanMessage
        from langchain_openai import ChatOpenAI

        t0 = time.time()
        try:
            base_url = validate_public_http_url(base_url)
            if base_url is None:
                return TestResult(status="error", error="API 地址不能为空")
            llm = ChatOpenAI(
                api_key=api_key,
                base_url=base_url,
                model=model,
                temperature=0,
                max_tokens=5,
                max_completion_tokens=5,
                request_timeout=self.LLM_TEST_TIMEOUT,
            )
            response = await asyncio.wait_for(
                llm.ainvoke([HumanMessage(content="Hi")]),
                timeout=self.LLM_TEST_TIMEOUT,
            )
            latency = (time.time() - t0) * 1000
            content = (
                response.content if hasattr(response, "content") else str(response)
            )
            if not content or len(str(content).strip()) == 0:
                return TestResult(
                    status="error", error="API 返回了空响应", latency_ms=latency
                )
            logger.info(
                f"[CONFIG_TESTER] LLM test ok model={model} latency={latency:.0f}ms"
            )
            return TestResult(status="ok", latency_ms=latency)

        except asyncio.TimeoutError:
            return TestResult(
                status="error",
                error="连接超时，请检查 API 地址或网络",
                latency_ms=(time.time() - t0) * 1000,
            )
        except AuthenticationError:
            return TestResult(
                status="error",
                error="API Key 无效，请检查密钥是否正确",
                latency_ms=(time.time() - t0) * 1000,
            )
        except Exception as e:
            msg = str(e)
            if (
                "401" in msg
                or "403" in msg
                or "unauthorized" in msg.lower()
                or "invalid_api_key" in msg.lower()
            ):
                hint = "API Key 无效，请检查密钥是否正确"
            elif "timeout" in msg.lower() or "timed out" in msg.lower():
                hint = "连接超时，请检查 API 地址或网络"
            elif (
                "connection" in msg.lower()
                or "refused" in msg.lower()
                or "unreachable" in msg.lower()
            ):
                hint = f"无法连接到 API 端点: {base_url}"
            elif "not found" in msg.lower() or "404" in msg:
                hint = f"API 端点不存在 (404): {base_url}"
            else:
                hint = msg[:200]
            return TestResult(
                status="error", error=hint, latency_ms=(time.time() - t0) * 1000
            )

    # ── Embedding ──────────────────────────────────────────────

    async def test_embedding(
        self, api_key: str, base_url: str, model: str
    ) -> TestResult:
        """Embed the word 'test'. 1 token consumed."""
        from langchain_openai import OpenAIEmbeddings

        t0 = time.time()
        try:
            base_url = validate_public_http_url(base_url)
            if base_url is None:
                return TestResult(status="error", error="API 地址不能为空")
            embeddings = OpenAIEmbeddings(
                api_key=api_key,
                base_url=base_url,
                model=model,
                check_embedding_ctx_length=False,
                request_timeout=self.EMBEDDING_TEST_TIMEOUT,
            )
            vectors = await asyncio.wait_for(
                embeddings.aembed_query("test"),
                timeout=self.EMBEDDING_TEST_TIMEOUT,
            )
            latency = (time.time() - t0) * 1000
            if not vectors or len(vectors) == 0:
                return TestResult(
                    status="error", error="API 返回了空向量", latency_ms=latency
                )
            logger.info(
                f"[CONFIG_TESTER] Embedding test ok model={model} dims={len(vectors)} latency={latency:.0f}ms"
            )
            return TestResult(status="ok", latency_ms=latency)

        except asyncio.TimeoutError:
            return TestResult(
                status="error",
                error="连接超时，请检查 API 地址或网络",
                latency_ms=(time.time() - t0) * 1000,
            )
        except AuthenticationError:
            return TestResult(
                status="error",
                error="API Key 无效，请检查密钥是否正确",
                latency_ms=(time.time() - t0) * 1000,
            )
        except Exception as e:
            msg = str(e)
            if "401" in msg or "403" in msg or "unauthorized" in msg.lower():
                hint = "API Key 无效，请检查密钥是否正确"
            elif "timeout" in msg.lower():
                hint = "连接超时，请检查 API 地址或网络"
            elif "connection" in msg.lower() or "refused" in msg.lower():
                hint = f"无法连接到 API 端点: {base_url}"
            else:
                hint = msg[:200]
            return TestResult(
                status="error", error=hint, latency_ms=(time.time() - t0) * 1000
            )

    # ── ASR ────────────────────────────────────────────────────

    async def test_asr(self, api_key: str, base_url: str) -> TestResult:
        """HTTP HEAD to the ASR API base URL. 0 tokens consumed."""
        t0 = time.time()
        headers = {"Authorization": f"Bearer {api_key}"}
        try:
            base_url = validate_public_http_url(base_url)
            if base_url is None:
                return TestResult(status="error", error="API 地址不能为空")
            async with httpx.AsyncClient(timeout=self.ASR_TEST_TIMEOUT) as client:
                resp = await client.get(base_url.rstrip("/"), headers=headers)
                latency = (time.time() - t0) * 1000

                if resp.status_code in (200, 401, 403):
                    # 401/403 means the server is reachable but the key is invalid —
                    # that's still a useful signal：the endpoint is correct, the key may be wrong
                    if resp.status_code == 200:
                        return TestResult(status="ok", latency_ms=latency)
                    else:
                        return TestResult(
                            status="error",
                            error=f"ASR API 认证失败 (HTTP {resp.status_code})，请检查 API Key",
                            latency_ms=latency,
                        )
                # 404 or other: endpoint likely wrong
                return TestResult(
                    status="error",
                    error=f"ASR API 端点不存在 (HTTP {resp.status_code})，请检查 API 地址",
                    latency_ms=latency,
                )
        except httpx.TimeoutException:
            return TestResult(
                status="error",
                error="连接超时，请检查 API 地址或网络",
                latency_ms=(time.time() - t0) * 1000,
            )
        except httpx.ConnectError:
            return TestResult(
                status="error",
                error=f"无法连接到 ASR API 端点: {base_url}",
                latency_ms=(time.time() - t0) * 1000,
            )
        except Exception as e:
            return TestResult(
                status="error",
                error=f"连接失败: {str(e)[:200]}",
                latency_ms=(time.time() - t0) * 1000,
            )
