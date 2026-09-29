package config

// Tests for ${VAR} / ${VAR:default} placeholder expansion in default.yaml
// (aligned with the main app loader) and the env-override channel.

import (
	"os"
	"testing"
)

func TestPlaceholderExpansion(t *testing.T) {
	t.Setenv("AT_TEST_SET", "hello")
	t.Setenv("AT_TEST_NUM", "42")
	t.Setenv("AT_TEST_EMPTY", "")
	t.Setenv("AT_TEST_OVERRIDE", "from-env")

	yaml := `
app:
  name: app-task
rdbms:
  url: "${AT_TEST_SET}"
scheduler:
  weight: ${AT_TEST_NUM:1}
  instance_id: "${AT_TEST_UNSET}"
  batch_size: ${AT_TEST_NUM:7}
email:
  api_key: "${AT_TEST_EMPTY:fallback-key}"
webui:
  token: "prefix-${AT_TEST_OVERRIDE}-suffix"
  token2: "${AT_TEST_OVERRIDE:ignored}"
`
	cfg, err := Load([]byte(yaml))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.RDBMS.URL != "hello" {
		t.Fatalf("set var = %q, want hello", cfg.RDBMS.URL)
	}
	if cfg.Scheduler.Weight != 42 {
		t.Fatalf("numeric placeholder = %d, want 42 (env wins over default)", cfg.Scheduler.Weight)
	}
	if cfg.Scheduler.InstanceID != "" {
		t.Fatalf("unset without default = %q, want empty", cfg.Scheduler.InstanceID)
	}
	if cfg.Scheduler.BatchSize != 42 {
		t.Fatalf("numeric with default = %d, want 42 (env wins)", cfg.Scheduler.BatchSize)
	}
	if cfg.Email.APIKey != "fallback-key" {
		t.Fatalf("empty env with default = %q, want fallback-key", cfg.Email.APIKey)
	}
	if cfg.WebUI.Token != "prefix-from-env-suffix" {
		t.Fatalf("embedded placeholder = %q", cfg.WebUI.Token)
	}
}

func TestPlaceholderUnsetNoDefault(t *testing.T) {
	t.Setenv("AT_TEST_MISSING", "")
	cfg, err := Load([]byte("webui:\n  token: \"${AT_TEST_MISSING}\"\n  session_store: memory\n"))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.WebUI.Token != "" {
		t.Fatalf("token = %q, want empty", cfg.WebUI.Token)
	}
	if cfg.WebUI.SessionStore != "memory" {
		t.Fatalf("literal field = %q, want memory", cfg.WebUI.SessionStore)
	}
}

func TestEnvOverrideStillWorks(t *testing.T) {
	t.Setenv("APPTASK__SERVER__PORT", "9999")
	cfg, err := Load([]byte("server:\n  port: 8001\n"))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Server.Port != 9999 {
		t.Fatalf("port = %d, want 9999 (APPTASK__ env override channel)", cfg.Server.Port)
	}
}

func TestPlaceholderDefaultFile(t *testing.T) {
	// The real embedded default.yaml must keep parsing with expansion on.
	// Secrets stay empty without env; literal defaults keep their values.
	os.Unsetenv("APPTASK__RDBMS__URL")
	os.Unsetenv("APPTASK__EMAIL__API_KEY")
	os.Unsetenv("APPTASK__WEBUI__TOKEN")
	os.Unsetenv("REDIS__URL")
	raw := func() []byte {
		b, err := os.ReadFile("../../default.yaml")
		if err != nil {
			t.Fatal(err)
		}
		return b
	}()
	cfg, err := Load(raw)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.RDBMS.URL != "" || cfg.Email.APIKey != "" || cfg.WebUI.Token != "" || cfg.Redis.URL != "" {
		t.Fatalf("secret fields must be empty without env: %+v", cfg)
	}
	if cfg.Scheduler.Workers != 16 || cfg.Scheduler.Weight != 1 || cfg.Server.Port != 8001 {
		t.Fatalf("literal defaults drifted: %+v", cfg.Scheduler)
	}
}
