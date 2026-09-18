# app/test/llm/conftest.py
"""Test configuration for the llm test package.

Registers the ``real_llm`` marker. Tests marked ``real_llm`` hit the REAL
Higress AI gateway (network + token cost) and are skipped unless explicitly
opted in — either via the ``--real-llm`` flag or ``MB_REAL_LLM=1``:

    # cross-shell (works in PowerShell / cmd / bash):
    pytest app/test/llm/test_real_llm.py -m real_llm -v -s --real-llm

    # or via environment variable:
    bash:       MB_REAL_LLM=1 pytest ...
    powershell: $env:MB_REAL_LLM = "1"; pytest ...
"""

import os

import pytest


def pytest_addoption(parser):
    parser.addoption(
        "--real-llm",
        action="store_true",
        default=False,
        help="run real-gateway LLM tests (network + token cost)",
    )


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "real_llm: hits the real Higress AI gateway (network + token cost); "
        "opt-in via --real-llm or MB_REAL_LLM=1",
    )
    # Test-infrastructure noise (not app leaks) — message-targeted ignores:
    # - pytest-asyncio 0.21 leaves its per-test ProactorEventLoop to the GC
    #   on Python 3.12;
    # - scheduling branches create AsyncMock coroutines as call arguments
    #   that are intentionally never awaited.
    config.addinivalue_line(
        "filterwarnings", "ignore:unclosed event loop:ResourceWarning"
    )
    config.addinivalue_line(
        "filterwarnings",
        "ignore:coroutine 'AsyncMockMixin._execute_mock_call' was never awaited:RuntimeWarning",
    )


def pytest_collection_modifyitems(config, items):
    enabled = config.getoption("--real-llm") or os.getenv("MB_REAL_LLM") == "1"
    if enabled:
        return
    skip_real = pytest.mark.skip(
        reason="real-gateway test costs tokens — opt in with --real-llm "
               "(or MB_REAL_LLM=1)"
    )
    for item in items:
        if "real_llm" in item.keywords:
            item.add_marker(skip_real)
