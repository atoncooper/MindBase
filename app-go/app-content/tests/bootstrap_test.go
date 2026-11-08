package tests

import (
	"context"
	"strings"
	"testing"

	"app-content/internal/bootstrap"
	"app-content/internal/config"
)

// One Run, one listener: the composition root must fail fast on invalid
// config instead of starting a half-configured server.
func TestBootstrapFailsFastOnInvalidConfig(t *testing.T) {
	cfg := &config.Config{}
	cfg.Server.TLS.Enabled = true
	err := bootstrap.Run(context.Background(), cfg)
	if err == nil || !strings.Contains(err.Error(), "database.mysql.url") {
		t.Fatalf("Run error = %v, want data-store validation failure", err)
	}
}

// HTTPS is mandatory: a plaintext listener must be refused unless the explicit
// local-debug escape hatch is set.
func TestBootstrapRejectsPlaintextByDefault(t *testing.T) {
	cfg := &config.Config{}
	cfg.Database.MySQL.URL = "x"
	cfg.Database.Mongo.URI = "y"
	cfg.Server.TLS.Enabled = false
	err := bootstrap.Run(context.Background(), cfg)
	if err == nil || !strings.Contains(err.Error(), "TLS is required") {
		t.Fatalf("Run error = %v, want TLS enforcement", err)
	}
}
