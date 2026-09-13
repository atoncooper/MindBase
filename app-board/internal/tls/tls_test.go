package tls

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// The auto mode must produce a stable dev CA plus a leaf that CHAINS to it —
// that property is what lets APISIX set tls_verify: true with just dev-ca.crt.
func TestEnsureGeneratesChainedLeaf(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath, caPath, err := Ensure("", "", dir)
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if caPath == "" {
		t.Fatal("auto mode must return the CA cert path")
	}
	if filepath.Dir(certPath) != dir || filepath.Base(certPath) != leafFile {
		t.Fatalf("cert path = %s", certPath)
	}

	pair, err := tls.LoadX509KeyPair(certPath, keyPath)
	if err != nil {
		t.Fatalf("load leaf: %v", err)
	}
	if pair.Leaf == nil {
		t.Fatal("leaf not parsed")
	}
	if !pair.Leaf.NotAfter.After(time.Now().Add(leafValidity - time.Hour)) {
		t.Fatalf("leaf validity too short: %s", pair.Leaf.NotAfter)
	}

	caPEM, err := os.ReadFile(caPath)
	if err != nil {
		t.Fatalf("read ca: %v", err)
	}
	block, _ := pem.Decode(caPEM)
	if block == nil {
		t.Fatal("ca pem undecodable")
	}
	if _, err := x509.ParseCertificate(block.Bytes); err != nil {
		t.Fatalf("parse ca: %v", err)
	}
	if _, err := pair.Leaf.Verify(x509.VerifyOptions{
		DNSName:     "app-board",
		Roots:       x509pool(caPEM),
		CurrentTime: time.Now(),
		KeyUsages:   []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}); err != nil {
		t.Fatalf("leaf does not chain to dev CA: %v", err)
	}
}

// Second Ensure with the same dir must REUSE both CA and leaf (no rotation
// on every restart).
func TestEnsureReusesValidFiles(t *testing.T) {
	dir := t.TempDir()
	cert1, _, ca1, err := Ensure("", "", dir)
	if err != nil {
		t.Fatalf("first ensure: %v", err)
	}
	cert2, _, ca2, err := Ensure("", "", dir)
	if err != nil {
		t.Fatalf("second ensure: %v", err)
	}
	if cert1 != cert2 || ca1 != ca2 {
		t.Fatalf("paths changed: %s/%s vs %s/%s", cert1, ca1, cert2, ca2)
	}
}

// Explicit mode: cert+key loaded as-is, no CA path (operator manages trust).
func TestEnsureExplicitMode(t *testing.T) {
	dir := t.TempDir()
	// Generate an auto pair first, then reference it explicitly.
	leaf, key, _, err := Ensure("", "", dir)
	if err != nil {
		t.Fatalf("seed: %v", err)
	}
	// Move to fresh paths so explicit mode is distinguishable from auto.
	leaf2 := filepath.Join(dir, "explicit.crt")
	key2 := filepath.Join(dir, "explicit.key")
	if err := os.Rename(leaf, leaf2); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(key, key2); err != nil {
		t.Fatal(err)
	}
	cert, k, ca, err := Ensure(leaf2, key2, "")
	if err != nil {
		t.Fatalf("explicit ensure: %v", err)
	}
	if cert != leaf2 || k != key2 || ca != "" {
		t.Fatalf("explicit mode returned cert=%s ca=%s", cert, ca)
	}
}

func TestEnsureOneSidedPathRejected(t *testing.T) {
	if _, _, _, err := Ensure("only-cert.crt", "", ""); err == nil {
		t.Fatal("cert without key must be rejected")
	}
}

// Rotator must self-heal: deleting the leaf file makes the next reload
// re-sign it from the stable CA.
func TestRotatorSelfHeal(t *testing.T) {
	dir := t.TempDir()
	r, err := NewRotator("", "", dir)
	if err != nil {
		t.Fatalf("new rotator: %v", err)
	}
	before, err := os.ReadFile(r.certPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(r.certPath); err != nil {
		t.Fatal(err)
	}
	if err := r.reloadOnce(); err != nil {
		t.Fatalf("reload after delete: %v", err)
	}
	after, err := os.ReadFile(r.certPath)
	if err != nil {
		t.Fatal("leaf not regenerated")
	}
	if string(before) == string(after) {
		t.Fatal("leaf regenerated identical — new key expected")
	}
	if r.current.Load() == nil {
		t.Fatal("rotator lost its certificate")
	}
}

func TestRotatorShortExpiryReSigns(t *testing.T) {
	dir := t.TempDir()
	r, err := NewRotator("", "", dir)
	if err != nil {
		t.Fatalf("new rotator: %v", err)
	}
	// Overwrite the leaf with a 10-day certificate (below rotateWithin).
	ca, err := ensureCA(dir, filepath.Join(dir, caCertFile))
	if err != nil {
		t.Fatal(err)
	}
	certPEM, keyPEM, err := generateLeaf(ca, 10*24*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(r.certPath, certPEM, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(r.keyPath, keyPEM, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := r.reloadOnce(); err != nil {
		t.Fatalf("reload: %v", err)
	}
	pair, _ := tls.LoadX509KeyPair(r.certPath, r.keyPath)
	if pair.Leaf == nil || time.Until(pair.Leaf.NotAfter) <= rotateWithin {
		t.Fatalf("leaf not renewed: %v", pair.Leaf)
	}
}

// helper: x509 pool that ignores the bool (keeps assertions tidy)
func x509pool(caPEM []byte) *x509.CertPool {
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(caPEM)
	return pool
}
