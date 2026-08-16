"""Parse a skill zip (from MinIO) into a Skill in-memory.

A skill zip contains:
    manifest.json   - {name, description, version, has_code_tools, entry, resources[]}
    SKILL.md        - instruction body (frontmatter optional; manifest wins)
    resources/      - optional reference resources
    tools/          - optional code tools, executed in the Daytona sandbox
                      (each file becomes a runnable script; manifest.entry
                      names the default entrypoint, default "main.py").

Code tools are parsed into Skill.code_tools (relpath -> source text) and
executed remotely by the run_skill_code tool - this module never writes
anything to disk, the zip is read entirely in memory.
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
    """One parsed skill - instructions + metadata (+ code tool sources).

    code_tools maps each file under tools/ to its source text
    (relpath without the tools/ prefix, e.g. {"main.py": "...",
    "utils.py": "..."}). entry is the default entrypoint filename
    (manifest entry or "main.py").
    """

    skill_id: str
    name: str
    description: str
    body: str  # SKILL.md instruction body (frontmatter stripped)
    has_code_tools: bool
    resources: list[str] = field(default_factory=list)
    manifest: dict = field(default_factory=dict)
    code_tools: dict[str, str] = field(default_factory=dict)
    entry: str | None = None


def parse_skill_zip(
    zip_bytes: bytes, *, skill_id: str, name: str, description: str = ""
) -> Skill:
    """Parse a skill zip archive into a Skill.

    skill_id / name / description come from the installed_skills row
    (manifest is source of truth for metadata); the zip own manifest.json
    provides has_code_tools / entry / resources. Files under tools/ are
    decoded as text into Skill.code_tools.
    """
    has_code_tools = False
    resources: list[str] = []
    manifest: dict = {}
    body = ""
    code_tools: dict[str, str] = {}
    entry: str | None = None

    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        names = zf.namelist()
        m_entry = _find_entry(names, "manifest.json")
        if m_entry is not None:
            try:
                manifest = json.loads(zf.read(m_entry).decode("utf-8"))
                has_code_tools = bool(manifest.get("has_code_tools", False))
                resources = list(manifest.get("resources", []))
                entry = manifest.get("entry") or None
            except Exception:
                logger.exception("[SKILLS] bad manifest.json in %s", skill_id)
        s_entry = _find_entry(names, "SKILL.md")
        if s_entry is not None:
            text = zf.read(s_entry).decode("utf-8")
            body = _strip_frontmatter(text)
        code_tools = _extract_code_tools(names, zf)
        if code_tools:
            has_code_tools = True

    return Skill(
        skill_id=skill_id,
        name=name,
        description=description,
        body=body,
        has_code_tools=has_code_tools,
        resources=resources,
        manifest=manifest,
        code_tools=code_tools,
        entry=entry,
    )


def _extract_code_tools(names: list[str], zf: zipfile.ZipFile) -> dict[str, str]:
    """Extract tools/ files as text: relpath (no tools/ prefix) -> source.

    Supports both flat zips (tools/main.py) and GitHub zipballs
    (owner-repo-sha/tools/main.py under a top-level prefix dir). Only
    text files are decoded; un-decodable entries are skipped with a warning.
    """
    code_tools: dict[str, str] = {}
    for n in names:
        if n.endswith("/"):
            continue  # directory entry
        if "/tools/" not in n and not n.startswith("tools/"):
            continue
        rel = n.split("/tools/", 1)[1] if "/tools/" in n else n[len("tools/") :]
        if not rel:
            continue
        try:
            code_tools[rel] = zf.read(n).decode("utf-8")
        except Exception:
            logger.warning("[SKILLS] skip non-text code tool %s", n)
    return code_tools


def _find_entry(names: list[str], target: str) -> str | None:
    """Find the zip entry closest to the root matching *target* filename.

    Supports both flat zips (SKILL.md at root) and GitHub zipballs
    (owner-repo-sha/SKILL.md under a top-level prefix dir). When several
    entries match, the shortest path wins (root preferred over nested).
    """
    matches = [n for n in names if n == target or n.endswith("/" + target)]
    if not matches:
        return None
    return min(matches, key=len)


def _strip_frontmatter(text: str) -> str:
    """Drop a leading ---\n...\n--- YAML frontmatter block."""
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) >= 3:
            return parts[2].lstrip("\n")
    return text


def read_manifest(zip_bytes: bytes) -> dict:
    """Read just manifest.json from a skill zip (for the install endpoint).

    Returns {} when the archive has no manifest. Used to extract
    skill_id / name / description / version / has_code_tools
    before persisting the row. Supports GitHub zipball layout (manifest
    under a top-level prefix dir).
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

    Returns {"files": [...], "manifest": dict, "body": str,
    "code_tools": [relpath...], "entry": str|None} where body is the
    SKILL.md content (frontmatter stripped) and code_tools lists the
    runnable files under tools/. Used by the preview endpoint.
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
        code_tools = _extract_code_tools(names, zf)
    return {
        "files": files,
        "manifest": manifest,
        "body": body,
        "code_tools": sorted(code_tools.keys()),
        "entry": manifest.get("entry") or None,
    }


def build_skill_zip(
    *,
    skill_md: str,
    manifest: dict,
    resources: dict[str, bytes] | None = None,
    code_tools: dict[str, str] | None = None,
) -> bytes:
    """Build a skill zip in memory (used by tests and the upload endpoint)."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("SKILL.md", skill_md)
        zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False))
        for fname, data in (resources or {}).items():
            zf.writestr("resources/" + fname, data)
        for rel, src in (code_tools or {}).items():
            zf.writestr("tools/" + rel, src)
    return buf.getvalue()
