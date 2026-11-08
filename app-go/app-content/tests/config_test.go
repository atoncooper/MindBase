package tests

import (
	"strings"
	"testing"

	"app-content/internal/config"
)

// Single listener: the one port comes from the process-wide server section.
func TestLoadConfigSinglePort(t *testing.T) {
	t.Setenv("APPBOARD__SERVER__PORT", "18004")
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if cfg.Server.Port != 18004 {
		t.Errorf("single listener port = %d", cfg.Server.Port)
	}
	if !cfg.Server.TLS.Enabled {
		t.Error("single listener should keep TLS enabled by default")
	}
}

func TestConfigDefaults(t *testing.T) {
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if cfg.Server.Port != 8004 {
		t.Fatalf("default single-listener port = %d, want 8004", cfg.Server.Port)
	}
	if !cfg.Server.TLS.Enabled || cfg.Server.TLS.CertDir == "" {
		t.Fatalf("TLS defaults missing: %+v", cfg.Server.TLS)
	}
	if cfg.Log.File.Path != "/app/logs/app-content.log" {
		t.Fatalf("log path = %q", cfg.Log.File.Path)
	}
	if cfg.Database.MySQL.MaxOpenConns != 20 || cfg.Database.Redis.KeyPrefix != "mind-base:" {
		t.Fatalf("database defaults missing: %+v", cfg.Database)
	}
}

// The env allow-list must REPLACE the YAML defaults so production can narrow
// CORS instead of silently keeping localhost origins.
func TestCORSAllowOriginsEnvReplacesDefaults(t *testing.T) {
	t.Setenv("CONTENT__SECURITY__CORS__ALLOW_ORIGINS", "https://app.example.com")
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	origins := cfg.Security.CORS.AllowOrigins
	if len(origins) != 1 || origins[0] != "https://app.example.com" {
		t.Fatalf("origins = %v, want exactly the env value", origins)
	}
}

// Credentials mode makes "*" insecure: validation must refuse it process-wide.
func TestWildcardCORSRejected(t *testing.T) {
	t.Setenv("CONTENT__SECURITY__CORS__ALLOW_ORIGINS", "*")
	if _, err := config.Load(); err == nil || !strings.Contains(err.Error(), "cors") {
		t.Fatalf("Load error = %v, want wildcard rejection", err)
	}
}

func TestInternalAPIKeyFromEnv(t *testing.T) {
	t.Setenv("CONTENT__INTERNAL_API_KEY", "svc-token")
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if cfg.Security.InternalAPIKey != "svc-token" {
		t.Fatalf("internal api key = %q", cfg.Security.InternalAPIKey)
	}
}

func TestAdvancedEnvOverrides(t *testing.T) {
	t.Setenv("CONTENT__SERVER__HTTP2", "false")
	t.Setenv("CONTENT__SERVER__TIMEOUTS__READ_SECONDS", "45")
	t.Setenv("CONTENT__SECURITY__RATE_LIMIT__RPS", "250")
	t.Setenv("CONTENT__SECURITY__RATE_LIMIT__BURST", "500")
	t.Setenv("CONTENT__SECURITY__BODY_LIMITS__NOTE_BYTES", "1048576")
	t.Setenv("CONTENT__SECURITY__HEADERS__HSTS_MAX_AGE_SECONDS", "600")
	t.Setenv("CONTENT__OBSERVABILITY__METRICS__ENABLED", "false")
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if cfg.Server.HTTP2 {
		t.Error("http2 override not applied")
	}
	if cfg.Server.Timeouts.ReadSeconds != 45 {
		t.Errorf("read timeout = %d", cfg.Server.Timeouts.ReadSeconds)
	}
	if cfg.Security.RateLimit.RPS != 250 || cfg.Security.RateLimit.Burst != 500 {
		t.Errorf("rate limit = %v/%d", cfg.Security.RateLimit.RPS, cfg.Security.RateLimit.Burst)
	}
	if cfg.Security.BodyLimits.NoteBytes != 1048576 {
		t.Errorf("note body limit = %d", cfg.Security.BodyLimits.NoteBytes)
	}
	if cfg.Security.Headers.HSTSMaxAgeSeconds != 600 {
		t.Errorf("hsts max-age = %d", cfg.Security.Headers.HSTSMaxAgeSeconds)
	}
	if cfg.Observability.Metrics.Enabled {
		t.Error("metrics override not applied")
	}
}

// Legacy per-domain variables map onto the single process-wide store config.
func TestLegacyDataStoreEnvMapsToSingleConfig(t *testing.T) {
	t.Setenv("APPBOARD__RDBMS__URL", "mysql+aiomysql://u:p@mysql:3306/mind_base")
	t.Setenv("MONGO__URI", "mongodb://mongo:27017")
	t.Setenv("REDIS__URL", "redis://redis:6379/1")
	t.Setenv("APPBOARD__MONGO__DB_NAME", "MindBase")
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if cfg.Database.MySQL.URL != "mysql+aiomysql://u:p@mysql:3306/mind_base" {
		t.Errorf("mysql url = %q", cfg.Database.MySQL.URL)
	}
	if cfg.Database.Mongo.URI != "mongodb://mongo:27017" || cfg.Database.BoardMongoDatabase() != "MindBase" {
		t.Errorf("mongo = %+v", cfg.Database.Mongo)
	}
	if cfg.Database.Redis.URL != "redis://redis:6379/1" {
		t.Errorf("redis url = %q", cfg.Database.Redis.URL)
	}
}

// Conflicting legacy DSNs must fail startup instead of silently splitting the
// service across two databases.
func TestConflictingLegacyMySQLRejected(t *testing.T) {
	t.Setenv("APPBOARD__RDBMS__URL", "mysql+aiomysql://u:p@mysql-a:3306/mind_base")
	t.Setenv("APPNOTE__RDBMS__URL", "mysql+aiomysql://u:p@mysql-b:3306/mind_base")
	if _, err := config.Load(); err == nil || !strings.Contains(err.Error(), "conflicting MySQL") {
		t.Fatalf("Load error = %v, want conflicting-MySQL rejection", err)
	}
}

// mTLS without a client CA bundle would reject every client: refuse to boot.
func TestClientAuthRequiresCAFile(t *testing.T) {
	t.Setenv("CONTENT__SERVER__TLS__CLIENT_AUTH", "require")
	if _, err := config.Load(); err == nil || !strings.Contains(err.Error(), "client_ca_file") {
		t.Fatalf("Load error = %v, want client_ca_file requirement", err)
	}
}
