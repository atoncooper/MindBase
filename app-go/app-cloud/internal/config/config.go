// Package config loads app-cloud configuration from embedded default.yaml +
// APPCLOUD__-prefixed env overrides + project-root .env.
//
// Secret-bearing settings (MinIO keys, Redis/Mongo URLs, AI gateway key,
// membership key) are shared with the other services and read from the SAME
// env var names (MINIO__*, REDIS__URL, MONGO__URI, AI_GATEWAY__*,
// APISIX_CONSUMER_KEY), so one .env drives the whole stack.
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
	Redis    RedisConfig    `yaml:"redis"`
	Mongo    MongoConfig    `yaml:"mongo"`
	Minio    MinioConfig    `yaml:"minio"`
	Upload   UploadConfig   `yaml:"upload"`
	Quota    QuotaConfig    `yaml:"quota"`
	Trash    TrashConfig    `yaml:"trash"`
	Pipeline PipelineConfig `yaml:"pipeline"`
	WSBridge WSBridgeConfig `yaml:"ws_bridge"`
	CORS     CORSConfig     `yaml:"cors"`
	Log      LogConfig      `yaml:"log"`
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

type RedisConfig struct {
	URL string `yaml:"url"`
}

type MongoConfig struct {
	URI      string `yaml:"uri"`
	Database string `yaml:"database"`
}

type MinioConfig struct {
	Enabled        bool   `yaml:"enabled"`
	Endpoint       string `yaml:"endpoint"`
	Region         string `yaml:"region"`
	Bucket         string `yaml:"bucket"`
	Secure         bool   `yaml:"secure"`
	PresignExpire  int    `yaml:"presign_expire"`
	AccessKey      string `yaml:"access_key"`
	SecretKey      string `yaml:"secret_key"`
	PublicEndpoint string `yaml:"public_endpoint"`
	PublicHost     string `yaml:"public_host"`
}

type UploadConfig struct {
	ChunkSize     int64 `yaml:"chunk_size"`
	MaxFileSize   int64 `yaml:"max_file_size"`
	HeartbeatTTL  int   `yaml:"heartbeat_ttl"`
	UploadMetaTTL int   `yaml:"upload_meta_ttl"`
}

type QuotaConfig struct {
	Free               int64  `yaml:"free"`
	VIP                int64  `yaml:"vip"`
	SVIP               int64  `yaml:"svip"`
	MembershipBaseURL  string `yaml:"membership_base_url"`
	MembershipAPIKey   string `yaml:"membership_api_key"`
	MembershipCacheTTL int    `yaml:"membership_cache_ttl"`
}

type TrashConfig struct {
	PurgeAfterDays       int `yaml:"purge_after_days"`
	SweepIntervalSeconds int `yaml:"sweep_interval_seconds"`
}

type EmbeddingConfig struct {
	BaseURL   string `yaml:"base_url"`
	APIKey    string `yaml:"api_key"`
	Model     string `yaml:"model"`
	Dimension int    `yaml:"dimension"`
	BatchSize int    `yaml:"batch_size"`
}

type MilvusConfig struct {
	Enabled    bool   `yaml:"enabled"`
	URI        string `yaml:"uri"`
	Token      string `yaml:"token"`
	Collection string `yaml:"collection"`
	Analyzer   string `yaml:"analyzer"`
}

type PipelineConfig struct {
	Enabled    bool            `yaml:"enabled"`
	MaxDocSize int64           `yaml:"max_doc_size"`
	Embedding  EmbeddingConfig `yaml:"embedding"`
	Milvus     MilvusConfig    `yaml:"milvus"`
}

type WSBridgeConfig struct {
	Enabled bool   `yaml:"enabled"`
	Channel string `yaml:"channel"`
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
	// app-go/app-cloud sits two levels below project root; .env lives at root.
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
	atol := func(key string, dst *int64) {
		if v := get(key); v != "" {
			if n, err := strconv.ParseInt(v, 10, 64); err == nil {
				*dst = n
			}
		}
	}

	// ── shared secret env vars (same names as the other services) ──
	if v := get("REDIS__URL"); v != "" {
		cfg.Redis.URL = v
	}
	if v := get("MONGO__URI"); v != "" {
		cfg.Mongo.URI = v
	}
	if v := get("MINIO__ACCESS_KEY"); v != "" {
		cfg.Minio.AccessKey = v
	}
	if v := get("MINIO__SECRET_KEY"); v != "" {
		cfg.Minio.SecretKey = v
	}
	if v := get("APISIX_CONSUMER_KEY"); v != "" {
		cfg.Quota.MembershipAPIKey = v
	}
	if v := get("AI_GATEWAY__API_KEY"); v != "" {
		cfg.Pipeline.Embedding.APIKey = v
	}
	if v := get("AI_GATEWAY__BASE_URL"); v != "" {
		cfg.Pipeline.Embedding.BaseURL = v
	}
	if v := get("MILVUS__URI"); v != "" {
		cfg.Pipeline.Milvus.URI = v
	}
	if v := get("MILVUS__TOKEN"); v != "" {
		cfg.Pipeline.Milvus.Token = v
	}

	// ── APPCLOUD__-prefixed overrides (highest priority) ──
	if v := get("APPCLOUD__RDBMS__URL"); v != "" {
		cfg.RDBMS.URL = v
	}
	if v := get("APPCLOUD__REDIS__URL"); v != "" {
		cfg.Redis.URL = v
	}
	atoi("APPCLOUD__SERVER__PORT", &cfg.Server.Port)
	if b, ok := getBool("APPCLOUD__APP__DEBUG"); ok {
		cfg.App.Debug = b
	}
	if v := get("APPCLOUD__MINIO__PUBLIC_ENDPOINT"); v != "" {
		cfg.Minio.PublicEndpoint = v
	}
	if v := get("APPCLOUD__MINIO__PUBLIC_HOST"); v != "" {
		cfg.Minio.PublicHost = v
	}
	if b, ok := getBool("APPCLOUD__PIPELINE__ENABLED"); ok {
		cfg.Pipeline.Enabled = b
	}
	if v := get("APPCLOUD__LOG__LEVEL"); v != "" {
		cfg.Log.Level = v
	}
	if v := get("APPCLOUD__LOG__OUTPUT"); v != "" {
		cfg.Log.Output = v
	}
	if v := get("APPCLOUD__LOG__FORMAT"); v != "" {
		cfg.Log.Format = v
	}
	if v := get("APPCLOUD__LOG__FILE__PATH"); v != "" {
		cfg.Log.File.Path = v
	}
	atol("APPCLOUD__QUOTA__FREE", &cfg.Quota.Free)
	atol("APPCLOUD__QUOTA__VIP", &cfg.Quota.VIP)
	atol("APPCLOUD__QUOTA__SVIP", &cfg.Quota.SVIP)
}

// Validate fails loud on config that would silently break the drive.
func Validate(cfg *Config) error {
	if strings.TrimSpace(cfg.RDBMS.URL) == "" {
		return fmt.Errorf("rdbms.url is required (APPCLOUD__RDBMS__URL)")
	}
	if !cfg.Minio.Enabled {
		return fmt.Errorf("minio.enabled=false is not supported — the drive requires object storage")
	}
	if cfg.Minio.AccessKey == "" || cfg.Minio.SecretKey == "" {
		return fmt.Errorf("minio access_key/secret_key required (MINIO__ACCESS_KEY / MINIO__SECRET_KEY)")
	}
	if cfg.Upload.ChunkSize <= 0 || cfg.Upload.MaxFileSize <= 0 {
		return fmt.Errorf("upload.chunk_size / upload.max_file_size must be positive")
	}
	if cfg.Pipeline.Enabled && cfg.Pipeline.Embedding.Dimension <= 0 {
		return fmt.Errorf("pipeline.embedding.dimension must be positive when pipeline enabled")
	}
	return nil
}
