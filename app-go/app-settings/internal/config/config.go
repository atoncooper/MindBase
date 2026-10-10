// Package config loads app-settings configuration from embedded default.yaml +
// APPSETTINGS__-prefixed env overrides + project-root .env.
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
	Log      LogConfig    `yaml:"log"`
	Timezone string       `yaml:"timezone"`
	RDBMS    RDBMSConfig  `yaml:"rdbms"`
	MinIO    MinIOConfig  `yaml:"minio"`
}

// MinIOConfig — object storage for user wallpaper uploads (shared bucket,
// same env names as the other services). Empty endpoint = wallpaper 503.
type MinIOConfig struct {
	Endpoint  string `yaml:"endpoint"`
	AccessKey string `yaml:"access_key"`
	SecretKey string `yaml:"secret_key"`
	Bucket    string `yaml:"bucket"`
	Secure    bool   `yaml:"secure"`
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
	// app-go/app-settings sits two levels below project root; .env lives at root.
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

	// ── MinIO (wallpaper storage) — shared env names, one .env drives all services ──
	if v := get("MINIO__ENDPOINT"); v != "" {
		cfg.MinIO.Endpoint = v
	}
	if v := get("MINIO__ACCESS_KEY"); v != "" {
		cfg.MinIO.AccessKey = v
	}
	if v := get("MINIO__SECRET_KEY"); v != "" {
		cfg.MinIO.SecretKey = v
	}
	if v := get("MINIO__BUCKET"); v != "" {
		cfg.MinIO.Bucket = v
	}
	if v := get("MINIO__SECURE"); v == "true" || v == "1" {
		cfg.MinIO.Secure = true
	}
	// ── APPSETTINGS__-prefixed overrides (highest priority) ──
	if v := get("APPSETTINGS__RDBMS__URL"); v != "" {
		cfg.RDBMS.URL = v
	}
	atoi("APPSETTINGS__SERVER__PORT", &cfg.Server.Port)
	if b, ok := getBool("APPSETTINGS__APP__DEBUG"); ok {
		cfg.App.Debug = b
	}
	if v := get("APPSETTINGS__LOG__LEVEL"); v != "" {
		cfg.Log.Level = v
	}
	if v := get("APPSETTINGS__LOG__OUTPUT"); v != "" {
		cfg.Log.Output = v
	}
	if v := get("APPSETTINGS__LOG__FORMAT"); v != "" {
		cfg.Log.Format = v
	}
	if v := get("APPSETTINGS__LOG__FILE__PATH"); v != "" {
		cfg.Log.File.Path = v
	}
}

// Validate fails loud on config that would silently break the service.
func Validate(cfg *Config) error {
	if strings.TrimSpace(cfg.RDBMS.URL) == "" {
		return fmt.Errorf("rdbms.url is required (APPSETTINGS__RDBMS__URL)")
	}
	return nil
}
