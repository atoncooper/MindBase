package certgen

// Tests for the runtime rotator: auto-mode regeneration near expiry / on
// missing files, and explicit-mode reload when the files change on disk.

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

func TestRotatorAutoRegeneratesNearExpiry(t *testing.T) {
	dir := t.TempDir()
	r, err := NewRotator("", "", dir)
	if err != nil {
		t.Fatalf("new rotator: %v", err)
	}

	// 用 2 小时有效期的证书覆盖，模拟"临近过期"。
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

	r.reloadOnce() // 余量 2h < 30d 阈值 → 重生成

	fresh := serialOf(t, r.certPath)
	if old.Cmp(fresh) == 0 {
		t.Fatal("cert must be regenerated when nearing expiry")
	}
	cur := r.current.Load()
	if cur == nil || cur.Leaf == nil || time.Until(cur.Leaf.NotAfter) < 800*24*time.Hour {
		t.Fatal("current cert must be the fresh long-validity one")
	}

	// 文件被删 → 下次巡检自愈重建。
	if err := os.Remove(r.certPath); err != nil {
		t.Fatalf("remove cert: %v", err)
	}
	r.reloadOnce()
	if _, err := os.Stat(r.certPath); err != nil {
		t.Fatalf("cert must self-heal after deletion: %v", err)
	}
}

func TestRotatorExplicitReloadsOnFileChange(t *testing.T) {
	dir := t.TempDir()
	c, k, err := Ensure("", "", dir) // 生成一对文件作为"外部管理的证书"
	if err != nil {
		t.Fatalf("seed pair: %v", err)
	}
	r, err := NewRotator(c, k, "")
	if err != nil {
		t.Fatalf("new rotator: %v", err)
	}
	if r.auto {
		t.Fatal("explicit paths must not be auto mode")
	}
	old := serialOf(t, c)

	// 外部换发：覆盖为新证书（串号必不同），巡检后应重载。
	certPEM, keyPEM, err := generate(825 * 24 * time.Hour)
	if err != nil {
		t.Fatalf("generate new pair: %v", err)
	}
	if err := os.WriteFile(c, certPEM, 0o644); err != nil {
		t.Fatalf("write cert: %v", err)
	}
	if err := os.WriteFile(k, keyPEM, 0o600); err != nil {
		t.Fatalf("write key: %v", err)
	}
	r.reloadOnce()
	if serialOf(t, c).Cmp(old) == 0 {
		t.Fatal("test setup: new pair must differ from old")
	}
	cur := r.current.Load()
	if cur == nil || cur.Leaf == nil || cur.Leaf.SerialNumber.Cmp(old) == 0 {
		t.Fatal("explicit cert file change must be reloaded into current")
	}

	// GetCertificate 回调应返回当前证书。
	got, err := r.GetCertificate(nil)
	if err != nil || got.Leaf.SerialNumber.Cmp(cur.Leaf.SerialNumber) != 0 {
		t.Fatal("GetCertificate must serve the current certificate")
	}
}
