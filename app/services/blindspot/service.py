"""BlindspotService - knowledge blind-spot map aggregation (Plan 1.0.6).

Read-only side service: aggregates learning signals (exposure / verification
/ probing) per KG entity into quadrant profiles. Writes no business data.
If Neo4j / MySQL / Mongo is missing, the corresponding signal degrades to
empty; with Neo4j entirely down the map reports available=False (the graph
is the skeleton of the map — without it there is nothing to show).
"""

from __future__ import annotations

from typing import Any

from loguru import logger
from sqlalchemy import select

from app.infra.neo4j import is_enabled as neo4j_ok
from app.repository.kg_graph_repository import (
    get_kg_graph_repository,
    normalize_name,
)

# Recent user messages scanned for the probed signal (guards full scans)
_PROBED_SCAN_LIMIT = 300
# Entity cap for the map response (head of the exposure ranking)
_MAX_ENTITIES = 500


class BlindspotService:
    """Blind-spot map: overview + entity detail + quiz scope resolution."""

    def __init__(self) -> None:
        self._graph = get_kg_graph_repository()

    # ------------------------------------------------------------------
    # Availability
    # ------------------------------------------------------------------

    def is_available(self) -> bool:
        return neo4j_ok()

    # ------------------------------------------------------------------
    # Overview map
    # ------------------------------------------------------------------

    async def map(self, uid: int, folder_ids: list[int] | None = None) -> dict[str, Any]:
        """Aggregate signals and return the five-quadrant entity lists."""
        empty = {
            "available": self.is_available(),
            "scope_bvids": 0,
            "quadrants": {q: [] for q in (
                "danger",
                "blind",
                "learning",
                "familiar",
                "unexplored",
            )},
            "stats": {},
        }
        if not self.is_available():
            return empty

        bvids = await self._resolve_bvids(uid, folder_ids)
        if not bvids:
            return empty
        empty["scope_bvids"] = len(bvids)

        rows = await self._graph.entity_exposure(bvids, limit=_MAX_ENTITIES)
        if not rows:
            return empty

        quiz_by_name = await self._quiz_signals(uid, rows)
        probed_names = await self._probed_names(uid, rows)

        from app.services.blindspot.scoring import QUADRANTS, classify, priority

        grouped: dict[str, list[dict[str, Any]]] = {q: [] for q in QUADRANTS}
        counts: dict[str, int] = {q: 0 for q in QUADRANTS}

        for row in rows:
            name_key = normalize_name(row.get("name", ""))
            sig = quiz_by_name.get(name_key) or {"total": 0, "correct": 0, "wrong": 0}
            total = sig["total"]
            correct = sig["correct"]
            wrong = sig["wrong"]
            rate = (correct / total) if total > 0 else None
            quadrant = classify(
                exposure=int(row.get("pages", 0)),
                quiz_total=total,
                correct_rate=rate,
                probed=name_key in probed_names,
            )
            item = {
                "eid": row.get("eid", ""),
                "name": row.get("name", ""),
                "type": row.get("type", ""),
                "description": row.get("description") or "",
                "exposure": int(row.get("pages", 0)),
                "evidence_sample": row.get("evidence_sample") or [],
                "quiz_total": total,
                "quiz_correct": correct,
                "quiz_wrong": wrong,
                "probed": name_key in probed_names,
                "priority": priority(
                    int(row.get("pages", 0)), correct, wrong
                ),
            }
            grouped[quadrant].append(item)
            counts[quadrant] += 1

        for items in grouped.values():
            items.sort(key=lambda x: (-x["priority"], -x["exposure"], x["name"]))

        return {
            "available": True,
            "scope_bvids": len(bvids),
            "quadrants": grouped,
            "stats": {
                "total_entities": sum(counts.values()),
                **counts,
            },
        }

    # ------------------------------------------------------------------
    # Entity detail
    # ------------------------------------------------------------------

    async def entity_detail(
        self, uid: int, eid: str
    ) -> dict[str, Any] | None:
        """Single entity: base info + review path (titled appearances) + quiz stats."""
        if not self.is_available():
            return None
        base = await self._graph.entities_by_eids([eid])
        if not base:
            return None
        ent = base[0]

        bvids = await self._resolve_bvids(uid, None)
        appearances = await self._graph.entity_appearances(eid, bvids)
        titles = await self._page_titles(
            [(a["bvid"], int(a.get("page_index") or 0)) for a in appearances]
        )

        path = [
            {
                "bvid": a["bvid"],
                "page_index": int(a.get("page_index") or 0),
                "quote": (a.get("quote") or "").strip(),
                "title": titles.get((a["bvid"], int(a.get("page_index") or 0)), a["bvid"]),
            }
            for a in appearances
        ]

        quiz_by_name = await self._quiz_signals(uid, [ent])
        sig = quiz_by_name.get(normalize_name(ent.get("name", ""))) or {
            "total": 0,
            "correct": 0,
            "wrong": 0,
        }

        return {
            "eid": ent.get("eid", ""),
            "name": ent.get("name", ""),
            "type": ent.get("type", ""),
            "description": ent.get("description") or "",
            "exposure": len(path),
            "review_path": path,
            "quiz_total": sig["total"],
            "quiz_correct": sig["correct"],
            "quiz_wrong": sig["wrong"],
        }

    # ------------------------------------------------------------------
    # Quiz scope resolution (router drives the existing quiz pipeline)
    # ------------------------------------------------------------------

    async def entity_quiz_pages(
        self, uid: int, eid: str, question_count: int
    ) -> dict[str, Any] | None:
        """Entity -> source pages shaped like QuizSet.source_pages.

        Returns None when the entity does not exist; pages=[] means the entity
        has no appearance within the user's scope.
        """
        if not self.is_available():
            return None
        base = await self._graph.entities_by_eids([eid])
        if not base:
            return None

        bvids = await self._resolve_bvids(uid, None)
        appearances = await self._graph.entity_appearances(eid, bvids)
        if not appearances:
            return {
                "entity": base[0],
                "pages": [],
                "message": "该实体在你的收藏范围内没有视频出处，无法出题",
            }

        cid_map = await self._cid_pages(sorted({a["bvid"] for a in appearances}))
        titles = await self._page_titles(list(cid_map.keys()))

        pages = []
        for a in appearances:
            key = (a["bvid"], int(a.get("page_index") or 0))
            meta = cid_map.get(key)
            if meta is None:
                continue
            pages.append(
                {
                    "bvid": a["bvid"],
                    "cid": meta["cid"],
                    "page_index": key[1],
                    "page_title": meta["page_title"]
                    or titles.get(key, f"P{key[1] + 1}"),
                }
            )
        # Trim pages above ~2x question count so retrieval is not diluted
        pages = pages[: max(question_count * 2, question_count)]
        return {"entity": base[0], "pages": pages, "message": ""}

    # ------------------------------------------------------------------
    # Signal collection internals
    # ------------------------------------------------------------------

    async def _resolve_bvids(
        self, uid: int, folder_ids: list[int] | None
    ) -> list[str]:
        """Folder scope resolution (reuses chat scope helpers; pure DB reads)."""
        from app.database import get_db_context
        from app.services.chat.scope import (
            get_bvids_by_media_ids,
            get_media_ids_for_uid,
        )

        try:
            async with get_db_context() as db:
                media_ids = await get_media_ids_for_uid(db, uid, folder_ids or None)
                if not media_ids:
                    return []
                return await get_bvids_by_media_ids(db, media_ids)
        except Exception as e:
            logger.warning("[BLINDSPOT] scope resolve failed uid={}: {}", uid, e)
            return []

    async def _quiz_signals(
        self, uid: int, entity_rows: list[dict[str, Any]]
    ) -> dict[str, dict[str, int]]:
        """Merge quiz answers per entity name via normalize_name keys.

        Chain: MySQL submissions -> answer details -> Mongo question tags
        (scheme A); untagged legacy questions fall back to Milvus attribution
        (scheme B). Any broken hop only loses that signal.
        """
        out: dict[str, dict[str, int]] = {}
        try:
            sub_quiz = await self._user_submissions(uid)
            if not sub_quiz:
                return out

            answers = await self._submission_answers(list(sub_quiz.keys()))
            if not answers:
                return out

            quiz_uuids = sorted(set(sub_quiz.values()))
            from app.repository import mongo_quiz_repository as mongo_quiz

            attrs = {
                a["question_uuid"]: a
                for a in await mongo_quiz.get_question_attributions(quiz_uuids)
            }

            attributor = self._get_attributor()
            for ans in answers:
                attr = attrs.get(ans["question_uuid"])
                names: list[str] = []
                if attr is not None and attr["related_entities"]:
                    names = attr["related_entities"]
                elif attributor.available and attr is not None:
                    names = await attributor.attribute(attr["question_text"])
                for n in names:
                    slot = out.setdefault(
                        normalize_name(n), {"total": 0, "correct": 0, "wrong": 0}
                    )
                    slot["total"] += 1
                    if ans["is_correct"]:
                        slot["correct"] += 1
                    else:
                        slot["wrong"] += 1
        except Exception as e:
            logger.warning("[BLINDSPOT] quiz signal aggregation failed: {}", e)
        return out

    @staticmethod
    async def _user_submissions(uid: int) -> dict[str, str]:
        """uid -> {submission_uuid: quiz_uuid}."""
        from app.database import get_db_context
        from app.models import QuizSubmission

        async with get_db_context() as db:
            rows = await db.execute(
                select(
                    QuizSubmission.submission_uuid, QuizSubmission.quiz_uuid
                ).where(QuizSubmission.uid == uid)
            )
            return {r[0]: r[1] for r in rows.fetchall() if r[0]}

    @staticmethod
    async def _submission_answers(
        submission_uuids: list[str],
    ) -> list[dict[str, Any]]:
        from app.database import get_db_context
        from app.models import QuizAnswer

        chunk_size = 200
        results: list[dict[str, Any]] = []
        async with get_db_context() as db:
            for i in range(0, len(submission_uuids), chunk_size):
                chunk = submission_uuids[i : i + chunk_size]
                rows = await db.execute(
                    select(
                        QuizAnswer.question_uuid,
                        QuizAnswer.submission_uuid,
                        QuizAnswer.is_correct,
                    ).where(QuizAnswer.submission_uuid.in_(chunk))
                )
                for q_uuid, s_uuid, ok in rows.fetchall():
                    results.append(
                        {
                            "question_uuid": q_uuid,
                            "submission_uuid": s_uuid,
                            "is_correct": bool(ok),
                        }
                    )
        return results

    def _get_attributor(self) -> Any:
        """Lazily build the attributor (available=False without Milvus index)."""
        from app.services.blindspot.attribution import EntityAttributor

        try:
            from app.services.rag import get_rag_service
            from app.repository.kg_entity_index import KgEntityIndex

            rag = get_rag_service()
            if rag.embeddings is None:
                return EntityAttributor(None)
            return EntityAttributor(KgEntityIndex(rag.embeddings))
        except Exception as e:
            logger.warning("[BLINDSPOT] attributor unavailable: {}", e)
            return EntityAttributor(None)

    @staticmethod
    async def _probed_names(
        uid: int, entity_rows: list[dict[str, Any]]
    ) -> set[str]:
        """Entity names appearing in recent user messages (normalized), best-effort."""
        try:
            from app.repository import mongo_chat_repository as mongo_chat

            texts = await mongo_chat.recent_user_texts_for_user(
                uid, limit=_PROBED_SCAN_LIMIT
            )
            if not texts:
                return set()
            blob = " ".join(t.lower() for t in texts)
            return {
                normalize_name(r.get("name", ""))
                for r in entity_rows
                if r.get("name")
                and normalize_name(r["name"]) in blob
            }
        except Exception as e:
            logger.warning("[BLINDSPOT] probed signal failed: {}", e)
            return set()

    @staticmethod
    async def _page_titles(keys: list[tuple[str, int]]) -> dict[tuple[str, int], str]:
        """(bvid, page_index) -> page title, used by review-path rendering."""
        if not keys:
            return {}
        bvid_list = sorted({b for b, _ in keys})
        from sqlalchemy import select

        from app.database import get_db_context
        from app.models import Video

        mapping: dict[tuple[str, int], str] = {}
        try:
            async with get_db_context() as db:
                rows = await db.execute(
                    select(Video.bvid, Video.page_index, Video.page_title).where(
                        Video.bvid.in_(bvid_list)
                    )
                )
                for bvid, page_index, page_title in rows.fetchall():
                    mapping[(bvid, int(page_index))] = (
                        page_title or f"P{page_index + 1}"
                    )
        except Exception as e:
            logger.warning("[BLINDSPOT] title lookup failed: {}", e)
        return mapping

    @staticmethod
    async def _cid_pages(bvids: list[str]) -> dict[tuple[str, int], dict[str, Any]]:
        """(bvid, page_index) -> {cid, page_title} (source_pages need cid)."""
        if not bvids:
            return {}
        from sqlalchemy import select

        from app.database import get_db_context
        from app.models import Video

        mapping: dict[tuple[str, int], dict[str, Any]] = {}
        try:
            async with get_db_context() as db:
                rows = await db.execute(
                    select(Video.bvid, Video.cid, Video.page_index, Video.page_title)
                    .where(Video.bvid.in_(bvids))
                    .where(Video.is_processed.is_(True))
                )
                for bvid, cid, page_index, page_title in rows.fetchall():
                    mapping[(bvid, int(page_index))] = {
                        "cid": cid,
                        "page_title": page_title or "",
                    }
        except Exception as e:
            logger.warning("[BLINDSPOT] cid lookup failed: {}", e)
        return mapping


_service: BlindspotService | None = None


def get_blindspot_service() -> BlindspotService:
    global _service
    if _service is None:
        _service = BlindspotService()
    return _service
