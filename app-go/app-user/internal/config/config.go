// Package config is the single configuration entry point for app-user: one
// embedded default.yaml (sections auth/bili/settings) plus the three legacy
// env prefixes (APPAUTH__ / APPBILI__ / APPSETTINGS__), so compose/.env need
// no rename in this cutover.
package config

import (
	"fmt"
	"os"
	"strings"

	appuser "app-user"

	"gopkg.in/yaml.v3"
)

// TLSConfig enables optional TLS on the three listeners (empty = plain HTTP).
type TLSConfig struct {
	CertFile string `yaml:"cert_file"`
	KeyFile  string `yaml:"key_file"`
}

// Config is the whole app-user configuration, one section per domain.
type Config struct {
	Auth     AuthConfig     `yaml:"auth"`
	Bili     BiliConfig     `yaml:"bili"`
	Settings SettingsConfig `yaml:"settings"`
	TLS      TLSConfig      `yaml:"tls"`
}

// Load parses default.yaml, then applies each domain env prefix via the
// existing per-domain loaders (behavior kept identical to the three services).
func Load() (*Config, error) {
	var sections map[string]yaml.Node
	if err := yaml.Unmarshal(appuser.DefaultYAML, &sections); err != nil {
		return nil, fmt.Errorf("parse default.yaml: %w", err)
	}
	section := func(name string) ([]byte, error) {
		node, ok := sections[name]
		if !ok {
			return nil, fmt.Errorf("default.yaml missing %q section", name)
		}
		return yaml.Marshal(node)
	}
	authBytes, err := section("auth")
	if err != nil {
		return nil, err
	}
	biliBytes, err := section("bili")
	if err != nil {
		return nil, err
	}
	settingsBytes, err := section("settings")
	if err != nil {
		return nil, err
	}
	cfgAuth, err := loadAuth(authBytes)
	if err != nil {
		return nil, fmt.Errorf("load auth config: %w", err)
	}
	cfgBili, err := loadBili(biliBytes)
	if err != nil {
		return nil, fmt.Errorf("load bili config: %w", err)
	}
	cfgSettings, err := loadSettings(settingsBytes)
	if err != nil {
		return nil, fmt.Errorf("load settings config: %w", err)
	}
	tlsBytes, err := section("tls")
	if err != nil {
		return nil, err
	}
	var tlsCfg TLSConfig
	if err := yaml.Unmarshal(tlsBytes, &tlsCfg); err != nil {
		return nil, fmt.Errorf("parse tls config: %w", err)
	}
	if v := strings.TrimSpace(os.Getenv("TLS__CERT_FILE")); v != "" {
		tlsCfg.CertFile = v
	}
	if v := strings.TrimSpace(os.Getenv("TLS__KEY_FILE")); v != "" {
		tlsCfg.KeyFile = v
	}
	if (tlsCfg.CertFile == "") != (tlsCfg.KeyFile == "") {
		return nil, fmt.Errorf("tls: cert_file and key_file must be set together")
	}
	return &Config{Auth: *cfgAuth, Bili: *cfgBili, Settings: *cfgSettings, TLS: tlsCfg}, nil
}

// Validate applies the three domain validations.
func Validate(c *Config) error {
	if err := validateAuth(&c.Auth); err != nil {
		return fmt.Errorf("auth config: %w", err)
	}
	if err := validateBili(&c.Bili); err != nil {
		return fmt.Errorf("bili config: %w", err)
	}
	if err := validateSettings(&c.Settings); err != nil {
		return fmt.Errorf("settings config: %w", err)
	}
	return nil
}
