// Package config loads app-bili configuration from embedded default.yaml +
// APPBILI__-prefixed env overrides + project-root .env.
//
// Secret-bearing settings are shared with the other services and read from
// the SAME env var names (AI_GATEWAY__*, MONGO__URI,
// SECURITY__API_KEY_ENCRYPTION_KEY, REDIS__URL) — one .env drives the stack.
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
	Mongo    MongoConfig    `yaml:"mongo"`
	Redis    RedisConfig    `yaml:"redis"`
	ASR      ASRConfig      `yaml:"asr"`
	Bili     BiliConfig     `yaml:"bili"`
	CORS     CORSConfig     `yaml:"cors"`
	Log      LogConfig      `yaml:"log"`
	Internal InternalConfig `yaml:"internal"`
}

// InternalConfig guards the /internal/bili M2M face (AI stack reads the
// knowledge scope); key = the shared APISIX consumer key.
type InternalConfig struct {
	APIKey string `yaml:"api_key"`
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
	URL string `yaml:"url"`
}

type ASRConfig struct {
	APIKey                   string `yaml:"api_key"`
	BaseURL                  string `yaml:"base_url"`
	TranscribeModel          string `yaml:"transcribe_model"`
	TranscribeTimeoutSeconds int    `yaml:"transcribe_timeout_seconds"`
	PollIntervalMS           int    `yaml:"poll_interval_ms"`
	ChunkConcurrency         int    `yaml:"chunk_concurrency"`
	MinTextChars             int    `yaml:"min_text_chars"`
	TmpDir                   string `yaml:"tmp_dir"`
}

type BiliConfig struct {
	PageDelayMinMS    int    `yaml:"page_delay_min_ms"`
	PageDelayMaxMS    int    `yaml:"page_delay_max_ms"`
	VideoDelayMinMS   int    `yaml:"video_delay_min_ms"`
	VideoDelayMaxMS   int    `yaml:"video_delay_max_ms"`
	MaxRetries        int    `yaml:"max_retries"`
	BackoffBaseMS     int    `yaml:"backoff_base_ms"`
	Proxy             string `yaml:"proxy"`
	RequestTimeoutSec int    `yaml:"request_timeout_seconds"`
	// EncryptionKey decrypts user_oauth.access_token (SESSDATA) — shared with
	// app-auth via SECURITY__API_KEY_ENCRYPTION_KEY (AES-256-GCM, base64(12B
	// nonce‖ct); format pinned by app-auth's compat_test.go).
	EncryptionKey string `yaml:"-"`
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
	// app-go/app-bili sits two levels below project root; .env lives at root.
	_ = godotenv.Load("../../.env")
	_ = godotenv.Load("../.env")

	var cfg Config
	if err := yaml.Unmarshal(yamlBytes, &cfg); err != nil {
		return nil, fmt.Errorf("parse default.yaml: %w", err)
	}
	if err := applyEnvOverrides(&cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func applyEnvOverrides(cfg *Config) error {
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
	if v := get("AI_GATEWAY__API_KEY"); v != "" {
		cfg.ASR.APIKey = v
	}
	if v := get("AI_GATEWAY__BASE_URL"); v != "" {
		cfg.ASR.BaseURL = v
	}
	// user_oauth SESSDATA decrypt key — shared with app-auth (compat fixture).
	if v := get("SECURITY__API_KEY_ENCRYPTION_KEY"); v != "" {
		cfg.Bili.EncryptionKey = v
	}
	// _FILE convention: the master key lives in a dedicated secret file
	// (docker volume mount / local secrets/ dir) and wins over the env var.
	if v, err := secretFromFile("SECURITY__API_KEY_ENCRYPTION_KEY_FILE"); err != nil {
		return err
	} else if v != "" {
		cfg.Bili.EncryptionKey = v
	}
	// internal M2M guard (AI stack scope reads); compose injects the shared
	// consumer key under the APPBILI__-prefixed name.
	if v := get("APPBILI__INTERNAL__API_KEY"); v != "" {
		cfg.Internal.APIKey = v
	}

	// ── APPBILI__-prefixed overrides (highest priority) ──
	if v := get("APPBILI__RDBMS__URL"); v != "" {
		cfg.RDBMS.URL = v
	}
	if v := get("APPBILI__MONGO__URI"); v != "" {
		cfg.Mongo.URI = v
	}
	if v := get("APPBILI__REDIS__URL"); v != "" {
		cfg.Redis.URL = v
	}
	if v := get("APPBILI__ASR__API_KEY"); v != "" {
		cfg.ASR.APIKey = v
	}
	if v := get("APPBILI__ASR__BASE_URL"); v != "" {
		cfg.ASR.BaseURL = v
	}
	atoi("APPBILI__SERVER__PORT", &cfg.Server.Port)
	if b, ok := getBool("APPBILI__APP__DEBUG"); ok {
		cfg.App.Debug = b
	}
	if v := get("APPBILI__BILI__PROXY"); v != "" {
		cfg.Bili.Proxy = v
	}
	if v := get("APPBILI__LOG__LEVEL"); v != "" {
		cfg.Log.Level = v
	}
	if v := get("APPBILI__LOG__OUTPUT"); v != "" {
		cfg.Log.Output = v
	}
	if v := get("APPBILI__LOG__FORMAT"); v != "" {
		cfg.Log.Format = v
	}
	if v := get("APPBILI__LOG__FILE__PATH"); v != "" {
		cfg.Log.File.Path = v
	}
	return nil
}

// secretFromFile implements the _FILE convention for secrets: when <NAME>_FILE
// is set, the secret is read from that path (docker volume / k8s secret mount,
// or the local secrets/ dir) and overrides the direct env var. Unset = no-op.
func secretFromFile(envName string) (string, error) {
	path := strings.TrimSpace(os.Getenv(envName))
	if path == "" {
		return "", nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("%s=%s: %w", envName, path, err)
	}
	return strings.TrimSpace(string(b)), nil
}

// Validate fails loud on config that would silently break the service.
func Validate(cfg *Config) error {
	if strings.TrimSpace(cfg.RDBMS.URL) == "" {
		return fmt.Errorf("rdbms.url is required (APPBILI__RDBMS__URL)")
	}
	if strings.TrimSpace(cfg.ASR.APIKey) == "" {
		return fmt.Errorf("asr.api_key is required (AI_GATEWAY__API_KEY)")
	}
	return nil
}
