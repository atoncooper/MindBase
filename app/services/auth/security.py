"""
AES-256-GCM encryption for OAuth tokens and sensitive fields.

Shares the same encryption key as ApiKeyManager (settings.api_key_encryption_key)
to avoid managing two separate keys.

Key format: 32-byte base64 string, injected via env var. Generate with:
    python -c "import base64, os; print(base64.b64encode(os.urandom(32)).decode())"

Ciphertext format: base64(12-byte nonce || AES-GCM ciphertext)
When no key is configured, falls back to plain base64 encode/decode so the app
remains usable in dev environments without a configured encryption key.

Security note: this protects against DB-level token leaks, not runtime memory dumps.
If the key is rotated, all previously encrypted data becomes unreadable — do not
change the key after deployment unless you are prepared to re-encrypt all records.
"""

import base64
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from loguru import logger

from app.config import settings

_aesgcm: AESGCM | None = None


def _init() -> None:
    """Decode the encryption key from config and initialise the AESGCM instance."""
    global _aesgcm
    key_b64 = settings.api_key_encryption_key
    if not key_b64:
        logger.warning("[AUTH_SECURITY] encryption key not set, tokens stored as plaintext")
        return

    try:
        key_bytes = base64.b64decode(key_b64)
        if len(key_bytes) != 32:
            raise ValueError(f"Key is {len(key_bytes)} bytes, expected 32")
        _aesgcm = AESGCM(key_bytes)
        logger.info("[AUTH_SECURITY] AES-256-GCM initialized")
    except Exception as e:
        _aesgcm = None
        logger.warning(f"[AUTH_SECURITY] invalid encryption key ({e}), tokens stored as plaintext")


def encrypt(plaintext: str) -> str:
    """Encrypt with AES-256-GCM, returning base64(12-byte nonce + ciphertext).

    Falls back to plain base64 when no encryption key is configured.
    """
    if _aesgcm is None:
        return base64.b64encode(plaintext.encode()).decode()
    nonce = os.urandom(12)
    ciphertext = _aesgcm.encrypt(nonce, plaintext.encode(), None)
    return base64.b64encode(nonce + ciphertext).decode()


def decrypt(ciphertext_b64: str) -> str:
    """Decrypt a base64-encoded AES-GCM ciphertext.

    Format must match encrypt: base64 decode → first 12 bytes = nonce → rest = ciphertext.
    Falls back to plain base64 decode when no key is configured.
    """
    raw = base64.b64decode(ciphertext_b64)
    if _aesgcm is None:
        return raw.decode()
    nonce = raw[:12]
    ciphertext = raw[12:]
    return _aesgcm.decrypt(nonce, ciphertext, None).decode()


# ── Password hashing ──────────────────────────────────────────────

import bcrypt


def hash_password(password: str) -> str:
    """Hash a plaintext password with bcrypt."""
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, password_hash: str) -> bool:
    """Verify a plaintext password against a bcrypt hash."""
    return bcrypt.checkpw(password.encode(), password_hash.encode())


_init()
