"""Tests for the MinIO public URL resolution fallback chain.

Covers _resolve_public_base(): explicit MINIO__PUBLIC_ENDPOINT >
MINIO__PUBLIC_HOST (auto /minio-proxy prefix) > localhost default, and
that _public_url rewrites only internal-endpoint URLs (so presigned
signatures stay valid through the nginx /minio-proxy rewrite).
"""

from app.infra import minio as minio_mod
from app.infra.config import config


def _patch_minio(monkeypatch, **kwargs):
    # build a section-like object overriding the fields we care about
    import types

    class _Section:
        pass

    sec = _Section()
    sec.enabled = True
    sec.endpoint = "http://minio:9000"
    sec.region = "us-east-1"
    sec.bucket = "drive-videos"
    sec.secure = False
    sec.presign_expire = 3600
    sec.access_key = ""
    sec.secret_key = ""
    sec.public_endpoint = kwargs.get("public_endpoint", "")
    sec.public_host = kwargs.get("public_host", "")
    monkeypatch.setattr(config, "minio", sec)
    return sec


class TestResolvePublicBase:
    def test_public_endpoint_wins(self, monkeypatch):
        _patch_minio(
            monkeypatch, public_endpoint="https://mindbase.example.com/minio-proxy",
            public_host="192.168.1.100",
        )
        assert minio_mod._resolve_public_base() == "https://mindbase.example.com/minio-proxy"

    def test_public_host_gets_minio_proxy_prefix(self, monkeypatch):
        _patch_minio(monkeypatch, public_host="192.168.1.100")
        assert minio_mod._resolve_public_base() == "http://192.168.1.100/minio-proxy"

    def test_public_host_domain_uses_https_when_secure(self, monkeypatch):
        sec = _patch_minio(monkeypatch, public_host="mindbase.example.com")
        sec.secure = True
        assert minio_mod._resolve_public_base() == "https://mindbase.example.com/minio-proxy"

    def test_localhost_default_when_nothing_configured(self, monkeypatch):
        _patch_minio(monkeypatch)
        assert minio_mod._resolve_public_base() == "http://localhost/minio-proxy"


class TestPublicUrl:
    def _client(self, monkeypatch, **kw):
        _patch_minio(monkeypatch, **kw)
        client = minio_mod.MinioClient.__new__(minio_mod.MinioClient)
        return client

    def test_internal_url_rewritten_to_public_base(self, monkeypatch):
        client = self._client(monkeypatch, public_host="10.0.0.5")
        internal = "http://minio:9000/drive-videos/code-artifacts/1/x/a.png?sig=abc"
        public = client._public_url(internal)
        assert public == "http://10.0.0.5/minio-proxy/drive-videos/code-artifacts/1/x/a.png?sig=abc"

    def test_other_urls_left_untouched(self, monkeypatch):
        client = self._client(monkeypatch, public_host="10.0.0.5")
        other = "https://cdn.example.com/some/file.bin"
        assert client._public_url(other) == other

    def test_localhost_default_rewrite(self, monkeypatch):
        client = self._client(monkeypatch)
        internal = "http://minio:9000/bucket/obj"
        assert client._public_url(internal) == "http://localhost/minio-proxy/bucket/obj"
