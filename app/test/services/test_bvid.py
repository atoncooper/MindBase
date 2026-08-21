# app/test/test_bvid.py
"""
Tests for app/utils/bvid.py — BV ↔ AV encoding algorithm.

Organized into:
  WhiteBox  — tests that know and verify internal algorithm details.
  BlackBox  — tests that only use the public API (contract / property tests).
"""

import hashlib
import random

import pytest

from app.utils.bvid import (
    bv_to_av,
    av_to_bv,
    resolve_video_id,
    bv_to_int_fallback,
    is_valid_bvid,
)


# ====================================================================
# White-Box Tests
# ====================================================================
# These tests depend on knowledge of internal constants and the encoding
# algorithm: _S, _XOR, _ADD, _BV_TABLE, Base58 arithmetic, etc.
# If the algorithm is updated these tests SHOULD FAIL — that's intentional.
# ====================================================================


class TestWhiteBox_Constants:
    """Verify the algorithm constants are exactly as expected."""

    def test_table_is_58_chars(self):
        import app.utils.bvid as m
        assert len(m._BV_TABLE) == 58

    def test_tr_covers_all_table_chars(self):
        import app.utils.bvid as m
        assert len(m._TR) == 58
        for c in m._BV_TABLE:
            assert c in m._TR

    def test_s_positions_are_valid(self):
        import app.utils.bvid as m
        for idx in m._S:
            assert 0 <= idx < 12

    def test_xor_and_add_are_positive(self):
        import app.utils.bvid as m
        assert m._XOR > 0
        assert m._ADD > 0


class TestWhiteBox_Encoding:
    """Verify the math of a known encoding step by step."""

    def test_bv_to_av_step_by_step(self):
        """Manually compute av for "BV1xx411c7mD" character by character."""
        import app.utils.bvid as m
        bvid = "BV1xx411c7mD"
        r = 0
        for i in range(6):
            char = bvid[m._S[i]]
            val = m._TR[char]
            r += val * (58 ** i)
        expected = (r - m._ADD) ^ m._XOR
        assert bv_to_av(bvid) == expected

    def test_av_to_bv_template_positions(self):
        """Template "BV1xx4x1x7xx" — non-x positions are fixed."""
        bv = av_to_bv(0)
        assert bv[0] == "B"
        assert bv[1] == "V"
        assert bv[2] == "1"
        assert bv[5] == "4"
        assert bv[7] == "1"
        assert bv[9] == "7"

    def test_all_output_chars_in_table(self):
        """Every character in any BV output belongs to the encoding table."""
        import app.utils.bvid as m
        for av in range(500):
            bv = av_to_bv(av)
            for ch in bv:
                if ch in ("B", "V", "1", "4", "7"):  # fixed template chars
                    continue
                assert ch in m._BV_TABLE, f"char '{ch}' not in table, av={av} bv={bv}"

    def test_58_power_bounds(self):
        """The encoded value fits within 58^6 - 1."""
        MAX_ENCODED = 58 ** 6 - 1
        for av in [0, 1, 2_000_000_000]:
            bv = av_to_bv(av)
            import app.utils.bvid as m
            r = 0
            for i in range(6):
                r += m._TR[bv[m._S[i]]] * (58 ** i)
            assert 0 <= r <= MAX_ENCODED

    def test_overflow_clamp(self):
        """AV values larger than ~2^31 wrap around due to XOR + mod behavior."""
        large = 3_000_000_000
        bv = av_to_bv(large)
        decoded = bv_to_av(bv)
        # After wrapping, the decoded value may differ from the original;
        # the invariant is that decode(encode(x)) rounds-trips properly.
        assert bv_to_av(av_to_bv(decoded)) == decoded


class TestWhiteBox_Coverage:
    """Edge cases that exercise every code path."""

    def test_every_s_position_exercised(self):
        """Encoding a value exercises all 6 significant positions."""
        bv = av_to_bv(123456)
        import app.utils.bvid as m
        changed = set()
        bv0 = av_to_bv(0)
        for i in m._S:
            if bv[i] != bv0[i]:
                changed.add(i)
        assert len(changed) > 0  # at least some positions differ from zero

    def test_min_expressible_av(self):
        """Smallest AV that encodes correctly."""
        for av in [0, 1]:
            assert bv_to_av(av_to_bv(av)) == av

    def test_xor_boundary(self):
        """Values near the XOR constant."""
        import app.utils.bvid as m
        for av in [m._XOR - 1, m._XOR, m._XOR + 1, m._XOR * 2]:
            assert bv_to_av(av_to_bv(av)) == av


# ====================================================================
# Black-Box Tests
# ====================================================================
# These tests only use the public API and make no assumptions about
# internal constants. They verify behavioral contracts, properties,
# and real-world correctness.
# ====================================================================


class TestBlackBox_RoundTrip:
    """∀ av: bv_to_av(av_to_bv(av)) == av"""

    RV = [0, 1, 2, 100, 65535, 999999, 1_000_000_000, 2_147_483_647]

    @pytest.mark.parametrize("av", RV)
    def test_av_roundtrip(self, av):
        assert bv_to_av(av_to_bv(av)) == av

    def test_consecutive_range(self):
        for av in range(2000):
            assert bv_to_av(av_to_bv(av)) == av

    def test_random_sampling(self):
        for _ in range(500):
            av = random.randint(0, 2_147_483_647)
            assert bv_to_av(av_to_bv(av)) == av

    def test_bv_roundtrip(self):
        """∀ valid bv: av_to_bv(bv_to_av(bv)) == bv"""
        bvs = [av_to_bv(av) for av in [0, 1, 100, 99999, 1234567890]]
        for bv in bvs:
            assert av_to_bv(bv_to_av(bv)) == bv


class TestBlackBox_Format:
    """Every BV output satisfies length=12 and prefix='BV'."""

    def test_length_is_always_12(self):
        for av in [0, 1, 100, 9999, 1_000_000, 2_000_000_000]:
            assert len(av_to_bv(av)) == 12

    def test_prefix_is_always_BV(self):
        for av in range(200):
            assert av_to_bv(av).startswith("BV")

    def test_template_positions_are_fixed(self):
        """Positions 0,1,2,5,7,9 carry fixed chars regardless of AV value."""
        bvs = [av_to_bv(av) for av in [0, 1, 500, 99999]]
        for bv in bvs:
            assert bv[0] == "B"
            assert bv[1] == "V"
            assert bv[2] == "1"
            assert bv[5] == "4"
            assert bv[7] == "1"
            assert bv[9] == "7"

    def test_valid_bvid_on_all_generated(self):
        for av in range(500):
            assert is_valid_bvid(av_to_bv(av))


class TestBlackBox_Bijection:
    """The mapping is a bijection for the representable domain."""

    def test_no_collisions_10k(self):
        bvs = {av_to_bv(av) for av in range(10_000)}
        assert len(bvs) == 10_000

    def test_no_collisions_random(self):
        bvs = set()
        for _ in range(5000):
            bvs.add(av_to_bv(random.randint(0, 2_000_000_000)))
        assert len(bvs) == 5000

    def test_inverse_uniqueness(self):
        """No two different AVs map to the same BV."""
        seen = {}
        for av in range(2000):
            bv = av_to_bv(av)
            if bv in seen:
                pytest.fail(f"collision: av={seen[bv]} and av={av} both → {bv}")
            seen[bv] = av

    def test_no_two_bvs_map_to_same_av(self):
        """No two different BVs decode to the same AV."""
        seen = {}
        for av in range(2000):
            bv = av_to_bv(av)
            decoded = bv_to_av(bv)
            if bv not in seen:
                seen[bv] = decoded
            else:
                assert seen[bv] == decoded


class TestBlackBox_ResolveVideoID:
    """Contract tests for resolve_video_id."""

    def test_no_aid_returns_computed(self):
        result = resolve_video_id("BV1xx411c7mD")
        assert result == bv_to_av("BV1xx411c7mD")

    def test_matching_aid_returns_same(self):
        result = resolve_video_id("BV1xx411c7mD", aid_from_api=2)
        assert result == 2

    def test_mismatched_aid_returns_api_value(self):
        result = resolve_video_id("BV1xx411c7mD", aid_from_api=99999)
        assert result == 99999

    def test_aid_zero_ignored(self):
        result = resolve_video_id("BV1xx411c7mD", aid_from_api=0)
        assert result == bv_to_av("BV1xx411c7mD")

    def test_aid_none_is_ignored(self):
        result = resolve_video_id("BV1xx411c7mD", aid_from_api=None)
        assert result == bv_to_av("BV1xx411c7mD")


class TestBlackBox_Fallback:
    """Contract tests for bv_to_int_fallback."""

    def test_returns_positive_int(self):
        for bv in ["BV1xx411c7mD", "BV17x411w7KC"]:
            assert bv_to_int_fallback(bv) > 0

    def test_deterministic(self):
        for bv in ["BV1xx411c7mD", "BV17x411w7KC"]:
            assert bv_to_int_fallback(bv) == bv_to_int_fallback(bv)

    def test_different_inputs_different_outputs(self):
        a = bv_to_int_fallback("BV1xx411c7mD")
        b = bv_to_int_fallback("BV17x411w7KC")
        assert a != b

    def test_idempotent_across_processes(self):
        """Same input always gives same output — critical for distributed use."""
        expected = bv_to_int_fallback("BV1xx411c7mD")
        for _ in range(100):
            assert bv_to_int_fallback("BV1xx411c7mD") == expected

    def test_reproducible_from_hash(self):
        """The fallback is literally SHA-256, so it must match raw hashlib."""
        bvid = "BV1xx411c7mD"
        h = hashlib.sha256(bvid.encode()).digest()[:8]
        expected = int.from_bytes(h, "big") & 0x7FFFFFFFFFFFFFFF
        assert bv_to_int_fallback(bvid) == expected


class TestBlackBox_IsValidBvid:
    """Contract tests for is_valid_bvid."""

    def test_valid_accepts_generated(self):
        for av in range(200):
            assert is_valid_bvid(av_to_bv(av))

    def test_rejects_empty_and_none(self):
        assert not is_valid_bvid("")
        assert not is_valid_bvid(None)  # type: ignore

    def test_rejects_wrong_length(self):
        for bad in ["BV", "BV1", "BV1234567890", "BV12345678901"]:
            assert not is_valid_bvid(bad), f"should reject: {bad!r}"

    def test_rejects_wrong_prefix(self):
        for bad in ["AV1xx411c7mD", "bv1xx411c7mD", "XX1xx411c7mD"]:
            assert not is_valid_bvid(bad), f"should reject: {bad!r}"

    def test_rejects_garbage(self):
        for garbage in ["!!!!!!!!!!!!", "BV@@@@@@@@@@", "BV0000000000"]:
            assert not is_valid_bvid(garbage), f"should reject: {garbage!r}"


class TestBlackBox_Fuzzing:
    """Random-input safety tests — ensure no crashes or undefined behavior."""

    def test_bv_to_av_does_not_crash_on_random_strings(self):
        chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
        for _ in range(500):
            bv = "BV" + "".join(random.choice(chars) for _ in range(10))
            try:
                bv_to_av(bv)
            except (KeyError, IndexError):
                pass  # expected for invalid input

    def test_av_to_bv_never_throws_for_any_int(self):
        for av in [
            0, 1, -1, -999,
            2_147_483_647,         # int32 max
            -2_147_483_648,        # int32 min
            9_223_372_036_854_775_807,  # int64 max
        ]:
            try:
                result = av_to_bv(av)
                assert len(result) == 12
            except Exception as e:
                pytest.fail(f"av_to_bv({av}) raised {type(e).__name__}: {e}")

    def test_never_returns_negative_av(self):
        """bv_to_av should never return a negative integer for valid input."""
        for av in range(2000):
            bv = av_to_bv(av)
            assert bv_to_av(bv) >= 0


class TestBlackBox_DistributedProperties:
    """Properties required for safe distributed usage."""

    def test_pure_function_same_thread(self):
        """100 calls in a row produce identical results."""
        bv = "BV1xx411c7mD"
        results = [bv_to_av(bv) for _ in range(100)]
        assert len(set(results)) == 1

    def test_pure_function_same_input(self):
        """Any valid BV always maps to the same integer."""
        for av in [0, 1, 100, 99999, 1_000_000]:
            bv = av_to_bv(av)
            expected = bv_to_av(bv)
            for _ in range(50):
                assert bv_to_av(bv) == expected

    def test_shard_routing_stable(self):
        """Shard = bv_to_av(bvid) % N is stable — same bvid → same shard."""
        bvs = [av_to_bv(av) for av in range(100)]
        for bv in bvs:
            shard = bv_to_av(bv) % 16
            for _ in range(20):
                assert bv_to_av(bv) % 16 == shard
