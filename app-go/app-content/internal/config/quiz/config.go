// Package config holds the quiz-domain tuning knobs. Data-store settings are
// process-wide (internal/config DatabaseConfig) — they must not be duplicated
// per domain, or the "one service" silently becomes three databases.
package config

import (
	"fmt"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Quota     QuotaConfig     `yaml:"quota"`
	Lifecycle LifecycleConfig `yaml:"lifecycle"`
}

// QuotaConfig mirrors the Python app/config quiz.limits daily quotas (UTC day,
// per uid). Consumed by the internal quota endpoints used by app-ts's AI flows.
type QuotaConfig struct {
	Generate int `yaml:"generate"`
	Grade    int `yaml:"grade"`
}

// LifecycleConfig owns the stuck-generating sweep. 大题量（plan-then-generate
// 并发批）生成 40-50 题可超过固定 15 分钟，因此基数可配置，且实际允许时长按
// 题量缩放（见 service allowedFor）。
type LifecycleConfig struct {
	GenerationTimeoutMinutes int `yaml:"generation_timeout_minutes"`
}

// Load parses the quiz section of default.yaml. Env overrides are applied by
// the root config loader (single precedence table), not here.
func Load(yamlBytes []byte) (*Config, error) {
	var cfg Config
	if err := yaml.Unmarshal(yamlBytes, &cfg); err != nil {
		return nil, fmt.Errorf("parse quiz section: %w", err)
	}
	return &cfg, nil
}

// Validate applies the historical Python-parity defaults.
func Validate(cfg *Config) error {
	if cfg.Quota.Generate <= 0 {
		cfg.Quota.Generate = 5
	}
	if cfg.Quota.Grade <= 0 {
		cfg.Quota.Grade = 20
	}
	if cfg.Lifecycle.GenerationTimeoutMinutes <= 0 {
		cfg.Lifecycle.GenerationTimeoutMinutes = 15
	}
	return nil
}
