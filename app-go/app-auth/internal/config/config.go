// Package config loads app-auth configuration from embedded default.yaml +
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

type Config struct {
	App          AppConfig          `yaml:"app"`
	Server       ServerConfig       `yaml:"server"`
	Timezone     string             `yaml:"timezone"`
	RDBMS        RDBMSConfig        `yaml:"rdbms"`
	Redis        RedisConfig        `yaml:"redis"`
	Auth         AuthConfig         `yaml:"auth"`
	Security     SecurityConfig     `yaml:"security"`
	Email        EmailConfig        `yaml:"email"`
	SMS          SMSConfig          `yaml:"sms"`
	WeChat       WeChatConfig       `yaml:"wechat"`
	WorkerID     int                `yaml:"worker_id"`
	SecurityCORS SecurityCORSConfig `yaml:"security_cors"`
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

type RedisConfig struct {
	URL string `yaml:"url"`
}

type AuthConfig struct {
	TokenTTLDays    int    `yaml:"token_ttl_days"`
	CacheTTLSeconds int    `yaml:"cache_ttl_seconds"`
	TokenCacheNS    string `yaml:"token_cache_namespace"`
}

type SecurityConfig struct {
	APIKeyEncryptionKey string        `yaml:"api_key_encryption_key"`
	Captcha             CaptchaConfig `yaml:"captcha"`
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
		"login_target":      {Max: 5, Window: 300},
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
	Enabled         bool   `yaml:"enabled"`
	AccessKeyID     string `yaml:"access_key_id"`
	AccessKeySecret string `yaml:"access_key_secret"`
	SignName        string `yaml:"sign_name"`
	TemplateCode    string `yaml:"template_code"`
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
}

type LogFileConfig struct {
	Path       string `yaml:"path"`
	MaxSize    int    `yaml:"max_size"`
	MaxBackups int    `yaml:"max_backups"`
	MaxAge     int    `yaml:"max_age"`
	Compress   bool   `yaml:"compress"`
}

// Load parses embedded default.yaml and applies env overrides. Best-effort
// loads project-root .env (docker injects env directly; local runs rely on
// godotenv, mirroring app-task).
func Load(yamlBytes []byte) (*Config, error) {
	// app-go/app-auth sits two levels below project root; .env lives at root.
	_ = godotenv.Load("../../.env")
	_ = godotenv.Load("../.env") // tolerate running from app-go/ during dev

	var cfg Config
	if err := yaml.Unmarshal(yamlBytes, &cfg); err != nil {
		return nil, fmt.Errorf("parse default.yaml: %w", err)
	}
	applyEnvOverrides(&cfg)
	if cfg.Security.RateLimit == nil {
		cfg.Security.RateLimit = map[string]RateLimitRule{}
	}
	mergeRateLimitDefaults(cfg.Security.RateLimit)
	return &cfg, nil
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
func applyEnvOverrides(cfg *Config) {
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
	if v := get("SMS__SIGN_NAME"); v != "" {
		cfg.SMS.SignName = v
	}
	if v := get("SMS__TEMPLATE_CODE"); v != "" {
		cfg.SMS.TemplateCode = v
	}
	if b, ok := getBool("SMS__ENABLED"); ok {
		cfg.SMS.Enabled = b
	}
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
}

// Validate fails loud on config that would silently break auth semantics.
func Validate(cfg *Config) error {
	if strings.TrimSpace(cfg.RDBMS.URL) == "" {
		return fmt.Errorf("rdbms.url is required (APPAUTH__RDBMS__URL)")
	}
	if cfg.WorkerID < 0 || cfg.WorkerID > 1023 {
		return fmt.Errorf("worker_id must be 0..1023, got %d", cfg.WorkerID)
	}
	if cfg.Auth.TokenTTLDays <= 0 {
		return fmt.Errorf("auth.token_ttl_days must be > 0")
	}
	return nil
}
