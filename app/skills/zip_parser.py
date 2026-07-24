"""Parse a skill zip (from MinIO) into a Skill in-memory.

A skill zip contains:
    manifest.json   - {name, description, version, has_code_tools, resources[]}
    SKILL.md        - instruction body (frontmatter optional; manifest wins)
    resources/      - optional reference resources
    tools/          - optional code tools (NOT executed yet - sandbox pending)

Nothing is written to disk. The zip is read entirely in memory.
"""

from __future__ import annotations

import io
import json
import logging
import zipfile
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Skill:
    """One parsed skill - instructions + metadata, no code execution."""

    skill_id: str
    name: str
    description: str
    body: str  # SKILL.md instruction body (frontmatter stripped)
    has_code_tools: bool
    resources: list[str] = field(default_factory=list)
    manifest: dict = field(default_factory=dict)


def parse_skill_zip(
    zip_bytes: bytes, *, skill_id: str, name: str, description: str = ""
) -> Skill:
    """Parse a skill zip archive into a :class:`Skill`.

    ``skill_id`` / ``name`` / ``description`` come from the installed_skills
    row (manifest is source of truth for metadata); the zip's own
    ``manifest.json`` provides ``has_code_tools`` / ``resources``.
    """
    has_code_tools = False
    resources: list[str] = []
    manifest: dict = {}
    body = ""

    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        names = zf.namelist()
        m_entry = _find_entry(names, "manifest.json")
        if m_entry is not None:
            try:
                manifest = json.loads(zf.read(m_entry).decode("utf-8"))
                has_code_tools = bool(manifest.get("has_code_tools", False))
                resources = list(manifest.get("resources", []))
            except Exception:
                logger.exception("[SKILLS] bad manifest.json in %s", skill_id)
        s_entry = _find_entry(names, "SKILL.md")
        if s_entry is not None:
            text = zf.read(s_entry).decode("utf-8")
            body = _strip_frontmatter(text)

    return Skill(
        skill_id=skill_id,
        name=name,
        description=description,
        body=body,
        has_code_tools=has_code_tools,
        resources=resources,
        manifest=manifest,
    )


def _find_entry(names: list[str], target: str) -> str | None:
    """Find the zip entry closest to the root matching *target* filename.

    Supports both flat zips (``SKILL.md`` at root) and GitHub zipballs
    (``owner-repo-sha/SKILL.md`` under a top-level prefix dir). When several
    entries match, the shortest path wins (root preferred over nested).
    """
    matches = [n for n in names if n == target or n.endswith(f"/{target}")]
    if not matches:
        return None
    return min(matches, key=len)


def _strip_frontmatter(text: str) -> str:
    """Drop a leading ``---\\n...\\n---`` YAML frontmatter block."""
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) >= 3:
            return parts[2].lstrip("\n")
    return text


def read_manifest(zip_bytes: bytes) -> dict:
    """Read just ``manifest.json`` from a skill zip (for the install endpoint).

    Returns ``{}`` when the archive has no manifest. Used to extract
    ``skill_id`` / ``name`` / ``description`` / ``version`` / ``has_code_tools``
    before persisting the row. Supports GitHub zipball layout (manifest under
    a top-level prefix dir).
    """
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        m_entry = _find_entry(zf.namelist(), "manifest.json")
        if m_entry is not None:
            try:
                return json.loads(zf.read(m_entry).decode("utf-8"))
            except Exception:
                logger.exception("[SKILLS] bad manifest.json")
                return {}
    return {}


def inspect_zip(zip_bytes: bytes) -> dict:
    """Inspect an installed skill zip without writing to disk.

    Returns ``{"files": [{name, path, size}], "manifest": dict, "body": str}``
    where ``body`` is the SKILL.md content (frontmatter stripped) and
    ``files`` lists every file in the archive. Used by the preview endpoint.
    """
    files: list[dict] = []
    manifest: dict = {}
    body = ""
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        names = zf.namelist()
        for n in names:
            if n.endswith("/"):
                continue  # directory entry
            info = zf.getinfo(n)
            files.append(
                {"name": n.rsplit("/", 1)[-1], "path": n, "size": info.file_size}
            )
        m_entry = _find_entry(names, "manifest.json")
        if m_entry is not None:
            try:
                manifest = json.loads(zf.read(m_entry).decode("utf-8"))
            except Exception:
                logger.exception("[SKILLS] bad manifest.json in inspect")
        s_entry = _find_entry(names, "SKILL.md")
        if s_entry is not None:
            body = _strip_frontmatter(zf.read(s_entry).decode("utf-8"))
    return {"files": files, "manifest": manifest, "body": body}


def build_skill_zip(
    *, skill_md: str, manifest: dict, resources: dict[str, bytes] | None = None
) -> bytes:
    """Build a skill zip in memory (used by tests and the upload endpoint)."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("SKILL.md", skill_md)
        zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False))
        for fname, data in (resources or {}).items():
            zf.writestr(f"resources/{fname}", data)
    return buf.getvalue()
