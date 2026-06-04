"""Tests for Milvus expression escaping and builder utilities."""

from app.repository.vector_store_milvus import _escape_expr, _quote_list, _build_in_filter, MILVUS_IN_MAX_SIZE


class TestEscapeExpr:
    def test_no_special_chars_unchanged(self):
        assert _escape_expr("hello") == "hello"

    def test_double_quote_escaped(self):
        result = _escape_expr('he"llo')
        assert result == 'he\\"llo'

    def test_backslash_escaped(self):
        result = _escape_expr("path\\file")
        assert result == "path\\\\file"

    def test_both_escaped(self):
        result = _escape_expr('say\\"hi')
        assert result == 'say\\\\\\"hi'

    def test_empty_string(self):
        assert _escape_expr("") == ""

    def test_uuid7_is_safe(self):
        uuid = "01972abc-1234-7def-8901-23456789abcd"
        assert _escape_expr(uuid) == uuid

    def test_injection_attempt_neutralized(self):
        malicious = 'x" || true || "'
        escaped = _escape_expr(malicious)
        # Double-quotes are escaped so the string won't break the Milvus expression
        assert escaped.count('"') == 0 or '\\"' in escaped
        # The content between quotes is preserved (quotes are escaped, not removed)
        assert "true" in escaped

    def test_bvid_format_is_safe(self):
        bvid = "BV1xx411c7mD"
        assert _escape_expr(bvid) == bvid


class TestQuoteList:
    def test_empty_list(self):
        assert _quote_list([]) == "[]"

    def test_single_string(self):
        assert _quote_list(["a"]) == '["a"]'

    def test_multiple_strings(self):
        assert _quote_list(["a", "b", "c"]) == '["a", "b", "c"]'

    def test_integers(self):
        assert _quote_list([1, 2, 3]) == "[1, 2, 3]"

    def test_floats(self):
        assert _quote_list([1.5, 2.5]) == "[1.5, 2.5]"

    def test_uuids(self):
        uuids = ["uuid-1", "uuid-2"]
        result = _quote_list(uuids)
        assert "uuid-1" in result
        assert "uuid-2" in result


class TestBuildInFilter:
    def test_empty_values_returns_none(self):
        assert _build_in_filter("bvid", []) is None

    def test_single_value(self):
        result = _build_in_filter("bvid", ["BV123"])
        assert result == 'bvid in ["BV123"]'

    def test_multiple_values(self):
        result = _build_in_filter("upload_uuid", ["a", "b", "c"])
        assert result == 'upload_uuid in ["a", "b", "c"]'

    def test_truncates_at_max_size(self):
        values = [f"id-{i}" for i in range(MILVUS_IN_MAX_SIZE + 500)]
        result = _build_in_filter("upload_uuid", values)
        assert result is not None
        # Should only contain the first MILVUS_IN_MAX_SIZE values
        count = result.count('"')
        assert count <= MILVUS_IN_MAX_SIZE * 2 + 2  # opening + closing brackets


class TestMilvusInMaxSize:
    def test_constant_is_positive(self):
        assert MILVUS_IN_MAX_SIZE > 0

    def test_constant_is_reasonable(self):
        assert 100 <= MILVUS_IN_MAX_SIZE <= 10000
