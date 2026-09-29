// Package config loads app-task configuration from embedded default.yaml +
// APPTASK__-prefixed env overrides + project-root .env.
package config

import (
	"fmt"
	"os"
	"regexp"
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
	Cluster      ClusterConfig      `yaml:"cluster"`
	Scheduler    SchedulerConfig    `yaml:"scheduler"`
	Lua          LuaConfig          `yaml:"lua"`
	HTTPExecutor HTTPExecutorConfig `yaml:"http_executor"`
	Email        EmailConfig        `yaml:"email"`
	Notification NotificationConfig `yaml:"notification"`
	WebUI        WebUIConfig        `yaml:"webui"`
	Security     SecurityConfig     `yaml:"security"`
	Log          LogConfig          `yaml:"log"`
}

type LogConfig struct {
	Level  string        `yaml:"level"`  // debug|info|warn|error (default info)
	Format string        `yaml:"format"` // text|json (default text)
	Output string        `yaml:"output"` // stdout|file|both (default stdout)
	File   LogFileConfig `yaml:"file"`
}

type LogFileConfig struct {
	Path       string `yaml:"path"`        // log file path (default /app/logs/app-task.log)
	MaxSize    int    `yaml:"max_size"`    // max MB per file (default 100)
	MaxBackups int    `yaml:"max_backups"` // old files kept (default 7)
	MaxAge     int    `yaml:"max_age"`     // days retained (default 30)
	Compress   bool   `yaml:"compress"`    // gzip rotated files
}

type AppConfig struct {
	Name  string `yaml:"name"`
	Debug bool   `yaml:"debug"`
}

type ServerConfig struct {
	Host string `yaml:"host"`
	Port int    `yaml:"port"`
	// TLS is optional (default off = plain HTTP). Enabled -> the whole service
	// (console + API + health) is served over HTTPS. cert/key provided as a
	// pair = use those files (production: CA-issued); both empty = auto-generate
	// a self-signed dev certificate under cert_dir (auto.crt/auto.key, reused
	// across restarts while valid; see internal/certgen).
	TLS TLSServerConfig `yaml:"tls"`
}

// TLSServerConfig: enabled + cert resolution (pair of files OR auto-generated
// dev certificate when both are empty).
type TLSServerConfig struct {
	Enabled bool   `yaml:"enabled"`
	Cert    string `yaml:"cert"`
	Key     string `yaml:"key"`
	CertDir string `yaml:"cert_dir"` // where auto-generated certs are stored (default certs)
}

type RDBMSConfig struct {
	URL             string `yaml:"url"`
	MaxOpenConns    int    `yaml:"max_open_conns"`
	MaxIdleConns    int    `yaml:"max_idle_conns"`
	ConnMaxLifetime int    `yaml:"conn_max_lifetime"`  // seconds; 0 = reuse forever
	ConnMaxIdleTime int    `yaml:"conn_max_idle_time"` // seconds; stale idle conns closed
	// go-sql-driver timeouts (seconds; 0 = driver default, which for
	// read/write is "no timeout" — a hung DB would freeze a worker forever).
	DialTimeoutSeconds  int `yaml:"dial_timeout_seconds"`
	ReadTimeoutSeconds  int `yaml:"read_timeout_seconds"`
	WriteTimeoutSeconds int `yaml:"write_timeout_seconds"`
	// TLS: "" (off) | "true" (system certs) | "skip-verify" (self-signed).
	TLS string `yaml:"tls"`
	// GORM: cache prepared statements on pooled connections (perf win for
	// hot repeated queries).
	PrepareStmt bool `yaml:"prepare_stmt"`
	// Slow query logging threshold (ms; GORM logs at WARN above it).
	SlowThresholdMS int `yaml:"slow_threshold_ms"`
}

// SchedulerConfig tunes the DB-polling dispatch loop. Zero values fall back
// to the service defaults (see service.NewScheduler).
type SchedulerConfig struct {
	IntervalSeconds          int    `yaml:"interval_seconds"`            // DB poll interval for due tasks
	Workers                  int    `yaml:"workers"`                     // dispatch goroutine pool size
	BatchSize                int    `yaml:"batch_size"`                  // due tasks claimed per tick
	DispatchingTimeoutSecond int    `yaml:"dispatching_timeout_seconds"` // stale dispatching claim reclaim age
	PerURLLimit              int    `yaml:"per_url_limit"`               // max concurrent dispatches per executor_url (0 = unlimited)
	InstanceID               string `yaml:"instance_id"`                 // claim owner identity (default hostname+rand)
	// Weight is this node's dispatch share (default 1 = equal). The effective
	// claim limit scales by weight / max(alive weights): give a node that also
	// runs other duties (a "manager") weight 1 and its workers 4, and the
	// manager ends up with a quarter of a worker's claim capacity.
	Weight int `yaml:"weight"`
}

// ClusterConfig tunes cluster membership admission.
type ClusterConfig struct {
	// Admission: "open" (default — any instance holding the shared DB
	// credentials registers automatically; the DB credential IS the cluster
	// trust boundary) or "pre_approved" (governance gate: a node must be
	// pre-registered via the console/CLI join flow BEFORE starting — missing
	// registration fails startup closed).
	Admission string `yaml:"admission"`
}

// RedisConfig points at the shared Redis (same REDIS__URL as the main
// app/app-auth). Optional: only needed for webui.session_store=redis
// (multi-instance console deployments). Pool/timeouts: 0 = go-redis defaults.
type RedisConfig struct {
	URL string `yaml:"url"`
	// Pool: go-redis defaults are PoolSize=10×NumCPU, MinIdleConns=0.
	PoolSize     int `yaml:"pool_size"`
	MinIdleConns int `yaml:"min_idle_conns"`
	// Timeouts in seconds; 0 = go-redis defaults (dial 5s, read/write 3s).
	DialTimeoutSeconds  int `yaml:"dial_timeout_seconds"`
	ReadTimeoutSeconds  int `yaml:"read_timeout_seconds"`
	WriteTimeoutSeconds int `yaml:"write_timeout_seconds"`
	// Retries on network errors; 0 = library default (3).
	MaxRetries int `yaml:"max_retries"`
}

// EmailConfig configures the mail delivery service (platform capability).
type EmailConfig struct {
	Provider string `yaml:"provider"`
	APIKey   string `yaml:"api_key"`
	From     string `yaml:"from_email"`
}

// NotificationConfig configures the mail delivery worker (retries).
type NotificationConfig struct {
	WorkerIntervalSeconds int `yaml:"worker_interval_seconds"`
	RetryMax              int `yaml:"retry_max"`
	RetryBackoffBase      int `yaml:"retry_backoff_base"`
}

// WebUIConfig configures the embedded admin console (served by Gin at /).
// Token empty = no auth (dev only); production MUST set APPTASK__WEBUI__TOKEN.
type WebUIConfig struct {
	Enabled           bool   `yaml:"enabled"`
	Token             string `yaml:"token"`
	SessionTTLMinutes int    `yaml:"session_ttl_minutes"` // login session lifetime (0 = default 12h)
	// SessionStore: "memory" (default, single instance — zero dependencies)
	// or "redis" (multi-instance: sessions + API-key reveals + throttles
	// shared via Redis; requires redis.url). Misconfigured redis fails loud
	// at startup.
	SessionStore string `yaml:"session_store"`
}

// HTTPExecutorConfig configures the HTTP(S) executor transport.
type HTTPExecutorConfig struct {
	TimeoutSeconds     int    `yaml:"timeout_seconds"`      // per-request timeout
	InsecureSkipVerify bool   `yaml:"insecure_skip_verify"` // opt out of TLS cert validation (self-signed only)
	CAFile             string `yaml:"ca_file"`              // PEM private CA to trust
}

// LuaConfig configures the Lua executor (dynamic scripts, GLUE-style).
type LuaConfig struct {
	TimeoutSeconds     int `yaml:"timeout_seconds"`      // per-script execution timeout
	MaxIdleVM          int `yaml:"max_idle_vm"`          // idle VM pool size
	MaxSourceLen       int `yaml:"max_source_len"`       // max script source bytes
	HTTPTimeoutSeconds int `yaml:"http_timeout_seconds"` // ctx.http_get/post timeout
}

type SecurityConfig struct {
	CORS struct {
		AllowOrigins []string `yaml:"allow_origins"`
	} `yaml:"cors"`
	// ServiceKeys are bootstrap API keys for the service surface (/tasks/*,
	// /scripts*, /internal/*) — e.g. the APISIX consumer key so gateway-routed
	// calls keep working. They are seeded into the api_key table at startup
	// and can be revoked like console-generated keys. Comma-separated env:
	// SecretEncKey decrypts the central secret store (ctx.secret in Lua
	// scripts). Deliberately SHARES the main app's env name so one .env entry
	// serves the whole ecosystem; base64-encoded 32-byte key.
	// Env: SECURITY__API_KEY_ENCRYPTION_KEY (not APPTASK__-prefixed).
	SecretEncKey string `yaml:"-"`
	// APPTASK__SECURITY__SERVICE_KEYS; falls back to the legacy
	// APPTASK__APP__CONSUMER_KEY when unset.
	ServiceKeys []string `yaml:"service_keys"`
}

// Load parses embedded default.yaml + applies APPTASK__ env overrides.
// Best-effort loads project-root .env (docker injects env directly).
//
// Placeholder expansion (aligned with the main app's loader, AGENTS.md §四):
// string values may reference environment variables as ${VAR} (unset/empty →
// "") or ${VAR:default} (unset/empty → default). .env holds only secrets;
// ordinary config stays in this file as literal defaults.
func Load(yamlBytes []byte) (*Config, error) {
	// app-task/ is one level below project root; .env lives at project root.
	// Loaded BEFORE expansion so ${VAR} placeholders see .env entries.
	_ = godotenv.Load("../.env")

	expanded, err := expandPlaceholders(yamlBytes)
	if err != nil {
		return nil, fmt.Errorf("expand placeholders: %w", err)
	}

	var cfg Config
	if err := yaml.Unmarshal(expanded, &cfg); err != nil {
		return nil, fmt.Errorf("parse default.yaml: %w", err)
	}
	applyEnvOverrides(&cfg)
	return &cfg, nil
}

// placeholderRe matches ${VAR} and ${VAR:default}. Names are shell-style
// (letters, digits, underscore).
var placeholderRe = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\}`)

// expandPlaceholders substitutes ${VAR} / ${VAR:default} against the process
// environment (which already includes the loaded .env). One pass only — no
// recursive expansion, so env values containing "${" stay literal.
func expandPlaceholders(yamlBytes []byte) ([]byte, error) {
	out := placeholderRe.ReplaceAllFunc(yamlBytes, func(m []byte) []byte {
		groups := placeholderRe.FindSubmatch(m)
		name, def := string(groups[1]), string(groups[2])
		if v, ok := os.LookupEnv(name); ok && v != "" {
			return []byte(v)
		}
		return []byte(def)
	})
	return out, nil
}

// applyEnvOverrides maps APPTASK__SECTION__KEY env vars onto the config.
// Mirrors Python config.py _apply_env_overrides semantics.
func applyEnvOverrides(cfg *Config) {
	get := func(key string) string { return strings.TrimSpace(os.Getenv(key)) }
	atoi := func(key string, dst *int) {
		if v := get(key); v != "" {
			if n, err := strconv.Atoi(v); err == nil {
				*dst = n
			}
		}
	}

	if v := get("APPTASK__RDBMS__URL"); v != "" {
		cfg.RDBMS.URL = v
	}
	if v := get("APPTASK__EMAIL__API_KEY"); v != "" {
		cfg.Email.APIKey = v
	}
	if v := get("APPTASK_EMAIL_API_KEY"); v != "" {
		cfg.Email.APIKey = v
	}
	if v := get("APPTASK__EMAIL__FROM"); v != "" {
		cfg.Email.From = v
	}
	if v := get("APPTASK__TIMEZONE"); v != "" {
		cfg.Timezone = v
	}
	atoi("APPTASK__SCHEDULER__INTERVAL_SECONDS", &cfg.Scheduler.IntervalSeconds)
	atoi("APPTASK__SCHEDULER__WORKERS", &cfg.Scheduler.Workers)
	atoi("APPTASK__SCHEDULER__BATCH_SIZE", &cfg.Scheduler.BatchSize)
	atoi("APPTASK__SCHEDULER__DISPATCHING_TIMEOUT_SECONDS", &cfg.Scheduler.DispatchingTimeoutSecond)
	atoi("APPTASK__SCHEDULER__PER_URL_LIMIT", &cfg.Scheduler.PerURLLimit)
	atoi("APPTASK__SCHEDULER__WEIGHT", &cfg.Scheduler.Weight)
	atoi("APPTASK__RDBMS__MAX_OPEN_CONNS", &cfg.RDBMS.MaxOpenConns)
	atoi("APPTASK__RDBMS__MAX_IDLE_CONNS", &cfg.RDBMS.MaxIdleConns)
	atoi("APPTASK__RDBMS__CONN_MAX_LIFETIME", &cfg.RDBMS.ConnMaxLifetime)
	atoi("APPTASK__RDBMS__CONN_MAX_IDLE_TIME", &cfg.RDBMS.ConnMaxIdleTime)
	atoi("APPTASK__RDBMS__DIAL_TIMEOUT_SECONDS", &cfg.RDBMS.DialTimeoutSeconds)
	atoi("APPTASK__RDBMS__READ_TIMEOUT_SECONDS", &cfg.RDBMS.ReadTimeoutSeconds)
	atoi("APPTASK__RDBMS__WRITE_TIMEOUT_SECONDS", &cfg.RDBMS.WriteTimeoutSeconds)
	if v := get("APPTASK__RDBMS__TLS"); v != "" {
		cfg.RDBMS.TLS = v
	}
	atoi("APPTASK__RDBMS__SLOW_THRESHOLD_MS", &cfg.RDBMS.SlowThresholdMS)
	atoi("APPTASK__REDIS__POOL_SIZE", &cfg.Redis.PoolSize)
	atoi("APPTASK__REDIS__MIN_IDLE_CONNS", &cfg.Redis.MinIdleConns)
	atoi("APPTASK__REDIS__MAX_RETRIES", &cfg.Redis.MaxRetries)
	if v := get("APPTASK__CLUSTER__ADMISSION"); v != "" {
		cfg.Cluster.Admission = v
	}
	if v := get("APPTASK__SCHEDULER__INSTANCE_ID"); v != "" {
		cfg.Scheduler.InstanceID = v
	}
	atoi("APPTASK__SERVER__PORT", &cfg.Server.Port)
	if v := get("APPTASK__SERVER__TLS__ENABLED"); v != "" {
		cfg.Server.TLS.Enabled = v == "true" || v == "1"
	}
	if v := get("APPTASK__SERVER__TLS__CERT"); v != "" {
		cfg.Server.TLS.Cert = v
	}
	if v := get("APPTASK__SERVER__TLS__KEY"); v != "" {
		cfg.Server.TLS.Key = v
	}
	if v := get("APPTASK__SERVER__TLS__CERT_DIR"); v != "" {
		cfg.Server.TLS.CertDir = v
	}
	if v := get("APPTASK__WEBUI__ENABLED"); v != "" {
		cfg.WebUI.Enabled = v == "true" || v == "1"
	}
	if v := get("APPTASK__WEBUI__TOKEN"); v != "" {
		cfg.WebUI.Token = v
	}
	atoi("APPTASK__WEBUI__SESSION_TTL_MINUTES", &cfg.WebUI.SessionTTLMinutes)
	if v := get("APPTASK__WEBUI__SESSION_STORE"); v != "" {
		cfg.WebUI.SessionStore = v
	}
	if v := get("APPTASK__REDIS__URL"); v != "" {
		cfg.Redis.URL = v
	} else if v := get("REDIS__URL"); v != "" {
		// Shared unprefixed env (same variable the main app / app-auth use).
		cfg.Redis.URL = v
	}
	if v := get("SECURITY__API_KEY_ENCRYPTION_KEY"); v != "" {
		cfg.Security.SecretEncKey = v
	}
	if v := get("APPTASK__SECURITY__SERVICE_KEYS"); v != "" {
		cfg.Security.ServiceKeys = splitCSV(v)
	} else if v := get("APPTASK__APP__CONSUMER_KEY"); v != "" {
		// legacy env (previously dead config): adopt as the bootstrap key
		cfg.Security.ServiceKeys = splitCSV(v)
	}
	if v := get("APPTASK__LOG__LEVEL"); v != "" {
		cfg.Log.Level = v
	}
	if v := get("APPTASK__HTTP_EXECUTOR__CA_FILE"); v != "" {
		cfg.HTTPExecutor.CAFile = v
	}
	if v := get("APPTASK__HTTP_EXECUTOR__INSECURE_SKIP_VERIFY"); v != "" {
		cfg.HTTPExecutor.InsecureSkipVerify = v == "true" || v == "1"
	}
	if v := get("APPTASK__LOG__FORMAT"); v != "" {
		cfg.Log.Format = v
	}
	if v := get("APPTASK__LOG__OUTPUT"); v != "" {
		cfg.Log.Output = v
	}
	if v := get("APPTASK__LOG__FILE__PATH"); v != "" {
		cfg.Log.File.Path = v
	}
	atoi("APPTASK__LOG__FILE__MAX_SIZE", &cfg.Log.File.MaxSize)
	atoi("APPTASK__LOG__FILE__MAX_BACKUPS", &cfg.Log.File.MaxBackups)
	atoi("APPTASK__LOG__FILE__MAX_AGE", &cfg.Log.File.MaxAge)
	if v := get("APPTASK__LOG__FILE__COMPRESS"); v != "" {
		cfg.Log.File.Compress = v == "true" || v == "1"
	}
}

// Validate checks critical config required for the service to function. The
// pure-scheduler has no hard requirements beyond the DB DSN (enforced at
// startup by db.Init), plus the TLS cert/key pairing rule when enabled.
func Validate(cfg *Config) error {
	if cfg.Server.TLS.Enabled && (cfg.Server.TLS.Cert == "") != (cfg.Server.TLS.Key == "") {
		return fmt.Errorf("server.tls: cert and key must be provided together, or both empty " +
			"(empty = auto-generate a self-signed dev certificate under cert_dir)")
	}
	return nil
}

// splitCSV splits a comma-separated env value into trimmed, non-empty parts.
func splitCSV(v string) []string {
	parts := strings.Split(v, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
