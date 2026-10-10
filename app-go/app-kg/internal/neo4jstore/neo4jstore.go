// Package neo4jstore owns the Neo4j driver lifecycle and the uniqueness
// constraints (port of app/infra/neo4j.py init/ensure_constraints/close).
package neo4jstore

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/neo4j/neo4j-go-driver/v5/neo4j"
)

// Store wraps the driver + database name.
type Store struct {
	driver   neo4j.DriverWithContext
	database string
}

// Connect opens the driver and verifies connectivity. Uri empty → error is
// returned by the caller (config validation already guarantees non-empty).
func Connect(ctx context.Context, uri, username, password, database string) (*Store, error) {
	driver, err := neo4j.NewDriverWithContext(uri, neo4j.BasicAuth(username, password, ""))
	if err != nil {
		return nil, fmt.Errorf("create neo4j driver: %w", err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := driver.VerifyConnectivity(pingCtx); err != nil {
		_ = driver.Close(ctx)
		return nil, fmt.Errorf("neo4j connectivity check failed: %w", err)
	}
	return &Store{driver: driver, database: database}, nil
}

// Close disconnects.
func (s *Store) Close(ctx context.Context) error {
	if s == nil || s.driver == nil {
		return nil
	}
	return s.driver.Close(ctx)
}

// Driver exposes the driver for the graph repository.
func (s *Store) Driver() neo4j.DriverWithContext {
	if s == nil {
		return nil
	}
	return s.driver
}

// Database returns the configured database name.
func (s *Store) Database() string {
	if s == nil {
		return "neo4j"
	}
	return s.database
}

// NewSession opens a session bound to the configured database.
func (s *Store) NewSession(ctx context.Context) neo4j.SessionWithContext {
	return s.driver.NewSession(ctx, neo4j.SessionConfig{DatabaseName: s.database})
}

// EnsureConstraints creates the same uniqueness constraints the Python
// backend declares (idempotent). Port of infra/neo4j.ensure_constraints.
func (s *Store) EnsureConstraints(ctx context.Context) error {
	stmts := []string{
		"CREATE CONSTRAINT kg_entity_eid IF NOT EXISTS FOR (e:Entity) REQUIRE e.eid IS UNIQUE",
		"CREATE CONSTRAINT kg_entity_name IF NOT EXISTS FOR (e:Entity) REQUIRE e.name_lower IS UNIQUE",
		"CREATE CONSTRAINT kg_video_bvid IF NOT EXISTS FOR (v:Video) REQUIRE v.bvid IS UNIQUE",
	}
	session := s.NewSession(ctx)
	defer session.Close(ctx)
	for _, stmt := range stmts {
		if _, err := session.Run(ctx, stmt, nil); err != nil {
			return fmt.Errorf("ensure constraint: %w", err)
		}
	}
	slog.Info("[NEO4J] constraints ensured", "database", s.database)
	return nil
}

// Ping measures driver-level connectivity latency (health endpoint).
func (s *Store) Ping(ctx context.Context) error {
	if s == nil || s.driver == nil {
		return fmt.Errorf("neo4j not connected")
	}
	pingCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	return s.driver.VerifyConnectivity(pingCtx)
}

// SanitizeDatabase guards against empty database names at call sites.
func SanitizeDatabase(name string) string {
	if strings.TrimSpace(name) == "" {
		return "neo4j"
	}
	return name
}
