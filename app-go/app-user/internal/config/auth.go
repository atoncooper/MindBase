// Package config loads app-user configuration from embedded default.yaml +
// APPAUTH__-prefixed env overrides + project-root .env.
//
// Secret-bearing settings (encryption key, Resend key, SMS/WeChat keys,
// Redis URL) are shared with the Python backend and are therefore read from
// the SAME env var names the backend uses (SECURITY__API_KEY_ENCRYPTION_KEY,
// EMAIL__API_KEY, SMS__*, WECHAT__*, REDIS__URL), so one .env serves both
// services. APPAUTH__-prefixed overrides always win.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/joho/godotenv"
	"gopkg.in/yaml.v3"
)

type AuthConfig struct {
	App          AppConfig          `yaml:"app"`
	Server       ServerConfig       `yaml:"server"`
	Timezone     string             `yaml:"timezone"`
	RDBMS        RDBMSConfig        `yaml:"rdbms"`
	Redis        RedisConfig        `yaml:"redis"`
	Auth         AuthTokenConfig    `yaml:"auth"`
	Security     SecurityConfig     `yaml:"security"`
	Email        EmailConfig        `yaml:"email"`
	SMS          SMSConfig          `yaml:"sms"`
	WeChat       WeChatConfig       `yaml:"wechat"`
	WorkerID     int                `yaml:"worker_id"`
	SecurityCORS SecurityCORSConfig `yaml:"security_cors"`
	Log          LogConfig          `yaml:"log"`
	Internal     InternalConfig     `yaml:"internal"`
	AppPay       AppPayConfig       `yaml:"app_pay"`
}

// AppPayConfig points at the app-pay membership face used to gate Coding Plan
// management (VIP/SVIP only). BaseURL is the APISIX origin; the client appends
// /internal/pay/membership/{uid}. Key = shared APISIX consumer key; when the
// YAML/env value is empty the client falls back to APISIX_CONSUMER_KEY.
type AppPayConfig struct {
	BaseURL string `yaml:"base_url"`
	Key     string `yaml:"key"`
}

// InternalConfig guards the /internal/auth M2M user-lookup face (AI stack);
// key = the shared APISIX consumer key.
type InternalConfig struct {
	APIKey string `yaml:"api_key"`
}

type AppConfig struct {
	Name  string `yaml:"name"`
	Debug bool   `yaml:"debug"`
}

type ServerConfig struct {
	Host string `yaml:"host"`
	Port int    `yaml:"port"`

	// Hardening / lifecycle knobs for the single HTTP listener. Zero values
	// fall back to safe defaults in cmd/app-user (never unbounded timeouts).
	ReadHeaderTimeoutSeconds int `yaml:"read_header_timeout_seconds"`
	ReadTimeoutSeconds       int `yaml:"read_timeout_seconds"`
	WriteTimeoutSeconds      int `yaml:"write_timeout_seconds"`
	IdleTimeoutSeconds       int `yaml:"idle_timeout_seconds"`
	ShutdownTimeoutSeconds   int `yaml:"shutdown_timeout_seconds"`
	MaxHeaderBytes           int `yaml:"max_header_bytes"`

	// Request/connection limits and edge behaviour.
	MaxBodyBytes         int      `yaml:"max_body_bytes"`
	TrustedProxies       []string `yaml:"trusted_proxies"`
	MaxConnections       int      `yaml:"max_connections"`
	MaxConcurrent        int      `yaml:"max_concurrent"`
	MaxConcurrentPerIP   int      `yaml:"max_concurrent_per_ip"`
	HTTP2Enabled         bool     `yaml:"http2_enabled"`
	Compression          string   `yaml:"compression"` // none|gzip|br|both
	KeepAliveMaxRequests int      `yaml:"keepalive_max_requests"`

	// Access log sampling/format (access_log.enabled=false disables it).
	AccessLogEnabled    bool   `yaml:"access_log_enabled"`
	AccessLogSampleRate int    `yaml:"access_log_sample_rate"` // 0-100 percent
	AccessLogFormat     string `yaml:"access_log_format"`      // slog|text
}

type RDBMSConfig struct {
	URL             string `yaml:"url"`
	MaxOpenConns    int    `yaml:"max_open_conns"`
	MaxIdleConns    int    `yaml:"max_idle_conns"`
	ConnMaxLifetime int    `yaml:"conn_max_lifetime"`
	ConnMaxIdleTime int    `yaml:"conn_max_idle_time_seconds"`
}

type RedisConfig struct {
	URL string `yaml:"url"`

	// Connection pool / timeout knobs (go-redis). Zero values keep go-redis
	// defaults; YAML defaults are set explicitly for predictability.
	PoolSize            int `yaml:"pool_size"`
	MinIdleConns        int `yaml:"min_idle_conns"`
	PoolTimeoutSeconds  int `yaml:"pool_timeout_seconds"`
	DialTimeoutSeconds  int `yaml:"dial_timeout_seconds"`
	ReadTimeoutSeconds  int `yaml:"read_timeout_seconds"`
	WriteTimeoutSeconds int `yaml:"write_timeout_seconds"`
	MaxRetries          int `yaml:"max_retries"`
}

type AuthTokenConfig struct {
	TokenTTLDays    int    `yaml:"token_ttl_days"`
	CacheTTLSeconds int    `yaml:"cache_ttl_seconds"`
	TokenCacheNS    string `yaml:"token_cache_namespace"`
}

type SecurityConfig struct {
	APIKeyEncryptionKey string `yaml:"api_key_encryption_key"`
	// AllowPlaintextFallback permits running without an AES key (test/dev only).
	// Production must fail closed instead of silently storing base64 plaintext.
	AllowPlaintextFallback bool          `yaml:"allow_plaintext_fallback"`
	Captcha                CaptchaConfig `yaml:"captcha"`
	// RateLimit — per-endpoint fixed-window rules, keyed by rule name.
	// Defaults (merged in Load) mirror the Python backend's
	// security.rate_limit.* settings; YAML entries override per rule.
	RateLimit map[string]RateLimitRule `yaml:"rate_limit"`
}

// RateLimitRule — max hits per window (seconds). Window 0 disables the rule.
type RateLimitRule struct {
	Max    int `yaml:"max"`
	Window int `yaml:"window"`
}

// defaultRateLimits mirrors the Python settings defaults (security.rate_limit).
func defaultRateLimits() map[string]RateLimitRule {
	return map[string]RateLimitRule{
		"login_ip":          {Max: 10, Window: 60},
		"login_target":      {Max: 20, Window: 300},
		"register_send_ip":  {Max: 5, Window: 3600},
		"register_send_tgt": {Max: 3, Window: 3600},
		"register_ip":       {Max: 10, Window: 3600},
		"phone_send_ip":     {Max: 10, Window: 60},
		"phone_send_tgt":    {Max: 5, Window: 600},
		"phone_login_ip":    {Max: 10, Window: 300},
		"email_send_ip":     {Max: 10, Window: 60},
		"email_send_uid":    {Max: 5, Window: 600},
		"email_verify_ip":   {Max: 20, Window: 60},
		"pw_reset_req_ip":   {Max: 5, Window: 3600},
		"pw_reset_req_tgt":  {Max: 3, Window: 3600},
		"pw_reset_ip":       {Max: 10, Window: 3600},
		"pw_change_uid":     {Max: 3, Window: 3600},
		"pw_set_uid":        {Max: 3, Window: 3600},
	}
}

type CaptchaConfig struct {
	Enabled     bool `yaml:"enabled"`
	Length      int  `yaml:"length"`
	TTLSeconds  int  `yaml:"ttl_seconds"`
	ImageWidth  int  `yaml:"image_width"`
	ImageHeight int  `yaml:"image_height"`
}

type EmailConfig struct {
	Enabled                bool   `yaml:"enabled"`
	APIKey                 string `yaml:"api_key"`
	FromEmail              string `yaml:"from_email"`
	FrontendURL            string `yaml:"frontend_url"`
	CodeTTLSeconds         int    `yaml:"code_ttl_seconds"`
	CodeLength             int    `yaml:"code_length"`
	RateLimitTargetSeconds int    `yaml:"rate_limit_target_seconds"`
	RateLimitUIDMinutes    int    `yaml:"rate_limit_uid_minutes"`
	RateLimitUIDMax        int    `yaml:"rate_limit_uid_max"`
	MaxVerifyAttempts      int    `yaml:"max_verify_attempts"`
}

type SMSConfig struct {
	Enabled bool `yaml:"enabled"`
	// Provider selects the Aliyun product: "dysmsapi" (smsservice, default,
	// custom sign/template) or "dypnsapi" (号码认证服务 短信认证, supports
	// system-granted sign/template and free code verification via
	// CheckSmsVerifyCode).
	Provider        string `yaml:"provider"`
	AccessKeyID     string `yaml:"access_key_id"`
	AccessKeySecret string `yaml:"access_key_secret"`
	SignName        string `yaml:"sign_name"`
	TemplateCode    string `yaml:"template_code"`
	// SchemeName is the Dypnsapi verification scheme (optional; default scheme
	// when empty). Must match between SendSmsVerifyCode and CheckSmsVerifyCode.
	SchemeName string `yaml:"scheme_name"`
	// CountryCode is the phone country code (default 86; Dypnsapi currently
	// only supports mainland China numbers).
	CountryCode string `yaml:"country_code"`
	// CodeSource selects who generates the verification code for Dypnsapi:
	// "local" (default; we generate/store/verify it, sent as an explicit value)
	// or "aliyun" (TemplateParam "##code##"; Aliyun generates and verifies it via
	// CheckSmsVerifyCode — the code never reaches our DB).
	CodeSource string `yaml:"code_source"`
	// IntervalSeconds is the Dypnsapi per-number send interval (default 60s).
	IntervalSeconds int `yaml:"interval_seconds"`
	// DuplicatePolicy: 1=overwrite old code (default), 2=keep both.
	DuplicatePolicy int `yaml:"duplicate_policy"`
	// AutoRetry: 1=allow Aliyun to retry/change signature internally (default).
	AutoRetry int `yaml:"auto_retry"`
	// TemplateCodes optionally selects a different approved/granted template
	// per business purpose (login / bind_phone / twofa_sms), e.g.
	// {login: "100001", bind_phone: "100004", twofa_sms: "100005"}.
	// Missing purpose falls back to TemplateCode.
	TemplateCodes map[string]string `yaml:"template_codes"`
	// TemplateParams are extra template variables (e.g. {"min":"5"}); "code"
	// is always injected by the service. Required when the approved/granted
	// template contains variables beyond ${code}. This is NOT a template list.
	TemplateParams map[string]string `yaml:"template_params"`
}

// Configured reports whether SMS can actually send: enabled AND the full
// credential/template set is present. /auth/features uses this so the frontend
// never shows a phone-login entry that would fail at send time.
func (c SMSConfig) Configured() bool {
	return c.Enabled &&
		c.AccessKeyID != "" &&
		c.AccessKeySecret != "" &&
		c.SignName != "" &&
		c.TemplateCode != ""
}

type WeChatConfig struct {
	Enabled     bool   `yaml:"enabled"`
	AppID       string `yaml:"app_id"`
	AppSecret   string `yaml:"app_secret"`
	RedirectURI string `yaml:"redirect_uri"`
}

type SecurityCORSConfig struct {
	AllowOrigins []string `yaml:"allow_origins"`
}

type LogConfig struct {
	Level  string        `yaml:"level"`
	Format string        `yaml:"format"`
	Output string        `yaml:"output"`
	File   LogFileConfig `yaml:"file"`

	AddSource bool `yaml:"add_source"`
	// RedactKeys masks matching attribute keys (default list if empty).
	RedactKeys []string          `yaml:"redact_keys"`
	Sampling   LogSamplingConfig `yaml:"sampling"`
	Async      LogAsyncConfig    `yaml:"async"`
}

type LogSamplingConfig struct {
	Enabled    bool `yaml:"enabled"`
	Initial    int  `yaml:"initial"`
	Thereafter int  `yaml:"thereafter"`
}

type LogAsyncConfig struct {
	Enabled      bool `yaml:"enabled"`
	Buffer       int  `yaml:"buffer"`
	DropWhenFull bool `yaml:"drop_when_full"`
}

type LogFileConfig struct {
	Path       string `yaml:"path"`
	MaxSize    int    `yaml:"max_size"`
	MaxBackups int    `yaml:"max_backups"`
	MaxAge     int    `yaml:"max_age"`
	Compress   bool   `yaml:"compress"`

	CompressAlgorithm string `yaml:"compress_algorithm"`
	CompressLevel     int    `yaml:"compress_level"`
	CompressQueue     int    `yaml:"compress_queue"`
	MaxTotalSize      int    `yaml:"max_total_size"`
}

// Load parses embedded default.yaml and applies env overrides. Best-effort
// loads project-root .env (docker injects env directly; local runs rely on
// godotenv, mirroring app-task).
func loadAuth(yamlBytes []byte) (*AuthConfig, error) {
	// app-go/app-user sits two levels below project root; .env lives at root.
	_ = godotenv.Load("../../.env")
	_ = godotenv.Load("../.env") // tolerate running from app-go/ during dev

	var cfg AuthConfig
	if err := yaml.Unmarshal(yamlBytes, &cfg); err != nil {
		return nil, fmt.Errorf("parse default.yaml: %w", err)
	}
	if err := applyAuthEnv(&cfg); err != nil {
		return nil, err
	}
	normalizeSMS(&cfg.SMS)
	if cfg.Security.RateLimit == nil {
		cfg.Security.RateLimit = map[string]RateLimitRule{}
	}
	mergeRateLimitDefaults(cfg.Security.RateLimit)
	return &cfg, nil
}

// normalizeSMS applies safe defaults and clamps explicit values: the provider
// defaults to the legacy dysmsapi path; dypnsapi-only knobs fall back when not
// applicable so existing deployments keep working unchanged.
func normalizeSMS(c *SMSConfig) {
	c.Provider = strings.ToLower(strings.TrimSpace(c.Provider))
	if c.Provider != "dypnsapi" {
		c.Provider = "dysmsapi"
		c.CodeSource = "local"
	}
	c.CodeSource = strings.ToLower(strings.TrimSpace(c.CodeSource))
	if c.Provider == "dypnsapi" && c.CodeSource != "aliyun" {
		c.CodeSource = "local"
	}
	if c.CountryCode == "" {
		c.CountryCode = "86"
	}
	if c.IntervalSeconds <= 0 {
		c.IntervalSeconds = 60
	}
	if c.DuplicatePolicy != 2 {
		c.DuplicatePolicy = 1
	}
	if c.AutoRetry != 0 {
		c.AutoRetry = 1
	}
}

// mergeRateLimitDefaults fills in the Python-parity defaults for any rule
// the YAML doesn't define (partial per-rule overrides supported).
func mergeRateLimitDefaults(rules map[string]RateLimitRule) {
	for name, def := range defaultRateLimits() {
		if _, ok := rules[name]; !ok {
			rules[name] = def
		}
	}
}

// applyEnvOverrides maps env vars onto the config. Order: shared backend env
// vars first (so a single .env drives both services), then APPAUTH__-prefixed
// overrides (highest priority).
func applyAuthEnv(cfg *AuthConfig) error {
	get := func(key string) string { return strings.TrimSpace(os.Getenv(key)) }
	getBool := func(key string) (bool, bool) {
		v := get(key)
		if v == "" {
			return false, false
		}
		return v == "true" || v == "1", true
	}
	atoi := func(key string, dst *int) {
		if v := get(key); v != "" {
			if n, err := strconv.Atoi(v); err == nil {
				*dst = n
			}
		}
	}

	// ── shared secret env vars (same names as the Python backend) ──
	if v := get("SECURITY__API_KEY_ENCRYPTION_KEY"); v != "" {
		cfg.Security.APIKeyEncryptionKey = v
	}
	// _FILE convention: the master key lives in a dedicated secret file
	// (docker volume mount / local secrets/ dir) and wins over the env var.
	if v, err := secretFromFile("SECURITY__API_KEY_ENCRYPTION_KEY_FILE"); err != nil {
		return err
	} else if v != "" {
		cfg.Security.APIKeyEncryptionKey = v
	}
	if v := get("REDIS__URL"); v != "" {
		cfg.Redis.URL = v
	}
	if v := get("EMAIL__API_KEY"); v != "" {
		cfg.Email.APIKey = v
	}
	if b, ok := getBool("EMAIL__ENABLED"); ok {
		cfg.Email.Enabled = b
	}
	if v := get("EMAIL__FROM_EMAIL"); v != "" {
		cfg.Email.FromEmail = v
	}
	if v := get("EMAIL__FRONTEND_URL"); v != "" {
		cfg.Email.FrontendURL = v
	}
	if v := get("SMS__ACCESS_KEY_ID"); v != "" {
		cfg.SMS.AccessKeyID = v
	}
	if v := get("SMS__ACCESS_KEY_SECRET"); v != "" {
		cfg.SMS.AccessKeySecret = v
	}
	// SMS 的非敏感配置（enabled/provider/sign_name/template_code/
	// template_codes/template_params/...）一律以 default.yaml 的 sms 段为准；
	// .env 只允许放 AccessKey 密钥对，避免“compose 默认值覆盖 YAML”的坑。
	if v := get("WECHAT__APP_ID"); v != "" {
		cfg.WeChat.AppID = v
	}
	if v := get("WECHAT__APP_SECRET"); v != "" {
		cfg.WeChat.AppSecret = v
	}
	if v := get("WECHAT__REDIRECT_URI"); v != "" {
		cfg.WeChat.RedirectURI = v
	}
	if b, ok := getBool("WECHAT__ENABLED"); ok {
		cfg.WeChat.Enabled = b
	}

	// internal M2M guard (/internal/auth/user/*); compose injects the shared
	// consumer key under the APPAUTH__-prefixed name.
	if v := get("APPAUTH__INTERNAL__API_KEY"); v != "" {
		cfg.Internal.APIKey = v
	}
	// app-pay membership lookup (Coding Plan VIP/SVIP gate). The key defaults to
	// the shared APISIX consumer key so one .env drives every service; an
	// explicit APPAUTH__APP_PAY__KEY wins.
	if v := get("APPAUTH__APP_PAY__BASE_URL"); v != "" {
		cfg.AppPay.BaseURL = v
	}
	if v := get("APPAUTH__APP_PAY__KEY"); v != "" {
		cfg.AppPay.Key = v
	}
	if v := get("APISIX_CONSUMER_KEY"); v != "" && cfg.AppPay.Key == "" {
		cfg.AppPay.Key = v
	}
	if b, ok := getBool("APPAUTH__SECURITY__ALLOW_PLAINTEXT_FALLBACK"); ok {
		cfg.Security.AllowPlaintextFallback = b
	}
	// ── APPAUTH__-prefixed overrides (highest priority) ──
	if v := get("APPAUTH__RDBMS__URL"); v != "" {
		cfg.RDBMS.URL = v
	}
	if v := get("APPAUTH__REDIS__URL"); v != "" {
		cfg.Redis.URL = v
	}
	atoi("APPAUTH__SERVER__PORT", &cfg.Server.Port)
	atoi("APPAUTH__WORKER_ID", &cfg.WorkerID)
	if v := get("APPAUTH__AUTH__TOKEN_TTL_DAYS"); v != "" {
		atoi("APPAUTH__AUTH__TOKEN_TTL_DAYS", &cfg.Auth.TokenTTLDays)
	}
	if v := get("APPAUTH__SECURITY__API_KEY_ENCRYPTION_KEY"); v != "" {
		cfg.Security.APIKeyEncryptionKey = v
	}
	if b, ok := getBool("APPAUTH__SECURITY__CAPTCHA__ENABLED"); ok {
		cfg.Security.Captcha.Enabled = b
	}
	if b, ok := getBool("APPAUTH__APP__DEBUG"); ok {
		cfg.App.Debug = b
	}
	atoi("APPAUTH__LOG__FILE__MAX_SIZE", &cfg.Log.File.MaxSize)
	if v := get("APPAUTH__LOG__LEVEL"); v != "" {
		cfg.Log.Level = v
	}
	if v := get("APPAUTH__LOG__FORMAT"); v != "" {
		cfg.Log.Format = v
	}
	if v := get("APPAUTH__LOG__OUTPUT"); v != "" {
		cfg.Log.Output = v
	}
	if v := get("APPAUTH__LOG__FILE__PATH"); v != "" {
		cfg.Log.File.Path = v
	}
	return nil
}

// secretFromFile implements the _FILE convention for secrets: when <NAME>_FILE
// is set, the secret is read from that path (docker volume / k8s secret mount,
// or the local secrets/ dir) and overrides the direct env var. Unset = no-op.
func secretFromFile(envName string) (string, error) {
	path := strings.TrimSpace(os.Getenv(envName))
	if path == "" {
		return "", nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("%s=%s: %w", envName, path, err)
	}
	return strings.TrimSpace(string(b)), nil
}

// Validate fails loud on config that would silently break auth semantics.
func validateAuth(cfg *AuthConfig) error {
	if strings.TrimSpace(cfg.RDBMS.URL) == "" {
		return fmt.Errorf("rdbms.url is required (APPAUTH__RDBMS__URL)")
	}
	if cfg.WorkerID < 0 || cfg.WorkerID > 1023 {
		return fmt.Errorf("worker_id must be 0..1023, got %d", cfg.WorkerID)
	}
	if cfg.Auth.TokenTTLDays <= 0 {
		return fmt.Errorf("auth.token_ttl_days must be > 0")
	}
	if strings.TrimSpace(cfg.Security.APIKeyEncryptionKey) == "" &&
		!cfg.Security.AllowPlaintextFallback && !cfg.App.Debug {
		return fmt.Errorf("security.api_key_encryption_key is required " +
			"(or set app.debug=true / security.allow_plaintext_fallback=true for local dev)")
	}
	return nil
}
