package config

// Tests for the layered config loading: embedded base -> -config overlay file
// -> PAYADMIN__ env overrides, plus guards on the committed overlay files
// (config.dev.yaml / config.docker.yaml must stay parseable).

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadOverlayPrecedence(t *testing.T) {
	dir := t.TempDir()
	overlay := filepath.Join(dir, "overlay.yaml")
	// Overlay sets port + url; leaves host untouched.
	if err := os.WriteFile(overlay, []byte(
		"server:\n  port: 9999\nrdbms:\n  url: \"mysql+aiomysql://u:p@h:3306/db\"\n",
	), 0o644); err != nil {
		t.Fatalf("write overlay: %v", err)
	}

	base := []byte("server:\n  host: 0.0.0.0\n  port: 8003\nrdbms:\n  url: \"\"\n")
	t.Setenv("PAYADMIN__LOG__LEVEL", "debug") // env beats the overlay file

	cfg, err := Load(base, overlay)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if cfg.Server.Port != 9999 {
		t.Fatalf("overlay port = %d, want 9999", cfg.Server.Port)
	}
	if cfg.RDBMS.URL != "mysql+aiomysql://u:p@h:3306/db" {
		t.Fatalf("overlay url = %q", cfg.RDBMS.URL)
	}
	if cfg.Server.Host != "0.0.0.0" {
		t.Fatalf("base host must survive the overlay, got %q", cfg.Server.Host)
	}
	if cfg.Log.Level != "debug" {
		t.Fatalf("env override must win over everything, got %q", cfg.Log.Level)
	}
}

func TestLoadWithoutOverlay(t *testing.T) {
	base := []byte("server:\n  port: 8003\n")
	cfg, err := Load(base, "")
	if err != nil {
		t.Fatalf("load without overlay: %v", err)
	}
	if cfg.Server.Port != 8003 || cfg.RDBMS.URL != "" {
		t.Fatalf("base-only config: %+v", cfg)
	}
}

func TestLoadMissingOverlayFailsLoud(t *testing.T) {
	if _, err := Load([]byte("app:\n  name: x\n"), filepath.Join(t.TempDir(), "nope.yaml")); err == nil {
		t.Fatal("an explicitly given -config file that is missing must fail loud")
	}
}

// Guard: the two committed overlay files must stay valid YAML and carry their
// expected shape (dev has a concrete DSN; docker leaves the DSN to env).
func TestCommittedOverlayFiles(t *testing.T) {
	base := []byte("server:\n  host: 0.0.0.0\n  port: 8003\nrdbms:\n  url: \"\"\n")

	dev, err := Load(base, "../../config.dev.yaml")
	if err != nil {
		t.Fatalf("config.dev.yaml: %v", err)
	}
	if dev.RDBMS.URL == "" {
		t.Fatal("config.dev.yaml must pin the local dev DSN (127.0.0.1:3307)")
	}
	if dev.App.Debug != true {
		t.Fatal("config.dev.yaml should enable debug for local development")
	}

	docker, err := Load(base, "../../config.docker.yaml")
	if err != nil {
		t.Fatalf("config.docker.yaml: %v", err)
	}
	if docker.RDBMS.URL != "" {
		t.Fatal("config.docker.yaml must NOT pin a DSN (compose injects PAYADMIN__RDBMS__URL)")
	}
	if docker.Log.Output != "both" {
		t.Fatalf("config.docker.yaml log output = %q, want both", docker.Log.Output)
	}
}

func TestValidateFailsWithoutDSN(t *testing.T) {
	if err := Validate(&Config{}); err == nil {
		t.Fatal("Validate must fail loud when rdbms.url is empty")
	}
	if err := Validate(&Config{RDBMS: RDBMSConfig{URL: "mysql+aiomysql://u:p@h/db"}}); err != nil {
		t.Fatalf("Validate with DSN: %v", err)
	}
}

func TestValidateTLSCertKeyPairSemantics(t *testing.T) {
	base := func() *Config {
		return &Config{RDBMS: RDBMSConfig{URL: "mysql+aiomysql://u:p@h/db"}}
	}
	// 只给 cert 不给 key（或反之）→ fail loud；双双留空=自动生成，合法。
	cfg := base()
	cfg.Server.TLS.Enabled = true
	cfg.Server.TLS.Cert = "/certs/admin.crt"
	if err := Validate(cfg); err == nil {
		t.Fatal("TLS enabled with cert but no key must fail loud")
	}
	cfg.Server.TLS.Key = "/certs/admin.key"
	if err := Validate(cfg); err != nil {
		t.Fatalf("TLS with both paths: %v", err)
	}
	// 双双留空 = 自动生成模式，合法。
	cfg.Server.TLS.Cert, cfg.Server.TLS.Key = "", ""
	if err := Validate(cfg); err != nil {
		t.Fatalf("TLS auto-generate mode: %v", err)
	}
	// 未启用时路径无所谓。
	cfg.Server.TLS.Enabled = false
	cfg.Server.TLS.Cert = "/certs/admin.crt"
	if err := Validate(cfg); err != nil {
		t.Fatalf("TLS disabled: %v", err)
	}
}

func TestCorsAllowOriginsEnvOverride(t *testing.T) {
	base := []byte("server:\n  port: 8003\n")
	t.Setenv("PAYADMIN__SECURITY__CORS__ALLOW_ORIGINS",
		" https://a.example.com , https://b.example.com ,,")
	cfg, err := Load(base, "")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	got := cfg.Security.CORS.AllowOrigins
	if len(got) != 2 || got[0] != "https://a.example.com" || got[1] != "https://b.example.com" {
		t.Fatalf("cors origins = %v, want 2 trimmed entries", got)
	}
}

func TestTLSOverlayParse(t *testing.T) {
	dir := t.TempDir()
	overlay := filepath.Join(dir, "o.yaml")
	if err := os.WriteFile(overlay, []byte(
		"server:\n  tls:\n    enabled: true\n    cert: /c/admin.crt\n    key: /c/admin.key\n",
	), 0o644); err != nil {
		t.Fatalf("write overlay: %v", err)
	}
	cfg, err := Load([]byte("server:\n  host: 0.0.0.0\n"), overlay)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if !cfg.Server.TLS.Enabled || cfg.Server.TLS.Cert != "/c/admin.crt" || cfg.Server.TLS.Key != "/c/admin.key" {
		t.Fatalf("tls overlay: %+v", cfg.Server.TLS)
	}
}
