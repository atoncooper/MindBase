package tests

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"testing"
	"time"

	appboardtls "app-content/internal/infra/tls/board"
)

// The auto mode must produce a stable dev CA plus a leaf that CHAINS to it —
// that property is what lets APISIX trust the upstream with just dev-ca.crt.
func TestTLSAutoChain(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath, caPath, err := appboardtls.Ensure("", "", dir)
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if caPath == "" {
		t.Fatal("auto mode must return the CA cert path")
	}
	if filepath.Dir(certPath) != dir || filepath.Base(certPath) != "server.crt" {
		t.Fatalf("cert path = %s", certPath)
	}

	pair, err := tls.LoadX509KeyPair(certPath, keyPath)
	if err != nil {
		t.Fatalf("load leaf: %v", err)
	}
	if pair.Leaf == nil {
		t.Fatal("leaf not parsed")
	}
	// 825-day leaf: must stay valid well beyond the 30-day rotate window.
	if !pair.Leaf.NotAfter.After(time.Now().Add(720 * 24 * time.Hour)) {
		t.Fatalf("leaf validity too short: %s", pair.Leaf.NotAfter)
	}

	caPEM, err := os.ReadFile(caPath)
	if err != nil {
		t.Fatalf("read ca: %v", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		t.Fatal("ca pem undecodable")
	}
	for _, dns := range []string{"app-content", "app-board", "mindbase"} {
		if _, err := pair.Leaf.Verify(x509.VerifyOptions{
			DNSName:     dns,
			Roots:       pool,
			CurrentTime: time.Now(),
			KeyUsages:   []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		}); err != nil {
			t.Fatalf("leaf does not chain/cover %q: %v", dns, err)
		}
	}
}

// Re-Ensure on the same dir must REUSE both CA and leaf (no rotation on restart).
func TestTLSReusesValidFiles(t *testing.T) {
	dir := t.TempDir()
	cert1, _, ca1, err := appboardtls.Ensure("", "", dir)
	if err != nil {
		t.Fatalf("first ensure: %v", err)
	}
	cert2, _, ca2, err := appboardtls.Ensure("", "", dir)
	if err != nil {
		t.Fatalf("second ensure: %v", err)
	}
	if cert1 != cert2 || ca1 != ca2 {
		t.Fatalf("paths changed: %s/%s vs %s/%s", cert1, ca1, cert2, ca2)
	}
}

func TestTLSExplicitMode(t *testing.T) {
	dir := t.TempDir()
	leaf, key, _, err := appboardtls.Ensure("", "", dir)
	if err != nil {
		t.Fatalf("seed: %v", err)
	}
	leaf2 := filepath.Join(dir, "explicit.crt")
	key2 := filepath.Join(dir, "explicit.key")
	if err := os.Rename(leaf, leaf2); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(key, key2); err != nil {
		t.Fatal(err)
	}
	cert, k, ca, err := appboardtls.Ensure(leaf2, key2, "")
	if err != nil {
		t.Fatalf("explicit ensure: %v", err)
	}
	if cert != leaf2 || k != key2 || ca != "" {
		t.Fatalf("explicit mode returned cert=%s ca=%s", cert, ca)
	}
}

func TestTLSOneSidedPathRejected(t *testing.T) {
	if _, _, _, err := appboardtls.Ensure("only-cert.crt", "", ""); err == nil {
		t.Fatal("cert without key must be rejected")
	}
}

// Rotator must self-heal: deleting the leaf file makes the next check re-sign
// it from the stable CA.
func TestTLSRotatorSelfHeal(t *testing.T) {
	dir := t.TempDir()
	r, err := appboardtls.NewRotator("", "", dir)
	if err != nil {
		t.Fatalf("new rotator: %v", err)
	}
	certPath := r.CertPath()
	before, err := os.ReadFile(certPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(certPath); err != nil {
		t.Fatal(err)
	}
	if err := r.CheckNow(); err != nil {
		t.Fatalf("reload after delete: %v", err)
	}
	after, err := os.ReadFile(certPath)
	if err != nil {
		t.Fatal("leaf not regenerated")
	}
	if string(before) == string(after) {
		t.Fatal("leaf regenerated identical — new key expected")
	}
	if r.Current() == nil {
		t.Fatal("rotator lost its certificate")
	}
}

// A near-expiry leaf must be re-signed on the next check (below the 30-day
// rotate window). We write a short-lived self-signed leaf; the rotator then
// replaces it with a CA-signed one.
func TestTLSRotatorReSignsNearExpiry(t *testing.T) {
	dir := t.TempDir()
	r, err := appboardtls.NewRotator("", "", dir)
	if err != nil {
		t.Fatalf("new rotator: %v", err)
	}
	shortCert, shortKey := selfSignedLeaf(t, "short.example", 10*24*time.Hour)
	if err := os.WriteFile(r.CertPath(), shortCert, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(r.KeyPath(), shortKey, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := r.CheckNow(); err != nil {
		t.Fatalf("reload: %v", err)
	}
	pair, err := tls.LoadX509KeyPair(r.CertPath(), r.KeyPath())
	if err != nil {
		t.Fatal(err)
	}
	if pair.Leaf == nil || time.Until(pair.Leaf.NotAfter) <= 30*24*time.Hour {
		t.Fatalf("leaf not renewed: %v", pair.Leaf)
	}
}

func selfSignedLeaf(t *testing.T, dns string, validity time.Duration) ([]byte, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		t.Fatal(err)
	}
	tmpl := x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: dns},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(validity),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{dns},
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
}
