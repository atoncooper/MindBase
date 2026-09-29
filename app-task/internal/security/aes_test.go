package security

// Roundtrip + format-compat tests for the field cipher. The on-disk format
// MUST stay byte-compatible with app/services/auth/security.py (mirrored
// from app-go/app-auth/internal/security/aes.go).

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestRoundtrip(t *testing.T) {
	key := base64.StdEncoding.EncodeToString(make([]byte, 32)) // 32 zero bytes
	c, err := NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	if !c.Enabled() {
		t.Fatal("cipher should be enabled with a key")
	}
	enc, err := c.Encrypt("s3cret-value-你好")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(enc, "s3cret") {
		t.Fatal("ciphertext leaks plaintext")
	}
	got, err := c.Decrypt(enc)
	if err != nil {
		t.Fatal(err)
	}
	if got != "s3cret-value-你好" {
		t.Fatalf("roundtrip = %q", got)
	}
}

func TestDevFallback(t *testing.T) {
	c, err := NewCipher("")
	if err != nil {
		t.Fatal(err)
	}
	if c.Enabled() {
		t.Fatal("empty key must select dev fallback")
	}
	enc, _ := c.Encrypt("plain")
	if enc != base64.StdEncoding.EncodeToString([]byte("plain")) {
		t.Fatalf("dev fallback = %q, want plain base64", enc)
	}
	got, err := c.Decrypt(enc)
	if err != nil || got != "plain" {
		t.Fatalf("dev roundtrip = %q %v", got, err)
	}
}

func TestBadKeyLength(t *testing.T) {
	key := base64.StdEncoding.EncodeToString(make([]byte, 16))
	if _, err := NewCipher(key); err == nil {
		t.Fatal("expected error for 16-byte key")
	}
}
