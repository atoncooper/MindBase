package tests

import (
	"testing"

	"app-content/internal/config"
)

func TestLoadConfigSectionsAndPorts(t *testing.T) {
	t.Setenv("APPBOARD__SERVER__PORT", "18004")
	t.Setenv("APPNOTE__SERVER__PORT", "18008")
	t.Setenv("APPQUIZ__SERVER__PORT", "18011")
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if cfg.Board.Server.Port != 18004 {
		t.Errorf("board port = %d", cfg.Board.Server.Port)
	}
	if cfg.Note.Server.Port != 18008 {
		t.Errorf("note port = %d", cfg.Note.Server.Port)
	}
	if cfg.Quiz.Server.Port != 18011 {
		t.Errorf("quiz port = %d", cfg.Quiz.Server.Port)
	}
	if !cfg.Board.Server.TLS.Enabled {
		t.Error("board TLS should stay enabled by default")
	}
}
