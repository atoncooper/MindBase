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
	App          AppConfig          `yaml:"app"`
	Server       ServerConfig       `yaml:"server"`
	Timezone     string             `yaml:"timezone"`
	RDBMS        RDBMSConfig        `yaml:"rdbms"`
	Mongo        MongoConfig        `yaml:"mongo"`
	Email        EmailConfig        `yaml:"email"`
	Notification NotificationConfig `yaml:"notification"`
	Scheduler    SchedulerConfig    `yaml:"scheduler"`
	Security     SecurityConfig     `yaml:"security"`
	Log          LogConfig          `yaml:"log"`
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
	Name            string `yaml:"name"`
	Debug           bool   `yaml:"debug"`
	BaseURL         string `yaml:"base_url"`
	ConsumerKey     string `yaml:"consumer_key"`
	GenerateLLMPath string `yaml:"generate_llm_path"`
	Timeout         int    `yaml:"timeout"`
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

type MongoConfig struct {
	URI                      string `yaml:"uri"`
	DBName                   string `yaml:"db_name"`
	ServerSelectionTimeoutMS int    `yaml:"server_selection_timeout_ms"`
}

type EmailConfig struct {
	Provider string `yaml:"provider"`
	APIKey   string `yaml:"api_key"`
	From     string `yaml:"from_email"`
	Timeout  int    `yaml:"timeout"`
}

type NotificationConfig struct {
	WorkerIntervalSeconds int `yaml:"worker_interval_seconds"`
	RetryMax              int `yaml:"retry_max"`
	RetryBackoffBase      int `yaml:"retry_backoff_base"`
}

type SchedulerConfig struct {
	IntervalSeconds int `yaml:"interval_seconds"`
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

	if v := get("APPTASK__APP__BASE_URL"); v != "" {
		cfg.App.BaseURL = v
	}
	if v := get("APPTASK__APP__CONSUMER_KEY"); v != "" {
		cfg.App.ConsumerKey = v
	}
	atoi("APPTASK__APP__TIMEOUT", &cfg.App.Timeout)
	if v := get("APPTASK__RDBMS__URL"); v != "" {
		cfg.RDBMS.URL = v
	}
	if v := get("APPTASK__MONGO__URI"); v != "" {
		cfg.Mongo.URI = v
	}
	if v := get("APPTASK__MONGO__DB_NAME"); v != "" {
		cfg.Mongo.DBName = v
	}
	// Email API key: APPTASK__EMAIL__API_KEY preferred, fall back to
	// APPTASK_EMAIL_API_KEY (shared env name in .env.example).
	if v := get("APPTASK__EMAIL__API_KEY"); v != "" {
		cfg.Email.APIKey = v
	}
	if v := get("APPTASK_EMAIL_API_KEY"); v != "" {
		cfg.Email.APIKey = v
	}
	if v := get("APPTASK__TIMEZONE"); v != "" {
		cfg.Timezone = v
	}
	atoi("APPTASK__SERVER__PORT", &cfg.Server.Port)
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

// Validate checks critical config required for the service to function. Returns
// an error when missing values would silently break the pipeline (every task
// failing quiz requests, or APISIX key-auth rejecting all /internal/quiz calls).
// Soft issues (no API key, test from-email) are logged by the caller, not fatal.
func Validate(cfg *Config) error {
	if cfg.App.BaseURL == "" {
		return fmt.Errorf("app.base_url is empty: set APPTASK__APP__BASE_URL (e.g. http://apisix:9080); without it every task fails to request quiz generation")
	}
	if cfg.App.ConsumerKey == "" {
		return fmt.Errorf("app.consumer_key is empty: set APPTASK__APP__CONSUMER_KEY (must match APISIX consumer); without it APISIX key-auth rejects all /internal/quiz calls")
	}
	return nil
}
