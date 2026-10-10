// Package config loads app-note-mcp settings.
//
// Precedence: process environment overrides root-.env values (godotenv walks
// up from the working directory), matching the other Go services
// (app-note APPNOTE__*, app-task APPTASK__*). This server has only a
// handful of knobs, so defaults live in code instead of an embedded YAML.
//
// Env keys (double underscore nests):
//
//	NOTEMCP__UPSTREAM__BASE_URL   APISIX gateway base (default http://127.0.0.1:9080)
//	NOTEMCP__UPSTREAM__API_KEY    key-auth consumer key (secrets only)
//	NOTEMCP__UPSTREAM__UID        note owner the server acts as
//	NOTEMCP__SERVER__TRANSPORT    stdio (default) | http
//	NOTEMCP__SERVER__HTTP_ADDR    listen addr for http transport (default :8009)
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"app-note-mcp/internal/logger"

	"github.com/joho/godotenv"
)

const (
	TransportStdio = "stdio"
	TransportHTTP  = "http"
)

type Config struct {
	Upstream UpstreamConfig
	Server   ServerConfig
	Log      LogConfig
}

type UpstreamConfig struct {
	// BaseURL is the APISIX gateway base; note calls go to
	// {BaseURL}/internal/note/* (key-auth route).
	BaseURL string
	// APIKey is the APISIX key-auth consumer key sent as the apikey header.
	APIKey string
	// UID is the note owner this server acts as. Tools take no uid
	// parameter, so the agent cannot address another user's notes.
	UID int64
}

type ServerConfig struct {
	// Transport selects the MCP transport: stdio or http (streamable-http).
	Transport string
	// HTTPAddr is the listen address for the http transport.
	HTTPAddr string
	// AuthToken is the bearer token the http transport requires for
	// single-user (fixed-uid) MCP hosts. stdio does not use it. Either this
	// or ServiceAPIKey must be present in http mode (fail closed): the
	// endpoint mutates note data, so an unauthenticated listener must not
	// come up silently.
	AuthToken string
	// ServiceAPIKey enables service mode for trusted internal callers (the
	// main-app backend): requests carrying `apikey: <ServiceAPIKey>` plus a
	// per-request `X-Uid` act as that uid. Value is the APISIX consumer key,
	// the same trust model as the note_internal gateway route.
	ServiceAPIKey string
	// AllowedOrigins is the Origin allowlist for browser-side clients. Empty
	// (default) rejects every request that carries an Origin header — MCP
	// hosts don't send one; browsers do (DNS rebinding defense, MCP spec).
	AllowedOrigins []string
	// RateLimitRPS / RateLimitBurst shape the /mcp token bucket.
	RateLimitRPS   float64
	RateLimitBurst int
	// MaxBodyBytes caps the /mcp request body (default 10MB: 256KB note
	// content + envelope headroom).
	MaxBodyBytes int64
	// MaxInflight caps concurrent /mcp requests (default 8; excess → 503).
	MaxInflight int
}

// LogConfig maps 1:1 onto logger.Options (see internal/logger).
type LogConfig struct {
	Level  string        // NOTEMCP__LOG__LEVEL (debug|info|warn|error)
	Format string        // NOTEMCP__LOG__FORMAT (json|text)
	Output string        // NOTEMCP__LOG__OUTPUT (stderr|stdout|file|both)
	File   LogFileConfig // NOTEMCP__LOG__FILE*
}

type LogFileConfig struct {
	Path       string
	MaxSize    int
	MaxBackups int
	MaxAge     int
	Compress   bool
}

// APIKeySet reports whether the upstream key-auth credential is present.
func (c *Config) APIKeySet() bool { return strings.TrimSpace(c.Upstream.APIKey) != "" }

// UIDSet reports whether the acting uid has been configured.
func (c *Config) UIDSet() bool { return c.Upstream.UID > 0 }

// ToOptions converts the env-parsed config into logger.Options.
func (l LogConfig) ToOptions() logger.Options {
	return logger.Options{
		Level:  l.Level,
		Format: l.Format,
		Output: l.Output,
		File: logger.FileOptions{
			Path:       l.File.Path,
			MaxSize:    l.File.MaxSize,
			MaxBackups: l.File.MaxBackups,
			MaxAge:     l.File.MaxAge,
			Compress:   l.File.Compress,
		},
	}
}

// Load reads .env (if found), then the environment, and validates values.
// Missing credentials are tolerated at startup (the container must boot even
// when NOTE_MCP_UID is unset in compose) and surface as tool-call errors;
// present-but-invalid values fail hard.
func Load() (*Config, error) {
	loadDotenv()

	cfg := &Config{
		Upstream: UpstreamConfig{
			BaseURL: envOr("NOTEMCP__UPSTREAM__BASE_URL", "http://127.0.0.1:9080"),
			APIKey:  strings.TrimSpace(os.Getenv("NOTEMCP__UPSTREAM__API_KEY")),
		},
		Server: ServerConfig{
			Transport:      strings.ToLower(envOr("NOTEMCP__SERVER__TRANSPORT", TransportStdio)),
			HTTPAddr:       envOr("NOTEMCP__SERVER__HTTP_ADDR", ":8009"),
			AuthToken:      strings.TrimSpace(os.Getenv("NOTEMCP__SERVER__AUTH_TOKEN")),
			ServiceAPIKey:  strings.TrimSpace(os.Getenv("NOTEMCP__SERVER__SERVICE_API_KEY")),
			AllowedOrigins: envListOr("NOTEMCP__SERVER__ALLOWED_ORIGINS"),
			RateLimitRPS:   envFloatOr("NOTEMCP__SERVER__RATE_LIMIT_RPS", 10),
			RateLimitBurst: envIntOr("NOTEMCP__SERVER__RATE_LIMIT_BURST", 20),
			MaxBodyBytes:   int64(envIntOr("NOTEMCP__SERVER__MAX_BODY_BYTES", 2<<20)),
			MaxInflight:    envIntOr("NOTEMCP__SERVER__MAX_INFLIGHT", 8),
		},
		Log: LogConfig{
			Level:  envOr("NOTEMCP__LOG__LEVEL", "info"),
			Format: envOr("NOTEMCP__LOG__FORMAT", "json"),
			Output: envOr("NOTEMCP__LOG__OUTPUT", "stderr"),
			File: LogFileConfig{
				Path:       envOr("NOTEMCP__LOG__FILE", "/app/logs/app-note-mcp.log"),
				MaxSize:    envIntOr("NOTEMCP__LOG__FILE_MAX_SIZE", 100),
				MaxBackups: envIntOr("NOTEMCP__LOG__FILE_MAX_BACKUPS", 7),
				MaxAge:     envIntOr("NOTEMCP__LOG__FILE_MAX_AGE", 30),
				Compress:   envOr("NOTEMCP__LOG__FILE_COMPRESS", "") == "true",
			},
		},
	}
	cfg.Upstream.BaseURL = strings.TrimRight(cfg.Upstream.BaseURL, "/")

	if raw := strings.TrimSpace(os.Getenv("NOTEMCP__UPSTREAM__UID")); raw != "" {
		uid, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || uid <= 0 {
			return nil, fmt.Errorf("invalid NOTEMCP__UPSTREAM__UID %q: must be a positive integer", raw)
		}
		cfg.Upstream.UID = uid
	}

	switch cfg.Server.Transport {
	case TransportStdio, TransportHTTP:
	default:
		return nil, fmt.Errorf("invalid NOTEMCP__SERVER__TRANSPORT %q: must be stdio or http", cfg.Server.Transport)
	}
	if cfg.Server.HTTPAddr == "" {
		cfg.Server.HTTPAddr = ":8009"
	}

	// Fail closed: the http endpoint mutates note data, so it must not come
	// up without at least one credential — a bearer token for fixed-uid MCP
	// hosts or the service key for the main-app backend. stdio needs neither
	// (process-level trust).
	if cfg.Server.Transport == TransportHTTP && !cfg.AuthTokenSet() && !cfg.ServiceKeySet() {
		return nil, errors.New("http transport requires NOTEMCP__SERVER__AUTH_TOKEN (bearer hosts) or NOTEMCP__SERVER__SERVICE_API_KEY (main-app service mode); stdio needs neither")
	}
	if cfg.Server.RateLimitRPS <= 0 {
		cfg.Server.RateLimitRPS = 10
	}
	if cfg.Server.RateLimitBurst < 1 {
		cfg.Server.RateLimitBurst = 1
	}
	if cfg.Server.MaxBodyBytes <= 0 {
		cfg.Server.MaxBodyBytes = 10 << 20
	}
	if cfg.Server.MaxInflight < 1 {
		cfg.Server.MaxInflight = 1
	}
	return cfg, nil
}

// AuthTokenSet reports whether the bearer credential is present.
func (c *Config) AuthTokenSet() bool { return strings.TrimSpace(c.Server.AuthToken) != "" }

// ServiceKeySet reports whether service mode (apikey + per-request X-Uid) is
// available for trusted internal callers.
func (c *Config) ServiceKeySet() bool { return strings.TrimSpace(c.Server.ServiceAPIKey) != "" }

// WarnMissing logs the tolerated-but-required credential gaps. Called by main
// after logging is set up. The configured uid is only needed for bearer
// clients (fixed identity); service-mode callers bring their own per request.
func (c *Config) WarnMissing(log *slog.Logger) {
	if !c.APIKeySet() {
		log.Warn("upstream apikey not configured; tool calls will fail",
			"env", "NOTEMCP__UPSTREAM__API_KEY")
	}
	if !c.UIDSet() && !c.ServiceKeySet() {
		log.Warn("acting uid not configured; tool calls will fail",
			"env", "NOTEMCP__UPSTREAM__UID (via NOTE_MCP_UID in .env)")
	}
	if !c.AuthTokenSet() && c.ServiceKeySet() {
		log.Info("no bearer token configured; external MCP hosts cannot connect, service mode only",
			"env", "NOTEMCP__SERVER__AUTH_TOKEN")
	}
}

// ErrNotConfigured is returned by tools when credentials are missing.
var ErrNotConfigured = errors.New("app-note-mcp is not configured: set NOTEMCP__UPSTREAM__API_KEY plus either NOTEMCP__UPSTREAM__UID (bearer clients) or NOTEMCP__SERVER__SERVICE_API_KEY with a per-request X-Uid (service mode); see docs/app-note-mcp.md")

// loadDotenv loads the project-root .env, walking up from the working
// directory. Existing process env wins (godotenv never overrides), so
// container-injected variables keep priority over file values.
func loadDotenv() {
	dir, err := os.Getwd()
	if err != nil {
		return
	}
	for i := 0; i < 6; i++ {
		candidate := filepath.Join(dir, ".env")
		if fi, err := os.Stat(candidate); err == nil && !fi.IsDir() {
			_ = godotenv.Load(candidate) // absent/invalid .env is not fatal
			return
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return
		}
		dir = parent
	}
}

func envOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func envIntOr(key string, fallback int) int {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return fallback
}

func envFloatOr(key string, fallback float64) float64 {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil && f > 0 {
			return f
		}
	}
	return fallback
}

// envListOr splits a comma-separated list; absent or empty yields nil.
func envListOr(key string) []string {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return nil
	}
	var out []string
	for _, part := range strings.Split(v, ",") {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}
