// Package config loads app-admin configuration from embedded default.yaml +
// APPADMIN__-prefixed env overrides + project-root .env (godotenv).
//
// Layering (highest wins, mirrors app-pay-admin / app-task):
//
//	default.yaml (embedded)  ->  optional -config overlay  ->  APPADMIN__* env
package config

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
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
	Session  SessionConfig  `yaml:"session"`
	Security SecurityConfig `yaml:"security"`
	// CloudReview — app-cloud internal preview wiring (see CloudReviewConfig).
	CloudReview CloudReviewConfig `yaml:"cloud_review"`
	Seed        SeedConfig        `yaml:"seed"`
	Log         LogConfig         `yaml:"log"`
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

// SessionConfig: DB-backed login session lifetime (admin_session table,
// HttpOnly cookie, sliding expiry on each authenticated request).
type SessionConfig struct {
	TTLMinutes int `yaml:"ttl_minutes"` // 0 = default 12h
}

type SecurityConfig struct {
	IPAllowlist []string `yaml:"ip_allowlist"`
	CORS        struct {
		AllowOrigins []string `yaml:"allow_origins"`
	} `yaml:"cors"`
}

// CloudReviewConfig wires the app-cloud internal share-content review preview.
// Both values required together; either missing = preview disabled (fail
// closed). The token is a dedicated shared secret, NOT an API key of any user.
type CloudReviewConfig struct {
	BaseURL string `yaml:"base_url"`
	Token   string `yaml:"token"`
}

// SeedConfig: default admin account inserted on first boot (missing username
// only; never overwrites an existing row). must_change_password is forced to 1
// so the first login must POST /api/me/password.
type SeedConfig struct {
	Username string `yaml:"username"`
	Password string `yaml:"password"`
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
// APPADMIN__ env overrides (highest priority). Precedence note: godotenv
// values never replace variables already set in the process environment, so
// "real env > .env" holds by construction.
func Load(yamlBytes []byte, overlayPath string) (*Config, error) {
	loadDotenv()

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

// loadDotenv walks up from the working directory looking for a project-root
// .env, so bare go run . (from this directory) and go run ./app-go/app-admin
// (from the project root) both find it. A missing file is not an error:
// docker containers get their config via APPADMIN__ env injection instead.
func loadDotenv() {
	dir, err := os.Getwd()
	if err != nil {
		return
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, ".env")); err == nil {
			_ = godotenv.Load(filepath.Join(dir, ".env"))
			return
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return
		}
		dir = parent
	}
}

// applyEnvOverrides maps APPADMIN__SECTION__KEY env vars onto the config
// (mirrors app-pay-admin's per-field mapping; no generic reflection magic).
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

	if v := get("APPADMIN__RDBMS__URL"); v != "" {
		cfg.RDBMS.URL = v
	}
	atoi("APPADMIN__RDBMS__MAX_OPEN_CONNS", &cfg.RDBMS.MaxOpenConns)
	atoi("APPADMIN__RDBMS__MAX_IDLE_CONNS", &cfg.RDBMS.MaxIdleConns)
	atoi("APPADMIN__RDBMS__CONN_MAX_LIFETIME", &cfg.RDBMS.ConnMaxLifetime)
	if v := get("APPADMIN__TIMEZONE"); v != "" {
		cfg.Timezone = v
	}
	if v := get("APPADMIN__SERVER__HOST"); v != "" {
		cfg.Server.Host = v
	}
	atoi("APPADMIN__SERVER__PORT", &cfg.Server.Port)
	atoi("APPADMIN__SESSION__TTL_MINUTES", &cfg.Session.TTLMinutes)
	// Security lists accept comma-separated environment values; an explicitly
	// empty value clears a list supplied by a YAML overlay.
	if v, ok := os.LookupEnv("APPADMIN__SECURITY__IP_ALLOWLIST"); ok {
		cfg.Security.IPAllowlist = splitList(v)
	}
	if v, ok := os.LookupEnv("APPADMIN__SECURITY__CORS__ALLOW_ORIGINS"); ok {
		cfg.Security.CORS.AllowOrigins = splitList(v)
	}
	if v := get("APPADMIN__CLOUD_REVIEW__BASE_URL"); v != "" {
		cfg.CloudReview.BaseURL = v
	}
	if v := get("APPADMIN__CLOUD_REVIEW__TOKEN"); v != "" {
		cfg.CloudReview.Token = v
	}
	if v := get("APPADMIN__SEED__USERNAME"); v != "" {
		cfg.Seed.Username = v
	}
	if v := get("APPADMIN__SEED__PASSWORD"); v != "" {
		cfg.Seed.Password = v
	}
	boolVar("APPADMIN__APP__DEBUG", &cfg.App.Debug)
	if v := get("APPADMIN__LOG__LEVEL"); v != "" {
		cfg.Log.Level = v
	}
	if v := get("APPADMIN__LOG__FORMAT"); v != "" {
		cfg.Log.Format = v
	}
	if v := get("APPADMIN__LOG__OUTPUT"); v != "" {
		cfg.Log.Output = v
	}
	if v := get("APPADMIN__LOG__FILE__PATH"); v != "" {
		cfg.Log.File.Path = v
	}
	atoi("APPADMIN__LOG__FILE__MAX_SIZE", &cfg.Log.File.MaxSize)
	atoi("APPADMIN__LOG__FILE__MAX_BACKUPS", &cfg.Log.File.MaxBackups)
	atoi("APPADMIN__LOG__FILE__MAX_AGE", &cfg.Log.File.MaxAge)
	boolVar("APPADMIN__LOG__FILE__COMPRESS", &cfg.Log.File.Compress)
}

// Validate fails loud on config that would silently misbehave: this service
// moderates the shared share schema, so starting without a DSN is always a
// mistake.
func Validate(cfg *Config) error {
	if strings.TrimSpace(cfg.RDBMS.URL) == "" {
		return fmt.Errorf("rdbms.url is empty: run 'go run .' inside app-go/app-admin/ " +
			"(reads the project-root .env), or docker compose injects APPADMIN__RDBMS__URL")
	}
	if strings.TrimSpace(cfg.Seed.Username) == "" || strings.TrimSpace(cfg.Seed.Password) == "" {
		return fmt.Errorf("seed.username/password must not be blank (env APPADMIN__SEED__USERNAME/PASSWORD)")
	}
	for _, entry := range cfg.Security.IPAllowlist {
		if err := validateIPOrCIDR(entry); err != nil {
			return fmt.Errorf("security.ip_allowlist entry %q: %w", entry, err)
		}
	}
	for _, origin := range cfg.Security.CORS.AllowOrigins {
		if err := validateOrigin(origin); err != nil {
			return fmt.Errorf("security.cors.allow_origins entry %q: %w", origin, err)
		}
	}
	// Review preview wiring is OPTIONAL: a lone base URL or token would
	// silently half-enable the plane, but blocking the whole console over an
	// optional feature is worse — NormalizeCloudReview (called by main) clears
	// the mismatch and disables the preview with a warning instead.
	return nil
}

// NormalizeCloudReview resolves the all-or-nothing invariant at startup:
// when base URL and token are not BOTH set, both are cleared (preview
// disabled, fail closed) and true is returned so main can warn loudly.
func NormalizeCloudReview(cfg *Config) bool {
	base, token := strings.TrimSpace(cfg.CloudReview.BaseURL), strings.TrimSpace(cfg.CloudReview.Token)
	if base != "" && token != "" {
		return false // fully wired
	}
	if base == "" && token == "" {
		return false // intentionally disabled
	}
	cfg.CloudReview.BaseURL, cfg.CloudReview.Token = "", ""
	return true // half-wired → cleared + warned
}

func splitList(value string) []string {
	var result []string
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			result = append(result, item)
		}
	}
	return result
}

func validateIPOrCIDR(value string) error {
	if strings.TrimSpace(value) != value || value == "" {
		return fmt.Errorf("must be an IP address or CIDR")
	}
	if net.ParseIP(value) != nil {
		return nil
	}
	if _, _, err := net.ParseCIDR(value); err != nil {
		return fmt.Errorf("must be an IP address or CIDR")
	}
	return nil
}

func validateOrigin(value string) error {
	if strings.TrimSpace(value) != value || value == "" {
		return fmt.Errorf("must be an exact http(s) origin without a path")
	}
	u, err := url.Parse(value)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" ||
		u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return fmt.Errorf("must be an exact http(s) origin without a path")
	}
	return nil
}
