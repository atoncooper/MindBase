// Package security holds the compatibility-critical primitives shared with
// the Python backend: AES-256-GCM field encryption, bcrypt password hashing,
// snowflake uid generation and opaque session-token generation. The on-disk
// formats MUST stay byte-compatible with app/services/auth/security.py and
// app/utils/snowflake.py — guarded by tests with Python-generated fixtures.
package security

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
)

// Cipher does AES-256-GCM field encryption.
//
// Ciphertext format (identical to the Python side):
//
//	base64( 12-byte nonce || AES-GCM ciphertext )
//
// When no key is configured (dev fallback), encrypt/decrypt degrade to plain
// std-base64 of the plaintext, exactly like security.py — this keeps legacy
// rows written by the keyless Python dev mode readable.
type Cipher struct {
	aead cipher.AEAD // nil = dev fallback
}

// NewCipher builds a Cipher from a base64-encoded 32-byte key.
// An empty key selects the dev fallback (plain base64, no encryption).
func NewCipher(keyB64 string) (*Cipher, error) {
	if keyB64 == "" {
		return &Cipher{}, nil
	}
	key, err := base64.StdEncoding.DecodeString(keyB64)
	if err != nil {
		return nil, fmt.Errorf("decode encryption key: %w", err)
	}
	if len(key) != 32 {
		return nil, fmt.Errorf("encryption key is %d bytes, expected 32", len(key))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("new cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("new gcm: %w", err)
	}
	return &Cipher{aead: aead}, nil
}

// Enabled reports whether real encryption is active (vs dev base64 fallback).
func (c *Cipher) Enabled() bool { return c.aead != nil }

// Encrypt encrypts plaintext into base64(nonce || ciphertext).
func (c *Cipher) Encrypt(plaintext string) (string, error) {
	if c.aead == nil {
		return base64.StdEncoding.EncodeToString([]byte(plaintext)), nil
	}
	nonce := make([]byte, 12)
	if _, err := rand.Read(nonce); err != nil {
		return "", fmt.Errorf("read nonce: %w", err)
	}
	sealed := c.aead.Seal(nil, nonce, []byte(plaintext), nil)
	out := make([]byte, 0, 12+len(sealed))
	out = append(out, nonce...)
	out = append(out, sealed...)
	return base64.StdEncoding.EncodeToString(out), nil
}

// Decrypt reverses Encrypt. Accepts values written by either the Go service
// or the Python backend (identical format).
func (c *Cipher) Decrypt(ciphertextB64 string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(ciphertextB64)
	if err != nil {
		return "", fmt.Errorf("decode ciphertext: %w", err)
	}
	if c.aead == nil {
		return string(raw), nil
	}
	if len(raw) < 12+c.aead.Overhead() {
		return "", errors.New("ciphertext too short")
	}
	plain, err := c.aead.Open(nil, raw[:12], raw[12:], nil)
	if err != nil {
		return "", fmt.Errorf("gcm open: %w", err)
	}
	return string(plain), nil
}
