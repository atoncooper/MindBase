// Package neo4j owns the Neo4j driver lifecycle of app-kg: the connection
// settings (this file), the driver/session plumbing, and the uniqueness
// constraints the graph depends on (neo4j.go).
package neo4j

import (
	"fmt"
	"strings"
)

// Config is the `neo4j:` block of default.yaml. Declared in the infra layer
// next to the code that consumes it; internal/config embeds it and stays the
// only YAML/env entry point.
type Config struct {
	URI      string `yaml:"uri"`
	Username string `yaml:"username"`
	Password string `yaml:"password"`
	Database string `yaml:"database"`
}

// Validate fails loud on a missing URI (this service is useless without the
// graph store) and applies the protocol defaults for username/database.
func (c *Config) Validate() error {
	if strings.TrimSpace(c.URI) == "" {
		return fmt.Errorf("neo4j.uri is required (KG__URI)")
	}
	if strings.TrimSpace(c.Database) == "" {
		c.Database = "neo4j"
	}
	if strings.TrimSpace(c.Username) == "" {
		c.Username = "neo4j"
	}
	return nil
}
