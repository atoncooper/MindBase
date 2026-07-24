"""Tests for SkillStoreClient - GitHub repo search + skill download.

Uses httpx.MockTransport so no real network is hit. The mock imitates:
  - /search/repositories  -> {items: [{full_name, description, ...}]}
  - /repos/{repo}/contents/{path}  -> directory listing or base64 file
"""

from __future__ import annotations

import base64
import io
import json
import zipfile

import httpx
import pytest

from app.skills.store.client import SkillStoreClient, StoreRepo
from app.skills.zip_parser import build_skill_zip

REPO1 = "owner1/skills-repo"


def _file_response(content: str) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "type": "file",
            "encoding": "base64",
            "content": base64.b64encode(content.encode("utf-8")).decode("ascii"),
            "path": "x",
        },
    )


def _dir_response(items: list[dict]) -> httpx.Response:
    return httpx.Response(200, json=items)


def _search_response(repos: list[dict]) -> httpx.Response:
    return httpx.Response(200, json={"items": repos})


class TestSkillStoreClient:
    @pytest.mark.asyncio
    async def test_list_repos_with_query(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/search/repositories"):
                assert request.url.params["q"] == "apple"
                return _search_response(
                    [
                        {
                            "full_name": REPO1,
                            "description": "apple skill repo",
                            "stargazers_count": 42,
                            "default_branch": "main",
                            "html_url": "https://github.com/owner1/skills-repo",
                        }
                    ]
                )
            return httpx.Response(404)

        client = SkillStoreClient(transport=httpx.MockTransport(handler))
        repos = await client.list_repos("apple")
        assert len(repos) == 1
        assert repos[0].full_name == REPO1
        assert repos[0].stargazers_count == 42
        assert repos[0].html_url == "https://github.com/owner1/skills-repo"

    @pytest.mark.asyncio
    async def test_list_repos_no_query_falls_back_to_topic(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/search/repositories"):
                assert request.url.params["q"] == "topic:mindbase-skill"
                return _search_response([])
            return httpx.Response(404)

        client = SkillStoreClient(topic="mindbase-skill", transport=httpx.MockTransport(handler))
        assert await client.list_repos() == []

    @pytest.mark.asyncio
    async def test_list_repos_ignores_items_without_full_name(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/search/repositories"):
                return _search_response(
                    [{"full_name": REPO1}, {"description": "no name"}]
                )
            return httpx.Response(404)

        client = SkillStoreClient(transport=httpx.MockTransport(handler))
        repos = await client.list_repos("x")
        assert len(repos) == 1
        assert repos[0].full_name == REPO1

    @pytest.mark.asyncio
    async def test_list_repos_caches_within_ttl(self) -> None:
        call_count = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal call_count
            if request.url.path.endswith("/search/repositories"):
                call_count += 1
                return _search_response([{"full_name": REPO1, "default_branch": "main"}])
            return httpx.Response(404)

        client = SkillStoreClient(transport=httpx.MockTransport(handler), cache_ttl=300)
        r1 = await client.list_repos("apple")
        r2 = await client.list_repos("apple")
        assert call_count == 1  # second served from cache
        assert r1 == r2

    @pytest.mark.asyncio
    async def test_list_repos_cache_separate_per_query(self) -> None:
        queries: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/search/repositories"):
                queries.append(request.url.params["q"])
                return _search_response([{"full_name": REPO1}])
            return httpx.Response(404)

        client = SkillStoreClient(transport=httpx.MockTransport(handler), cache_ttl=300)
        await client.list_repos("apple")
        await client.list_repos("banana")
        assert queries == ["apple", "banana"]  # separate cache keys

    @pytest.mark.asyncio
    async def test_list_repos_invalidate_cache_refetches(self) -> None:
        call_count = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal call_count
            if request.url.path.endswith("/search/repositories"):
                call_count += 1
                return _search_response([{"full_name": REPO1}])
            return httpx.Response(404)

        client = SkillStoreClient(transport=httpx.MockTransport(handler), cache_ttl=300)
        await client.list_repos("apple")
        client.invalidate_cache()
        await client.list_repos("apple")
        assert call_count == 2  # cache cleared -> re-fetched

    @pytest.mark.asyncio
    async def test_download_repo_returns_zip_and_manifest(self) -> None:
        zip_bytes = build_skill_zip(
            skill_md="# Apple Skills\n24 sub-packs",
            manifest={"skill_id": "apple-skills", "name": "Apple Skills", "has_code_tools": False},
        )

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == f"/repos/{REPO1}/zipball/main":
                return httpx.Response(200, content=zip_bytes)
            return httpx.Response(404)

        client = SkillStoreClient(transport=httpx.MockTransport(handler))
        data, manifest = await client.download_repo(REPO1, "main")
        assert data == zip_bytes
        assert manifest["name"] == "Apple Skills"

    @pytest.mark.asyncio
    async def test_download_repo_finds_manifest_under_zipball_prefix(self) -> None:
        """GitHub zipball wraps files under a top-level owner-repo-sha/ dir."""
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr(
                "owner1-skills-repo-abcd123/manifest.json",
                json.dumps({"skill_id": "apple-skills", "name": "Apple"}),
            )
            zf.writestr("owner1-skills-repo-abcd123/SKILL.md", "# Apple\nbody")
        zip_bytes = buf.getvalue()

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == f"/repos/{REPO1}/zipball/main":
                return httpx.Response(200, content=zip_bytes)
            return httpx.Response(404)

        client = SkillStoreClient(transport=httpx.MockTransport(handler))
        _, manifest = await client.download_repo(REPO1, "main")
        assert manifest["name"] == "Apple"

    @pytest.mark.asyncio
    async def test_download_repo_raises_on_404(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(404)

        client = SkillStoreClient(transport=httpx.MockTransport(handler))
        with pytest.raises(httpx.HTTPStatusError):
            await client.download_repo(REPO1, "main")

    @pytest.mark.asyncio
    async def test_get_contents_returns_dir_entries(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == f"/repos/{REPO1}/contents/skills":
                return _dir_response(
                    [
                        {"name": "video-summary", "type": "dir", "path": "skills/video-summary", "size": 0},
                        {"name": "SKILL.md", "type": "file", "path": "skills/SKILL.md", "size": 100},
                    ]
                )
            return httpx.Response(404)

        client = SkillStoreClient(transport=httpx.MockTransport(handler))
        result = await client.get_contents(REPO1, "skills", "main")
        assert result["type"] == "dir"
        assert len(result["entries"]) == 2
        assert result["entries"][0]["name"] == "video-summary"
        assert result["entries"][0]["type"] == "dir"

    @pytest.mark.asyncio
    async def test_get_contents_returns_file_content(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == f"/repos/{REPO1}/contents/skills/SKILL.md":
                return _file_response("# Title\nbody")
            return httpx.Response(404)

        client = SkillStoreClient(transport=httpx.MockTransport(handler))
        result = await client.get_contents(REPO1, "skills/SKILL.md", "main")
        assert result["type"] == "file"
        assert "body" in result["content"]

    @pytest.mark.asyncio
    async def test_get_contents_root_when_path_empty(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            # path="" -> /contents/ (root); accept either form
            p = request.url.path
            if p in (f"/repos/{REPO1}/contents/", f"/repos/{REPO1}/contents"):
                return _dir_response(
                    [{"name": "skills", "type": "dir", "path": "skills", "size": 0}]
                )
            return httpx.Response(404)

        client = SkillStoreClient(transport=httpx.MockTransport(handler))
        result = await client.get_contents(REPO1, "", "main")
        assert result["type"] == "dir"
        assert len(result["entries"]) == 1

    def test_enabled_always_true(self) -> None:
        assert SkillStoreClient().enabled is True

    def test_token_header(self) -> None:
        client = SkillStoreClient(token="ghp_x")
        assert client._headers()["Authorization"] == "Bearer ghp_x"

    def test_store_repo_parses_fields(self) -> None:
        r = StoreRepo(
            full_name="o/r",
            description="d",
            stargazers_count=5,
            default_branch="main",
            html_url="u",
            extra="ignored",  # type: ignore[call-arg]
        )
        assert r.full_name == "o/r"
        assert r.stargazers_count == 5
