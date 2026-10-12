// Package config loads app-quiz configuration from embedded default.yaml +
// APPQUIZ__-prefixed env overrides + project-root .env.
//
// Secret-bearing settings are shared with the other services and read from
// the SAME env var names (MONGO__URI, REDIS__URL), so one .env drives the
// whole stack.
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
	App      AppConfig    `yaml:"app"`
	Server   ServerConfig `yaml:"server"`
	Timezone string       `yaml:"timezone"`
	RDBMS    RDBMSConfig  `yaml:"rdbms"`
	Mongo    MongoConfig  `yaml:"mongo"`
	Redis    RedisConfig  `yaml:"redis"`
	Quota     QuotaConfig     `yaml:"quota"`
	CORS      CORSConfig      `yaml:"cors"`
	Log       LogConfig       `yaml:"log"`
	Lifecycle LifecycleConfig `yaml:"lifecycle"`
}

// QuotaConfig mirrors the Python app/config quiz.limits daily quotas (UTC day,
// per uid). Consumed by the internal quota endpoints used by app-ts's AI flows.
type QuotaConfig struct {
	Generate int `yaml:"generate"`
	Grade    int `yaml:"grade"`
}

// LifecycleConfig owns the stuck-generating sweep. 大题量（plan-then-generate
// 并发批）生成 40-50 题可超过固定 15 分钟，因此基数可配置，且实际允许时长按
// 题量缩放（见 service allowedFor）。
type LifecycleConfig struct {
	GenerationTimeoutMinutes int `yaml:"generation_timeout_minutes"`
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

type MongoConfig struct {
	URI      string `yaml:"uri"`
	Database string `yaml:"database"`
}

type RedisConfig struct {
	URL       string `yaml:"url"`
	KeyPrefix string `yaml:"key_prefix"`
}

type CORSConfig struct {
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
// loads project-root .env (docker injects env directly).
func Load(yamlBytes []byte) (*Config, error) {
	// app-go/app-quiz sits two levels below project root; .env lives at root.
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

	// ── shared secret env vars (same names as the other services) ──
	if v := get("MONGO__URI"); v != "" {
		cfg.Mongo.URI = v
	}
	if v := get("REDIS__URL"); v != "" {
		cfg.Redis.URL = v
	}

	// ── APPQUIZ__-prefixed overrides (highest priority) ──
	if v := get("APPQUIZ__RDBMS__URL"); v != "" {
		cfg.RDBMS.URL = v
	}
	if v := get("APPQUIZ__MONGO__URI"); v != "" {
		cfg.Mongo.URI = v
	}
	if v := get("APPQUIZ__MONGO__DATABASE"); v != "" {
		cfg.Mongo.Database = v
	}
	if v := get("APPQUIZ__REDIS__URL"); v != "" {
		cfg.Redis.URL = v
	}
	if v := get("APPQUIZ__REDIS__KEY_PREFIX"); v != "" {
		cfg.Redis.KeyPrefix = v
	}
	atoi("APPQUIZ__SERVER__PORT", &cfg.Server.Port)
	if b, ok := getBool("APPQUIZ__APP__DEBUG"); ok {
		cfg.App.Debug = b
	}
	if v := get("APPQUIZ__LOG__LEVEL"); v != "" {
		cfg.Log.Level = v
	}
	if v := get("APPQUIZ__LOG__OUTPUT"); v != "" {
		cfg.Log.Output = v
	}
	if v := get("APPQUIZ__LOG__FORMAT"); v != "" {
		cfg.Log.Format = v
	}
	if v := get("APPQUIZ__LOG__FILE__PATH"); v != "" {
		cfg.Log.File.Path = v
	}
	atoi("APPQUIZ__LIFECYCLE__GENERATION_TIMEOUT_MINUTES", &cfg.Lifecycle.GenerationTimeoutMinutes)
}

// Validate fails loud on config that would silently break the service.
// Mongo and Redis are optional at boot: Mongo reads degrade (question lists
// come back empty, same as the disabled-Python-Mongo semantics) and the Redis
// share cache falls through to the source stores on every read.
func Validate(cfg *Config) error {
	if strings.TrimSpace(cfg.RDBMS.URL) == "" {
		return fmt.Errorf("rdbms.url is required (APPQUIZ__RDBMS__URL)")
	}
	if strings.TrimSpace(cfg.Mongo.Database) == "" {
		return fmt.Errorf("mongo.database must not be empty")
	}
	if strings.TrimSpace(cfg.Redis.KeyPrefix) == "" {
		cfg.Redis.KeyPrefix = "mind-base:"
	}
	// Python parity defaults (quiz.limits: generate 5 / grade 20).
	if cfg.Quota.Generate <= 0 {
		cfg.Quota.Generate = 5
	}
	if cfg.Quota.Grade <= 0 {
		cfg.Quota.Grade = 20
	}
	if cfg.Lifecycle.GenerationTimeoutMinutes <= 0 {
		cfg.Lifecycle.GenerationTimeoutMinutes = 15
	}
	return nil
}
