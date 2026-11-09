package tests

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

	"app-content-mcp/internal/certs"
)

// The auto-generated file names are part of the documented certs contract
// (dev-ca.crt/dev-ca.key + server.crt/server.key); black-box tests pin the
// same names the container ships.
const (
	certsCACertFile = "dev-ca.crt"
	certsCAKeyFile  = "dev-ca.key"
	certsLeafFile   = "server.crt"
	certsLeafKey    = "server.key"
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
	cert, key, caPath, err := certs.Ensure("", "", dir)
	if err != nil {
		t.Fatalf("Ensure: %v", err)
	}

	for _, f := range []string{certsCACertFile, certsCAKeyFile, certsLeafFile, certsLeafKey} {
		if _, err := os.Stat(filepath.Join(dir, f)); err != nil {
			t.Errorf("missing %s: %v", f, err)
		}
	}
	if caPath != filepath.Join(dir, certsCACertFile) {
		t.Errorf("caPath = %q", caPath)
	}

	// Leaf must chain to the dev CA and cover localhost + the deployment
	// alias "mindbase".
	caCert := readCert(t, filepath.Join(dir, certsCACertFile))
	leaf := readCert(t, cert)
	pool := x509.NewCertPool()
	pool.AddCert(caCert)
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: pool, DNSName: "localhost"}); err != nil {
		t.Errorf("leaf does not verify against dev CA for localhost: %v", err)
	}
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: pool, DNSName: "mindbase"}); err != nil {
		t.Errorf("leaf does not verify against dev CA for mindbase: %v", err)
	}
	// The leaf is documented as 825 days; allow clock skew but require the
	// same long-lived posture (auto mode must not emit short certificates).
	if time.Until(leaf.NotAfter) < 800*24*time.Hour {
		t.Errorf("leaf validity too short: %v", leaf.NotAfter)
	}

	// Key pair must load as a serving certificate.
	if _, err := tls.LoadX509KeyPair(cert, key); err != nil {
		t.Errorf("LoadX509KeyPair: %v", err)
	}
}

func TestEnsureAutoReusesExisting(t *testing.T) {
	dir := t.TempDir()
	cert1, _, ca1, err := certs.Ensure("", "", dir)
	if err != nil {
		t.Fatalf("first Ensure: %v", err)
	}
	leaf1 := readCert(t, cert1)
	caBytes1, _ := os.ReadFile(ca1)

	cert2, _, ca2, err := certs.Ensure("", "", dir)
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
	seedCert, seedKey, _, err := certs.Ensure("", "", dir)
	if err != nil {
		t.Fatalf("seed: %v", err)
	}

	cert, key, caPath, err := certs.Ensure(seedCert, seedKey, "")
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
	if _, _, _, err := certs.Ensure(filepath.Join(dir, certsLeafFile), "", dir); err == nil {
		t.Error("cert without key must be rejected")
	}
	if _, _, _, err := certs.Ensure("", filepath.Join(dir, certsLeafKey), dir); err == nil {
		t.Error("key without cert must be rejected")
	}
}

// TestRotatorSelfHealsVanishedLeaf: losing the leaf files must not leave the
// server without a certificate — a fresh Rotator over the same dir recreates
// the leaf from the stable dev CA. (Hot-swapping an already running Rotator is
// driven by its unexported daily check; the exported contract is that a
// restart/rebuild from the same dir self-heals and serves a loadable pair.)
func TestRotatorSelfHealsVanishedLeaf(t *testing.T) {
	dir := t.TempDir()
	r, err := certs.NewRotator("", "", dir)
	if err != nil {
		t.Fatalf("NewRotator: %v", err)
	}
	if _, err := r.GetCertificate(nil); err != nil {
		t.Fatalf("initial GetCertificate: %v", err)
	}
	if r.CACertPath() != filepath.Join(dir, certsCACertFile) {
		t.Errorf("CACertPath = %q", r.CACertPath())
	}

	// Simulate file loss; the next resolution must re-sign from the dev CA.
	if err := os.Remove(filepath.Join(dir, certsLeafFile)); err != nil {
		t.Fatalf("remove leaf: %v", err)
	}
	if err := os.Remove(filepath.Join(dir, certsLeafKey)); err != nil {
		t.Fatalf("remove leaf key: %v", err)
	}
	r2, err := certs.NewRotator("", "", dir)
	if err != nil {
		t.Fatalf("NewRotator after loss: %v", err)
	}
	if _, err := r2.GetCertificate(nil); err != nil {
		t.Fatalf("GetCertificate after self-heal: %v", err)
	}
	if _, err := tls.LoadX509KeyPair(filepath.Join(dir, certsLeafFile), filepath.Join(dir, certsLeafKey)); err != nil {
		t.Errorf("regenerated files unreadable: %v", err)
	}
}

// TestGenerateLeafKeyIsECDSAP256 pins the leaf key algorithm through the
// exported auto mode (the former in-package test called generateLeaf
// directly): the serving key must be an ECDSA P-256 key.
func TestGenerateLeafKeyIsECDSAP256(t *testing.T) {
	dir := t.TempDir()
	cert, key, _, err := certs.Ensure("", "", dir)
	if err != nil {
		t.Fatalf("Ensure: %v", err)
	}

	data, err := os.ReadFile(key)
	if err != nil {
		t.Fatalf("read leaf key: %v", err)
	}
	block, _ := pem.Decode(data)
	if block == nil {
		t.Fatalf("no PEM block in %s", key)
	}
	priv, err := x509.ParseECPrivateKey(block.Bytes)
	if err != nil {
		t.Fatalf("parse leaf key: %v", err)
	}
	if priv.Curve != elliptic.P256() {
		t.Errorf("leaf curve = %v, want P-256", priv.Curve)
	}

	pub, ok := readCert(t, cert).PublicKey.(*ecdsa.PublicKey)
	if !ok {
		t.Fatalf("leaf public key = %T, want *ecdsa.PublicKey", readCert(t, cert).PublicKey)
	}
	if pub.Curve != elliptic.P256() {
		t.Errorf("leaf public curve = %v, want P-256", pub.Curve)
	}
}
