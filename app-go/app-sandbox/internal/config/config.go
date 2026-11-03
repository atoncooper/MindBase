// Package config loads app-sandbox configuration from embedded default.yaml +
// SANDBOX__-prefixed env overrides + project-root .env.
//
// Precedence (later wins): default.yaml -> project .env -> real environment.
// Shared env names are honoured as fallbacks so one project .env drives every
// service: RDBMS__URL (database.dsn), APISIX_CONSUMER_KEY (auth + quota api
// keys) and APP_PAY_BASE_URL (quota.appPay.baseUrl).
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/joho/godotenv"
	"gopkg.in/yaml.v3"
)

// Runtime types.
const (
	RuntimeFake        = "fake"
	RuntimeOpenSandbox = "opensandbox"
)

// Quota kinds (usage counters live in sandbox_usage_daily).
const (
	QuotaAcademicRun   = "academic_run"
	QuotaConcurrent    = "sandbox_concurrent"
	QuotaCPUSeconds    = "sandbox_cpu_seconds"
	QuotaArtifactBytes = "sandbox_artifact_bytes"
)

// QuotaKinds is the fixed quota dimension set; config.Validate requires a
// limit row for each of them when quota.enabled.
var QuotaKinds = []string{QuotaAcademicRun, QuotaConcurrent, QuotaCPUSeconds, QuotaArtifactBytes}

// Config is the whole service configuration.
type Config struct {
	App       AppConfig       `yaml:"app"`
	Server    ServerConfig    `yaml:"server"`
	Log       LogConfig       `yaml:"log"`
	Timezone  string          `yaml:"timezone"`
	Database  DatabaseConfig  `yaml:"database"`
	Auth      AuthConfig      `yaml:"auth"`
	Admin     AdminConfig     `yaml:"admin"`
	Runtime   RuntimeConfig   `yaml:"runtime"`
	Execution ExecutionConfig `yaml:"execution"`
	Lease     LeaseConfig     `yaml:"lease"`
	Admission AdmissionConfig `yaml:"admission"`
	Quota     QuotaConfig     `yaml:"quota"`
	Artifacts ArtifactsConfig `yaml:"artifacts"`
	Sweeper   SweeperConfig   `yaml:"sweeper"`
}

type AppConfig struct {
	Name  string `yaml:"name"`
	Debug bool   `yaml:"debug"`
}

type ServerConfig struct {
	Host string `yaml:"host"`
	Port int    `yaml:"port"`
}

type DatabaseConfig struct {
	DSN             string `yaml:"dsn"`
	MaxOpenConns    int    `yaml:"max_open_conns"`
	MaxIdleConns    int    `yaml:"max_idle_conns"`
	ConnMaxLifetime int    `yaml:"conn_max_lifetime"`
}

// AdminConfig configures the internal admin API. The token is
// a shared secret between app-admin and app-sandbox; it is never sent to
// browsers and is independent from the APISIX consumer key. An empty token
// disables the admin API (503 on every request).
type AdminConfig struct {
	Token string `yaml:"token"`
}

type AuthConfig struct {
	// APIKey is the shared gateway consumer key. Empty means every protected
	// route fails closed with 401 (the service still starts and serves /health).
	APIKey string `yaml:"apiKey"`
}

type RuntimeConfig struct {
	Type        string            `yaml:"type"`
	Image       string            `yaml:"image"`
	Resources   ResourceConfig    `yaml:"resources"`
	OpenSandbox OpenSandboxConfig `yaml:"opensandbox"`
}

type ResourceConfig struct {
	CPU    string `yaml:"cpu"`
	Memory string `yaml:"memory"`
}

type OpenSandboxConfig struct {
	LifecycleBaseURL string `yaml:"lifecycleBaseUrl"`
	ExecdBaseURL     string `yaml:"execdBaseUrl"`
	ExecdPort        int    `yaml:"execdPort"`
	PoolRef          string `yaml:"poolRef"`
	APIKey           string `yaml:"apiKey"`
	CreateTimeoutMS  int    `yaml:"createTimeoutMs"`
	ExecTimeoutMS    int    `yaml:"execTimeoutMs"`
}

type ExecutionConfig struct {
	MaxTimeoutMS          int `yaml:"maxTimeoutMs"`
	PreviewBytes          int `yaml:"previewBytes"`
	MaxCodeBytes          int `yaml:"maxCodeBytes"`
	IdempotencyTTLSeconds int `yaml:"idempotencyTtlSeconds"`
}

type LeaseConfig struct {
	TTLSeconds int `yaml:"ttlSeconds"`
	MaxPerUID  int `yaml:"maxPerUid"`
}

type AdmissionConfig struct {
	MaxConcurrent  int `yaml:"maxConcurrent"`
	MaxPerUID      int `yaml:"maxPerUid"`
	QueueSize      int `yaml:"queueSize"`
	QueueTimeoutMS int `yaml:"queueTimeoutMs"`
}

type QuotaConfig struct {
	Enabled bool                 `yaml:"enabled"`
	AppPay  AppPayConfig         `yaml:"appPay"`
	Limits  map[string]TierLimit `yaml:"limits"`
}

type AppPayConfig struct {
	BaseURL    string `yaml:"baseUrl"`
	APIKey     string `yaml:"apiKey"`
	TimeoutMS  int    `yaml:"timeoutMs"`
	CacheTTLMS int    `yaml:"cacheTtlMs"`
}

// TierLimit is one quota dimension across membership tiers. Values are in the
// unit named by the quota kind (counts, bytes or CPU-seconds).
type TierLimit struct {
	Free int64 `yaml:"free"`
	VIP  int64 `yaml:"vip"`
	SVIP int64 `yaml:"svip"`
}

type ArtifactsConfig struct {
	PresignTTLSeconds int      `yaml:"presignTtlSeconds"`
	MaxFileBytes      int64    `yaml:"maxFileBytes"`
	MaxTotalBytes     int64    `yaml:"maxTotalBytes"`
	DefaultGlobs      []string `yaml:"defaultGlobs"`
}

type SweeperConfig struct {
	IntervalMS      int  `yaml:"intervalMs"`
	OrphanDryRun    bool `yaml:"orphanDryRun"`
	CreateTimeoutMS int  `yaml:"createTimeoutMs"`
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

// Load parses embedded default.yaml, applies env overrides and best-effort
// loads the project-root .env (docker injects real env vars instead).
func Load(yamlBytes []byte) (*Config, error) {
	// app-go/app-sandbox sits two levels below the project root.
	_ = godotenv.Load("../../.env")
	_ = godotenv.Load("../.env")

	var cfg Config
	if err := yaml.Unmarshal(yamlBytes, &cfg); err != nil {
		return nil, fmt.Errorf("parse default.yaml: %w", err)
	}
	applyEnvOverrides(&cfg)
	return &cfg, nil
}

func applyEnvOverrides(cfg *Config) {
	get := func(key string) string { return strings.TrimSpace(os.Getenv(key)) }
	setStr := func(key string, dst *string) {
		if v := get(key); v != "" {
			*dst = v
		}
	}
	setInt := func(key string, dst *int) {
		if v := get(key); v != "" {
			if n, err := strconv.Atoi(v); err == nil {
				*dst = n
			}
		}
	}
	setInt64 := func(key string, dst *int64) {
		if v := get(key); v != "" {
			if n, err := strconv.ParseInt(v, 10, 64); err == nil {
				*dst = n
			}
		}
	}
	setBool := func(key string, dst *bool) {
		switch strings.ToLower(get(key)) {
		case "true", "1", "yes", "on":
			*dst = true
		case "false", "0", "no", "off":
			*dst = false
		}
	}

	// ── shared env fallbacks (one .env drives every service) ──
	setStr("RDBMS__URL", &cfg.Database.DSN)
	setStr("APISIX_CONSUMER_KEY", &cfg.Auth.APIKey)
	setStr("APP_PAY_BASE_URL", &cfg.Quota.AppPay.BaseURL)
	setStr("APISIX_CONSUMER_KEY", &cfg.Quota.AppPay.APIKey)

	// ── SANDBOX__-prefixed overrides (highest priority) ──
	setStr("SANDBOX__DATABASE__DSN", &cfg.Database.DSN)
	setStr("SANDBOX__SERVER__HOST", &cfg.Server.Host)
	setInt("SANDBOX__SERVER__PORT", &cfg.Server.Port)
	setStr("SANDBOX__AUTH__API_KEY", &cfg.Auth.APIKey)
	setStr("SANDBOX__ADMIN__TOKEN", &cfg.Admin.Token)
	setStr("SANDBOX__APP__NAME", &cfg.App.Name)
	setBool("SANDBOX__APP__DEBUG", &cfg.App.Debug)
	setStr("SANDBOX__TIMEZONE", &cfg.Timezone)

	setStr("SANDBOX__RUNTIME__TYPE", &cfg.Runtime.Type)
	setStr("SANDBOX__RUNTIME__IMAGE", &cfg.Runtime.Image)
	setStr("SANDBOX__RUNTIME__RESOURCES__CPU", &cfg.Runtime.Resources.CPU)
	setStr("SANDBOX__RUNTIME__RESOURCES__MEMORY", &cfg.Runtime.Resources.Memory)
	setStr("SANDBOX__RUNTIME__OPENSANDBOX__LIFECYCLE_BASE_URL", &cfg.Runtime.OpenSandbox.LifecycleBaseURL)
	setStr("SANDBOX__RUNTIME__OPENSANDBOX__EXECD_BASE_URL", &cfg.Runtime.OpenSandbox.ExecdBaseURL)
	setInt("SANDBOX__RUNTIME__OPENSANDBOX__EXECD_PORT", &cfg.Runtime.OpenSandbox.ExecdPort)
	setStr("SANDBOX__RUNTIME__OPENSANDBOX__POOL_REF", &cfg.Runtime.OpenSandbox.PoolRef)
	setStr("SANDBOX__RUNTIME__OPENSANDBOX__API_KEY", &cfg.Runtime.OpenSandbox.APIKey)
	setInt("SANDBOX__RUNTIME__OPENSANDBOX__CREATE_TIMEOUT_MS", &cfg.Runtime.OpenSandbox.CreateTimeoutMS)
	setInt("SANDBOX__RUNTIME__OPENSANDBOX__EXEC_TIMEOUT_MS", &cfg.Runtime.OpenSandbox.ExecTimeoutMS)

	setInt("SANDBOX__EXECUTION__MAX_TIMEOUT_MS", &cfg.Execution.MaxTimeoutMS)
	setInt("SANDBOX__EXECUTION__PREVIEW_BYTES", &cfg.Execution.PreviewBytes)
	setInt("SANDBOX__EXECUTION__MAX_CODE_BYTES", &cfg.Execution.MaxCodeBytes)
	setInt("SANDBOX__EXECUTION__IDEMPOTENCY_TTL_SECONDS", &cfg.Execution.IdempotencyTTLSeconds)

	setInt("SANDBOX__LEASE__TTL_SECONDS", &cfg.Lease.TTLSeconds)
	setInt("SANDBOX__LEASE__MAX_PER_UID", &cfg.Lease.MaxPerUID)

	setInt("SANDBOX__ADMISSION__MAX_CONCURRENT", &cfg.Admission.MaxConcurrent)
	setInt("SANDBOX__ADMISSION__MAX_PER_UID", &cfg.Admission.MaxPerUID)
	setInt("SANDBOX__ADMISSION__QUEUE_SIZE", &cfg.Admission.QueueSize)
	setInt("SANDBOX__ADMISSION__QUEUE_TIMEOUT_MS", &cfg.Admission.QueueTimeoutMS)

	setBool("SANDBOX__QUOTA__ENABLED", &cfg.Quota.Enabled)
	setStr("SANDBOX__QUOTA__APP_PAY__BASE_URL", &cfg.Quota.AppPay.BaseURL)
	setStr("SANDBOX__QUOTA__APP_PAY__API_KEY", &cfg.Quota.AppPay.APIKey)
	setInt("SANDBOX__QUOTA__APP_PAY__TIMEOUT_MS", &cfg.Quota.AppPay.TimeoutMS)
	setInt("SANDBOX__QUOTA__APP_PAY__CACHE_TTL_MS", &cfg.Quota.AppPay.CacheTTLMS)
	// SANDBOX__QUOTA__LIMITS__<KIND>__<TIER>, e.g. ..._ACADEMIC_RUN__FREE
	if cfg.Quota.Limits != nil {
		for kind := range cfg.Quota.Limits {
			limit := cfg.Quota.Limits[kind]
			prefix := "SANDBOX__QUOTA__LIMITS__" + strings.ToUpper(strings.ReplaceAll(kind, "-", "_")) + "__"
			setInt64(prefix+"FREE", &limit.Free)
			setInt64(prefix+"VIP", &limit.VIP)
			setInt64(prefix+"SVIP", &limit.SVIP)
			cfg.Quota.Limits[kind] = limit
		}
	}

	setInt("SANDBOX__ARTIFACTS__PRESIGN_TTL_SECONDS", &cfg.Artifacts.PresignTTLSeconds)
	setInt64("SANDBOX__ARTIFACTS__MAX_FILE_BYTES", &cfg.Artifacts.MaxFileBytes)
	setInt64("SANDBOX__ARTIFACTS__MAX_TOTAL_BYTES", &cfg.Artifacts.MaxTotalBytes)

	setInt("SANDBOX__SWEEPER__INTERVAL_MS", &cfg.Sweeper.IntervalMS)
	setBool("SANDBOX__SWEEPER__ORPHAN_DRY_RUN", &cfg.Sweeper.OrphanDryRun)
	setInt("SANDBOX__SWEEPER__CREATE_TIMEOUT_MS", &cfg.Sweeper.CreateTimeoutMS)

	setStr("SANDBOX__LOG__LEVEL", &cfg.Log.Level)
	setStr("SANDBOX__LOG__FORMAT", &cfg.Log.Format)
	setStr("SANDBOX__LOG__OUTPUT", &cfg.Log.Output)
	setStr("SANDBOX__LOG__FILE__PATH", &cfg.Log.File.Path)
}

// Validate fails loud on config that would silently break the service.
func Validate(cfg *Config) error {
	if strings.TrimSpace(cfg.Database.DSN) == "" {
		return fmt.Errorf("database.dsn is required (SANDBOX__DATABASE__DSN or RDBMS__URL)")
	}
	if cfg.Server.Port <= 0 || cfg.Server.Port > 65535 {
		return fmt.Errorf("server.port must be within 1..65535")
	}
	switch cfg.Runtime.Type {
	case RuntimeFake:
	case RuntimeOpenSandbox:
		if strings.TrimSpace(cfg.Runtime.OpenSandbox.LifecycleBaseURL) == "" {
			return fmt.Errorf("runtime.opensandbox.lifecycleBaseUrl is required when runtime.type=opensandbox")
		}
	default:
		return fmt.Errorf("runtime.type must be fake or opensandbox (got %q)", cfg.Runtime.Type)
	}
	if cfg.Lease.TTLSeconds <= 0 {
		return fmt.Errorf("lease.ttlSeconds must be > 0")
	}
	if cfg.Admission.MaxConcurrent <= 0 || cfg.Admission.MaxPerUID <= 0 {
		return fmt.Errorf("admission.maxConcurrent and admission.maxPerUid must be > 0")
	}
	if cfg.Execution.MaxTimeoutMS <= 0 {
		return fmt.Errorf("execution.maxTimeoutMs must be > 0")
	}
	if cfg.Quota.Enabled {
		for _, kind := range QuotaKinds {
			if _, ok := cfg.Quota.Limits[kind]; !ok {
				return fmt.Errorf("quota.limits.%s is required when quota.enabled", kind)
			}
		}
	}
	if cfg.Sweeper.IntervalMS <= 0 {
		return fmt.Errorf("sweeper.intervalMs must be > 0")
	}
	return nil
}

// QuotaLimit returns the tier limits of one quota kind (zero value when unset).
func (c *Config) QuotaLimit(kind string) TierLimit {
	if c.Quota.Limits == nil {
		return TierLimit{}
	}
	return c.Quota.Limits[kind]
}

// LeaseTTL is the lease TTL as a duration.
func (c *Config) LeaseTTL() time.Duration {
	return time.Duration(c.Lease.TTLSeconds) * time.Second
}

// MaxExecTimeout is the hard ceiling for a single execution.
func (c *Config) MaxExecTimeout() time.Duration {
	return time.Duration(c.Execution.MaxTimeoutMS) * time.Millisecond
}

// AdmissionQueueTimeout is how long a request may wait for an admission slot.
func (c *Config) AdmissionQueueTimeout() time.Duration {
	return time.Duration(c.Admission.QueueTimeoutMS) * time.Millisecond
}

// SweeperInterval is the sweeper tick period.
func (c *Config) SweeperInterval() time.Duration {
	return time.Duration(c.Sweeper.IntervalMS) * time.Millisecond
}

// CreateTimeout is the runtime.Create ceiling.
func (c *Config) CreateTimeout() time.Duration {
	if c.Runtime.OpenSandbox.CreateTimeoutMS > 0 {
		return time.Duration(c.Runtime.OpenSandbox.CreateTimeoutMS) * time.Millisecond
	}
	return 60 * time.Second
}

// CPUMilli parses runtime.resources.cpu ("500m", "2", "1500m") into milli-CPUs.
// Unparseable/empty input falls back to 500m so quota accounting never divides
// by zero.
func (c *Config) CPUMilli() int64 {
	raw := strings.TrimSpace(strings.ToLower(c.Runtime.Resources.CPU))
	if raw == "" {
		return 500
	}
	if strings.HasSuffix(raw, "m") {
		if n, err := strconv.ParseInt(strings.TrimSuffix(raw, "m"), 10, 64); err == nil && n > 0 {
			return n
		}
		return 500
	}
	if n, err := strconv.ParseFloat(raw, 64); err == nil && n > 0 {
		return int64(n * 1000)
	}
	return 500
}
