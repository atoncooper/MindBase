// Package certgen resolves the TLS certificate for HTTPS serving of the
// embedded web console.
//
// Two modes (server.tls):
//   - explicit cert+key file paths -> load and use them (production: CA-issued);
//   - both empty -> auto-generate a self-signed development certificate and
//     PERSIST it under the cert dir (auto.crt/auto.key); subsequent starts
//     reuse the files while they remain valid (>72h), so the certificate does
//     not rotate on every restart.
//
// Self-signed dev certificates trigger browser warnings until the cert is
// imported into the trust store; for a warning-free workflow import auto.crt
// as a trust anchor (it is generated with CA:TRUE for exactly that purpose).
package certgen

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

// Ensure returns usable cert/key file paths:
//   - certPath+keyPath both set -> load them (fail loud on unreadable/broken);
//   - exactly one set -> invalid configuration;
//   - both empty -> auto-generate under dir (default "certs") and save.
func Ensure(certPath, keyPath, dir string) (string, string, error) {
	switch {
	case certPath != "" && keyPath != "":
		if _, err := tls.LoadX509KeyPair(certPath, keyPath); err != nil {
			return "", "", fmt.Errorf("load tls cert/key: %w", err)
		}
		return certPath, keyPath, nil
	case certPath != "" || keyPath != "":
		return "", "", fmt.Errorf("tls cert and key must be provided together, or both empty (empty = auto-generate a dev certificate)")
	}

	if dir == "" {
		dir = "certs"
	}
	certPath = filepath.Join(dir, "auto.crt")
	keyPath = filepath.Join(dir, "auto.key")

	// Reuse the existing certificate while it stays valid (>72h) so it does
	// not change on every restart.
	if pair, err := tls.LoadX509KeyPair(certPath, keyPath); err == nil && pair.Leaf != nil {
		if time.Until(pair.Leaf.NotAfter) > 72*time.Hour {
			return certPath, keyPath, nil
		}
	}

	certPEM, keyPEM, err := generate(825 * 24 * time.Hour)
	if err != nil {
		return "", "", fmt.Errorf("generate self-signed cert: %w", err)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", "", fmt.Errorf("create cert dir: %w", err)
	}
	if err := os.WriteFile(keyPath, keyPEM, 0o600); err != nil {
		return "", "", fmt.Errorf("write key: %w", err)
	}
	if err := os.WriteFile(certPath, certPEM, 0o644); err != nil {
		return "", "", fmt.Errorf("write cert: %w", err)
	}
	return certPath, keyPath, nil
}

// generate creates one self-signed certificate (ECDSA P-256, SANs covering
// loopback/hostname/container name). CA:TRUE so the file can be imported as a
// trust anchor for warning-free local browsing.
func generate(validity time.Duration) (certPEM, keyPEM []byte, err error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, nil, err
	}
	host, _ := os.Hostname()
	tmpl := x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "app-task-dev", Organization: []string{"MindBase"}},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(validity),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  true,
		DNSNames:              []string{"localhost", "app-task"},
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
	}
	if host != "" {
		tmpl.DNSNames = append(tmpl.DNSNames, host)
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, nil, err
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, nil, err
	}
	certPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM = pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	return certPEM, keyPEM, nil
}

// Rotator holds the currently effective certificate for tls.Config
// GetCertificate and re-checks it on a fixed ticker:
//   - auto mode: regenerate (tmp+rename, atomic) when the stored certificate
//     is near expiry or the files went missing; new TLS handshakes pick up the
//     new certificate immediately, no restart;
//   - explicit file mode: reload when the files change on disk (external
//     renewal); near-expiry only logs a warning (cannot self-renew).
type Rotator struct {
	certPath string
	keyPath  string
	auto     bool

	current atomic.Pointer[tls.Certificate]

	checkEvery   time.Duration // ticker period (default 24h)
	rotateWithin time.Duration // auto-mode regeneration threshold (default 30 days)
	genValidity  time.Duration // validity for regenerated certificates (default 825 days)
}

// NewRotator completes the startup resolution (Ensure) and loads the initial
// certificate into memory.
func NewRotator(certPath, keyPath, dir string) (*Rotator, error) {
	auto := certPath == "" && keyPath == "" // both empty = auto-generate mode
	certPath, keyPath, err := Ensure(certPath, keyPath, dir)
	if err != nil {
		return nil, err
	}
	r := &Rotator{
		certPath:     certPath,
		keyPath:      keyPath,
		auto:         auto,
		checkEvery:   24 * time.Hour,
		rotateWithin: 30 * 24 * time.Hour,
		genValidity:  825 * 24 * time.Hour,
	}
	r.reloadOnce()
	if r.current.Load() == nil {
		return nil, fmt.Errorf("load initial tls certificate from %s", certPath)
	}
	return r, nil
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
		t := time.NewTicker(r.checkEvery)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				r.reloadOnce()
			}
		}
	}()
}

// reloadOnce re-reads/regenerates the certificate and swaps it atomically.
// Any failure keeps the currently loaded certificate (log, never crash).
func (r *Rotator) reloadOnce() {
	if !r.auto {
		pair, err := tls.LoadX509KeyPair(r.certPath, r.keyPath)
		if err != nil {
			slog.Error("[TLS] reload explicit certificate failed, keeping current", "err", err)
			return
		}
		r.current.Store(&pair)
		if pair.Leaf != nil && time.Until(pair.Leaf.NotAfter) < r.rotateWithin {
			slog.Warn("[TLS] certificate nearing expiry — renew externally",
				"cert", r.certPath, "not_after", pair.Leaf.NotAfter.Format(time.RFC3339))
		}
		return
	}

	pair, err := tls.LoadX509KeyPair(r.certPath, r.keyPath)
	if err == nil && pair.Leaf != nil && time.Until(pair.Leaf.NotAfter) >= r.rotateWithin {
		r.current.Store(&pair) // still healthy, no rotation needed
		return
	}
	reason := "nearing expiry"
	if err != nil {
		reason = "missing/unreadable"
	}
	if err := r.regenerate(); err != nil {
		slog.Error("[TLS] auto rotate failed, keeping current", "reason", reason, "err", err)
		return
	}
	pair, err = tls.LoadX509KeyPair(r.certPath, r.keyPath)
	if err != nil {
		slog.Error("[TLS] reload rotated certificate failed", "err", err)
		return
	}
	notAfter := ""
	if pair.Leaf != nil {
		notAfter = pair.Leaf.NotAfter.Format(time.RFC3339)
	}
	slog.Info("[TLS] certificate rotated", "reason", reason, "cert", r.certPath, "not_after", notAfter)
	r.current.Store(&pair)
}

// regenerate writes the new key/cert via tmp+rename (best-effort atomicity).
func (r *Rotator) regenerate() error {
	certPEM, keyPEM, err := generate(r.genValidity)
	if err != nil {
		return err
	}
	certTmp, keyTmp := r.certPath+".tmp", r.keyPath+".tmp"
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

// CertPath returns the resolved certificate file path (for startup logging).
func (r *Rotator) CertPath() string { return r.certPath }
