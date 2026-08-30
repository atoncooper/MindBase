"""Best-effort text extraction for legacy Word 97-2003 ``.doc`` files.

Browsers cannot render binary ``.doc`` natively and python-docx only reads
OOXML ``.docx``. This module provides a *preview-only* text extractor so
legacy documents can still be viewed online.

Quality caveats (why this is preview-only, never fed into RAG):
- tables / images / headers are flattened or dropped
- heuristic piece decoding may produce artifacts on exotic encodings

Algorithm:
1. Open the OLE2 compound document (``olefile``) and read ``WordDocument``.
2. Parse the FIB header: ``fcMin``/``fcMac`` (simple non-complex files) and
   ``fcClx``/``lcbClx`` (piece table location), plus ``fWhichTblStm`` to pick
   the ``0Table``/``1Table`` stream.
3. If a piece table (CLX) exists, walk its PLCPCD entries: each PCD carries
   a file offset whose bit 30 marks ANSI(=8-bit, cp1252/gbk) vs UTF-16 text.
4. Fallback for non-complex files: decode ``WordDocument[fcMin:fcMac]``
   directly (UTF-16LE when FIB says fExtChar, else cp936/cp1252 heuristics).
"""

from __future__ import annotations

import io
import logging
import re

logger = logging.getLogger(__name__)

_FCLC_COMPLEX = 0x0004  # FIB flag: piece table (CLX) is authoritative
_FEXTCHAR_100 = 0x1000  # FIB flag (old offset): text is Unicode
_FWHICHTBLSTM = 0x0200  # FIB flag: table stream name is "1Table" not "0Table"
_PCD_FC_COMPRESSED = 0x40000000  # PCD fc bit 30: piece is 8-bit ANSI

_CTRL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_MULTI_BLANK_RE = re.compile(r"\n{3,}")
_SPECIAL_RE = re.compile(r"[\r\x07\x0b\x0c\x1e\x1f]")


def extract_doc_text(content: bytes) -> str | None:
    """Extract best-effort text from a .doc byte blob.

    Returns ``None`` when the blob is not a recognizable Word document or
    parsing fails — callers fall back to download-only UI.
    """
    try:
        import olefile

        ole = olefile.OleFileIO(io.BytesIO(content))
    except Exception:
        return None

    try:
        if not ole.exists("WordDocument"):
            return None
        word_stream = ole.openstream("WordDocument").read()
        if len(word_stream) < 0x200 or word_stream[:2] != b"\xec\xa5":
            # wIdent magic 0xA5EC (little-endian).
            return None

        flags = int.from_bytes(word_stream[0x0A:0x0C], "little")
        text = _extract_via_piece_table(ole, word_stream, flags)
        if text is None:
            text = _extract_simple(word_stream, flags)
        if not text:
            return None
        return _clean(text)[:500_000]
    except Exception:
        logger.warning("[DOC_PREVIEW] extraction failed", exc_info=True)
        return None
    finally:
        ole.close()


def _extract_via_piece_table(
    ole, word_stream: bytes, flags: int
) -> str | None:
    """Decode text through the CLX piece table (complex + most modern files)."""
    fc_clx = int.from_bytes(word_stream[0x01A2:0x01A6], "little")
    lcb_clx = int.from_bytes(word_stream[0x01A6:0x01AA], "little")
    if lcb_clx == 0:
        return None

    table_name = "1Table" if flags & _FWHICHTBLSTM else "0Table"
    if not ole.exists(table_name):
        table_name = "1Table" if table_name == "0Table" else "0Table"
        if not ole.exists(table_name):
            return None
    clx = ole.openstream(table_name).read()[fc_clx : fc_clx + lcb_clx]

    pieces = _parse_clx(clx)
    if not pieces:
        return None

    parts: list[str] = []
    for offset, count, compressed in pieces:
        chunk_end = min(offset + (count if compressed else count * 2), len(word_stream))
        raw = word_stream[offset:chunk_end]
        if not raw:
            continue
        if compressed:
            parts.append(_decode_ansi(raw))
        else:
            parts.append(raw.decode("utf-16-le", errors="replace"))
    return "".join(parts)


def _parse_clx(clx: bytes) -> list[tuple[int, int, bool]]:
    """Walk the CLX: skip Prc blocks (0x01), parse PlcPcd (0x02).

    Returns ``(byte_offset_in_word_stream, char_count, is_compressed)``
    tuples in document order.
    """
    pieces: list[tuple[int, int, bool]] = []
    pos = 0
    while pos < len(clx):
        tag = clx[pos]
        if tag == 0x01:  # Prc — skip its data block
            if pos + 3 > len(clx):
                break
            cb_grpprl = int.from_bytes(clx[pos + 1 : pos + 3], "little")
            pos += 3 + cb_grpprl
        elif tag == 0x02:  # PlcPcd
            if pos + 5 > len(clx):
                break
            plc_len = int.from_bytes(clx[pos + 1 : pos + 5], "little")
            plc = clx[pos + 5 : pos + 5 + plc_len]
            pieces.extend(_parse_plcpcd(plc))
            break
        else:
            break
    return pieces


def _parse_plcpcd(plc: bytes) -> list[tuple[int, int, bool]]:
    """Parse one PlcPcd: CPs[n+1] uint32 + PCDs[n] 8 bytes each.

    PCD layout: 2 bytes flags, 4 bytes fc, 2 bytes prm.
    Total PlcPcd size = 4*(n+1) + 8*n -> n = (len-4)/12, but the PCD
    array itself is strided by 8 bytes.
    """
    n_pcd, rem = divmod(len(plc) - 4, 12)
    if n_pcd <= 0 or rem != 0:
        return []
    cps = [
        int.from_bytes(plc[i * 4 : i * 4 + 4], "little") for i in range(n_pcd + 1)
    ]
    pcds_off = (n_pcd + 1) * 4
    pieces: list[tuple[int, int, bool]] = []
    for i in range(n_pcd):
        pcd = plc[pcds_off + i * 8 : pcds_off + i * 8 + 8]
        fc = int.from_bytes(pcd[2:6], "little")
        compressed = bool(fc & _PCD_FC_COMPRESSED)
        real_fc = fc & 0x3FFFFFFF
        count = cps[i + 1] - cps[i]
        if count <= 0:
            continue
        pieces.append((real_fc if compressed else real_fc * 2, count, compressed))
    return pieces


def _extract_simple(word_stream: bytes, flags: int) -> str | None:
    """Fallback for non-complex files: contiguous fcMin..fcMac region."""
    fc_min = int.from_bytes(word_stream[0x18:0x1C], "little")
    fc_mac = int.from_bytes(word_stream[0x1C:0x20], "little")
    if not (0 <= fc_min < fc_mac <= len(word_stream)):
        return None
    raw = word_stream[fc_min:fc_mac]
    if flags & _FEXTCHAR_100:
        return raw.decode("utf-16-le", errors="replace")
    # Old 8-bit files: CJK docs are typically GBK; latin ones cp1252.
    try:
        return raw.decode("gbk")
    except UnicodeDecodeError:
        return _decode_ansi(raw)


def _decode_ansi(raw: bytes) -> str:
    """Decode an 8-bit piece: prefer GBK (CJK docs), fall back to cp1252."""
    try:
        return raw.decode("gbk")
    except UnicodeDecodeError:
        return raw.decode("cp1252", errors="replace")


def _clean(text: str) -> str:
    """Normalize Word control characters and collapse blank runs."""
    text = _SPECIAL_RE.sub("\n", text)
    text = _CTRL_RE.sub("", text)
    text = "\n".join(line.strip() for line in text.splitlines())
    return _MULTI_BLANK_RE.sub("\n\n", text).strip()
