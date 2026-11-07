package security

import (
	"crypto/rand"
	"encoding/base64"
)

// GenerateToken returns an opaque session token: 48 random bytes encoded as
// unpadded url-safe base64 (64 chars, ~256 bits entropy) — byte-format
// equivalent to Python's secrets.token_urlsafe(48), so tokens issued by
// either service validate against the same user_tokens rows.
func GenerateToken() (string, error) {
	b := make([]byte, 48)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
