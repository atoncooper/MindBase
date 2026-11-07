// Package config is the single configuration entry point for app-content:
// one embedded default.yaml with board/note/quiz sections plus the three
// legacy env prefixes (APPBOARD__ / APPNOTE__ / APPQUIZ__), so compose/.env
// need no rename in this cutover.
package config

import (
	"fmt"

	appcontent "app-content"
	boardconfig "app-content/internal/config/board"
	noteconfig "app-content/internal/config/note"
	quizconfig "app-content/internal/config/quiz"

	"gopkg.in/yaml.v3"
)

// Config is the whole app-content configuration, one section per domain.
type Config struct {
	Board boardconfig.Config
	Note  noteconfig.Config
	Quiz  quizconfig.Config
}

// Load parses the embedded YAML and delegates each section to the domain
// loader (which keeps its historical env prefix and validation behavior).
func Load() (*Config, error) {
	var sections map[string]yaml.Node
	if err := yaml.Unmarshal(appcontent.DefaultYAML, &sections); err != nil {
		return nil, fmt.Errorf("parse default.yaml: %w", err)
	}
	section := func(name string) ([]byte, error) {
		node, ok := sections[name]
		if !ok {
			return nil, fmt.Errorf("default.yaml missing %q section", name)
		}
		return yaml.Marshal(node)
	}
	boardBytes, err := section("board")
	if err != nil {
		return nil, err
	}
	noteBytes, err := section("note")
	if err != nil {
		return nil, err
	}
	quizBytes, err := section("quiz")
	if err != nil {
		return nil, err
	}
	boardCfg, err := boardconfig.Load(boardBytes)
	if err != nil {
		return nil, fmt.Errorf("load board config: %w", err)
	}
	noteCfg, err := noteconfig.Load(noteBytes)
	if err != nil {
		return nil, fmt.Errorf("load note config: %w", err)
	}
	quizCfg, err := quizconfig.Load(quizBytes)
	if err != nil {
		return nil, fmt.Errorf("load quiz config: %w", err)
	}
	return &Config{Board: *boardCfg, Note: *noteCfg, Quiz: *quizCfg}, nil
}
