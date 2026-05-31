"""
Auth service package — user authentication, OAuth binding, token sessions, encryption.

Layers (bottom-up):
    security.py    AES-256-GCM encrypt/decrypt (utility, used by user_service)
    token.py       Token create/validate/revoke (used by user_service)
    user_service.py   User lifecycle orchestration (used by routers/auth.py)

Public API:
    from app.services.auth import UserService, validate_token, encrypt, decrypt
"""

from app.services.auth.user_service import UserService
from app.services.auth.token import (
    generate_token, create_token, validate_token,
    revoke_token, revoke_all_tokens,
)
from app.services.auth.security import encrypt, decrypt

__all__ = [
    "UserService",
    "generate_token",
    "create_token",
    "validate_token",
    "revoke_token",
    "revoke_all_tokens",
    "encrypt",
    "decrypt",
]
