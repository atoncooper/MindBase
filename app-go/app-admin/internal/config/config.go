// Package config loads app-admin configuration from embedded default.yaml +
// APPADMIN__-prefixed env overrides + project-root .env (godotenv).
//
// Layering (highest wins, mirrors app-pay-admin / app-task):
//
//	default.yaml (embedded)  ->  optional -config overlay  ->  APPADMIN__* env
package config

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/joho/godotenv"
	"gopkg.in/yaml.v3"
)

type Config struct {
	App      AppConfig    `yaml:"app"`
	Server   ServerConfig `yaml:"server"`
	Timezone string       `yaml:"timezone"`
	RDBMS    RDBMSConfig  `yaml:"rdbms"`
	// PayRDBMS is the OPTIONAL second connection: app_pay on the dedicated
	// app-pay-mysql instance (pay_* schema owned by app-pay / Java Flyway).
	// Empty url = payment console disabled (/api/pay/** answers 503) while the
	// rest of the console keeps working.
	PayRDBMS RDBMSConfig    `yaml:"pay_rdbms"`
	Session  SessionConfig  `yaml:"session"`
	Security SecurityConfig `yaml:"security"`
	// Pay configures the payment-operations console (grant quota, refund-review
	// upstream, fund-audit JSONL path).
	Pay PayConfig `yaml:"pay"`
	// CloudReview — app-cloud internal preview wiring (see CloudReviewConfig).
	CloudReview CloudReviewConfig `yaml:"cloud_review"`
	// SandboxAdmin — app-sandbox internal admin plane (see SandboxAdminConfig).
	SandboxAdmin SandboxAdminConfig `yaml:"sandbox_admin"`
	Seed         SeedConfig         `yaml:"seed"`
	Log          LogConfig          `yaml:"log"`
}

type AppConfig struct {
	Name  string `yaml:"name"`
	Debug bool   `yaml:"debug"`
}

type ServerConfig struct {
	Host string `yaml:"host"`
	Port int    `yaml:"port"`
}

type RDBMSConfig struct {
	URL             string `yaml:"url"`
	MaxOpenConns    int    `yaml:"max_open_conns"`
	MaxIdleConns    int    `yaml:"max_idle_conns"`
	ConnMaxLifetime int    `yaml:"conn_max_lifetime"`
}

// SessionConfig: DB-backed login session lifetime (admin_session table,
// HttpOnly cookie, sliding expiry on each authenticated request) plus the
// device / IP binding rules re-checked whenever a session is presented.
type SessionConfig struct {
	TTLMinutes    int    `yaml:"ttl_minutes"`    // 0 = default 12h
	DeviceBinding string `yaml:"device_binding"` // ""|off|id|strict
	IPBinding     string `yaml:"ip_binding"`     // ""|off|subnet|exact
	IPv4Prefix    int    `yaml:"ipv4_prefix"`    // 0 = default 24
	IPv6Prefix    int    `yaml:"ipv6_prefix"`    // 0 = default 64
}

// DeviceBindingMode normalizes the device-fingerprint policy. Only id and
// strict enable the check; empty or unknown values mean off (no header
// required, no session device comparison).
func (s SessionConfig) DeviceBindingMode() string {
	switch mode := strings.ToLower(strings.TrimSpace(s.DeviceBinding)); mode {
	case "id", "strict":
		return mode
	default:
		return "off"
	}
}

// IPBindingMode normalizes the session IP policy. Only exact and subnet enable
// the check; everything else means off.
func (s SessionConfig) IPBindingMode() string {
	switch mode := strings.ToLower(strings.TrimSpace(s.IPBinding)); mode {
	case "exact", "subnet":
		return mode
	default:
		return "off"
	}
}

// IPv4PrefixOr returns the effective IPv4 subnet size with the documented
// default applied when the field is unset or out of range.
func (s SessionConfig) IPv4PrefixOr() int {
	if s.IPv4Prefix >= 1 && s.IPv4Prefix <= 32 {
		return s.IPv4Prefix
	}
	return 24
}

// IPv6PrefixOr returns the effective IPv6 subnet size (default 64).
func (s SessionConfig) IPv6PrefixOr() int {
	if s.IPv6Prefix >= 1 && s.IPv6Prefix <= 128 {
		return s.IPv6Prefix
	}
	return 64
}

// LoginConfig bounds repeated failed logins. Both budgets are enforced on every
// attempt: the short IP window stops one host hammering the endpoint, while the
// longer account window protects a single account across rotating addresses.
type LoginConfig struct {
	MaxFailsPerIP        int `yaml:"max_fails_per_ip"`       // 0 = default 10
	IPWindowSeconds      int `yaml:"ip_window_seconds"`      // 0 = default 60
	MaxFailsPerAccount   int `yaml:"max_fails_per_account"`  // 0 = default 10
	AccountWindowSeconds int `yaml:"account_window_seconds"` // 0 = default 900
}

type SecurityConfig struct {
	IPAllowlist []string `yaml:"ip_allowlist"`
	// TrustedProxies lists the reverse proxies whose X-Forwarded-* headers may
	// be believed (IP or CIDR). Empty = forwarded headers are never trusted and
	// the TCP peer address is the client address.
	TrustedProxies []string `yaml:"trusted_proxies"`
	CORS           struct {
		AllowOrigins []string `yaml:"allow_origins"`
	} `yaml:"cors"`
	Login LoginConfig `yaml:"login"`
}

// CloudReviewConfig wires the app-cloud internal share-content review preview.
// Both values required together; either missing = preview disabled (fail
// closed). The token is a dedicated shared secret, NOT an API key of any user.
type CloudReviewConfig struct {
	BaseURL string `yaml:"base_url"`
	Token   string `yaml:"token"`
}

// SandboxAdminConfig wires the sandbox console proxy (/api/sandbox/*) to
// app-sandbox's /internal/admin/* surface. Both values are
// required together; either missing disables the proxy (503, fail closed) while
// the rest of the console keeps working. The token is a dedicated shared secret
// between app-admin and app-sandbox — NOT an APISIX consumer key, and never sent
// to the browser.
type SandboxAdminConfig struct {
	BaseURL string `yaml:"base_url"`
	Token   string `yaml:"token"`
}

// PayConfig configures the payment-operations console.
type PayConfig struct {
	Grant     PayGrantConfig `yaml:"grant"`
	Ops       PayOpsConfig   `yaml:"ops"`
	AuditFile string         `yaml:"audit_file"`
}

// PayGrantConfig mirrors app-pay GrantQuotaService's daily cap: app-admin
// writes pay_membership_event directly, so it must enforce the same circuit
// breaker or the console grant would bypass the execution point. 0 = unlimited.
type PayGrantConfig struct {
	DailyMaxCount int `yaml:"daily_max_count"`
	DailyMaxDays  int `yaml:"daily_max_days"`
}

// PayOpsConfig wires the refund-review workbench to app-pay's internal
// endpoints. The fund write happens in app-pay (audit/state-machine
// consistency); the console carries PAY_OPS_KEY through APISIX key-auth
// (pay-ops consumer) plus the logged-in operator identity. key empty = the
// whole refund-review group stays hidden (404).
type PayOpsConfig struct {
	BaseURL             string `yaml:"base_url"`              // default http://apisix:9080 (compose injects)
	Key                 string `yaml:"key"`                   // PAY_OPS_KEY (pay-ops consumer)
	TimeoutSeconds      int    `yaml:"timeout_seconds"`       // default 5
	RefundReviewEnabled bool   `yaml:"refund_review_enabled"` // master switch
}

// SeedConfig: default admin account inserted on first boot (missing username
// only; never overwrites an existing row). must_change_password is forced to 1
// so the first login must POST /api/me/password.
type SeedConfig struct {
	Username string `yaml:"username"`
	Password string `yaml:"password"`
}

type LogConfig struct {
	Level  string        `yaml:"level"`  // debug|info|warn|error (default info)
	Format string        `yaml:"format"` // text|json (default json)
	Output string        `yaml:"output"` // stdout|file|both (default stdout)
	File   LogFileConfig `yaml:"file"`
}

type LogFileConfig struct {
	Path       string `yaml:"path"`
	MaxSize    int    `yaml:"max_size"`
	MaxBackups int    `yaml:"max_backups"`
	MaxAge     int    `yaml:"max_age"`
	Compress   bool   `yaml:"compress"`
}

// Load parses the embedded default.yaml, then merges the optional overlay
// config file (-config flag; only present keys override), then applies
// APPADMIN__ env overrides (highest priority). Precedence note: godotenv
// values never replace variables already set in the process environment, so
// "real env > .env" holds by construction.
func Load(yamlBytes []byte, overlayPath string) (*Config, error) {
	loadDotenv()

	var cfg Config
	if err := yaml.Unmarshal(yamlBytes, &cfg); err != nil {
		return nil, fmt.Errorf("parse default.yaml: %w", err)
	}
	if overlayPath != "" {
		b, err := os.ReadFile(overlayPath)
		if err != nil {
			return nil, fmt.Errorf("read -config %s: %w", overlayPath, err)
		}
		if err := yaml.Unmarshal(b, &cfg); err != nil {
			return nil, fmt.Errorf("parse %s: %w", overlayPath, err)
		}
	}
	applyEnvOverrides(&cfg)
	return &cfg, nil
}

// loadDotenv walks up from the working directory looking for a project-root
// .env, so bare go run . (from this directory) and go run ./app-go/app-admin
// (from the project root) both find it. A missing file is not an error:
// docker containers get their config via APPADMIN__ env injection instead.
func loadDotenv() {
	dir, err := os.Getwd()
	if err != nil {
		return
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, ".env")); err == nil {
			_ = godotenv.Load(filepath.Join(dir, ".env"))
			return
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return
		}
		dir = parent
	}
}

// applyEnvOverrides maps APPADMIN__SECTION__KEY env vars onto the config
// (mirrors app-pay-admin's per-field mapping; no generic reflection magic).
func applyEnvOverrides(cfg *Config) {
	get := func(key string) string { return strings.TrimSpace(os.Getenv(key)) }
	atoi := func(key string, dst *int) {
		if v := get(key); v != "" {
			if n, err := strconv.Atoi(v); err == nil {
				*dst = n
			}
		}
	}
	boolVar := func(key string, dst *bool) {
		if v := get(key); v != "" {
			*dst = v == "true" || v == "1"
		}
	}

	if v := get("APPADMIN__RDBMS__URL"); v != "" {
		cfg.RDBMS.URL = v
	}
	atoi("APPADMIN__RDBMS__MAX_OPEN_CONNS", &cfg.RDBMS.MaxOpenConns)
	atoi("APPADMIN__RDBMS__MAX_IDLE_CONNS", &cfg.RDBMS.MaxIdleConns)
	atoi("APPADMIN__RDBMS__CONN_MAX_LIFETIME", &cfg.RDBMS.ConnMaxLifetime)
	if v := get("APPADMIN__TIMEZONE"); v != "" {
		cfg.Timezone = v
	}
	if v := get("APPADMIN__SERVER__HOST"); v != "" {
		cfg.Server.Host = v
	}
	atoi("APPADMIN__SERVER__PORT", &cfg.Server.Port)
	atoi("APPADMIN__SESSION__TTL_MINUTES", &cfg.Session.TTLMinutes)
	if v := get("APPADMIN__SESSION__DEVICE_BINDING"); v != "" {
		cfg.Session.DeviceBinding = v
	}
	if v := get("APPADMIN__SESSION__IP_BINDING"); v != "" {
		cfg.Session.IPBinding = v
	}
	atoi("APPADMIN__SESSION__IPV4_PREFIX", &cfg.Session.IPv4Prefix)
	atoi("APPADMIN__SESSION__IPV6_PREFIX", &cfg.Session.IPv6Prefix)
	// Security lists accept comma-separated environment values; an explicitly
	// empty value clears a list supplied by a YAML overlay.
	if v, ok := os.LookupEnv("APPADMIN__SECURITY__IP_ALLOWLIST"); ok {
		cfg.Security.IPAllowlist = splitList(v)
	}
	if v, ok := os.LookupEnv("APPADMIN__SECURITY__TRUSTED_PROXIES"); ok {
		cfg.Security.TrustedProxies = splitList(v)
	}
	atoi("APPADMIN__SECURITY__LOGIN__MAX_FAILS_PER_IP", &cfg.Security.Login.MaxFailsPerIP)
	atoi("APPADMIN__SECURITY__LOGIN__IP_WINDOW_SECONDS", &cfg.Security.Login.IPWindowSeconds)
	atoi("APPADMIN__SECURITY__LOGIN__MAX_FAILS_PER_ACCOUNT", &cfg.Security.Login.MaxFailsPerAccount)
	atoi("APPADMIN__SECURITY__LOGIN__ACCOUNT_WINDOW_SECONDS", &cfg.Security.Login.AccountWindowSeconds)
	if v, ok := os.LookupEnv("APPADMIN__SECURITY__CORS__ALLOW_ORIGINS"); ok {
		cfg.Security.CORS.AllowOrigins = splitList(v)
	}
	if v := get("APPADMIN__CLOUD_REVIEW__BASE_URL"); v != "" {
		cfg.CloudReview.BaseURL = v
	}
	if v := get("APPADMIN__CLOUD_REVIEW__TOKEN"); v != "" {
		cfg.CloudReview.Token = v
	}
	if v := get("APPADMIN__SANDBOX_ADMIN__BASE_URL"); v != "" {
		cfg.SandboxAdmin.BaseURL = v
	}
	if v := get("APPADMIN__SANDBOX_ADMIN__TOKEN"); v != "" {
		cfg.SandboxAdmin.Token = v
	}
	// Payment operations: second database + grant quota + refund-review upstream.
	if v := get("APPADMIN__PAY_RDBMS__URL"); v != "" {
		cfg.PayRDBMS.URL = v
	}
	atoi("APPADMIN__PAY_RDBMS__MAX_OPEN_CONNS", &cfg.PayRDBMS.MaxOpenConns)
	atoi("APPADMIN__PAY_RDBMS__MAX_IDLE_CONNS", &cfg.PayRDBMS.MaxIdleConns)
	atoi("APPADMIN__PAY_RDBMS__CONN_MAX_LIFETIME", &cfg.PayRDBMS.ConnMaxLifetime)
	atoi("APPADMIN__PAY__GRANT__DAILY_MAX_COUNT", &cfg.Pay.Grant.DailyMaxCount)
	atoi("APPADMIN__PAY__GRANT__DAILY_MAX_DAYS", &cfg.Pay.Grant.DailyMaxDays)
	if v := get("APPADMIN__PAY__OPS__BASE_URL"); v != "" {
		cfg.Pay.Ops.BaseURL = v
	}
	if v := get("APPADMIN__PAY__OPS__KEY"); v != "" {
		cfg.Pay.Ops.Key = v
	}
	atoi("APPADMIN__PAY__OPS__TIMEOUT_SECONDS", &cfg.Pay.Ops.TimeoutSeconds)
	boolVar("APPADMIN__PAY__OPS__REFUND_REVIEW_ENABLED", &cfg.Pay.Ops.RefundReviewEnabled)
	if v := get("APPADMIN__PAY__AUDIT_FILE"); v != "" {
		cfg.Pay.AuditFile = v
	}
	if v := get("APPADMIN__SEED__USERNAME"); v != "" {
		cfg.Seed.Username = v
	}
	if v := get("APPADMIN__SEED__PASSWORD"); v != "" {
		cfg.Seed.Password = v
	}
	boolVar("APPADMIN__APP__DEBUG", &cfg.App.Debug)
	if v := get("APPADMIN__LOG__LEVEL"); v != "" {
		cfg.Log.Level = v
	}
	if v := get("APPADMIN__LOG__FORMAT"); v != "" {
		cfg.Log.Format = v
	}
	if v := get("APPADMIN__LOG__OUTPUT"); v != "" {
		cfg.Log.Output = v
	}
	if v := get("APPADMIN__LOG__FILE__PATH"); v != "" {
		cfg.Log.File.Path = v
	}
	atoi("APPADMIN__LOG__FILE__MAX_SIZE", &cfg.Log.File.MaxSize)
	atoi("APPADMIN__LOG__FILE__MAX_BACKUPS", &cfg.Log.File.MaxBackups)
	atoi("APPADMIN__LOG__FILE__MAX_AGE", &cfg.Log.File.MaxAge)
	boolVar("APPADMIN__LOG__FILE__COMPRESS", &cfg.Log.File.Compress)
}

// Validate fails loud on config that would silently misbehave: this service
// moderates the shared share schema, so starting without a DSN is always a
// mistake.
func Validate(cfg *Config) error {
	if strings.TrimSpace(cfg.RDBMS.URL) == "" {
		return fmt.Errorf("rdbms.url is empty: run 'go run .' inside app-go/app-admin/ " +
			"(reads the project-root .env), or docker compose injects APPADMIN__RDBMS__URL")
	}
	if strings.TrimSpace(cfg.Seed.Username) == "" || strings.TrimSpace(cfg.Seed.Password) == "" {
		return fmt.Errorf("seed.username/password must not be blank (env APPADMIN__SEED__USERNAME/PASSWORD)")
	}
	for _, entry := range cfg.Security.IPAllowlist {
		if err := validateIPOrCIDR(entry); err != nil {
			return fmt.Errorf("security.ip_allowlist entry %q: %w", entry, err)
		}
	}
	for _, origin := range cfg.Security.CORS.AllowOrigins {
		if err := validateOrigin(origin); err != nil {
			return fmt.Errorf("security.cors.allow_origins entry %q: %w", origin, err)
		}
	}
	for _, entry := range cfg.Security.TrustedProxies {
		if err := validateIPOrCIDR(entry); err != nil {
			return fmt.Errorf("security.trusted_proxies entry %q: %w", entry, err)
		}
	}
	if err := validateSessionPolicy(cfg); err != nil {
		return err
	}
	// The optional upstream planes (cloud review preview, sandbox console proxy)
	// are NOT validated here: a lone base URL or token would silently half-enable
	// one, but blocking the whole console over an optional feature is worse —
	// NormalizeCloudReview / NormalizeSandboxAdmin (called by main) clear the
	// mismatch and disable that plane with a warning instead.
	return nil
}

// validateSessionPolicy rejects unknown binding modes and out-of-range subnet
// sizes. Zero prefixes mean "unset" and are normalized to the defaults.
func validateSessionPolicy(cfg *Config) error {
	switch strings.ToLower(strings.TrimSpace(cfg.Session.DeviceBinding)) {
	case "", "off", "id", "strict":
	default:
		return fmt.Errorf("session.device_binding must be off, id or strict, got %q", cfg.Session.DeviceBinding)
	}
	switch strings.ToLower(strings.TrimSpace(cfg.Session.IPBinding)) {
	case "", "off", "subnet", "exact":
	default:
		return fmt.Errorf("session.ip_binding must be off, subnet or exact, got %q", cfg.Session.IPBinding)
	}
	if cfg.Session.IPv4Prefix == 0 {
		cfg.Session.IPv4Prefix = 24
	} else if cfg.Session.IPv4Prefix < 1 || cfg.Session.IPv4Prefix > 32 {
		return fmt.Errorf("session.ipv4_prefix must be between 1 and 32, got %d", cfg.Session.IPv4Prefix)
	}
	if cfg.Session.IPv6Prefix == 0 {
		cfg.Session.IPv6Prefix = 64
	} else if cfg.Session.IPv6Prefix < 1 || cfg.Session.IPv6Prefix > 128 {
		return fmt.Errorf("session.ipv6_prefix must be between 1 and 128, got %d", cfg.Session.IPv6Prefix)
	}
	return nil
}

// NormalizeCloudReview resolves the all-or-nothing invariant at startup:
// when base URL and token are not BOTH set, both are cleared (preview
// disabled, fail closed) and true is returned so main can warn loudly.
func NormalizeCloudReview(cfg *Config) bool {
	base, token := strings.TrimSpace(cfg.CloudReview.BaseURL), strings.TrimSpace(cfg.CloudReview.Token)
	if base != "" && token != "" {
		return false // fully wired
	}
	if base == "" && token == "" {
		return false // intentionally disabled
	}
	cfg.CloudReview.BaseURL, cfg.CloudReview.Token = "", ""
	return true // half-wired → cleared + warned
}

// NormalizeSandboxAdmin resolves the same all-or-nothing invariant for the
// sandbox console proxy: when base URL and token are not BOTH set, both are
// cleared (proxy disabled, /api/sandbox/* answers 503) and true is returned so
// main can warn loudly. Fully wired or fully empty returns false.
func NormalizeSandboxAdmin(cfg *Config) bool {
	base, token := strings.TrimSpace(cfg.SandboxAdmin.BaseURL), strings.TrimSpace(cfg.SandboxAdmin.Token)
	if base != "" && token != "" {
		return false // fully wired
	}
	if base == "" && token == "" {
		return false // intentionally disabled
	}
	cfg.SandboxAdmin.BaseURL, cfg.SandboxAdmin.Token = "", ""
	return true // half-wired → cleared + warned
}

// NormalizePayOps resolves the all-or-nothing invariant for the refund-review
// workbench: the upstream base URL and the ops key must be set TOGETHER. Half
// wiring is cleared (the workbench stays hidden, 404) and true is returned so
// main can warn loudly; a fully wired or fully empty config returns false.
func NormalizePayOps(cfg *Config) bool {
	base, key := strings.TrimSpace(cfg.Pay.Ops.BaseURL), strings.TrimSpace(cfg.Pay.Ops.Key)
	if base != "" && key != "" {
		return false // fully wired
	}
	if base == "" && key == "" {
		return false // intentionally disabled
	}
	cfg.Pay.Ops.BaseURL, cfg.Pay.Ops.Key = "", ""
	return true // half-wired → cleared + warned
}

func splitList(value string) []string {
	var result []string
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			result = append(result, item)
		}
	}
	return result
}

func validateIPOrCIDR(value string) error {
	if strings.TrimSpace(value) != value || value == "" {
		return fmt.Errorf("must be an IP address or CIDR")
	}
	if net.ParseIP(value) != nil {
		return nil
	}
	if _, _, err := net.ParseCIDR(value); err != nil {
		return fmt.Errorf("must be an IP address or CIDR")
	}
	return nil
}

func validateOrigin(value string) error {
	if strings.TrimSpace(value) != value || value == "" {
		return fmt.Errorf("must be an exact http(s) origin without a path")
	}
	u, err := url.Parse(value)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" ||
		u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return fmt.Errorf("must be an exact http(s) origin without a path")
	}
	return nil
}
