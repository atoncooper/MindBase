// Package config loads app-task configuration from embedded default.yaml +
// APPTASK__-prefixed env overrides + project-root .env.
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
	App       AppConfig       `yaml:"app"`
	Server    ServerConfig    `yaml:"server"`
	Timezone  string          `yaml:"timezone"`
	RDBMS     RDBMSConfig     `yaml:"rdbms"`
	Scheduler    SchedulerConfig    `yaml:"scheduler"`
	Lua          LuaConfig          `yaml:"lua"`
	HTTPExecutor HTTPExecutorConfig `yaml:"http_executor"`
	Email        EmailConfig        `yaml:"email"`
	Notification NotificationConfig `yaml:"notification"`
	WebUI        WebUIConfig        `yaml:"webui"`
	Security  SecurityConfig  `yaml:"security"`
	Log       LogConfig       `yaml:"log"`
}

type LogConfig struct {
	Level  string        `yaml:"level"`   // debug|info|warn|error (default info)
	Format string        `yaml:"format"`  // text|json (default text)
	Output string        `yaml:"output"`  // stdout|file|both (default stdout)
	File   LogFileConfig `yaml:"file"`
}

type LogFileConfig struct {
	Path       string `yaml:"path"`        // log file path (default /app/logs/app-task.log)
	MaxSize    int    `yaml:"max_size"`    // max MB per file (default 100)
	MaxBackups int    `yaml:"max_backups"` // old files kept (default 7)
	MaxAge     int    `yaml:"max_age"`     // days retained (default 30)
	Compress   bool   `yaml:"compress"`   // gzip rotated files
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

type SchedulerConfig struct {
	IntervalSeconds int `yaml:"interval_seconds"`
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
	MaxIdleVM          int `yaml:"max_idle_vm"`           // idle VM pool size
	MaxSourceLen       int `yaml:"max_source_len"`        // max script source bytes
	HTTPTimeoutSeconds int `yaml:"http_timeout_seconds"`  // ctx.http_get/post timeout
}

type SecurityConfig struct {
	CORS struct {
		AllowOrigins []string `yaml:"allow_origins"`
	} `yaml:"cors"`
}

// Load parses embedded default.yaml + applies APPTASK__ env overrides.
// Best-effort loads project-root .env (docker injects env directly).
func Load(yamlBytes []byte) (*Config, error) {
	// app-task/ is one level below project root; .env lives at project root.
	_ = godotenv.Load("../.env")

	var cfg Config
	if err := yaml.Unmarshal(yamlBytes, &cfg); err != nil {
		return nil, fmt.Errorf("parse default.yaml: %w", err)
	}
	applyEnvOverrides(&cfg)
	return &cfg, nil
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
	atoi("APPTASK__SERVER__PORT", &cfg.Server.Port)
	if v := get("APPTASK__WEBUI__ENABLED"); v != "" {
		cfg.WebUI.Enabled = v == "true" || v == "1"
	}
	if v := get("APPTASK__WEBUI__TOKEN"); v != "" {
		cfg.WebUI.Token = v
	}
	atoi("APPTASK__WEBUI__SESSION_TTL_MINUTES", &cfg.WebUI.SessionTTLMinutes)
	if v := get("APPTASK__LOG__LEVEL"); v != "" {
		cfg.Log.Level = v
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
// startup by db.Init), so this is a no-op placeholder for future checks.
func Validate(cfg *Config) error {
	_ = cfg
	return nil
}
