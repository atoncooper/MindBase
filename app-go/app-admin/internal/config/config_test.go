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
	t.Setenv("APPADMIN__SANDBOX_ADMIN__BASE_URL", "http://app-sandbox:8017")
	t.Setenv("APPADMIN__SANDBOX_ADMIN__TOKEN", "sandbox-secret")
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
	if cfg.SandboxAdmin.BaseURL != "http://app-sandbox:8017" || cfg.SandboxAdmin.Token != "sandbox-secret" {
		t.Fatalf("sandbox_admin override lost: %+v", cfg.SandboxAdmin)
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

// The sandbox console proxy follows the same all-or-nothing rule as the cloud
// review preview: a lone base URL/token is cleared and reported (proxy 503),
// never half-enabled, and must not block startup.
func TestValidateSandboxAdminAllOrNothing(t *testing.T) {
	base := func() *Config {
		return &Config{
			RDBMS: RDBMSConfig{URL: "x"},
			Seed:  SeedConfig{Username: "a", Password: "b"},
		}
	}
	both := base()
	both.SandboxAdmin = SandboxAdminConfig{BaseURL: "http://app-sandbox:8017", Token: "t"}
	if err := Validate(both); err != nil {
		t.Fatalf("fully wired sandbox proxy rejected: %v", err)
	}
	if NormalizeSandboxAdmin(both) {
		t.Fatal("fully wired config must survive normalization")
	}

	loneURL := base()
	loneURL.SandboxAdmin = SandboxAdminConfig{BaseURL: "http://app-sandbox:8017"}
	if err := Validate(loneURL); err != nil {
		t.Fatalf("half wiring must not block startup: %v", err)
	}
	if !NormalizeSandboxAdmin(loneURL) {
		t.Fatal("half wiring must be reported as disabled")
	}
	if loneURL.SandboxAdmin.BaseURL != "" || loneURL.SandboxAdmin.Token != "" {
		t.Fatalf("half wiring must be cleared: %+v", loneURL.SandboxAdmin)
	}

	loneToken := base()
	loneToken.SandboxAdmin = SandboxAdminConfig{Token: "t"}
	if !NormalizeSandboxAdmin(loneToken) {
		t.Fatal("lone token must be reported as disabled")
	}

	none := base()
	if NormalizeSandboxAdmin(none) {
		t.Fatal("both empty is intentionally disabled, not a mismatch")
	}
}

// Payment-operations config: the second database, grant quota and the
// refund-review upstream all map onto APPADMIN__PAY_* env vars.
func TestApplyPayEnvOverrides(t *testing.T) {
	t.Setenv("APPADMIN__PAY_RDBMS__URL", "mysql+aiomysql://u:p@app-pay-mysql:3306/app_pay")
	t.Setenv("APPADMIN__PAY_RDBMS__MAX_OPEN_CONNS", "7")
	t.Setenv("APPADMIN__PAY_RDBMS__MAX_IDLE_CONNS", "3")
	t.Setenv("APPADMIN__PAY_RDBMS__CONN_MAX_LIFETIME", "600")
	t.Setenv("APPADMIN__PAY__GRANT__DAILY_MAX_COUNT", "12")
	t.Setenv("APPADMIN__PAY__GRANT__DAILY_MAX_DAYS", "345")
	t.Setenv("APPADMIN__PAY__OPS__BASE_URL", "http://apisix:9080")
	t.Setenv("APPADMIN__PAY__OPS__KEY", "pay-ops-key")
	t.Setenv("APPADMIN__PAY__OPS__TIMEOUT_SECONDS", "9")
	t.Setenv("APPADMIN__PAY__OPS__REFUND_REVIEW_ENABLED", "true")
	t.Setenv("APPADMIN__PAY__AUDIT_FILE", "/app/logs/pay-audit.jsonl")

	var cfg Config
	applyEnvOverrides(&cfg)

	if cfg.PayRDBMS.URL != "mysql+aiomysql://u:p@app-pay-mysql:3306/app_pay" ||
		cfg.PayRDBMS.MaxOpenConns != 7 || cfg.PayRDBMS.MaxIdleConns != 3 || cfg.PayRDBMS.ConnMaxLifetime != 600 {
		t.Fatalf("pay_rdbms override lost: %+v", cfg.PayRDBMS)
	}
	if cfg.Pay.Grant.DailyMaxCount != 12 || cfg.Pay.Grant.DailyMaxDays != 345 {
		t.Fatalf("pay.grant override lost: %+v", cfg.Pay.Grant)
	}
	if cfg.Pay.Ops.BaseURL != "http://apisix:9080" || cfg.Pay.Ops.Key != "pay-ops-key" ||
		cfg.Pay.Ops.TimeoutSeconds != 9 || !cfg.Pay.Ops.RefundReviewEnabled {
		t.Fatalf("pay.ops override lost: %+v", cfg.Pay.Ops)
	}
	if cfg.Pay.AuditFile != "/app/logs/pay-audit.jsonl" {
		t.Fatalf("pay.audit_file override lost: %q", cfg.Pay.AuditFile)
	}
}

// Session device / IP binding and the login throttle budgets map onto
// APPADMIN__SESSION__* / APPADMIN__SECURITY__LOGIN__* env vars.
func TestApplySessionSecurityEnvOverrides(t *testing.T) {
	t.Setenv("APPADMIN__SESSION__DEVICE_BINDING", "id")
	t.Setenv("APPADMIN__SESSION__IP_BINDING", "exact")
	t.Setenv("APPADMIN__SESSION__IPV4_PREFIX", "20")
	t.Setenv("APPADMIN__SESSION__IPV6_PREFIX", "56")
	t.Setenv("APPADMIN__SECURITY__TRUSTED_PROXIES", " 172.16.0.0/12 , 10.1.2.3 ")
	t.Setenv("APPADMIN__SECURITY__LOGIN__MAX_FAILS_PER_IP", "3")
	t.Setenv("APPADMIN__SECURITY__LOGIN__IP_WINDOW_SECONDS", "30")
	t.Setenv("APPADMIN__SECURITY__LOGIN__MAX_FAILS_PER_ACCOUNT", "7")
	t.Setenv("APPADMIN__SECURITY__LOGIN__ACCOUNT_WINDOW_SECONDS", "1200")

	var cfg Config
	applyEnvOverrides(&cfg)

	if got := cfg.Session.DeviceBindingMode(); got != "id" {
		t.Fatalf("session.device_binding mode = %q, want id", got)
	}
	if got := cfg.Session.IPBindingMode(); got != "exact" {
		t.Fatalf("session.ip_binding mode = %q, want exact", got)
	}
	if cfg.Session.IPv4Prefix != 20 || cfg.Session.IPv6Prefix != 56 {
		t.Fatalf("session prefixes: %+v", cfg.Session)
	}
	if len(cfg.Security.TrustedProxies) != 2 ||
		cfg.Security.TrustedProxies[0] != "172.16.0.0/12" || cfg.Security.TrustedProxies[1] != "10.1.2.3" {
		t.Fatalf("trusted proxies: %+v", cfg.Security.TrustedProxies)
	}
	if cfg.Security.Login.MaxFailsPerIP != 3 || cfg.Security.Login.IPWindowSeconds != 30 ||
		cfg.Security.Login.MaxFailsPerAccount != 7 || cfg.Security.Login.AccountWindowSeconds != 1200 {
		t.Fatalf("login limits: %+v", cfg.Security.Login)
	}
}

// Unknown binding modes and out-of-range prefixes fail loud; zero prefixes are
// normalized to the documented defaults.
func TestValidateSessionPolicy(t *testing.T) {
	valid := func() *Config {
		return &Config{RDBMS: RDBMSConfig{URL: "x"}, Seed: SeedConfig{Username: "a", Password: "b"}}
	}

	cfg := valid()
	if err := Validate(cfg); err != nil {
		t.Fatalf("empty binding config rejected: %v", err)
	}
	if cfg.Session.IPv4Prefix != 24 || cfg.Session.IPv6Prefix != 64 {
		t.Fatalf("zero prefixes must normalize to 24/64: %+v", cfg.Session)
	}
	if got := cfg.Session.DeviceBindingMode(); got != "off" {
		t.Fatalf("empty device_binding must mean off, got %q", got)
	}
	if got := cfg.Session.IPBindingMode(); got != "off" {
		t.Fatalf("empty ip_binding must mean off, got %q", got)
	}

	for _, binding := range []string{"", "off", "id", "strict"} {
		cfg = valid()
		cfg.Session.DeviceBinding = binding
		if err := Validate(cfg); err != nil {
			t.Fatalf("device_binding %q rejected: %v", binding, err)
		}
	}
	cfg = valid()
	cfg.Session.DeviceBinding = "fingerprint"
	if err := Validate(cfg); err == nil {
		t.Fatal("unknown device_binding must be rejected")
	}

	for _, binding := range []string{"", "off", "subnet", "exact"} {
		cfg = valid()
		cfg.Session.IPBinding = binding
		if err := Validate(cfg); err != nil {
			t.Fatalf("ip_binding %q rejected: %v", binding, err)
		}
	}
	cfg = valid()
	cfg.Session.IPBinding = "prefix"
	if err := Validate(cfg); err == nil {
		t.Fatal("unknown ip_binding must be rejected")
	}

	cfg = valid()
	cfg.Session.IPv4Prefix = 33
	if err := Validate(cfg); err == nil {
		t.Fatal("ipv4_prefix 33 must be rejected")
	}
	cfg = valid()
	cfg.Session.IPv6Prefix = 129
	if err := Validate(cfg); err == nil {
		t.Fatal("ipv6_prefix 129 must be rejected")
	}
	cfg = valid()
	cfg.Session.IPv4Prefix, cfg.Session.IPv6Prefix = 20, 56
	if err := Validate(cfg); err != nil {
		t.Fatalf("custom prefixes rejected: %v", err)
	}

	cfg = valid()
	cfg.Security.TrustedProxies = []string{"not-an-ip"}
	if err := Validate(cfg); err == nil {
		t.Fatal("invalid trusted_proxies entry must be rejected")
	}
	cfg = valid()
	cfg.Security.TrustedProxies = []string{"172.16.0.0/12", "10.1.2.3"}
	if err := Validate(cfg); err != nil {
		t.Fatalf("valid trusted proxies rejected: %v", err)
	}
}

// Refund-review wiring is all-or-nothing: base URL + ops key must both be set;
// half wiring is cleared (workbench stays hidden) and reported to main.
func TestNormalizePayOps(t *testing.T) {
	both := &Config{}
	both.Pay.Ops.BaseURL = "http://apisix:9080"
	both.Pay.Ops.Key = "k"
	if NormalizePayOps(both) {
		t.Fatal("fully wired pay ops must survive normalization")
	}
	if both.Pay.Ops.BaseURL == "" || both.Pay.Ops.Key == "" {
		t.Fatalf("fully wired pay ops must not be cleared: %+v", both.Pay.Ops)
	}

	loneURL := &Config{}
	loneURL.Pay.Ops.BaseURL = "http://apisix:9080"
	if !NormalizePayOps(loneURL) {
		t.Fatal("lone base url must be reported as disabled")
	}
	if loneURL.Pay.Ops.BaseURL != "" || loneURL.Pay.Ops.Key != "" {
		t.Fatalf("half wiring must be cleared: %+v", loneURL.Pay.Ops)
	}

	loneKey := &Config{}
	loneKey.Pay.Ops.Key = "k"
	if !NormalizePayOps(loneKey) {
		t.Fatal("lone ops key must be reported as disabled")
	}

	none := &Config{}
	if NormalizePayOps(none) {
		t.Fatal("both empty is intentionally disabled, not a mismatch")
	}
}
