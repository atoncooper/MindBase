"""Unit tests for legacy .doc best-effort text extraction.

The full pipeline needs a real OLE2 Word file (olefile cannot write one),
so these tests target the decoders directly with hand-crafted byte blobs,
plus the not-a-doc rejection path.
"""

import pytest

from app.services.doc_parser.legacy_doc import (
    _clean,
    _decode_ansi,
    _parse_clx,
    _parse_plcpcd,
    extract_doc_text,
)


class TestDecodeAnsi:
    def test_gbk_chinese(self):
        raw = "工程项目报告".encode("gbk")
        assert _decode_ansi(raw) == "工程项目报告"

    def test_fallback_cp1252(self):
        raw = b"caf\xe9"  # é in cp1252, invalid GBK sequence
        assert _decode_ansi(raw) == "café"


class TestParsePlcPcd:
    def test_two_pieces_mixed_encodings(self):
        # 2 PCDs -> 3 CPs. Piece 0: chars 0..5 compressed at fc=0x100.
        # Piece 1: chars 5..8 UTF-16 at fc=0x200 (real byte offset 0x400).
        cp = b"".join(n.to_bytes(4, "little") for n in (0, 5, 8))

        def pcd(fc: int) -> bytes:
            return b"\x00\x00" + fc.to_bytes(4, "little") + b"\x00\x00"

        plc = cp + pcd(0x100 | 0x40000000) + pcd(0x200)
        clx = b"\x02" + len(plc).to_bytes(4, "little") + plc

        pieces = _parse_clx(clx)
        assert pieces == [
            (0x100, 5, True),
            (0x400, 3, False),
        ]

    def test_malformed_lengths_rejected(self):
        assert _parse_plcpcd(b"\x01\x02\x03") == []
        assert _parse_plcpcd(b"") == []

    def test_prc_blocks_skipped(self):
        cp = (0).to_bytes(4, "little") + (2).to_bytes(4, "little")
        plc = cp + b"\x00\x00" + b"\x10\x00\x00\x00" + b"\x00\x00"
        prc = b"\x01" + (2).to_bytes(2, "little") + b"\xaa\xbb"
        clx = prc + b"\x02" + len(plc).to_bytes(4, "little") + plc
        pieces = _parse_clx(clx)
        assert len(pieces) == 1


class TestClean:
    def test_control_chars_and_blanks(self):
        # \r and \n each normalize to a line break -> "b\n\nc" collapses to one blank line.
        dirty = "a\x07b\r\n\x00c\n\n\n\nd "
        assert _clean(dirty) == "a\nb\n\nc\n\nd"

    def test_empty(self):
        assert _clean("") == ""


class TestExtractDocText:
    def test_non_doc_blob_returns_none(self):
        assert extract_doc_text(b"just some text file content") is None
        assert extract_doc_text(b"PK\x03\x04 zip bytes here") is None

    @pytest.mark.parametrize("blob", [b"", b"\xec\xa5", b"\xec\xa5" + b"\x00" * 10])
    def test_truncated_blobs_return_none(self, blob):
        assert extract_doc_text(blob) is None
