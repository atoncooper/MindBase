// Package config loads app-kg configuration from embedded default.yaml +
// APPKG__-prefixed env overrides + project-root .env.
//
// Secret-bearing settings are shared with the other services and read from
// the SAME env var names (KG__URI, KG__PASSWORD/NEO4J_PASSWORD,
// RDBMS__URL via compose), so one .env drives the whole stack.
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
	App    AppConfig    `yaml:"app"`
	Server ServerConfig `yaml:"server"`
	Log    LogConfig    `yaml:"log"`

	Timezone string      `yaml:"timezone"`
	RDBMS    RDBMSConfig `yaml:"rdbms"`
	Neo4j    Neo4jConfig `yaml:"neo4j"`
}

type AppConfig struct {
	Name  string `yaml:"name"`
	Debug bool   `yaml:"debug"`
}

type ServerConfig struct {
	Host       string `yaml:"host"`
	GrpcPort   int    `yaml:"grpc_port"`
	HealthPort int    `yaml:"health_port"`
}

type RDBMSConfig struct {
	URL             string `yaml:"url"`
	MaxOpenConns    int    `yaml:"max_open_conns"`
	MaxIdleConns    int    `yaml:"max_idle_conns"`
	ConnMaxLifetime int    `yaml:"conn_max_lifetime"`
}

type Neo4jConfig struct {
	URI      string `yaml:"uri"`
	Username string `yaml:"username"`
	Password string `yaml:"password"`
	Database string `yaml:"database"`
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
	// app-go/app-kg sits two levels below project root; .env lives at root.
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

	// ── shared env vars (same names as the Python backend) ──
	// KG__URI is the bolt address the compose stack already injects for the
	// Python backend; the password prefers KG__PASSWORD with the
	// NEO4J_PASSWORD fallback (compose: KG__PASSWORD=${NEO4J_PASSWORD:-...}).
	if v := get("KG__URI"); v != "" {
		cfg.Neo4j.URI = v
	}
	if v := get("KG__PASSWORD"); v != "" {
		cfg.Neo4j.Password = v
	} else if v := get("NEO4J_PASSWORD"); v != "" {
		cfg.Neo4j.Password = v
	}

	// ── APPKG__-prefixed overrides (highest priority) ──
	if v := get("APPKG__RDBMS__URL"); v != "" {
		cfg.RDBMS.URL = v
	}
	if v := get("APPKG__NEO4J__URI"); v != "" {
		cfg.Neo4j.URI = v
	}
	if v := get("APPKG__NEO4J__USERNAME"); v != "" {
		cfg.Neo4j.Username = v
	}
	if v := get("APPKG__NEO4J__PASSWORD"); v != "" {
		cfg.Neo4j.Password = v
	}
	if v := get("APPKG__NEO4J__DATABASE"); v != "" {
		cfg.Neo4j.Database = v
	}
	atoi("APPKG__SERVER__GRPC_PORT", &cfg.Server.GrpcPort)
	atoi("APPKG__SERVER__HEALTH_PORT", &cfg.Server.HealthPort)
	if b, ok := getBool("APPKG__APP__DEBUG"); ok {
		cfg.App.Debug = b
	}
	if v := get("APPKG__LOG__LEVEL"); v != "" {
		cfg.Log.Level = v
	}
	if v := get("APPKG__LOG__OUTPUT"); v != "" {
		cfg.Log.Output = v
	}
	if v := get("APPKG__LOG__FORMAT"); v != "" {
		cfg.Log.Format = v
	}
	if v := get("APPKG__LOG__FILE__PATH"); v != "" {
		cfg.Log.File.Path = v
	}
}

// Validate fails loud on config that would silently break the service.
// Neo4j is REQUIRED (this service is useless without the graph store);
// MySQL is required for page bookkeeping and scope resolution.
func Validate(cfg *Config) error {
	if strings.TrimSpace(cfg.Neo4j.URI) == "" {
		return fmt.Errorf("neo4j.uri is required (KG__URI)")
	}
	if strings.TrimSpace(cfg.RDBMS.URL) == "" {
		return fmt.Errorf("rdbms.url is required (APPKG__RDBMS__URL)")
	}
	if strings.TrimSpace(cfg.Neo4j.Database) == "" {
		cfg.Neo4j.Database = "neo4j"
	}
	if strings.TrimSpace(cfg.Neo4j.Username) == "" {
		cfg.Neo4j.Username = "neo4j"
	}
	return nil
}
