"""SkillStoreClient - search GitHub for skill repos, download their skills.

Two-step marketplace:

1. ``list_repos(query)`` - GitHub Search API for repositories matching the
   query (falls back to ``topic:{topic}`` when no query). Returns repo
   metadata so the UI can show GitHub search results.
2. ``download_repo_skills(repo, branch)`` - read the repo's ``skills/``
   directory; each subdir is one skill (``SKILL.md`` + ``manifest.json``).
   Pack each into an in-memory zip for ``SkillManager.install`` to store
   in MinIO. Nothing is written to local disk.

Config (``config.skill_store``):
    topic   - GitHub topic used as the default search when no query (default
              "mindbase-skill")
    api_key - optional GitHub token (search API is tightly rate-limited when
              unauthenticated: 10/min vs 30/min authenticated)
"""

from __future__ import annotations

import base64
import logging
import time
from typing import Any, Optional

import httpx
from pydantic import BaseModel, ConfigDict

from app.infra.config import config
from app.skills.zip_parser import read_manifest

logger = logging.getLogger(__name__)


class StoreRepo(BaseModel):
    """A GitHub repository returned by the store search."""

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    full_name: str  # "owner/repo"
    description: str = ""
    stargazers_count: int = 0
    default_branch: str = "main"
    html_url: str = ""


class SkillStoreClient:
    """GitHub-search-backed skill store client."""

    API = "https://api.github.com"

    def __init__(
        self,
        topic: str = "mindbase-skill",
        token: str = "",
        timeout: int = 30,
        transport: Optional[httpx.AsyncBaseTransport] = None,
        cache_ttl: int = 300,
    ) -> None:
        self._topic = topic
        self._token = token
        self._timeout = timeout
        self._transport = transport
        # per-query result cache: key -> (fetched_at_monotonic, repos)
        # keeps us within GitHub Search rate limits (10/min unauth, 30/min auth)
        self._cache: dict[str, tuple[float, list[StoreRepo]]] = {}
        self._cache_ttl = cache_ttl

    @property
    def topic(self) -> str:
        return self._topic

    @property
    def enabled(self) -> bool:
        return True  # always can search GitHub (topic is just a default)

    def _headers(self) -> dict[str, str]:
        h: dict[str, str] = {"Accept": "application/vnd.github+json"}
        if self._token:
            h["Authorization"] = f"Bearer {self._token}"
        return h

    async def _get_json(
        self, client: httpx.AsyncClient, repo: str, branch: str, path: str
    ) -> Any:
        resp = await client.get(
            f"{self.API}/repos/{repo}/contents/{path}",
            params={"ref": branch},
            headers=self._headers(),
        )
        resp.raise_for_status()
        return resp.json()

    async def _read_file(
        self, client: httpx.AsyncClient, repo: str, branch: str, path: str
    ) -> str:
        data = await self._get_json(client, repo, branch, path)
        if isinstance(data, list):
            raise ValueError(f"expected file, got directory: {path}")
        if data.get("encoding") == "base64" and data.get("content") is not None:
            return base64.b64decode(data["content"]).decode("utf-8")
        return data.get("content", "")

    # ── search ─────────────────────────────────────────────────────────

    async def list_repos(self, query: str | None = None) -> list[StoreRepo]:
        """Search GitHub repos. Falls back to ``topic:{topic}`` when no query.

        Results are cached per-query for ``cache_ttl`` seconds (default 300s)
        to stay within GitHub Search rate limits.
        """
        key = (query or "").strip() or f"__topic__{self._topic}"
        now = time.monotonic()
        cached = self._cache.get(key)
        if cached is not None and now - cached[0] < self._cache_ttl:
            return cached[1]

        q = query.strip() if query and query.strip() else f"topic:{self._topic}"
        async with httpx.AsyncClient(timeout=self._timeout, transport=self._transport) as client:
            resp = await client.get(
                f"{self.API}/search/repositories",
                params={"q": q, "per_page": 30},
                headers=self._headers(),
            )
            resp.raise_for_status()
            items = resp.json().get("items", [])
        repos = [
            StoreRepo(
                full_name=it.get("full_name", ""),
                description=it.get("description") or "",
                stargazers_count=it.get("stargazers_count", 0),
                default_branch=it.get("default_branch", "main"),
                html_url=it.get("html_url", ""),
            )
            for it in items
            if it.get("full_name")
        ]
        self._cache[key] = (now, repos)
        return repos

    def invalidate_cache(self) -> None:
        """Drop all cached search results (e.g. after install/uninstall)."""
        self._cache.clear()

    # ── download ───────────────────────────────────────────────────────

    async def download_repo(
        self, repo: str, branch: str = "main"
    ) -> tuple[bytes, dict]:
        """Download the entire repo as a zip (GitHub zipball).

        The repo is treated as ONE skill pack (skill_id = repo name). Returns
        ``(zip_bytes, manifest)``. ``manifest.json`` is read from the zipball
        (top-level prefix supported by ``read_manifest``).
        """
        async with httpx.AsyncClient(timeout=self._timeout, transport=self._transport) as client:
            resp = await client.get(
                f"{self.API}/repos/{repo}/zipball/{branch}",
                headers=self._headers(),
                follow_redirects=True,
            )
            resp.raise_for_status()
            zip_bytes = resp.content
        manifest = read_manifest(zip_bytes)
        return zip_bytes, manifest

    async def get_contents(
        self, repo: str, path: str = "", branch: str = "main"
    ) -> dict:
        """List a directory or read a file in a repo (GitHub contents API).

        Lets the UI browse a repo before installing. Returns
        ``{"type": "dir", "entries": [{name, type, path, size}]}`` for a
        directory, or ``{"type": "file", "name", "path", "content"}`` for a
        file (content decoded to text).
        """
        async with httpx.AsyncClient(timeout=self._timeout, transport=self._transport) as client:
            data = await self._get_json(client, repo, branch, path or "")
        if isinstance(data, list):
            return {
                "type": "dir",
                "entries": [
                    {
                        "name": e.get("name", ""),
                        "type": e.get("type", "file"),
                        "path": e.get("path", ""),
                        "size": e.get("size", 0),
                    }
                    for e in data
                ],
            }
        content = ""
        if data.get("encoding") == "base64" and data.get("content") is not None:
            content = base64.b64decode(data["content"]).decode("utf-8")
        else:
            content = data.get("content", "") or ""
        return {
            "type": "file",
            "name": data.get("name", ""),
            "path": data.get("path", path),
            "content": content,
        }


# ── module-level singleton (lazy, config-driven) ──────────────────────────

_client: Optional[SkillStoreClient] = None


def get_skill_store_client() -> SkillStoreClient:
    """Return the process-wide SkillStoreClient built from config."""
    global _client
    if _client is None:
        sec = config.skill_store
        token = sec.api_key.get_secret_value() if sec.api_key else ""
        _client = SkillStoreClient(sec.topic, token, sec.timeout)
    return _client
