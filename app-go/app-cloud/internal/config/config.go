// Package config loads app-cloud configuration from embedded default.yaml +
// APPCLOUD__-prefixed env overrides + project-root .env.
//
// Secret-bearing settings (MinIO keys, Redis/Mongo URLs, AI gateway key,
// membership key) are shared with the other services and read from the SAME
// env var names (MINIO__*, REDIS__URL, MONGO__URI, AI_GATEWAY__*,
// APISIX_CONSUMER_KEY), so one .env drives the whole stack.
package config

import (
	"encoding/hex"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/joho/godotenv"
	"gopkg.in/yaml.v3"
)

type Config struct {
	App         AppConfig         `yaml:"app"`
	Server      ServerConfig      `yaml:"server"`
	Timezone    string            `yaml:"timezone"`
	RDBMS       RDBMSConfig       `yaml:"rdbms"`
	Redis       RedisConfig       `yaml:"redis"`
	Mongo       MongoConfig       `yaml:"mongo"`
	Minio       MinioConfig       `yaml:"minio"`
	Upload      UploadConfig      `yaml:"upload"`
	Attest      AttestConfig      `yaml:"attest"`
	AdminReview AdminReviewConfig `yaml:"admin_review"`
	Joblock     JoblockConfig     `yaml:"joblock"`
	Quota       QuotaConfig       `yaml:"quota"`
	Trash       TrashConfig       `yaml:"trash"`
	Pipeline    PipelineConfig    `yaml:"pipeline"`
	Kg          KgConfig          `yaml:"kg"`
	WSBridge    WSBridgeConfig    `yaml:"ws_bridge"`
	CORS        CORSConfig        `yaml:"cors"`
	Log         LogConfig         `yaml:"log"`
}

// KgConfig — app-kg internal cloud-doc routing endpoints (L1 graph writes;
// best-effort: failures are logged, never fatal). Empty base URL disables
// graph writes (summaries still land in Mongo).
type KgConfig struct {
	BaseURL string `yaml:"base_url"`
	Token   string `yaml:"token"`
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

// JoblockConfig — Redis-lease tuning for the background jobs (trash sweeper,
// daily reconciler). The TTL must comfortably exceed the job context timeout
// (10 min) so a crashed holder cannot deadlock the tick, yet should not dwarf
// the rollout interval: a replica taking over after a k8s rolling update
// waits for the previous lease to expire. 15 min balances both.
type JoblockConfig struct {
	LeaseTTLSecs int `yaml:"lease_ttl_seconds"`
}

// DefaultJoblockLeaseTTLSecs applies when the value is unset or non-positive.
const DefaultJoblockLeaseTTLSecs = 900

// AttestConfig — public-share device-attestation HMAC key. MUST be identical
// across all replicas of a multi-instance deployment: challenges/tickets are
// stateless HMACs, so a per-process random key breaks when nginx round-robins
// /cloud/s/* across replicas (challenge issued by A, attest hits B → verify
// fails). Single-replica deployments may leave it empty (boot-random key).
type AttestConfig struct {
	Secret string `yaml:"secret"`
}

// AdminReviewConfig protects the app-admin-only share-content preview
// endpoint. Empty token disables the endpoint (fail closed).
type AdminReviewConfig struct {
	Token string `yaml:"token"`
}

// KeyBytes parses the configured secret into HMAC key material:
// 64 hex chars → 32 decoded bytes; otherwise any raw string ≥ 32 bytes is
// used as-is. Empty → (nil, nil): the attestor falls back to a boot-random
// key with a loud warning. Anything else is invalid and must fail startup.
func (a AttestConfig) KeyBytes() ([]byte, error) {
	s := strings.TrimSpace(a.Secret)
	if s == "" {
		return nil, nil
	}
	if len(s) == 64 {
		if b, err := hex.DecodeString(s); err == nil {
			return b, nil
		}
	}
	if len(s) >= 32 {
		return []byte(s), nil
	}
	return nil, fmt.Errorf("attest.secret must be 64 hex chars (32 bytes) or a raw string of at least 32 bytes")
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
	Workers    int             `yaml:"workers"`
	MaxWorkers int             `yaml:"max_workers"`
	Autoscale  bool            `yaml:"autoscale"`
	Admission  AdmissionConfig `yaml:"admission"`
	Embedding  EmbeddingConfig `yaml:"embedding"`
	Milvus     MilvusConfig    `yaml:"milvus"`
	Summary    SummaryConfig   `yaml:"summary"`
}

// AdmissionConfig — queue admission control (capacity layer): without it a
// burst of manual triggers can enqueue unbounded work and starve the
// downstream LLM/embedding gateways. Limits of 0 disable the check.
type AdmissionConfig struct {
	MaxPerUID     int64 `yaml:"max_per_uid"`
	MaxQueueDepth int64 `yaml:"max_queue_depth"`
}

// SummaryConfig — L1 routing payload: a small-model structured summary
// stored alongside the parsed document. Best-effort by design: any failure
// is logged and skipped, never blocking vectorization (L2 covers). The model
// MUST be routable by the same Higress gateway as the embedding config
// (credentials/base URL are shared with it); an empty model disables the
// stage cleanly.
type SummaryConfig struct {
	Enabled       bool   `yaml:"enabled"`
	Model         string `yaml:"model"`
	MaxInputChars int    `yaml:"max_input_chars"`
	MaxOutputTok  int    `yaml:"max_output_tokens"`
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
	if cfg.Joblock.LeaseTTLSecs <= 0 {
		cfg.Joblock.LeaseTTLSecs = DefaultJoblockLeaseTTLSecs
	}
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
	// compose shares these under the bare MINIO__ names; APPCLOUD__-prefixed
	// overrides below take precedence.
	if v := get("MINIO__PUBLIC_ENDPOINT"); v != "" {
		cfg.Minio.PublicEndpoint = v
	}
	if v := get("MINIO__PUBLIC_HOST"); v != "" {
		cfg.Minio.PublicHost = v
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
	if v := get("APPCLOUD__ATTEST__SECRET"); v != "" {
		cfg.Attest.Secret = v
	}
	if v := get("APPCLOUD__ADMIN_REVIEW__TOKEN"); v != "" {
		cfg.AdminReview.Token = v
	}
	atoi("APPCLOUD__JOBLOCK__LEASE_TTL_SECS", &cfg.Joblock.LeaseTTLSecs)
	if b, ok := getBool("APPCLOUD__PIPELINE__ENABLED"); ok {
		cfg.Pipeline.Enabled = b
	}
	atoi("APPCLOUD__PIPELINE__WORKERS", &cfg.Pipeline.Workers)
	atoi("APPCLOUD__PIPELINE__MAX_WORKERS", &cfg.Pipeline.MaxWorkers)
	atol("APPCLOUD__PIPELINE__ADMISSION__MAX_PER_UID", &cfg.Pipeline.Admission.MaxPerUID)
	atol("APPCLOUD__PIPELINE__ADMISSION__MAX_QUEUE_DEPTH", &cfg.Pipeline.Admission.MaxQueueDepth)
	if b, ok := getBool("APPCLOUD__PIPELINE__AUTOSCALE"); ok {
		cfg.Pipeline.Autoscale = b
	}
	if v := get("APPCLOUD__PIPELINE__SUMMARY__MODEL"); v != "" {
		cfg.Pipeline.Summary.Model = v
	}
	if v := get("APPCLOUD__KG__BASE_URL"); v != "" {
		cfg.Kg.BaseURL = v
	}
	if v := get("APPCLOUD__KG__TOKEN"); v != "" {
		cfg.Kg.Token = v
	}
	if b, ok := getBool("APPCLOUD__PIPELINE__SUMMARY__ENABLED"); ok {
		cfg.Pipeline.Summary.Enabled = b
	}
	atoi("APPCLOUD__PIPELINE__SUMMARY__MAX_INPUT_CHARS", &cfg.Pipeline.Summary.MaxInputChars)
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
	if _, err := cfg.Attest.KeyBytes(); err != nil {
		return err
	}
	if cfg.Pipeline.Enabled && cfg.Pipeline.Embedding.Dimension <= 0 {
		return fmt.Errorf("pipeline.embedding.dimension must be positive when pipeline enabled")
	}
	return nil
}
