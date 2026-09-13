// Package tls resolves and rotates the serving certificate.
//
// Two modes (server.tls):
//   - explicit cert+key file paths -> load and use them (production: CA-issued
//     certificates managed externally); the CA must then be trusted by APISIX;
//   - both empty -> auto mode: a persistent dev CA (dev-ca.key/dev-ca.crt,
//     10 years) plus a leaf certificate signed by THAT CA (server.crt/key,
//     ECDSA P-256, 825 days, SAN app-board/localhost/loopback). Because every
//     leaf chains to the same stable dev CA, APISIX can set tls_verify: true
//     with just dev-ca.crt mounted — even in auto mode.
//
// Rotator re-checks daily: auto mode re-signs the leaf when it has <30 days
// left (or the file vanished — self-heal) and hot-swaps via GetCertificate;
// explicit mode reloads changed files and only warns on nearing expiry.
package tls

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"log/slog"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"
)

const (
	caCertFile = "dev-ca.crt"
	caKeyFile  = "dev-ca.key"
	leafFile   = "server.crt"
	leafKey    = "server.key"

	caValidity    = 10 * 365 * 24 * time.Hour
	leafValidity  = 825 * 24 * time.Hour
	rotateWithin  = 30 * 24 * time.Hour
	checkInterval = 24 * time.Hour
)

// Ensure resolves the cert/key paths (auto mode generates what's missing)
// and returns them together with the CA cert path (empty in explicit mode —
// the operator supplies their own trust chain).
func Ensure(certPath, keyPath, dir string) (cert, key, caPath string, err error) {
	switch {
	case certPath != "" && keyPath != "":
		if _, err := tls.LoadX509KeyPair(certPath, keyPath); err != nil {
			return "", "", "", fmt.Errorf("load tls cert/key: %w", err)
		}
		return certPath, keyPath, "", nil
	case certPath != "" || keyPath != "":
		return "", "", "", fmt.Errorf("tls cert 与 key 须同时提供，或同时留空（留空=自动生成开发 CA+证书）")
	}

	if dir == "" {
		dir = "certs"
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", "", "", fmt.Errorf("create cert dir: %w", err)
	}
	caPath = filepath.Join(dir, caCertFile)
	leafPath := filepath.Join(dir, leafFile)
	leafKeyPath := filepath.Join(dir, leafKey)

	ca, err := ensureCA(dir, caPath)
	if err != nil {
		return "", "", "", err
	}
	if err := ensureLeaf(leafPath, leafKeyPath, ca); err != nil {
		return "", "", "", err
	}
	return leafPath, leafKeyPath, caPath, nil
}

// caKeyPair loads or creates the persistent dev CA (CN app-board-dev-ca).
func ensureCA(dir, caPath string) (*caKeyPair, error) {
	caKeyPath := filepath.Join(dir, caKeyFile)
	if pair, err := tls.LoadX509KeyPair(caPath, caKeyPath); err == nil && pair.Leaf != nil {
		if time.Until(pair.Leaf.NotAfter) > 72*time.Hour {
			return loadCAPrivate(caPath, caKeyPath, &pair)
		}
		slog.Info("[TLS] dev CA nearing expiry, regenerating", "ca", caPath)
	}

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate ca key: %w", err)
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, err
	}
	tmpl := x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "app-board-dev-ca", Organization: []string{"MindBase"}},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(caValidity),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLen:            1,
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, fmt.Errorf("create ca cert: %w", err)
	}
	if err := writePEM(caPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644); err != nil {
		return nil, err
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, err
	}
	if err := writePEM(caKeyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), 0o600); err != nil {
		return nil, err
	}
	slog.Info("[TLS] dev CA generated", "ca", caPath, "not_after", tmpl.NotAfter.Format(time.RFC3339))
	return loadCAPrivate(caPath, caKeyPath, nil)
}

type caKeyPair struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
}

func loadCAPrivate(caPath, caKeyPath string, pair *tls.Certificate) (*caKeyPair, error) {
	if pair == nil {
		var err error
		p, err := tls.LoadX509KeyPair(caPath, caKeyPath)
		if err != nil {
			return nil, fmt.Errorf("load ca: %w", err)
		}
		pair = &p
	}
	key, ok := pair.PrivateKey.(*ecdsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("ca key is not ECDSA")
	}
	return &caKeyPair{cert: pair.Leaf, key: key}, nil
}

// ensureLeaf (re)creates the leaf iff missing or expiring within rotateWithin.
func ensureLeaf(leafPath, leafKeyPath string, ca *caKeyPair) error {
	if pair, err := tls.LoadX509KeyPair(leafPath, leafKeyPath); err == nil && pair.Leaf != nil {
		if time.Until(pair.Leaf.NotAfter) > rotateWithin {
			return nil
		}
		slog.Info("[TLS] leaf nearing expiry, re-signing", "cert", leafPath)
	}
	certPEM, keyPEM, err := generateLeaf(ca, leafValidity)
	if err != nil {
		return err
	}
	if err := writePEM(leafKeyPath, keyPEM, 0o600); err != nil {
		return err
	}
	return writePEM(leafPath, certPEM, 0o644)
}

// generateLeaf signs one server certificate with the dev CA. SANs cover the
// container DNS name (SNI target), the service hostname and loopback for
// local `go run` debugging.
func generateLeaf(ca *caKeyPair, validity time.Duration) (certPEM, keyPEM []byte, err error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, fmt.Errorf("generate leaf key: %w", err)
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, nil, err
	}
	host, _ := os.Hostname()
	tmpl := x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "app-board", Organization: []string{"MindBase"}},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(validity),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		DNSNames:              []string{"localhost", "app-board"},
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
	}
	if host != "" {
		tmpl.DNSNames = append(tmpl.DNSNames, host)
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, ca.cert, &key.PublicKey, ca.key)
	if err != nil {
		return nil, nil, fmt.Errorf("sign leaf: %w", err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, nil, err
	}
	certPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM = pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	return certPEM, keyPEM, nil
}

func writePEM(path string, data []byte, mode os.FileMode) error {
	if err := os.WriteFile(path, data, mode); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	return nil
}

// ── 运行期自动轮换 ──────────────────────────────────────────────────
//
// Rotator holds the live certificate for tls.Config.GetCertificate; a
// background goroutine re-checks daily. Auto mode: re-sign the leaf from the
// stable dev CA when expiring within rotateWithin or when files vanish
// (atomic tmp+rename), hot-swap without restart. Explicit mode: reload
// changed files; nearing expiry only warns (renewal is external).

type Rotator struct {
	certPath string
	keyPath  string
	caPath   string
	auto     bool

	current atomic.Pointer[tls.Certificate]
}

// NewRotator completes the startup resolution and loads the initial cert.
func NewRotator(certPath, keyPath, dir string) (*Rotator, error) {
	auto := certPath == "" && keyPath == ""
	certPath, keyPath, caPath, err := Ensure(certPath, keyPath, dir)
	if err != nil {
		return nil, err
	}
	r := &Rotator{certPath: certPath, keyPath: keyPath, caPath: caPath, auto: auto}
	if err := r.reloadOnce(); err != nil {
		return nil, fmt.Errorf("load initial tls certificate: %w", err)
	}
	return r, nil
}

// CACertPath returns the dev CA cert path (auto mode) — mounted into APISIX
// as the trust anchor for tls_verify. Empty in explicit mode.
func (r *Rotator) CACertPath() string { return r.caPath }

// Summary logs the resolved TLS posture at startup (paths only, no secrets).
func (r *Rotator) Summary() {
	mode := "explicit"
	if r.auto {
		mode = "auto (dev CA + leaf)"
	}
	slog.Info("[TLS] serving certificate resolved",
		"mode", mode, "cert", r.certPath, "ca", r.caPath)
}

// GetCertificate is wired into tls.Config; called per new TLS handshake.
func (r *Rotator) GetCertificate(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	if c := r.current.Load(); c != nil {
		return c, nil
	}
	return nil, fmt.Errorf("no tls certificate loaded")
}

// Start launches the periodic rotation check until stop is closed.
func (r *Rotator) Start(stop <-chan struct{}) {
	go func() {
		t := time.NewTicker(checkInterval)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				_ = r.reloadOnce()
			}
		}
	}()
}

// reloadOnce re-reads or re-signs the certificate and swaps it atomically.
// Any failure keeps the currently loaded certificate (log, never crash).
func (r *Rotator) reloadOnce() error {
	pair, err := tls.LoadX509KeyPair(r.certPath, r.keyPath)
	if err == nil && pair.Leaf != nil && time.Until(pair.Leaf.NotAfter) >= rotateWithin {
		r.current.Store(&pair)
		return nil
	}

	reason := "nearing expiry"
	if err != nil {
		reason = "missing/unreadable"
	}
	if !r.auto {
		if err != nil {
			// Explicit files vanished/broken: keep serving the in-memory
			// cert and complain loudly — the operator must fix the files.
			return fmt.Errorf("explicit certificate %s: %w (keeping in-memory certificate)", r.certPath, err)
		}
		r.current.Store(&pair)
		slog.Warn("[TLS] explicit certificate nearing expiry — renew externally",
			"cert", r.certPath, "not_after", pair.Leaf.NotAfter.Format(time.RFC3339))
		return nil
	}

	// Auto mode: re-sign from the stable dev CA (self-heal for vanished
	// files, renewal for near-expiry ones) via tmp+rename atomicity.
	if err := r.regenerate(); err != nil {
		return fmt.Errorf("rotate leaf: %w (keeping current certificate, reason: %s)", err, reason)
	}
	if err := r.reloadOnce(); err != nil {
		return err
	}
	slog.Info("[TLS] leaf certificate rotated", "reason", reason, "cert", r.certPath)
	return nil
}

func (r *Rotator) regenerate() error {
	dir := filepath.Dir(r.certPath)
	ca, err := ensureCA(dir, r.caPath)
	if err != nil {
		return err
	}
	certPEM, keyPEM, err := generateLeaf(ca, leafValidity)
	if err != nil {
		return err
	}
	keyTmp := r.keyPath + ".tmp"
	certTmp := r.certPath + ".tmp"
	if err := os.WriteFile(keyTmp, keyPEM, 0o600); err != nil {
		return err
	}
	if err := os.WriteFile(certTmp, certPEM, 0o644); err != nil {
		_ = os.Remove(keyTmp)
		return err
	}
	if err := os.Rename(keyTmp, r.keyPath); err != nil {
		_ = os.Remove(keyTmp)
		_ = os.Remove(certTmp)
		return err
	}
	if err := os.Rename(certTmp, r.certPath); err != nil {
		_ = os.Remove(certTmp)
		return err
	}
	return nil
}
