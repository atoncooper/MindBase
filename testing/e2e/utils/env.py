"""Environment helper: typed access to .env values."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv

_BASE = Path(__file__).resolve().parent.parent
load_dotenv(_BASE / ".env")


def get_env(key: str, default: Optional[str] = None) -> Optional[str]:
    return os.getenv(key, default)


def get_env_int(key: str, default: int = 0) -> int:
    try:
        return int(os.getenv(key, str(default)))
    except (TypeError, ValueError):
        return default


def get_env_list(key: str, default: Optional[list[str]] = None) -> list[str]:
    raw = os.getenv(key, "")
    if not raw:
        return default or []
    return [x.strip() for x in raw.split(",") if x.strip()]
