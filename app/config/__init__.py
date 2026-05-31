# app/config/__init__.py
"""
Application configuration package.

Usage (unchanged from before):
    from app.config import settings, ensure_directories
    print(settings.llm_model)

For direct access to the raw config dict:
    from app.config import get_config
    cfg = get_config()
    print(cfg["llm"]["model"])
"""

from app.config.loader import get_config, load_config
from app.config.settings import settings, ensure_directories

__all__ = [
    "get_config",
    "load_config",
    "settings",
    "ensure_directories",
]
