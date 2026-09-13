// Package config loads app-board configuration from embedded default.yaml +
// APPBOARD__-prefixed env overrides + project-root .env.
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
	App      AppConfig      `yaml:"app"`
	Server   ServerConfig   `yaml:"server"`
	RDBMS    RDBMSConfig    `yaml:"rdbms"`
	Mongo    MongoConfig    `yaml:"mongo"`
	Redis    RedisConfig    `yaml:"redis"`
	Security SecurityConfig `yaml:"security"`
	Log      LogConfig      `yaml:"log"`
}

type SecurityConfig struct {
	CORS struct {
		AllowOrigins []string `yaml:"allow_origins"`
	} `yaml:"cors"`
}

// RedisConfig configures the optional read cache. URL empty = caching
// disabled (reads go straight to the stores). Redis unavailability never
// breaks correctness — cache ops degrade to misses.
type RedisConfig struct {
	URL             string `yaml:"url"`               // redis://:pass@host:6379/2 (own DB index, main app uses /1)
	CacheTTLSeconds int    `yaml:"cache_ttl_seconds"` // backstop TTL for cached reads (default 300)
}

type AppConfig struct {
	Name  string `yaml:"name"`
	Debug bool   `yaml:"debug"`
}

type ServerConfig struct {
	Host string    `yaml:"host"`
	Port int       `yaml:"port"`
	TLS  TLSConfig `yaml:"tls"`

	// HTTP server connection/timeouts (net/http). Zero values fall back to
	// the defaults in ServerConfig.Defaults — never leave them at zero at
	// runtime: an unset Read/IdleTimeout lets slow clients pin goroutines and
	// TLS channels indefinitely (slowloris-style resource exhaustion).
	ReadHeaderTimeoutSeconds int `yaml:"read_header_timeout_seconds"` // TLS handshake + request-line (default 10s)
	ReadTimeoutSeconds       int `yaml:"read_timeout_seconds"`        // whole request incl. 8MB body upload (default 60s)
	WriteTimeoutSeconds      int `yaml:"write_timeout_seconds"`       // response write, TLS overhead included (default 120s)
	IdleTimeoutSeconds       int `yaml:"idle_timeout_seconds"`        // keep-alive pool: how long idle conns are reused before close (default 120s)
	MaxHeaderBytes           int `yaml:"max_header_bytes"`            // request-line+headers cap (default 1MB)
}

// Defaults fills unset (zero) server fields so a mis-specified yaml can never
// disable timeouts silently. Values tuned for board-sized payloads (8MB PUTs
// over slow links) plus long-lived keep-alive reuse behind the gateway.
func (c *ServerConfig) Defaults() {
	if c.ReadHeaderTimeoutSeconds <= 0 {
		c.ReadHeaderTimeoutSeconds = 10
	}
	if c.ReadTimeoutSeconds <= 0 {
		c.ReadTimeoutSeconds = 60
	}
	if c.WriteTimeoutSeconds <= 0 {
		c.WriteTimeoutSeconds = 120
	}
	if c.IdleTimeoutSeconds <= 0 {
		c.IdleTimeoutSeconds = 120
	}
	if c.MaxHeaderBytes <= 0 {
		c.MaxHeaderBytes = 1 << 20
	}
}

// TLSConfig mirrors app-pay-admin's server.tls: explicit cert/key paths OR
// both empty = auto mode (dev CA + leaf under cert_dir, auto-renewed).
type TLSConfig struct {
	Enabled bool   `yaml:"enabled"` // false only for local debugging (escape hatch)
	CertDir string `yaml:"cert_dir"`
	Cert    string `yaml:"cert"` // explicit mode; empty = auto CA+leaf
	Key     string `yaml:"key"`
}

type RDBMSConfig struct {
	URL             string `yaml:"url"`
	MaxOpenConns    int    `yaml:"max_open_conns"`
	MaxIdleConns    int    `yaml:"max_idle_conns"`
	ConnMaxLifetime int    `yaml:"conn_max_lifetime"`
}

type MongoConfig struct {
	URI     string `yaml:"uri"`
	DBName  string `yaml:"db_name"`
	Timeout int    `yaml:"timeout_seconds"`
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

// Load parses embedded default.yaml + applies APPBOARD__ env overrides.
// Best-effort loads project-root .env (docker injects env directly).
func Load(yamlBytes []byte) (*Config, error) {
	// app-board/ is one level below project root; .env lives at project root.
	_ = godotenv.Load("../.env")

	var cfg Config
	if err := yaml.Unmarshal(yamlBytes, &cfg); err != nil {
		return nil, fmt.Errorf("parse default.yaml: %w", err)
	}
	applyEnvOverrides(&cfg)
	return &cfg, nil
}

// applyEnvOverrides maps APPBOARD__SECTION__KEY env vars onto the config.
func applyEnvOverrides(cfg *Config) {
	get := func(key string) string { return strings.TrimSpace(os.Getenv(key)) }
	atoi := func(key string, dst *int) {
		if v := get(key); v != "" {
			if n, err := strconv.Atoi(v); err == nil {
				*dst = n
			}
		}
	}

	atoi("APPBOARD__SERVER__PORT", &cfg.Server.Port)
	atoi("APPBOARD__SERVER__READ_HEADER_TIMEOUT_SECONDS", &cfg.Server.ReadHeaderTimeoutSeconds)
	atoi("APPBOARD__SERVER__READ_TIMEOUT_SECONDS", &cfg.Server.ReadTimeoutSeconds)
	atoi("APPBOARD__SERVER__WRITE_TIMEOUT_SECONDS", &cfg.Server.WriteTimeoutSeconds)
	atoi("APPBOARD__SERVER__IDLE_TIMEOUT_SECONDS", &cfg.Server.IdleTimeoutSeconds)
	atoi("APPBOARD__SERVER__MAX_HEADER_BYTES", &cfg.Server.MaxHeaderBytes)
	if v := get("APPBOARD__SERVER__TLS__ENABLED"); v != "" {
		cfg.Server.TLS.Enabled = v == "true" || v == "1"
	}
	if v := get("APPBOARD__SERVER__TLS__CERT_DIR"); v != "" {
		cfg.Server.TLS.CertDir = v
	}
	if v := get("APPBOARD__SERVER__TLS__CERT"); v != "" {
		cfg.Server.TLS.Cert = v
	}
	if v := get("APPBOARD__SERVER__TLS__KEY"); v != "" {
		cfg.Server.TLS.Key = v
	}
	if v := get("APPBOARD__RDBMS__URL"); v != "" {
		cfg.RDBMS.URL = v
	}
	if v := get("APPBOARD__MONGO__URI"); v != "" {
		cfg.Mongo.URI = v
	}
	if v := get("APPBOARD__MONGO__DB_NAME"); v != "" {
		cfg.Mongo.DBName = v
	}
	if v := get("APPBOARD__REDIS__URL"); v != "" {
		cfg.Redis.URL = v
	}
	atoi("APPBOARD__REDIS__CACHE_TTL_SECONDS", &cfg.Redis.CacheTTLSeconds)
	atoi("APPBOARD__MONGO__TIMEOUT", &cfg.Mongo.Timeout)
	for _, o := range strings.Split(get("APPBOARD__SECURITY__CORS__ALLOW_ORIGINS"), ",") {
		if o = strings.TrimSpace(o); o != "" {
			cfg.Security.CORS.AllowOrigins = append(cfg.Security.CORS.AllowOrigins, o)
		}
	}
	if v := get("APPBOARD__LOG__LEVEL"); v != "" {
		cfg.Log.Level = v
	}
	if v := get("APPBOARD__LOG__FORMAT"); v != "" {
		cfg.Log.Format = v
	}
	if v := get("APPBOARD__LOG__OUTPUT"); v != "" {
		cfg.Log.Output = v
	}
	if v := get("APPBOARD__LOG__FILE__PATH"); v != "" {
		cfg.Log.File.Path = v
	}
	atoi("APPBOARD__LOG__FILE__MAX_SIZE", &cfg.Log.File.MaxSize)
	atoi("APPBOARD__LOG__FILE__MAX_BACKUPS", &cfg.Log.File.MaxBackups)
	atoi("APPBOARD__LOG__FILE__MAX_AGE", &cfg.Log.File.MaxAge)
	if v := get("APPBOARD__LOG__FILE__COMPRESS"); v != "" {
		cfg.Log.File.Compress = v == "true" || v == "1"
	}
}

// Validate checks critical config required for the service to function.
func Validate(cfg *Config) error {
	if strings.TrimSpace(cfg.RDBMS.URL) == "" {
		return fmt.Errorf("rdbms.url is required (APPBOARD__RDBMS__URL)")
	}
	if strings.TrimSpace(cfg.Mongo.URI) == "" {
		return fmt.Errorf("mongo.uri is required (APPBOARD__MONGO__URI)")
	}
	if strings.TrimSpace(cfg.Mongo.DBName) == "" {
		return fmt.Errorf("mongo.db_name is required")
	}
	return nil
}

// Defaults applies runtime fallbacks for unset fields. Called after Load, so
// callers always see fully-resolved config (env > yaml > code defaults).
func Defaults(cfg *Config) {
	cfg.Server.Defaults()
}
