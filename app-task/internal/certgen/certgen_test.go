package certgen

// Tests for certificate resolution: auto-generation + reuse, the paired
// cert/key validation rule, and auto-mode regeneration near expiry.

import (
	"crypto/x509"
	"encoding/pem"
	"math/big"
	"os"
	"testing"
	"time"
)

func serialOf(t *testing.T, certPath string) *big.Int {
	t.Helper()
	b, err := os.ReadFile(certPath)
	if err != nil {
		t.Fatalf("read cert: %v", err)
	}
	block, _ := pem.Decode(b)
	if block == nil {
		t.Fatal("cert not PEM")
	}
	leaf, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatalf("parse cert: %v", err)
	}
	return leaf.SerialNumber
}

func TestEnsureAutoGeneratesAndReuses(t *testing.T) {
	dir := t.TempDir()
	c, k, err := Ensure("", "", dir)
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
	first := serialOf(t, c)

	// Second call within validity must reuse the same certificate file.
	c2, k2, err := Ensure("", "", dir)
	if err != nil {
		t.Fatalf("ensure again: %v", err)
	}
	if c2 != c || k2 != k {
		t.Fatalf("paths changed: %s/%s -> %s/%s", c, k, c2, k2)
	}
	if serialOf(t, c2).Cmp(first) != 0 {
		t.Fatal("certificate regenerated within validity window")
	}
}

func TestEnsureRejectsHalfConfig(t *testing.T) {
	if _, _, err := Ensure("cert.crt", "", t.TempDir()); err == nil {
		t.Fatal("expected error for cert without key")
	}
	if _, _, err := Ensure("", "key.key", t.TempDir()); err == nil {
		t.Fatal("expected error for key without cert")
	}
}

func TestRotatorAutoRegeneratesNearExpiry(t *testing.T) {
	dir := t.TempDir()
	r, err := NewRotator("", "", dir)
	if err != nil {
		t.Fatalf("new rotator: %v", err)
	}

	// Overwrite with a 2h certificate to simulate "near expiry".
	certPEM, keyPEM, err := generate(2 * time.Hour)
	if err != nil {
		t.Fatalf("generate short cert: %v", err)
	}
	if err := os.WriteFile(r.certPath, certPEM, 0o644); err != nil {
		t.Fatalf("write short cert: %v", err)
	}
	if err := os.WriteFile(r.keyPath, keyPEM, 0o600); err != nil {
		t.Fatalf("write short key: %v", err)
	}
	old := serialOf(t, r.certPath)

	r.reloadOnce()

	if got := serialOf(t, r.certPath); got.Cmp(old) == 0 {
		t.Fatal("certificate not regenerated near expiry")
	}
	if r.current.Load() == nil {
		t.Fatal("no certificate loaded after rotation")
	}
	if _, err := r.GetCertificate(nil); err != nil {
		t.Fatalf("GetCertificate: %v", err)
	}
}

func TestRotatorKeepsHealthyCertificate(t *testing.T) {
	dir := t.TempDir()
	r, err := NewRotator("", "", dir)
	if err != nil {
		t.Fatalf("new rotator: %v", err)
	}
	old := serialOf(t, r.certPath)
	r.reloadOnce()
	if serialOf(t, r.certPath).Cmp(old) != 0 {
		t.Fatal("healthy certificate was rotated")
	}
}
