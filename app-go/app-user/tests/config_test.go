package tests

import (
	"testing"

	"app-user/internal/config"
)

// TestLegacyEnvPrefixes pins the v1 compatibility contract: one default.yaml,
// but each domain still reads its original env prefix so compose/.env need no
// rename in this cutover.
func TestLegacyEnvPrefixes(t *testing.T) {
	t.Setenv("APPAUTH__SERVER__PORT", "18006")
	t.Setenv("APPAUTH__RDBMS__URL", "mysql+aiomysql://u:p@h:3306/db_auth")
	t.Setenv("APPBILI__SERVER__PORT", "18010")
	t.Setenv("APPSETTINGS__SERVER__PORT", "18015")
	t.Setenv("APPSETTINGS__RDBMS__URL", "mysql+aiomysql://u:p@h:3306/db_settings")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if cfg.Auth.Server.Port != 18006 {
		t.Errorf("auth port = %d, want 18006", cfg.Auth.Server.Port)
	}
	if cfg.Auth.RDBMS.URL != "mysql+aiomysql://u:p@h:3306/db_auth" {
		t.Errorf("auth rdbms = %q", cfg.Auth.RDBMS.URL)
	}
	if cfg.Bili.Server.Port != 18010 {
		t.Errorf("bili port = %d, want 18010", cfg.Bili.Server.Port)
	}
	if cfg.Settings.Server.Port != 18015 {
		t.Errorf("settings port = %d, want 18015", cfg.Settings.Server.Port)
	}
	if cfg.Settings.RDBMS.URL != "mysql+aiomysql://u:p@h:3306/db_settings" {
		t.Errorf("settings rdbms = %q", cfg.Settings.RDBMS.URL)
	}
}

// TestTLSConfigOptional pins the optional TLS switch: both files or neither.
func TestTLSConfigOptional(t *testing.T) {
	t.Setenv("TLS__CERT_FILE", "/certs/fullchain.pem")
	t.Setenv("TLS__KEY_FILE", "/certs/privkey.pem")
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if cfg.TLS.CertFile != "/certs/fullchain.pem" || cfg.TLS.KeyFile != "/certs/privkey.pem" {
		t.Errorf("tls = %+v", cfg.TLS)
	}

	t.Setenv("TLS__KEY_FILE", "")
	if _, err := config.Load(); err == nil {
		t.Fatal("cert without key must be rejected")
	}
}
