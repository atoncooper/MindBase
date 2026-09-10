// Package config loads app-pay-admin configuration from embedded default.yaml +
// PAYADMIN__-prefixed env overrides + project-root .env.
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
	Timezone string         `yaml:"timezone"`
	RDBMS    RDBMSConfig    `yaml:"rdbms"`
	WebUI    WebUIConfig    `yaml:"webui"`
	Audit    AuditConfig    `yaml:"audit"`
	Security SecurityConfig `yaml:"security"`
	Log      LogConfig      `yaml:"log"`
}

type AppConfig struct {
	Name  string `yaml:"name"`
	Debug bool   `yaml:"debug"`
}

type ServerConfig struct {
	Host string `yaml:"host"`
	Port int    `yaml:"port"`
	// TLS 可选（默认关闭 = 纯 HTTP 回环）：启用后整站 HTTPS。
	// 证书用 scripts/gen-dev-cert.* 生成的开发证书，生产挂正式 CA 签发证书。
	TLS TLSServerConfig `yaml:"tls"`
}

// TLSServerConfig：enabled；cert/key 成对提供=用指定文件，双双留空=自动生成
// 自签开发证书并保存到 cert_dir（auto.crt/auto.key，有效期内重启复用）。
type TLSServerConfig struct {
	Enabled bool   `yaml:"enabled"`
	Cert    string `yaml:"cert"`
	Key     string `yaml:"key"`
	CertDir string `yaml:"cert_dir"` // 自动生成证书的保存目录（默认 certs）
}

type RDBMSConfig struct {
	URL             string `yaml:"url"`
	MaxOpenConns    int    `yaml:"max_open_conns"`
	MaxIdleConns    int    `yaml:"max_idle_conns"`
	ConnMaxLifetime int    `yaml:"conn_max_lifetime"`
}

// WebUIConfig configures the embedded admin console (served by Gin at /).
// Token empty = no master API key (console login is still username/password);
// production SHOULD set PAYADMIN__WEBUI__TOKEN for script access.
type WebUIConfig struct {
	Enabled           bool   `yaml:"enabled"`
	Token             string `yaml:"token"`
	SessionTTLMinutes int    `yaml:"session_ttl_minutes"` // login session lifetime (0 = default 12h)
}

// AuditConfig configures the JSONL audit trail for money-touching operations.
type AuditConfig struct {
	File string `yaml:"file"`
}

type SecurityConfig struct {
	CORS struct {
		AllowOrigins []string `yaml:"allow_origins"`
	} `yaml:"cors"`
}

type LogConfig struct {
	Level  string        `yaml:"level"`  // debug|info|warn|error (default info)
	Format string        `yaml:"format"` // text|json (default json)
	Output string        `yaml:"output"` // stdout|file|both (default stdout)
	File   LogFileConfig `yaml:"file"`
}

type LogFileConfig struct {
	Path       string `yaml:"path"`
	MaxSize    int    `yaml:"max_size"`
	MaxBackups int    `yaml:"max_backups"`
	MaxAge     int    `yaml:"max_age"`
	Compress   bool   `yaml:"compress"`
}

// Load parses the embedded default.yaml, then merges the optional overlay
// config file (-config flag; only present keys override), then applies
// PAYADMIN__ env overrides (highest priority):
//
//	default.yaml (embedded)  ->  -config file  ->  PAYADMIN__* env
//
// overlayPath empty = no overlay (docker default: compose injects env only).
func Load(yamlBytes []byte, overlayPath string) (*Config, error) {
	// app-pay-admin/ is one level below project root; .env lives at project root.
	_ = godotenv.Load("../.env")

	var cfg Config
	if err := yaml.Unmarshal(yamlBytes, &cfg); err != nil {
		return nil, fmt.Errorf("parse default.yaml: %w", err)
	}
	if overlayPath != "" {
		b, err := os.ReadFile(overlayPath)
		if err != nil {
			return nil, fmt.Errorf("read -config %s: %w", overlayPath, err)
		}
		if err := yaml.Unmarshal(b, &cfg); err != nil {
			return nil, fmt.Errorf("parse %s: %w", overlayPath, err)
		}
	}
	applyEnvOverrides(&cfg)
	return &cfg, nil
}

// applyEnvOverrides maps PAYADMIN__SECTION__KEY env vars onto the config
// (mirrors app-task's per-field mapping; no generic reflection magic).
func applyEnvOverrides(cfg *Config) {
	get := func(key string) string { return strings.TrimSpace(os.Getenv(key)) }
	atoi := func(key string, dst *int) {
		if v := get(key); v != "" {
			if n, err := strconv.Atoi(v); err == nil {
				*dst = n
			}
		}
	}
	boolVar := func(key string, dst *bool) {
		if v := get(key); v != "" {
			*dst = v == "true" || v == "1"
		}
	}

	if v := get("PAYADMIN__RDBMS__URL"); v != "" {
		cfg.RDBMS.URL = v
	}
	atoi("PAYADMIN__RDBMS__MAX_OPEN_CONNS", &cfg.RDBMS.MaxOpenConns)
	atoi("PAYADMIN__RDBMS__MAX_IDLE_CONNS", &cfg.RDBMS.MaxIdleConns)
	atoi("PAYADMIN__RDBMS__CONN_MAX_LIFETIME", &cfg.RDBMS.ConnMaxLifetime)
	if v := get("PAYADMIN__TIMEZONE"); v != "" {
		cfg.Timezone = v
	}
	atoi("PAYADMIN__SERVER__PORT", &cfg.Server.Port)
	boolVar("PAYADMIN__SERVER__TLS__ENABLED", &cfg.Server.TLS.Enabled)
	if v := get("PAYADMIN__SERVER__TLS__CERT"); v != "" {
		cfg.Server.TLS.Cert = v
	}
	if v := get("PAYADMIN__SERVER__TLS__KEY"); v != "" {
		cfg.Server.TLS.Key = v
	}
	if v := get("PAYADMIN__SERVER__TLS__CERT_DIR"); v != "" {
		cfg.Server.TLS.CertDir = v
	}
	// CORS 白名单：逗号分隔多个 origin（跨域调用方需要带 cookie 时，
	// 白名单 origin 必须精确匹配，且浏览器要求 Allow-Credentials，已默认开启）。
	if v := get("PAYADMIN__SECURITY__CORS__ALLOW_ORIGINS"); v != "" {
		origins := cfg.Security.CORS.AllowOrigins[:0]
		for _, o := range strings.Split(v, ",") {
			if o = strings.TrimSpace(o); o != "" {
				origins = append(origins, o)
			}
		}
		cfg.Security.CORS.AllowOrigins = origins
	}
	boolVar("PAYADMIN__APP__DEBUG", &cfg.App.Debug)
	boolVar("PAYADMIN__WEBUI__ENABLED", &cfg.WebUI.Enabled)
	if v := get("PAYADMIN__WEBUI__TOKEN"); v != "" {
		cfg.WebUI.Token = v
	}
	atoi("PAYADMIN__WEBUI__SESSION_TTL_MINUTES", &cfg.WebUI.SessionTTLMinutes)
	if v := get("PAYADMIN__AUDIT__FILE"); v != "" {
		cfg.Audit.File = v
	}
	if v := get("PAYADMIN__LOG__LEVEL"); v != "" {
		cfg.Log.Level = v
	}
	if v := get("PAYADMIN__LOG__FORMAT"); v != "" {
		cfg.Log.Format = v
	}
	if v := get("PAYADMIN__LOG__OUTPUT"); v != "" {
		cfg.Log.Output = v
	}
	if v := get("PAYADMIN__LOG__FILE__PATH"); v != "" {
		cfg.Log.File.Path = v
	}
	atoi("PAYADMIN__LOG__FILE__MAX_SIZE", &cfg.Log.File.MaxSize)
	atoi("PAYADMIN__LOG__FILE__MAX_BACKUPS", &cfg.Log.File.MaxBackups)
	atoi("PAYADMIN__LOG__FILE__MAX_AGE", &cfg.Log.File.MaxAge)
	boolVar("PAYADMIN__LOG__FILE__COMPRESS", &cfg.Log.File.Compress)
}

// Validate fails loud on config that would silently misbehave: this service
// writes to the pay domain, so starting without a DSN is always a mistake.
func Validate(cfg *Config) error {
	if strings.TrimSpace(cfg.RDBMS.URL) == "" {
		return fmt.Errorf("rdbms.url is empty: run `go run .` inside app-pay-admin/ " +
			"(auto-loads config.dev.yaml), or docker compose injects PAYADMIN__RDBMS__URL")
	}
	if cfg.Server.TLS.Enabled {
		// cert/key 要么成对提供（用指定文件），要么双双留空（自动生成开发证书）。
		if (cfg.Server.TLS.Cert == "") != (cfg.Server.TLS.Key == "") {
			return fmt.Errorf("server.tls: cert 与 key 须同时提供，或同时留空" +
				"（留空=自动生成自签开发证书并保存到 cert_dir）")
		}
	}
	return nil
}
