// Package config loads app-user settings-domain configuration from embedded
// default.yaml + APPSETTINGS__-prefixed env overrides + project-root .env.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/joho/godotenv"
	"gopkg.in/yaml.v3"
)

type SettingsConfig struct {
	App        AppConfig        `yaml:"app"`
	Server     ServerConfig     `yaml:"server"`
	Log        LogConfig        `yaml:"log"`
	Timezone   string           `yaml:"timezone"`
	RDBMS      RDBMSConfig      `yaml:"rdbms"`
	AppCloud   AppCloudConfig   `yaml:"app_cloud"`
	CodingPlan CodingPlanConfig `yaml:"coding_plan"`
	MCP        MCPConfig        `yaml:"mcp"`
}

// CodingPlanConfig is the operator-owned provider catalog for Coding Plans.
// All provider base URLs live here (default.yaml) instead of being hardcoded in
// Go or the frontend; the account editor and probe/list/test paths share it.
// MCPConfig controls the per-user third-party MCP connection surface
// (/settings/mcp/servers). Credentials use the shared AES cipher
// (security.api_key_encryption_key); app-ts reads connections via the
// internal M2M face.
type MCPConfig struct {
	Enabled    bool           `yaml:"enabled"`
	MaxServers int            `yaml:"max_servers"`
	OAuth      MCPOAuthConfig `yaml:"oauth"`
}

// MCPOAuthConfig is the deployment-specific half of the OAuth 2.1 flow:
// callback_url is registered with the provider via dynamic client registration
// and must be browser-reachable through the gateway; frontend_url is where the
// callback redirects afterwards.
type MCPOAuthConfig struct {
	CallbackURL string `yaml:"callback_url"`
	FrontendURL string `yaml:"frontend_url"`
	// ClientName is sent to providers during dynamic client registration.
	ClientName string `yaml:"client_name"`
	// ClientID/ClientSecret skip DCR and use a pre-registered OAuth client
	// (providers that issue credentials instead of allowing registration).
	ClientID     string `yaml:"client_id"`
	ClientSecret string `yaml:"client_secret"`
	// Scopes overrides the discovered scopes (space separated).
	Scopes            string `yaml:"scopes"`
	AllowPrivateHosts bool   `yaml:"allow_private_hosts"`
	TimeoutMs         int    `yaml:"timeout_ms"`
}

type CodingPlanConfig struct {
	Providers []CodingPlanProviderConfig `yaml:"providers"`
}

type CodingPlanProviderConfig struct {
	Name             string   `yaml:"name"`
	Label            string   `yaml:"label"`
	OpenAIBaseURL    string   `yaml:"openai_base_url"`
	AnthropicBaseURL string   `yaml:"anthropic_base_url"`
	ModelsURL        string   `yaml:"models_url"`
	ModelHint        string   `yaml:"model_hint"`
	LegacyBaseURLs   []string `yaml:"legacy_base_urls"`
}

// AppCloudConfig — app-cloud M2M face that owns object storage. app-user only
// calls its /internal/cloud/avatar endpoints; MinIO credentials stay in app-cloud.
type AppCloudConfig struct {
	BaseURL   string `yaml:"base_url"`
	APIKey    string `yaml:"api_key"`
	TimeoutMs int    `yaml:"timeout_ms"`
}

// Load parses embedded default.yaml and applies env overrides. Best-effort
// loads project-root .env (docker injects env directly).
func loadSettings(yamlBytes []byte) (*SettingsConfig, error) {
	// app-go/app-settings sits two levels below project root; .env lives at root.
	_ = godotenv.Load("../../.env")
	_ = godotenv.Load("../.env")

	var cfg SettingsConfig
	if err := yaml.Unmarshal(yamlBytes, &cfg); err != nil {
		return nil, fmt.Errorf("parse default.yaml: %w", err)
	}
	applySettingsEnv(&cfg)
	return &cfg, nil
}

func applySettingsEnv(cfg *SettingsConfig) {
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

	// ── app-cloud avatar storage (M2M) ─────────────────────────────────
	if v := get("APPSETTINGS__APP_CLOUD__BASE_URL"); v != "" {
		cfg.AppCloud.BaseURL = v
	}
	if v := get("APP_CLOUD_BASE_URL"); v != "" {
		cfg.AppCloud.BaseURL = v
	}
	if v := get("APPSETTINGS__APP_CLOUD__API_KEY"); v != "" {
		cfg.AppCloud.APIKey = v
	}
	if v := get("APP_CLOUD_API_KEY"); v != "" {
		cfg.AppCloud.APIKey = v
	}
	if v := get("APISIX_CONSUMER_KEY"); v != "" && cfg.AppCloud.APIKey == "" {
		cfg.AppCloud.APIKey = v
	}
	atoi("APPSETTINGS__APP_CLOUD__TIMEOUT_MS", &cfg.AppCloud.TimeoutMs)
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
	if b, ok := getBool("APPSETTINGS__MCP__ENABLED"); ok {
		cfg.MCP.Enabled = b
	}
	atoi("APPSETTINGS__MCP__MAX_SERVERS", &cfg.MCP.MaxServers)
	if v := get("APPSETTINGS__MCP__OAUTH__CALLBACK_URL"); v != "" {
		cfg.MCP.OAuth.CallbackURL = v
	}
	if v := get("APPSETTINGS__MCP__OAUTH__FRONTEND_URL"); v != "" {
		cfg.MCP.OAuth.FrontendURL = v
	}
	if b, ok := getBool("APPSETTINGS__MCP__OAUTH__ALLOW_PRIVATE_HOSTS"); ok {
		cfg.MCP.OAuth.AllowPrivateHosts = b
	}
	atoi("APPSETTINGS__MCP__OAUTH__TIMEOUT_MS", &cfg.MCP.OAuth.TimeoutMs)
	if v := get("APPSETTINGS__MCP__OAUTH__CLIENT_NAME"); v != "" {
		cfg.MCP.OAuth.ClientName = v
	}
	if v := get("APPSETTINGS__MCP__OAUTH__CLIENT_ID"); v != "" {
		cfg.MCP.OAuth.ClientID = v
	}
	if v := get("APPSETTINGS__MCP__OAUTH__CLIENT_SECRET"); v != "" {
		cfg.MCP.OAuth.ClientSecret = v
	}
	if v := get("APPSETTINGS__MCP__OAUTH__SCOPES"); v != "" {
		cfg.MCP.OAuth.Scopes = v
	}
}

// Validate fails loud on config that would silently break the service.
func validateSettings(cfg *SettingsConfig) error {
	if strings.TrimSpace(cfg.RDBMS.URL) == "" {
		return fmt.Errorf("rdbms.url is required (APPSETTINGS__RDBMS__URL)")
	}
	// Provider names are the stable keys stored in coding_plans; duplicates or
	// empty names would make the YAML catalog ambiguous.
	seen := make(map[string]bool, len(cfg.CodingPlan.Providers))
	for i, p := range cfg.CodingPlan.Providers {
		name := strings.ToLower(strings.TrimSpace(p.Name))
		if name == "" {
			return fmt.Errorf("settings.coding_plan.providers[%d].name is required", i)
		}
		if seen[name] {
			return fmt.Errorf("settings.coding_plan.providers has duplicate name %q", name)
		}
		seen[name] = true
	}
	return nil
}
