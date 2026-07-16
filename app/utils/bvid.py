"""
Bilibili BV ↔ AV mapping algorithm.

BV strings are reversible Base58 + XOR encodings of integer AV numbers.
Converts VARCHAR(20) primary keys to INT for faster JOINs and index lookups.

Distributed-friendly: same input → same output, pure function, zero coordination.
Naturally idempotent — multiple nodes inserting the same bvid never conflict.

Reference: https://github.com/SocialSisterYi/bilibili-API-collect
"""

import hashlib
from typing import Optional


# ── BV ↔ AV algorithm constants ─────────────────────────────────

_BV_TABLE = "fZodR9XQDSUm21yCkr6zBqiveYah8bt4xsWpHnJE7jL5VG3guMTKNPAwcF"
_TR = {c: i for i, c in enumerate(_BV_TABLE)}

_S = [11, 10, 3, 8, 4, 6]     # positions of 6 significant chars within a 12-char BV string
_XOR = 177451812               # fixed XOR salt
_ADD = 8728348608              # base offset


# ── Public API ──────────────────────────────────────────────────

def bv_to_av(bvid: str) -> int:
    """Convert BV string to AV integer.

    _S indices reference the full 12-character BV (including "BV" prefix).
    E.g. for "BV1xx411c7mD", _S=[11,10,3,8,4,6] picks 'D','m','x','c','4','1'.

    >>> bv_to_av("BV1xx411c7mD")
    2
    """
    r = 0
    for i in range(6):
        r += _TR[bvid[_S[i]]] * (58 ** i)
    return (r - _ADD) ^ _XOR


def av_to_bv(av: int) -> str:
    """Convert AV integer to BV string.

    Produces a 12-character BV. The template "BV1xx4x1x7xx" has x positions
    filled by the algorithm.

    >>> av_to_bv(2)
    'BV1xx411c7mD'
    """
    av = (av ^ _XOR) + _ADD
    chars = ["B", "V", "1", " ", " ", "4", " ", "1", " ", "7", " ", " "]
    for i in range(6):
        chars[_S[i]] = _BV_TABLE[(av // (58 ** i)) % 58]
    return "".join(chars)


def resolve_video_id(bvid: str, aid_from_api: Optional[int] = None) -> int:
    """Resolve a numeric video ID from a BV string.

    Uses the BV→AV algorithm by default. When the Bilibili API returns an aid,
    cross-checks for correctness. If mismatched, trusts the API aid and logs
    a warning — this guards against future encoding-table changes.

    Args:
        bvid: BV string, e.g. "BV1xx411c7mD"
        aid_from_api: aid field from Bilibili API response (optional)

    Returns:
        Integer ID suitable for use as a primary / foreign key.
    """
    computed = bv_to_av(bvid)

    if aid_from_api and aid_from_api > 0 and computed != aid_from_api:
        import logging
        logging.getLogger("mind_base").warning(
            f"[BVID] algorithm mismatch! bvid={bvid} "
            f"computed={computed} api_aid={aid_from_api} "
            f"— using api_aid"
        )
        return aid_from_api

    return computed


def bv_to_int_fallback(bvid: str) -> int:
    """Fallback hash for when the BV→AV algorithm becomes invalid.

    Uses SHA-256 to produce a deterministic integer from any BV string.
    Still distributed-safe (same input → same output), but produces
    unsequenced numbers with worse index locality.
    """
    h = hashlib.sha256(bvid.encode()).digest()[:8]
    return int.from_bytes(h, "big") & 0x7FFFFFFFFFFFFFFF


def is_valid_bvid(bvid: str) -> bool:
    """Check whether a string is a well-formed BV identifier."""
    if not bvid or len(bvid) != 12:
        return False
    if not bvid.startswith("BV"):
        return False
    try:
        bv_to_av(bvid)
        return True
    except (KeyError, IndexError):
        return False
