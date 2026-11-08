// Package config is the single configuration entry point for app-content.
//
// Layout: process-wide app/server/security/log/observability sections plus one
// section per domain (board/note/quiz). Environment overrides use
// CONTENT__SECTION__KEY (double underscore nests). Legacy APPBOARD__ /
// APPNOTE__ / APPQUIZ__ prefixes remain valid for the domain sections and for
// the old single-listener/log/CORS keys.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	appcontent "app-content"
	quizconfig "app-content/internal/config/quiz"

	"github.com/joho/godotenv"
	"gopkg.in/yaml.v3"
)

// AppConfig identifies the deployment.
type AppConfig struct {
	Name  string `yaml:"name"`
	Env   string `yaml:"env"` // dev|staging|production
	Debug bool   `yaml:"debug"`
}

// TimeoutsConfig is the HTTP server timeout baseline.
type TimeoutsConfig struct {
	ReadHeaderSeconds int `yaml:"read_header_seconds"`
	ReadSeconds       int `yaml:"read_seconds"`
	WriteSeconds      int `yaml:"write_seconds"`
	IdleSeconds       int `yaml:"idle_seconds"`
}

// TLSConfig configures the single HTTPS listener.
type TLSConfig struct {
	Enabled          bool   `yaml:"enabled"`
	CertDir          string `yaml:"cert_dir"`
	Cert             string `yaml:"cert"`
	Key              string `yaml:"key"`
	MinVersion       string `yaml:"min_version"`    // 1.2|1.3
	ClientAuth       string `yaml:"client_auth"`    // none|request|require
	ClientCAFile     string `yaml:"client_ca_file"` // required when client_auth != none
	RotateWithinDays int    `yaml:"rotate_within_days"`
}

// ServerConfig is the one and only process listener.
type ServerConfig struct {
	Host                    string         `yaml:"host"`
	Port                    int            `yaml:"port"`
	HTTP2                   bool           `yaml:"http2"`
	MaxHeaderBytes          int            `yaml:"max_header_bytes"`
	GracefulShutdownSeconds int            `yaml:"graceful_shutdown_seconds"`
	TrustedProxies          []string       `yaml:"trusted_proxies"`
	Timeouts                TimeoutsConfig `yaml:"timeouts"`
	TLS                     TLSConfig      `yaml:"tls"`
}

// RequestIDConfig controls trace-id propagation.
type RequestIDConfig struct {
	Header    string `yaml:"header"`
	MaxLength int    `yaml:"max_length"`
}

// HeadersConfig is the security-header baseline.
type HeadersConfig struct {
	HSTSEnabled        bool   `yaml:"hsts_enabled"`
	HSTSMaxAgeSeconds  int    `yaml:"hsts_max_age_seconds"`
	FrameOptions       string `yaml:"frame_options"`
	ContentTypeOptions string `yaml:"content_type_options"`
	ReferrerPolicy     string `yaml:"referrer_policy"`
	PermissionsPolicy  string `yaml:"permissions_policy"`
}

// CORSConfig is an explicit allow-list (credentials mode).
type CORSConfig struct {
	AllowOrigins     []string `yaml:"allow_origins"`
	AllowMethods     []string `yaml:"allow_methods"`
	AllowHeaders     []string `yaml:"allow_headers"`
	ExposeHeaders    []string `yaml:"expose_headers"`
	AllowCredentials bool     `yaml:"allow_credentials"`
	MaxAgeSeconds    int      `yaml:"max_age_seconds"`
}

// RateLimitConfig is the in-process token-bucket guard.
type RateLimitConfig struct {
	Enabled                bool     `yaml:"enabled"`
	RPS                    float64  `yaml:"rps"`
	Burst                  int      `yaml:"burst"`
	Key                    string   `yaml:"key"` // ip|ip_uid
	ExcludePaths           []string `yaml:"exclude_paths"`
	CleanupIntervalSeconds int      `yaml:"cleanup_interval_seconds"`
}

// BodyLimitsConfig caps request bodies per domain.
type BodyLimitsConfig struct {
	BoardBytes int64 `yaml:"board_bytes"`
	NoteBytes  int64 `yaml:"note_bytes"`
	QuizBytes  int64 `yaml:"quiz_bytes"`
}

// SecurityConfig is process-wide security configuration.
type SecurityConfig struct {
	InternalAPIKey string           `yaml:"internal_api_key"`
	RequestID      RequestIDConfig  `yaml:"request_id"`
	Headers        HeadersConfig    `yaml:"headers"`
	CORS           CORSConfig       `yaml:"cors"`
	RateLimit      RateLimitConfig  `yaml:"rate_limit"`
	BodyLimits     BodyLimitsConfig `yaml:"body_limits"`
}

// LogFileConfig is lumberjack rotation.
type LogFileConfig struct {
	Path       string `yaml:"path"`
	MaxSize    int    `yaml:"max_size"`
	MaxBackups int    `yaml:"max_backups"`
	MaxAge     int    `yaml:"max_age"`
	Compress   bool   `yaml:"compress"`
}

// LogConfig is the process-wide logger.
type LogConfig struct {
	Level     string        `yaml:"level"`
	Format    string        `yaml:"format"`
	Output    string        `yaml:"output"`
	AddSource bool          `yaml:"add_source"`
	File      LogFileConfig `yaml:"file"`
}

// HealthConfig controls the aggregated probe.
type HealthConfig struct {
	TimeoutSeconds int `yaml:"timeout_seconds"`
}

// MetricsConfig exposes a Prometheus text endpoint.
type MetricsConfig struct {
	Enabled bool   `yaml:"enabled"`
	Path    string `yaml:"path"`
}

// PprofConfig exposes net/http/pprof (never enable publicly).
type PprofConfig struct {
	Enabled bool `yaml:"enabled"`
}

// ObservabilityConfig groups health/metrics/pprof.
type ObservabilityConfig struct {
	Health  HealthConfig  `yaml:"health"`
	Metrics MetricsConfig `yaml:"metrics"`
	Pprof   PprofConfig   `yaml:"pprof"`
}

// Config is the whole app-content configuration.
type Config struct {
	App           AppConfig
	Server        ServerConfig
	Security      SecurityConfig
	Log           LogConfig
	Observability ObservabilityConfig
	Database      DatabaseConfig
	Quiz          quizconfig.Config
}

// Load parses the embedded YAML and delegates each domain section to its
// historical loader (which keeps its env prefix).
func Load() (*Config, error) {
	// Load the project-root .env exactly once, before any env override is
	// read. Domain packages no longer load dotenv on their own.
	_ = godotenv.Load("../../.env")
	_ = godotenv.Load("../.env")

	var sections map[string]yaml.Node
	if err := yaml.Unmarshal(appcontent.DefaultYAML, &sections); err != nil {
		return nil, fmt.Errorf("parse default.yaml: %w", err)
	}
	decode := func(name string, dst any) error {
		node, ok := sections[name]
		if !ok {
			return nil // optional root section
		}
		raw, err := yaml.Marshal(node)
		if err != nil {
			return err
		}
		return yaml.Unmarshal(raw, dst)
	}
	cfg := &Config{}
	if err := decode("app", &cfg.App); err != nil {
		return nil, fmt.Errorf("app section: %w", err)
	}
	if err := decode("server", &cfg.Server); err != nil {
		return nil, fmt.Errorf("server section: %w", err)
	}
	if err := decode("security", &cfg.Security); err != nil {
		return nil, fmt.Errorf("security section: %w", err)
	}
	if err := decode("log", &cfg.Log); err != nil {
		return nil, fmt.Errorf("log section: %w", err)
	}
	if err := decode("observability", &cfg.Observability); err != nil {
		return nil, fmt.Errorf("observability section: %w", err)
	}
	if err := decode("database", &cfg.Database); err != nil {
		return nil, fmt.Errorf("database section: %w", err)
	}
	section := func(name string) ([]byte, error) {
		node, ok := sections[name]
		if !ok {
			return nil, fmt.Errorf("default.yaml missing %q section", name)
		}
		return yaml.Marshal(node)
	}
	quizBytes, err := section("quiz")
	if err != nil {
		return nil, err
	}
	quizCfg, err := quizconfig.Load(quizBytes)
	if err != nil {
		return nil, fmt.Errorf("load quiz config: %w", err)
	}
	cfg.Quiz = *quizCfg

	if err := applyEnvOverrides(cfg); err != nil {
		return nil, err
	}
	applyDefaults(cfg)
	if err := quizconfig.Validate(&cfg.Quiz); err != nil {
		return nil, fmt.Errorf("quiz config: %w", err)
	}
	if err := validate(cfg); err != nil {
		return nil, err
	}
	return cfg, nil
}

func env(key string) string { return strings.TrimSpace(os.Getenv(key)) }
func envInt(key string, dst *int) {
	if v := env(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			*dst = n
		}
	}
}
func envInt64(key string, dst *int64) {
	if v := env(key); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			*dst = n
		}
	}
}
func envBool(key string, dst *bool) {
	if v := env(key); v != "" {
		*dst = v == "true" || v == "1"
	}
}
func envFloat(key string, dst *float64) {
	if v := env(key); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			*dst = f
		}
	}
}
func envCSV(key string, dst *[]string) {
	if v := env(key); v != "" {
		parts := make([]string, 0)
		for _, p := range strings.Split(v, ",") {
			if p = strings.TrimSpace(p); p != "" {
				parts = append(parts, p)
			}
		}
		*dst = parts
	}
}

func applyEnvOverrides(cfg *Config) error {
	// ── process-wide CONTENT__ overrides ──
	if v := env("CONTENT__APP__ENV"); v != "" {
		cfg.App.Env = v
	}
	envBool("CONTENT__APP__DEBUG", &cfg.App.Debug)
	if v := env("CONTENT__SERVER__HOST"); v != "" {
		cfg.Server.Host = v
	}
	envInt("CONTENT__SERVER__PORT", &cfg.Server.Port)
	envBool("CONTENT__SERVER__HTTP2", &cfg.Server.HTTP2)
	envInt("CONTENT__SERVER__MAX_HEADER_BYTES", &cfg.Server.MaxHeaderBytes)
	envInt("CONTENT__SERVER__GRACEFUL_SHUTDOWN_SECONDS", &cfg.Server.GracefulShutdownSeconds)
	envCSV("CONTENT__SERVER__TRUSTED_PROXIES", &cfg.Server.TrustedProxies)
	envInt("CONTENT__SERVER__TIMEOUTS__READ_HEADER_SECONDS", &cfg.Server.Timeouts.ReadHeaderSeconds)
	envInt("CONTENT__SERVER__TIMEOUTS__READ_SECONDS", &cfg.Server.Timeouts.ReadSeconds)
	envInt("CONTENT__SERVER__TIMEOUTS__WRITE_SECONDS", &cfg.Server.Timeouts.WriteSeconds)
	envInt("CONTENT__SERVER__TIMEOUTS__IDLE_SECONDS", &cfg.Server.Timeouts.IdleSeconds)
	envBool("CONTENT__SERVER__TLS__ENABLED", &cfg.Server.TLS.Enabled)
	if v := env("CONTENT__SERVER__TLS__CERT_DIR"); v != "" {
		cfg.Server.TLS.CertDir = v
	}
	if v := env("CONTENT__SERVER__TLS__CERT"); v != "" {
		cfg.Server.TLS.Cert = v
	}
	if v := env("CONTENT__SERVER__TLS__KEY"); v != "" {
		cfg.Server.TLS.Key = v
	}
	if v := env("CONTENT__SERVER__TLS__MIN_VERSION"); v != "" {
		cfg.Server.TLS.MinVersion = v
	}
	if v := env("CONTENT__SERVER__TLS__CLIENT_AUTH"); v != "" {
		cfg.Server.TLS.ClientAuth = v
	}
	if v := env("CONTENT__SERVER__TLS__CLIENT_CA_FILE"); v != "" {
		cfg.Server.TLS.ClientCAFile = v
	}
	envInt("CONTENT__SERVER__TLS__ROTATE_WITHIN_DAYS", &cfg.Server.TLS.RotateWithinDays)
	if v := env("CONTENT__INTERNAL_API_KEY"); v != "" {
		cfg.Security.InternalAPIKey = v
	}
	if v := env("CONTENT__SECURITY__REQUEST_ID__HEADER"); v != "" {
		cfg.Security.RequestID.Header = v
	}
	envInt("CONTENT__SECURITY__REQUEST_ID__MAX_LENGTH", &cfg.Security.RequestID.MaxLength)
	envBool("CONTENT__SECURITY__HEADERS__HSTS_ENABLED", &cfg.Security.Headers.HSTSEnabled)
	envInt("CONTENT__SECURITY__HEADERS__HSTS_MAX_AGE_SECONDS", &cfg.Security.Headers.HSTSMaxAgeSeconds)
	envCSV("CONTENT__SECURITY__CORS__ALLOW_ORIGINS", &cfg.Security.CORS.AllowOrigins)
	envCSV("CONTENT__SECURITY__CORS__ALLOW_METHODS", &cfg.Security.CORS.AllowMethods)
	envCSV("CONTENT__SECURITY__CORS__ALLOW_HEADERS", &cfg.Security.CORS.AllowHeaders)
	envCSV("CONTENT__SECURITY__CORS__EXPOSE_HEADERS", &cfg.Security.CORS.ExposeHeaders)
	envBool("CONTENT__SECURITY__CORS__ALLOW_CREDENTIALS", &cfg.Security.CORS.AllowCredentials)
	envInt("CONTENT__SECURITY__CORS__MAX_AGE_SECONDS", &cfg.Security.CORS.MaxAgeSeconds)
	envBool("CONTENT__SECURITY__RATE_LIMIT__ENABLED", &cfg.Security.RateLimit.Enabled)
	envFloat("CONTENT__SECURITY__RATE_LIMIT__RPS", &cfg.Security.RateLimit.RPS)
	envInt("CONTENT__SECURITY__RATE_LIMIT__BURST", &cfg.Security.RateLimit.Burst)
	if v := env("CONTENT__SECURITY__RATE_LIMIT__KEY"); v != "" {
		cfg.Security.RateLimit.Key = v
	}
	envCSV("CONTENT__SECURITY__RATE_LIMIT__EXCLUDE_PATHS", &cfg.Security.RateLimit.ExcludePaths)
	envInt64("CONTENT__SECURITY__BODY_LIMITS__BOARD_BYTES", &cfg.Security.BodyLimits.BoardBytes)
	envInt64("CONTENT__SECURITY__BODY_LIMITS__NOTE_BYTES", &cfg.Security.BodyLimits.NoteBytes)
	envInt64("CONTENT__SECURITY__BODY_LIMITS__QUIZ_BYTES", &cfg.Security.BodyLimits.QuizBytes)
	if v := env("CONTENT__LOG__LEVEL"); v != "" {
		cfg.Log.Level = v
	}
	if v := env("CONTENT__LOG__FORMAT"); v != "" {
		cfg.Log.Format = v
	}
	if v := env("CONTENT__LOG__OUTPUT"); v != "" {
		cfg.Log.Output = v
	}
	envBool("CONTENT__LOG__ADD_SOURCE", &cfg.Log.AddSource)
	envBool("CONTENT__OBSERVABILITY__METRICS__ENABLED", &cfg.Observability.Metrics.Enabled)
	if v := env("CONTENT__OBSERVABILITY__METRICS__PATH"); v != "" {
		cfg.Observability.Metrics.Path = v
	}
	envBool("CONTENT__OBSERVABILITY__PPROF__ENABLED", &cfg.Observability.Pprof.Enabled)
	envInt("CONTENT__OBSERVABILITY__HEALTH__TIMEOUT_SECONDS", &cfg.Observability.Health.TimeoutSeconds)

	// ── legacy app-board env keys (pre-merge compatibility) ──
	envInt("APPBOARD__SERVER__PORT", &cfg.Server.Port)
	envInt("APPBOARD__SERVER__READ_HEADER_TIMEOUT_SECONDS", &cfg.Server.Timeouts.ReadHeaderSeconds)
	envInt("APPBOARD__SERVER__READ_TIMEOUT_SECONDS", &cfg.Server.Timeouts.ReadSeconds)
	envInt("APPBOARD__SERVER__WRITE_TIMEOUT_SECONDS", &cfg.Server.Timeouts.WriteSeconds)
	envInt("APPBOARD__SERVER__IDLE_TIMEOUT_SECONDS", &cfg.Server.Timeouts.IdleSeconds)
	envInt("APPBOARD__SERVER__MAX_HEADER_BYTES", &cfg.Server.MaxHeaderBytes)
	envBool("APPBOARD__SERVER__TLS__ENABLED", &cfg.Server.TLS.Enabled)
	if v := env("APPBOARD__SERVER__TLS__CERT_DIR"); v != "" {
		cfg.Server.TLS.CertDir = v
	}
	if v := env("APPBOARD__SERVER__TLS__CERT"); v != "" {
		cfg.Server.TLS.Cert = v
	}
	if v := env("APPBOARD__SERVER__TLS__KEY"); v != "" {
		cfg.Server.TLS.Key = v
	}
	envCSV("APPBOARD__SECURITY__CORS__ALLOW_ORIGINS", &cfg.Security.CORS.AllowOrigins)
	if v := env("APPBOARD__LOG__LEVEL"); v != "" {
		cfg.Log.Level = v
	}
	if v := env("APPBOARD__LOG__FORMAT"); v != "" {
		cfg.Log.Format = v
	}
	if v := env("APPBOARD__LOG__OUTPUT"); v != "" {
		cfg.Log.Output = v
	}
	if v := env("APPBOARD__LOG__FILE__PATH"); v != "" {
		cfg.Log.File.Path = v
	}
	envInt("APPBOARD__LOG__FILE__MAX_SIZE", &cfg.Log.File.MaxSize)
	envInt("APPBOARD__LOG__FILE__MAX_BACKUPS", &cfg.Log.File.MaxBackups)
	envInt("APPBOARD__LOG__FILE__MAX_AGE", &cfg.Log.File.MaxAge)
	envBool("APPBOARD__LOG__FILE__COMPRESS", &cfg.Log.File.Compress)

	// ── quiz-domain tuning (data stores are process-wide Database) ──
	envInt("CONTENT__QUIZ__QUOTA__GENERATE", &cfg.Quiz.Quota.Generate)
	envInt("CONTENT__QUIZ__QUOTA__GRADE", &cfg.Quiz.Quota.Grade)
	envInt("CONTENT__QUIZ__LIFECYCLE__GENERATION_TIMEOUT_MINUTES", &cfg.Quiz.Lifecycle.GenerationTimeoutMinutes)
	envInt("APPQUIZ__QUOTA__GENERATE", &cfg.Quiz.Quota.Generate)
	envInt("APPQUIZ__QUOTA__GRADE", &cfg.Quiz.Quota.Grade)
	envInt("APPQUIZ__LIFECYCLE__GENERATION_TIMEOUT_MINUTES", &cfg.Quiz.Lifecycle.GenerationTimeoutMinutes)

	return applyDatabaseEnvOverrides(&cfg.Database)
}

func applyDefaults(cfg *Config) {
	if cfg.App.Name == "" {
		cfg.App.Name = "app-content"
	}
	if cfg.App.Env == "" {
		cfg.App.Env = "production"
	}
	if cfg.Server.Host == "" {
		cfg.Server.Host = "0.0.0.0"
	}
	if cfg.Server.Port == 0 {
		cfg.Server.Port = 8004
	}
	if cfg.Server.MaxHeaderBytes == 0 {
		cfg.Server.MaxHeaderBytes = 1 << 20
	}
	if cfg.Server.GracefulShutdownSeconds == 0 {
		cfg.Server.GracefulShutdownSeconds = 15
	}
	if cfg.Server.Timeouts.ReadHeaderSeconds == 0 {
		cfg.Server.Timeouts.ReadHeaderSeconds = 10
	}
	if cfg.Server.Timeouts.ReadSeconds == 0 {
		cfg.Server.Timeouts.ReadSeconds = 60
	}
	if cfg.Server.Timeouts.WriteSeconds == 0 {
		cfg.Server.Timeouts.WriteSeconds = 120
	}
	if cfg.Server.Timeouts.IdleSeconds == 0 {
		cfg.Server.Timeouts.IdleSeconds = 120
	}
	if cfg.Server.TLS.CertDir == "" {
		cfg.Server.TLS.CertDir = "certs"
	}
	if cfg.Server.TLS.MinVersion == "" {
		cfg.Server.TLS.MinVersion = "1.2"
	}
	if cfg.Server.TLS.ClientAuth == "" {
		cfg.Server.TLS.ClientAuth = "none"
	}
	if cfg.Server.TLS.RotateWithinDays == 0 {
		cfg.Server.TLS.RotateWithinDays = 30
	}
	if cfg.Security.RequestID.Header == "" {
		cfg.Security.RequestID.Header = "X-Request-Id"
	}
	if cfg.Security.RequestID.MaxLength == 0 {
		cfg.Security.RequestID.MaxLength = 64
	}
	if cfg.Security.Headers.HSTSMaxAgeSeconds == 0 {
		cfg.Security.Headers.HSTSMaxAgeSeconds = 31536000
	}
	if cfg.Security.Headers.FrameOptions == "" {
		cfg.Security.Headers.FrameOptions = "DENY"
	}
	if cfg.Security.Headers.ContentTypeOptions == "" {
		cfg.Security.Headers.ContentTypeOptions = "nosniff"
	}
	if cfg.Security.Headers.ReferrerPolicy == "" {
		cfg.Security.Headers.ReferrerPolicy = "no-referrer"
	}
	if len(cfg.Security.CORS.AllowMethods) == 0 {
		cfg.Security.CORS.AllowMethods = []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"}
	}
	if len(cfg.Security.CORS.AllowHeaders) == 0 {
		cfg.Security.CORS.AllowHeaders = []string{"Authorization", "Content-Type", "X-Requested-With", "X-Request-Id", "If-Match", "X-Api-Key", "apikey"}
	}
	if len(cfg.Security.CORS.ExposeHeaders) == 0 {
		cfg.Security.CORS.ExposeHeaders = []string{"X-Total-Count", "X-Request-Id"}
	}
	if cfg.Security.CORS.MaxAgeSeconds == 0 {
		cfg.Security.CORS.MaxAgeSeconds = 600
	}
	if cfg.Security.RateLimit.RPS == 0 {
		cfg.Security.RateLimit.RPS = 100
	}
	if cfg.Security.RateLimit.Burst == 0 {
		cfg.Security.RateLimit.Burst = 200
	}
	if cfg.Security.RateLimit.Key == "" {
		cfg.Security.RateLimit.Key = "ip"
	}
	if cfg.Security.RateLimit.CleanupIntervalSeconds == 0 {
		cfg.Security.RateLimit.CleanupIntervalSeconds = 300
	}
	if cfg.Security.BodyLimits.BoardBytes == 0 {
		cfg.Security.BodyLimits.BoardBytes = 9 << 20
	}
	if cfg.Security.BodyLimits.NoteBytes == 0 {
		cfg.Security.BodyLimits.NoteBytes = 2 << 20
	}
	if cfg.Security.BodyLimits.QuizBytes == 0 {
		cfg.Security.BodyLimits.QuizBytes = 4 << 20
	}
	if cfg.Log.Level == "" {
		cfg.Log.Level = "info"
	}
	if cfg.Log.Format == "" {
		cfg.Log.Format = "json"
	}
	if cfg.Log.Output == "" {
		cfg.Log.Output = "stdout"
	}
	if cfg.Log.File.Path == "" {
		cfg.Log.File.Path = "/app/logs/app-content.log"
	}
	if cfg.Observability.Health.TimeoutSeconds == 0 {
		cfg.Observability.Health.TimeoutSeconds = 2
	}
	if cfg.Observability.Metrics.Path == "" {
		cfg.Observability.Metrics.Path = "/metrics"
	}
	applyDatabaseDefaults(&cfg.Database)
}

func validate(cfg *Config) error {
	if cfg.Server.Port <= 0 || cfg.Server.Port > 65535 {
		return fmt.Errorf("server.port out of range: %d", cfg.Server.Port)
	}
	if cfg.Server.Timeouts.ReadHeaderSeconds <= 0 || cfg.Server.Timeouts.ReadSeconds <= 0 ||
		cfg.Server.Timeouts.WriteSeconds <= 0 || cfg.Server.Timeouts.IdleSeconds <= 0 {
		return fmt.Errorf("server timeouts must be positive")
	}
	if cfg.Server.TLS.MinVersion != "1.2" && cfg.Server.TLS.MinVersion != "1.3" {
		return fmt.Errorf("server.tls.min_version must be 1.2 or 1.3")
	}
	switch cfg.Server.TLS.ClientAuth {
	case "none":
	case "request", "require":
		if strings.TrimSpace(cfg.Server.TLS.ClientCAFile) == "" {
			return fmt.Errorf("server.tls.client_ca_file is required when client_auth=%s", cfg.Server.TLS.ClientAuth)
		}
	default:
		return fmt.Errorf("server.tls.client_auth must be none|request|require")
	}
	switch cfg.Log.Format {
	case "text", "json":
	default:
		return fmt.Errorf("log.format must be text|json")
	}
	switch cfg.Log.Output {
	case "stdout", "file", "both":
	default:
		return fmt.Errorf("log.output must be stdout|file|both")
	}
	if cfg.Security.RateLimit.Key != "ip" && cfg.Security.RateLimit.Key != "ip_uid" {
		return fmt.Errorf("security.rate_limit.key must be ip|ip_uid")
	}
	if cfg.Security.RateLimit.RPS <= 0 || cfg.Security.RateLimit.Burst <= 0 {
		return fmt.Errorf("security.rate_limit.rps/burst must be > 0")
	}
	for _, o := range cfg.Security.CORS.AllowOrigins {
		if strings.TrimSpace(o) == "*" {
			return fmt.Errorf("cors allow_origins must not contain \"*\" (credentials mode)")
		}
	}
	if cfg.Security.BodyLimits.BoardBytes <= 0 || cfg.Security.BodyLimits.NoteBytes <= 0 || cfg.Security.BodyLimits.QuizBytes <= 0 {
		return fmt.Errorf("security.body_limits must be > 0")
	}
	if !strings.HasPrefix(cfg.Observability.Metrics.Path, "/") {
		return fmt.Errorf("observability.metrics.path must start with /")
	}
	return nil
}

// ValidateDataStores enforces the runtime requirements (URLs present). It is
// checked by bootstrap.Run, not Load: Load must stay usable for tooling that
// only inspects the YAML shape.
func (c *Config) ValidateDataStores() error {
	return validateDatabase(&c.Database)
}
