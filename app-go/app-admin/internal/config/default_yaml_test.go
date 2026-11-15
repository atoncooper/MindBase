package config

// The embedded default.yaml is the source of truth for every non-secret knob;
// this guard catches a malformed YAML edit (main only fails at startup) and
// pins the payment-operations defaults added by the app-pay-admin merge.

import (
	"os"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestDefaultYAMLParsesAndCarriesPayDefaults(t *testing.T) {
	raw, err := os.ReadFile("../../default.yaml")
	if err != nil {
		t.Fatalf("read default.yaml: %v", err)
	}
	var cfg Config
	if err := yaml.Unmarshal(raw, &cfg); err != nil {
		t.Fatalf("default.yaml is not valid YAML: %v", err)
	}

	if cfg.Server.Port != 8016 || cfg.Timezone != "Asia/Shanghai" {
		t.Fatalf("baseline defaults changed: port=%d tz=%q", cfg.Server.Port, cfg.Timezone)
	}
	if cfg.PayRDBMS.MaxOpenConns != 10 || cfg.PayRDBMS.MaxIdleConns != 5 || cfg.PayRDBMS.ConnMaxLifetime != 1800 {
		t.Fatalf("pay_rdbms defaults: %+v", cfg.PayRDBMS)
	}
	if cfg.PayRDBMS.URL != "" {
		t.Fatalf("pay_rdbms.url must default to empty (pay disabled): %q", cfg.PayRDBMS.URL)
	}
	if cfg.Pay.Grant.DailyMaxCount != 50 || cfg.Pay.Grant.DailyMaxDays != 1000 {
		t.Fatalf("pay.grant defaults: %+v", cfg.Pay.Grant)
	}
	// Phase 2: the upstream planes default to HTTPS endpoints (APISIX 9443,
	// app-cloud 8007, sandbox TLS front 8443). Tokens/keys still default empty,
	// so a lone default URL is normalized away by Normalize* until the secret
	// is injected (fail closed).
	if cfg.Pay.Ops.BaseURL != "https://apisix:9443" || cfg.Pay.Ops.Key != "" ||
		!cfg.Pay.Ops.RefundReviewEnabled || cfg.Pay.Ops.TimeoutSeconds != 5 {
		t.Fatalf("pay.ops defaults: %+v", cfg.Pay.Ops)
	}
	if cfg.CloudReview.BaseURL != "https://app-cloud:8007" || cfg.CloudReview.Token != "" {
		t.Fatalf("cloud_review defaults: %+v", cfg.CloudReview)
	}
	if cfg.SandboxAdmin.BaseURL != "https://app-sandbox:8443" || cfg.SandboxAdmin.Token != "" {
		t.Fatalf("sandbox_admin defaults: %+v", cfg.SandboxAdmin)
	}
	// Server TLS stays off by default but ships the mounted-cert paths.
	if cfg.Server.TLS.Enabled || cfg.Server.TLS.Cert != "/app/certs/server.crt" ||
		cfg.Server.TLS.Key != "/app/certs/server.key" {
		t.Fatalf("server.tls defaults: %+v", cfg.Server.TLS)
	}
	if cfg.Pay.AuditFile != "/app/logs/pay-audit.jsonl" {
		t.Fatalf("pay.audit_file default: %q", cfg.Pay.AuditFile)
	}
	// Session binding defaults: strict device fingerprint + subnet IP match,
	// with the documented prefix sizes.
	if cfg.Session.DeviceBinding != "strict" || cfg.Session.IPBinding != "subnet" ||
		cfg.Session.IPv4Prefix != 24 || cfg.Session.IPv6Prefix != 64 {
		t.Fatalf("session binding defaults: %+v", cfg.Session)
	}
	// Login budget defaults: 10 fails / 60s per IP, 10 fails / 900s per account.
	if cfg.Security.Login.MaxFailsPerIP != 10 || cfg.Security.Login.IPWindowSeconds != 60 ||
		cfg.Security.Login.MaxFailsPerAccount != 10 || cfg.Security.Login.AccountWindowSeconds != 900 {
		t.Fatalf("security.login defaults: %+v", cfg.Security.Login)
	}
	if len(cfg.Security.TrustedProxies) != 0 {
		t.Fatalf("trusted_proxies must default to empty (trust none): %+v", cfg.Security.TrustedProxies)
	}
}
