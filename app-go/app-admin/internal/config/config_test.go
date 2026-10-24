// Guard tests for config layering: APPADMIN__ env overrides must win over the
// embedded defaults, and Validate must reject a config that cannot reach the
// shared MySQL (the service is useless and dangerous without a DSN).
package config

import "testing"

func TestApplyEnvOverrides(t *testing.T) {
	t.Setenv("APPADMIN__RDBMS__URL", "mysql+aiomysql://u:p@mysql:3306/mind_base")
	t.Setenv("APPADMIN__SERVER__PORT", "8999")
	t.Setenv("APPADMIN__SESSION__TTL_MINUTES", "60")
	t.Setenv("APPADMIN__SEED__USERNAME", "ops-root")
	t.Setenv("APPADMIN__SEED__PASSWORD", "s3cret")
	t.Setenv("APPADMIN__APP__DEBUG", "true")
	t.Setenv("APPADMIN__SECURITY__IP_ALLOWLIST", " 192.0.2.0/24, 2001:db8::1 ")
	t.Setenv("APPADMIN__SECURITY__CORS__ALLOW_ORIGINS", " http://127.0.0.1:3001 , http://admin.example.com ")
	t.Setenv("APPADMIN__LOG__OUTPUT", "both")

	var cfg Config
	applyEnvOverrides(&cfg)

	if cfg.RDBMS.URL != "mysql+aiomysql://u:p@mysql:3306/mind_base" {
		t.Fatalf("rdbms.url override lost: %q", cfg.RDBMS.URL)
	}
	if cfg.Server.Port != 8999 {
		t.Fatalf("server.port override lost: %d", cfg.Server.Port)
	}
	if cfg.Session.TTLMinutes != 60 {
		t.Fatalf("session.ttl_minutes override lost: %d", cfg.Session.TTLMinutes)
	}
	if cfg.Seed.Username != "ops-root" || cfg.Seed.Password != "s3cret" {
		t.Fatalf("seed override lost: %+v", cfg.Seed)
	}
	if !cfg.App.Debug {
		t.Fatal("app.debug override lost")
	}
	if len(cfg.Security.IPAllowlist) != 2 || cfg.Security.IPAllowlist[0] != "192.0.2.0/24" {
		t.Fatalf("IP allowlist parse wrong: %+v", cfg.Security.IPAllowlist)
	}
	if len(cfg.Security.CORS.AllowOrigins) != 2 || cfg.Security.CORS.AllowOrigins[0] != "http://127.0.0.1:3001" {
		t.Fatalf("cors whitelist parse wrong: %+v", cfg.Security.CORS.AllowOrigins)
	}
	if cfg.Log.Output != "both" {
		t.Fatalf("log.output override lost: %q", cfg.Log.Output)
	}
}

func TestValidate(t *testing.T) {
	if err := Validate(&Config{RDBMS: RDBMSConfig{URL: "x"}, Seed: SeedConfig{Username: "a", Password: "b"}}); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
	if err := Validate(&Config{Seed: SeedConfig{Username: "a", Password: "b"}}); err == nil {
		t.Fatal("empty dsn must be rejected")
	}
	if err := Validate(&Config{RDBMS: RDBMSConfig{URL: "x"}}); err == nil {
		t.Fatal("blank seed must be rejected")
	}
	if err := Validate(&Config{
		RDBMS: RDBMSConfig{URL: "x"}, Seed: SeedConfig{Username: "a", Password: "b"},
		Security: SecurityConfig{IPAllowlist: []string{"not-an-ip"}},
	}); err == nil {
		t.Fatal("invalid IP allowlist entry must be rejected")
	}
	validOrigin := &Config{RDBMS: RDBMSConfig{URL: "x"}, Seed: SeedConfig{Username: "a", Password: "b"}}
	validOrigin.Security.CORS.AllowOrigins = []string{"https://admin.example.com"}
	if err := Validate(validOrigin); err != nil {
		t.Fatalf("valid exact origin rejected: %v", err)
	}
	validOrigin.Security.CORS.AllowOrigins = []string{"https://admin.example.com/path"}
	if err := Validate(validOrigin); err == nil {
		t.Fatal("CORS origin with a path must be rejected")
	}
}

// Half-configured review wiring must NOT fail Validate (optional feature must
// not block the console); NormalizeCloudReview clears it and reports.
func TestValidateCloudReviewAllOrNothing(t *testing.T) {
	base := func() *Config {
		return &Config{
			RDBMS: RDBMSConfig{URL: "x"},
			Seed:  SeedConfig{Username: "a", Password: "b"},
		}
	}
	both := base()
	both.CloudReview = CloudReviewConfig{BaseURL: "http://app-cloud:8007", Token: "t"}
	if err := Validate(both); err != nil {
		t.Fatalf("fully wired review config rejected: %v", err)
	}
	if NormalizeCloudReview(both) {
		t.Fatal("fully wired config must survive normalization")
	}

	loneURL := base()
	loneURL.CloudReview = CloudReviewConfig{BaseURL: "http://app-cloud:8007"}
	if err := Validate(loneURL); err != nil {
		t.Fatalf("half wiring must not block startup: %v", err)
	}
	if !NormalizeCloudReview(loneURL) {
		t.Fatal("half wiring must be reported as disabled")
	}
	if loneURL.CloudReview.BaseURL != "" || loneURL.CloudReview.Token != "" {
		t.Fatalf("half wiring must be cleared: %+v", loneURL.CloudReview)
	}

	loneToken := base()
	loneToken.CloudReview = CloudReviewConfig{Token: "t"}
	if !NormalizeCloudReview(loneToken) {
		t.Fatal("lone token must be reported as disabled")
	}

	none := base()
	if NormalizeCloudReview(none) {
		t.Fatal("both empty is intentionally disabled, not a mismatch")
	}
}
