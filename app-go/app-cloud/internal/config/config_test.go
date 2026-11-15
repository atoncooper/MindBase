package config

import (
	"os"
	"testing"
)

// P0-2 support: the attest secret parser must accept the documented formats
// and reject everything else at startup (fail loud, never silently degrade).
func TestAttestKeyBytes(t *testing.T) {
	b, err := AttestConfig{Secret: ""}.KeyBytes()
	if err != nil || b != nil {
		t.Fatalf("empty secret => (nil, nil); got %v, err %v", b, err)
	}
	hex64 := "a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4"
	hexc := AttestConfig{Secret: hex64}
	b, err = hexc.KeyBytes()
	if err != nil || len(b) != 32 {
		t.Fatalf("64 hex chars => 32 decoded bytes; got len %d, err %v", len(b), err)
	}
	raw := "0123456789abcdef0123456789abcdef0123456789abcdef" // 48 raw chars
	rawc := AttestConfig{Secret: raw}
	b, err = rawc.KeyBytes()
	if err != nil || string(b) != raw {
		t.Fatalf("raw >= 32 bytes used as-is; err %v", err)
	}
	shortc := AttestConfig{Secret: "too-short"}
	if _, err := shortc.KeyBytes(); err == nil {
		t.Fatal("short secret must be rejected")
	}
	nothexc := AttestConfig{Secret: "zzzz" + hex64[4:]} // 64 chars, not valid hex
	b, err = nothexc.KeyBytes()
	if err != nil || len(b) != 64 {
		t.Fatal("non-hex 64 chars are accepted as raw key material (>= 32 bytes rule)")
	}
}

// clearOCRTestEnv keeps the assertions deterministic regardless of the host or
// project-root .env (godotenv loads it on a best-effort basis).
func clearOCRTestEnv(t *testing.T) {
	t.Helper()
	for _, key := range []string{
		"APPCLOUD__PIPELINE__OCR__ENABLED", "APPCLOUD__PIPELINE__OCR__MODEL",
		"APPCLOUD__PIPELINE__OCR__MAX_IMAGE_BYTES", "APPCLOUD__PIPELINE__OCR__MAX_PDF_PAGES",
		"APPCLOUD__PIPELINE__OCR__MAX_IMAGES", "APPCLOUD__PIPELINE__OCR__TIMEOUT_SECONDS",
		"APPCLOUD__PIPELINE__SUMMARY__MODEL", "APPCLOUD__INTERNAL__API_KEY",
		"APPCLOUD__PIPELINE__SUMMARY__ENABLED",
		// Outbound URL defaults pinned by the shipped-YAML guard test must not
		// be shadowed by a host .env / shell export.
		"AI_GATEWAY__BASE_URL", "APPCLOUD__KG__BASE_URL",
	} {
		t.Setenv(key, "")
	}
}

func TestOCRLimitsDefaultAndEnvOverrides(t *testing.T) {
	clearOCRTestEnv(t)
	cfg, err := Load([]byte("app:\n  name: test\n"))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if cfg.Pipeline.OCR.MaxImageBytes != DefaultOCRMaxImageBytes ||
		cfg.Pipeline.OCR.MaxPDFPages != DefaultOCRMaxPDFPages ||
		cfg.Pipeline.OCR.MaxImages != DefaultOCRMaxImages ||
		cfg.Pipeline.OCR.TimeoutSecs != DefaultOCRTimeoutSecs {
		t.Fatalf("unset OCR limits must normalize to defaults, got %+v", cfg.Pipeline.OCR)
	}

	t.Setenv("APPCLOUD__PIPELINE__OCR__ENABLED", "true")
	t.Setenv("APPCLOUD__PIPELINE__OCR__MODEL", "z-ai/glm-test")
	t.Setenv("APPCLOUD__PIPELINE__OCR__MAX_IMAGE_BYTES", "2048")
	t.Setenv("APPCLOUD__PIPELINE__OCR__MAX_PDF_PAGES", "3")
	t.Setenv("APPCLOUD__PIPELINE__OCR__MAX_IMAGES", "7")
	t.Setenv("APPCLOUD__PIPELINE__OCR__TIMEOUT_SECONDS", "30")
	t.Setenv("APPCLOUD__INTERNAL__API_KEY", "internal-secret")

	cfg, err = Load([]byte("app:\n  name: test\n"))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	ocr := cfg.Pipeline.OCR
	if !ocr.Enabled || ocr.Model != "z-ai/glm-test" || ocr.MaxImageBytes != 2048 ||
		ocr.MaxPDFPages != 3 || ocr.MaxImages != 7 || ocr.TimeoutSecs != 30 {
		t.Fatalf("env overrides not applied: %+v", ocr)
	}
	if cfg.Internal.APIKey != "internal-secret" {
		t.Fatalf("internal api key = %q", cfg.Internal.APIKey)
	}
}

func TestValidateRejectsNonPositiveOCRLimits(t *testing.T) {
	cfg := &Config{}
	cfg.RDBMS.URL = "dsn"
	cfg.Minio.Enabled = true
	cfg.Minio.AccessKey = "a"
	cfg.Minio.SecretKey = "b"
	cfg.Upload.ChunkSize = 1
	cfg.Upload.MaxFileSize = 1
	cfg.Pipeline.OCR = OCRConfig{Enabled: true, Model: "m", MaxImageBytes: 0}
	if err := Validate(cfg); err == nil {
		t.Fatal("enabled OCR with a zero limit must fail validation")
	}
	cfg.Pipeline.OCR.MaxImageBytes = 1024
	cfg.Pipeline.OCR.MaxPDFPages = 1
	cfg.Pipeline.OCR.MaxImages = 1
	cfg.Pipeline.OCR.TimeoutSecs = 1
	if err := Validate(cfg); err != nil {
		t.Fatalf("valid OCR config rejected: %v", err)
	}
}

// Phase 2 HTTPS listener: APPCLOUD__SERVER__TLS__* maps onto server.tls, and
// enabling TLS without both PEM paths fails validation (fail loud at startup).
func TestServerTLSDefaultsAndEnvOverrides(t *testing.T) {
	for _, key := range []string{
		"APPCLOUD__SERVER__TLS__ENABLED", "APPCLOUD__SERVER__TLS__CERT", "APPCLOUD__SERVER__TLS__KEY",
	} {
		t.Setenv(key, "")
	}
	cfg, err := Load([]byte("app:\n  name: test\n"))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if cfg.Server.TLS.Enabled {
		t.Fatal("server.tls.enabled must default to false")
	}

	t.Setenv("APPCLOUD__SERVER__TLS__ENABLED", "true")
	t.Setenv("APPCLOUD__SERVER__TLS__CERT", "/app/certs/server.crt")
	t.Setenv("APPCLOUD__SERVER__TLS__KEY", "/app/certs/server.key")
	cfg, err = Load([]byte("app:\n  name: test\n"))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if !cfg.Server.TLS.Enabled || cfg.Server.TLS.Cert != "/app/certs/server.crt" ||
		cfg.Server.TLS.Key != "/app/certs/server.key" {
		t.Fatalf("server.tls overrides not applied: %+v", cfg.Server.TLS)
	}

	cfg.RDBMS.URL = "dsn"
	cfg.Minio.Enabled = true
	cfg.Minio.AccessKey, cfg.Minio.SecretKey = "a", "b"
	cfg.Upload.ChunkSize, cfg.Upload.MaxFileSize = 1, 1
	cfg.Server.TLS.Key = ""
	if err := Validate(cfg); err == nil {
		t.Fatal("tls.enabled without key must be rejected")
	}
}

// TestShippedDefaultYAMLCarriesContractDefaults pins the values the rest of
// the stack relies on: the summary stage must run with the routed model, and
// OCR must be on with bounded limits.
func TestShippedDefaultYAMLCarriesContractDefaults(t *testing.T) {
	clearOCRTestEnv(t)
	raw, err := os.ReadFile("../../default.yaml")
	if err != nil {
		t.Fatalf("read default.yaml: %v", err)
	}
	cfg, err := Load(raw)
	if err != nil {
		t.Fatalf("load default.yaml: %v", err)
	}
	if cfg.Pipeline.Summary.Model != "z-ai/glm-5.3-flash" || !cfg.Pipeline.Summary.Enabled {
		t.Fatalf("summary defaults = %+v", cfg.Pipeline.Summary)
	}
	ocr := cfg.Pipeline.OCR
	if !ocr.Enabled || ocr.Model != "z-ai/glm-5.3-flash" {
		t.Fatalf("ocr defaults = %+v", ocr)
	}
	if ocr.MaxImageBytes != 10485760 || ocr.MaxPDFPages != 20 || ocr.MaxImages != 40 || ocr.TimeoutSecs != 90 {
		t.Fatalf("ocr default limits = %+v", ocr)
	}
	if cfg.Internal.APIKey != "" {
		t.Fatalf("internal api key must default empty (fail closed), got %q", cfg.Internal.APIKey)
	}
	// Phase 2: HTTPS listener off by default, mounted-cert paths shipped.
	if cfg.Server.TLS.Enabled || cfg.Server.TLS.Cert != "/app/certs/server.crt" ||
		cfg.Server.TLS.Key != "/app/certs/server.key" {
		t.Fatalf("server.tls defaults = %+v", cfg.Server.TLS)
	}
	// Outbound defaults are HTTPS (APISIX 9443 / app-kg 8014 / Higress 8443).
	if cfg.Quota.MembershipBaseURL != "https://apisix:9443/internal/pay" ||
		cfg.Kg.BaseURL != "https://app-kg:8014" ||
		cfg.Pipeline.Embedding.BaseURL != "https://higress:8443/v1" {
		t.Fatalf("outbound https defaults: quota=%q kg=%q embedding=%q",
			cfg.Quota.MembershipBaseURL, cfg.Kg.BaseURL, cfg.Pipeline.Embedding.BaseURL)
	}
}
