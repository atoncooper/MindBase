package certs

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func readCert(t *testing.T, path string) *x509.Certificate {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	block, _ := pem.Decode(data)
	if block == nil {
		t.Fatalf("no PEM block in %s", path)
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	return cert
}

func TestEnsureAutoGeneratesCAAndLeaf(t *testing.T) {
	dir := t.TempDir()
	cert, key, caPath, err := Ensure("", "", dir)
	if err != nil {
		t.Fatalf("Ensure: %v", err)
	}

	for _, f := range []string{caCertFile, caKeyFile, leafFile, leafKey} {
		if _, err := os.Stat(filepath.Join(dir, f)); err != nil {
			t.Errorf("missing %s: %v", f, err)
		}
	}
	if caPath != filepath.Join(dir, caCertFile) {
		t.Errorf("caPath = %q", caPath)
	}

	// Leaf must chain to the dev CA and cover localhost + the deployment
	// alias "mindbase".
	caCert := readCert(t, filepath.Join(dir, caCertFile))
	leaf := readCert(t, cert)
	pool := x509.NewCertPool()
	pool.AddCert(caCert)
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: pool, DNSName: "localhost"}); err != nil {
		t.Errorf("leaf does not verify against dev CA for localhost: %v", err)
	}
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: pool, DNSName: "mindbase"}); err != nil {
		t.Errorf("leaf does not verify against dev CA for mindbase: %v", err)
	}
	if time.Until(leaf.NotAfter) < leafValidity-time.Hour {
		t.Errorf("leaf validity too short: %v", leaf.NotAfter)
	}

	// Key pair must load as a serving certificate.
	if _, err := tls.LoadX509KeyPair(cert, key); err != nil {
		t.Errorf("LoadX509KeyPair: %v", err)
	}
}

func TestEnsureAutoReusesExisting(t *testing.T) {
	dir := t.TempDir()
	cert1, _, ca1, err := Ensure("", "", dir)
	if err != nil {
		t.Fatalf("first Ensure: %v", err)
	}
	leaf1 := readCert(t, cert1)
	caBytes1, _ := os.ReadFile(ca1)

	cert2, _, ca2, err := Ensure("", "", dir)
	if err != nil {
		t.Fatalf("second Ensure: %v", err)
	}
	leaf2 := readCert(t, cert2)
	caBytes2, _ := os.ReadFile(ca2)

	if !leaf1.Equal(leaf2) {
		t.Error("leaf must be reused, not re-signed, while valid")
	}
	if string(caBytes1) != string(caBytes2) {
		t.Error("dev CA must be stable across restarts")
	}
}

func TestEnsureExplicitPair(t *testing.T) {
	dir := t.TempDir()
	// Seed files via auto mode, then reference them explicitly.
	seedCert, seedKey, _, err := Ensure("", "", dir)
	if err != nil {
		t.Fatalf("seed: %v", err)
	}

	cert, key, caPath, err := Ensure(seedCert, seedKey, "")
	if err != nil {
		t.Fatalf("Ensure explicit: %v", err)
	}
	if cert != seedCert || key != seedKey {
		t.Errorf("explicit paths not honored: %s %s", cert, key)
	}
	if caPath != "" {
		t.Errorf("explicit mode must return empty CA path, got %q", caPath)
	}
}

func TestEnsureExplicitHalfPairRejected(t *testing.T) {
	dir := t.TempDir()
	if _, _, _, err := Ensure(filepath.Join(dir, leafFile), "", dir); err == nil {
		t.Error("cert without key must be rejected")
	}
	if _, _, _, err := Ensure("", filepath.Join(dir, leafKey), dir); err == nil {
		t.Error("key without cert must be rejected")
	}
}

func TestRotatorSelfHealsVanishedLeaf(t *testing.T) {
	dir := t.TempDir()
	r, err := NewRotator("", "", dir)
	if err != nil {
		t.Fatalf("NewRotator: %v", err)
	}
	if _, err := r.GetCertificate(nil); err != nil {
		t.Fatalf("initial GetCertificate: %v", err)
	}

	// Simulate file loss; the daily check must re-sign and hot-swap.
	if err := os.Remove(filepath.Join(dir, leafFile)); err != nil {
		t.Fatalf("remove leaf: %v", err)
	}
	if err := os.Remove(filepath.Join(dir, leafKey)); err != nil {
		t.Fatalf("remove leaf key: %v", err)
	}
	if err := r.reloadOnce(); err != nil {
		t.Fatalf("reloadOnce after loss: %v", err)
	}
	if _, err := r.GetCertificate(nil); err != nil {
		t.Fatalf("GetCertificate after self-heal: %v", err)
	}
	if _, err := tls.LoadX509KeyPair(r.certPath, r.keyPath); err != nil {
		t.Errorf("regenerated files unreadable: %v", err)
	}
}

func TestGenerateLeafKeyIsECDSAP256(t *testing.T) {
	dir := t.TempDir()
	ca, err := ensureCA(dir, filepath.Join(dir, caCertFile))
	if err != nil {
		t.Fatalf("ensureCA: %v", err)
	}
	certPEM, keyPEM, err := generateLeaf(ca, time.Hour)
	if err != nil {
		t.Fatalf("generateLeaf: %v", err)
	}
	block, _ := pem.Decode(keyPEM)
	key, err := x509.ParseECPrivateKey(block.Bytes)
	if err != nil {
		t.Fatalf("parse leaf key: %v", err)
	}
	if key.Curve != elliptic.P256() {
		t.Errorf("leaf curve = %v, want P-256", key.Curve)
	}
	_ = certPEM
	_ = ecdsa.PublicKey{}
}
