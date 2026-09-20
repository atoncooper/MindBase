package config

import (
	"strings"
	"testing"
)

func TestLoadDefaults(t *testing.T) {
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Upstream.BaseURL != "http://127.0.0.1:9080" {
		t.Errorf("BaseURL = %q", cfg.Upstream.BaseURL)
	}
	if cfg.Server.Transport != TransportStdio || cfg.Server.HTTPAddr != ":8005" {
		t.Errorf("server defaults = %+v", cfg.Server)
	}
	if cfg.APIKeySet() || cfg.UIDSet() {
		t.Errorf("credentials should be unset in a clean env: %+v", cfg.Upstream)
	}
}

func TestLoadInvalidUID(t *testing.T) {
	t.Setenv("BOARDMCP__UPSTREAM__UID", "not-a-number")
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "BOARDMCP__UPSTREAM__UID") {
		t.Errorf("want UID validation error, got %v", err)
	}
}

func TestLoadZeroUIDRejected(t *testing.T) {
	t.Setenv("BOARDMCP__UPSTREAM__UID", "0")
	if _, err := Load(); err == nil {
		t.Error("uid 0 must be rejected")
	}
}

func TestLoadValidUID(t *testing.T) {
	t.Setenv("BOARDMCP__UPSTREAM__UID", "12345")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !cfg.UIDSet() || cfg.Upstream.UID != 12345 {
		t.Errorf("UID = %d, want 12345", cfg.Upstream.UID)
	}
}

func TestLoadInvalidTransport(t *testing.T) {
	t.Setenv("BOARDMCP__SERVER__TRANSPORT", "grpc")
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "TRANSPORT") {
		t.Errorf("want transport validation error, got %v", err)
	}
}

func TestLoadHTTPFailsClosedWithoutToken(t *testing.T) {
	t.Setenv("BOARDMCP__SERVER__TRANSPORT", "http")
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "AUTH_TOKEN") {
		t.Errorf("http without auth token must fail closed, got %v", err)
	}

	t.Setenv("BOARDMCP__SERVER__AUTH_TOKEN", "tok")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("http with auth token: %v", err)
	}
	if !cfg.AuthTokenSet() {
		t.Error("AuthTokenSet = false")
	}
	if cfg.Server.RateLimitRPS != 10 || cfg.Server.RateLimitBurst != 20 || cfg.Server.MaxInflight != 8 {
		t.Errorf("hardening defaults = %+v", cfg.Server)
	}
}

func TestLoadStdioNeedsNoToken(t *testing.T) {
	if _, err := Load(); err != nil {
		t.Fatalf("stdio without auth token must boot, got %v", err)
	}
}

func TestLoadAllowedOrigins(t *testing.T) {
	t.Setenv("BOARDMCP__SERVER__ALLOWED_ORIGINS", "http://a:3000, https://b ,")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	got := cfg.Server.AllowedOrigins
	if len(got) != 2 || got[0] != "http://a:3000" || got[1] != "https://b" {
		t.Errorf("AllowedOrigins = %v", got)
	}
}
