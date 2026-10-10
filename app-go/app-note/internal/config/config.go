// Package config loads app-note configuration from embedded default.yaml +
// APPNOTE__-prefixed env overrides + project-root .env.
//
// Secret-bearing settings are shared with the other services and read from
// the SAME env var names (MONGO__URI), so one .env drives the whole stack.
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
	CORS     CORSConfig   `yaml:"cors"`
	Log      LogConfig    `yaml:"log"`
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
	// app-go/app-note sits two levels below project root; .env lives at root.
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

	// ── APPNOTE__-prefixed overrides (highest priority) ──
	if v := get("APPNOTE__RDBMS__URL"); v != "" {
		cfg.RDBMS.URL = v
	}
	if v := get("APPNOTE__MONGO__URI"); v != "" {
		cfg.Mongo.URI = v
	}
	if v := get("APPNOTE__MONGO__DATABASE"); v != "" {
		cfg.Mongo.Database = v
	}
	atoi("APPNOTE__SERVER__PORT", &cfg.Server.Port)
	if b, ok := getBool("APPNOTE__APP__DEBUG"); ok {
		cfg.App.Debug = b
	}
	if v := get("APPNOTE__LOG__LEVEL"); v != "" {
		cfg.Log.Level = v
	}
	if v := get("APPNOTE__LOG__OUTPUT"); v != "" {
		cfg.Log.Output = v
	}
	if v := get("APPNOTE__LOG__FORMAT"); v != "" {
		cfg.Log.Format = v
	}
	if v := get("APPNOTE__LOG__FILE__PATH"); v != "" {
		cfg.Log.File.Path = v
	}
}

// Validate fails loud on config that would silently break the service.
// Mongo is optional at boot: when disabled, reads degrade (empty content)
// and writes fail per-request — same semantics as the Python backend.
func Validate(cfg *Config) error {
	if strings.TrimSpace(cfg.RDBMS.URL) == "" {
		return fmt.Errorf("rdbms.url is required (APPNOTE__RDBMS__URL)")
	}
	if strings.TrimSpace(cfg.Mongo.Database) == "" {
		return fmt.Errorf("mongo.database must not be empty")
	}
	return nil
}
