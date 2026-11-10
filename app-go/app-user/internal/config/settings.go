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
	App      AppConfig      `yaml:"app"`
	Server   ServerConfig   `yaml:"server"`
	Log      LogConfig      `yaml:"log"`
	Timezone string         `yaml:"timezone"`
	RDBMS    RDBMSConfig    `yaml:"rdbms"`
	AppCloud AppCloudConfig `yaml:"app_cloud"`
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
}

// Validate fails loud on config that would silently break the service.
func validateSettings(cfg *SettingsConfig) error {
	if strings.TrimSpace(cfg.RDBMS.URL) == "" {
		return fmt.Errorf("rdbms.url is required (APPSETTINGS__RDBMS__URL)")
	}
	return nil
}
