package tests

import (
	"os"
	"strings"
	"testing"

	"app-kg/internal/config"
)

// TestDefaultsParse pins the YAML key ↔ struct mapping, including the
// infra-owned rdbms/neo4j blocks (the shape moved into internal/infra, so a
// wrong yaml tag here would silently drop production settings).
func TestDefaultsParse(t *testing.T) {
	raw, err := os.ReadFile("../default.yaml")
	if err != nil {
		t.Fatalf("read default.yaml: %v", err)
	}
	t.Setenv("APPKG__NEO4J__URI", "bolt://localhost:7687")
	t.Setenv("APPKG__RDBMS__URL", "mysql+aiomysql://u:p@localhost:3306/bilirag")

	cfg, err := config.Load(raw)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if cfg.App.Name != "app-kg" {
		t.Errorf("app.name = %q", cfg.App.Name)
	}
	if cfg.Server.GrpcPort != 8013 || cfg.Server.HealthPort != 8014 {
		t.Errorf("ports = %d/%d", cfg.Server.GrpcPort, cfg.Server.HealthPort)
	}
	if cfg.Timezone != "Asia/Shanghai" {
		t.Errorf("timezone = %q", cfg.Timezone)
	}
	if cfg.RDBMS.MaxOpenConns != 10 || cfg.RDBMS.MaxIdleConns != 5 || cfg.RDBMS.ConnMaxLifetime != 1800 {
		t.Errorf("rdbms pool = %+v", cfg.RDBMS)
	}
	if cfg.RDBMS.URL != "mysql+aiomysql://u:p@localhost:3306/bilirag" {
		t.Errorf("rdbms.url = %q (env override not applied)", cfg.RDBMS.URL)
	}
	if cfg.Neo4j.URI != "bolt://localhost:7687" {
		t.Errorf("neo4j.uri = %q (env override not applied)", cfg.Neo4j.URI)
	}
	if cfg.Log.File.Path != "/app/logs/app-kg.log" {
		t.Errorf("log.file.path = %q", cfg.Log.File.Path)
	}
	if err := config.Validate(cfg); err != nil {
		t.Fatalf("validate: %v", err)
	}
	if cfg.Neo4j.Database != "neo4j" || cfg.Neo4j.Username != "neo4j" {
		t.Errorf("neo4j defaults = %+v (want neo4j/neo4j)", cfg.Neo4j)
	}
}

// TestServerTLSConfig pins the TLS contract: disabled by default with the
// container-side /app/certs leaf paths, APPKG__SERVER__TLS__* env overrides,
// and validation refusing enabled-without-cert/key.
func TestServerTLSConfig(t *testing.T) {
	raw, err := os.ReadFile("../default.yaml")
	if err != nil {
		t.Fatalf("read default.yaml: %v", err)
	}
	t.Setenv("APPKG__NEO4J__URI", "bolt://localhost:7687")
	t.Setenv("APPKG__RDBMS__URL", "mysql+aiomysql://u:p@localhost:3306/bilirag")

	cfg, err := config.Load(raw)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if cfg.Server.TLS.Enabled {
		t.Errorf("server.tls.enabled default = true, want false (plaintext posture)")
	}
	if cfg.Server.TLS.Cert != "/app/certs/server.crt" || cfg.Server.TLS.Key != "/app/certs/server.key" {
		t.Errorf("server.tls paths = %q/%q, want /app/certs/server.{crt,key}", cfg.Server.TLS.Cert, cfg.Server.TLS.Key)
	}

	t.Setenv("APPKG__SERVER__TLS__ENABLED", "true")
	t.Setenv("APPKG__SERVER__TLS__CERT", "/tmp/kg.crt")
	t.Setenv("APPKG__SERVER__TLS__KEY", "/tmp/kg.key")
	cfg, err = config.Load(raw)
	if err != nil {
		t.Fatalf("load (tls env): %v", err)
	}
	if !cfg.Server.TLS.Enabled || cfg.Server.TLS.Cert != "/tmp/kg.crt" || cfg.Server.TLS.Key != "/tmp/kg.key" {
		t.Errorf("tls env overrides not applied: %+v", cfg.Server.TLS)
	}
	if err := config.Validate(cfg); err != nil {
		t.Fatalf("validate (tls enabled): %v", err)
	}

	cfg.Server.TLS.Key = ""
	if err := config.Validate(cfg); err == nil || !strings.Contains(err.Error(), "server.tls.key") {
		t.Fatalf("tls enabled without key: err = %v", err)
	}
}

// TestValidateFailsLoud: both stores are required; the error names the env var
// an operator must set.
func TestValidateFailsLoud(t *testing.T) {
	var cfg config.Config
	if err := config.Validate(&cfg); err == nil || !strings.Contains(err.Error(), "neo4j.uri is required") {
		t.Fatalf("missing neo4j.uri: err = %v", err)
	}
	cfg.Neo4j.URI = "bolt://localhost:7687"
	if err := config.Validate(&cfg); err == nil || !strings.Contains(err.Error(), "rdbms.url is required") {
		t.Fatalf("missing rdbms.url: err = %v", err)
	}
}
