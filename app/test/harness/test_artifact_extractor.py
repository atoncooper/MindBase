"""Tests for _extract_artifacts - parses <<ARTIFACT_START>> markers from stdout.

Verifies the code agent's artifact extraction protocol: base64-decoded binary
outputs (images/files) are pulled out of stdout and the markers are replaced
with placeholders so the LLM doesn't see megabytes of base64 noise.
"""

import base64

from app.tools.code.run_code import ARTIFACT_MAX_BYTES, _extract_artifacts


class TestExtractArtifacts:
    def test_no_markers_returns_empty(self):
        cleaned, artifacts = _extract_artifacts("exitCode=0\nhello world")
        assert cleaned == "exitCode=0\nhello world"
        assert artifacts == []

    def test_single_image_artifact(self):
        payload = b"\x89PNG fake image data"
        b64 = base64.b64encode(payload).decode()
        stdout = f"exitCode=0\n<<ARTIFACT_START:heart.png>>{b64}<<ARTIFACT_END>>"
        cleaned, artifacts = _extract_artifacts(stdout)
        assert len(artifacts) == 1
        art = artifacts[0]
        assert art["name"] == "heart.png"
        assert art["data"] == payload
        assert art["content_type"] == "image/png"
        assert art["size"] == len(payload)
        # Marker replaced with placeholder, base64 stripped from content.
        assert "<<ARTIFACT_START" not in cleaned
        assert b64 not in cleaned
        assert "[已提取产物: heart.png]" in cleaned

    def test_multiple_artifacts(self):
        b64_1 = base64.b64encode(b"img1").decode()
        b64_2 = base64.b64encode(b"img2").decode()
        stdout = (
            f"<<ARTIFACT_START:a.png>>{b64_1}<<ARTIFACT_END>>"
            f" middle text "
            f"<<ARTIFACT_START:b.jpg>>{b64_2}<<ARTIFACT_END>>"
        )
        cleaned, artifacts = _extract_artifacts(stdout)
        assert len(artifacts) == 2
        assert artifacts[0]["name"] == "a.png"
        assert artifacts[0]["content_type"] == "image/png"
        assert artifacts[1]["name"] == "b.jpg"
        assert artifacts[1]["content_type"] == "image/jpeg"
        # Both base64 blobs stripped.
        assert b64_1 not in cleaned and b64_2 not in cleaned

    def test_oversized_artifact_skipped(self):
        big = b"x" * (ARTIFACT_MAX_BYTES + 1)
        b64 = base64.b64encode(big).decode()
        stdout = f"<<ARTIFACT_START:big.bin>>{b64}<<ARTIFACT_END>>"
        cleaned, artifacts = _extract_artifacts(stdout)
        assert artifacts == []
        assert "[产物过大已跳过: big.bin" in cleaned
        assert b64 not in cleaned

    def test_corrupt_base64_skipped(self):
        # 5 chars -> len % 4 == 1, which base64 rejects as invalid.
        stdout = "<<ARTIFACT_START:bad.png>>abcde<<ARTIFACT_END>>"
        cleaned, artifacts = _extract_artifacts(stdout)
        assert artifacts == []
        assert "[产物解析失败: bad.png]" in cleaned

    def test_unknown_extension_defaults_octet_stream(self):
        b64 = base64.b64encode(b"data").decode()
        stdout = f"<<ARTIFACT_START:weird.zzz>>{b64}<<ARTIFACT_END>>"
        _, artifacts = _extract_artifacts(stdout)
        assert artifacts[0]["content_type"] == "application/octet-stream"

    def test_marker_name_trimmed(self):
        b64 = base64.b64encode(b"x").decode()
        # Whitespace around the name should be stripped.
        stdout = f"<<ARTIFACT_START:  heart.png  >>{b64}<<ARTIFACT_END>>"
        _, artifacts = _extract_artifacts(stdout)
        assert artifacts[0]["name"] == "heart.png"
