package neo4j

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	neo4jDriver "github.com/neo4j/neo4j-go-driver/v5/neo4j"
)

// Store wraps the driver + database name. Repositories open sessions from it;
// nothing outside infra touches the driver.
type Store struct {
	driver   neo4jDriver.DriverWithContext
	database string
}

// Connect opens the driver and verifies connectivity (config validation
// already guarantees a non-empty URI).
func Connect(ctx context.Context, cfg Config) (*Store, error) {
	driver, err := neo4jDriver.NewDriverWithContext(cfg.URI, neo4jDriver.BasicAuth(cfg.Username, cfg.Password, ""))
	if err != nil {
		return nil, fmt.Errorf("create neo4j driver: %w", err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := driver.VerifyConnectivity(pingCtx); err != nil {
		_ = driver.Close(ctx)
		return nil, fmt.Errorf("neo4j connectivity check failed: %w", err)
	}
	return &Store{driver: driver, database: cfg.Database}, nil
}

// Close disconnects (nil-safe).
func (s *Store) Close(ctx context.Context) error {
	if s == nil || s.driver == nil {
		return nil
	}
	return s.driver.Close(ctx)
}

// NewSession opens a session bound to the configured database.
func (s *Store) NewSession(ctx context.Context) neo4jDriver.SessionWithContext {
	return s.driver.NewSession(ctx, neo4jDriver.SessionConfig{DatabaseName: s.database})
}

// EnsureConstraints creates the same uniqueness constraints the Python
// backend declared (idempotent). Called once at boot.
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

// Ping measures driver-level connectivity (health probe).
func (s *Store) Ping(ctx context.Context) error {
	if s == nil || s.driver == nil {
		return fmt.Errorf("neo4j not connected")
	}
	pingCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	return s.driver.VerifyConnectivity(pingCtx)
}
