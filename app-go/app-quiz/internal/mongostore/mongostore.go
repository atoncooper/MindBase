// Package mongostore — MongoDB connection management for app-quiz, the
// counterpart of the db package (which owns MySQL). It owns the client
// lifecycle, ping, and index declarations; collection reads live in the repo
// package, mirroring the db (connection) / repo (queries) split used for
// MySQL.
//
// Nil-safe (empty store) when Mongo is not configured: Database() returns
// nil and repo reads degrade to empty results (same semantics as the Python
// backend's disabled-Mongo behaviour — question lists come back empty and
// stale-refresh checks are skipped).
package mongostore

import (
	"context"
	"strings"
	"time"

	"app-quiz/internal/config"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// MongoStore owns the MongoDB client + database handle. Nil-safe when
// disabled.
type MongoStore struct {
	client *mongo.Client
	db     *mongo.Database
}

// NewMongoStore connects and pings. Empty URI → disabled store (no error).
func NewMongoStore(ctx context.Context, cfg *config.Config) (*MongoStore, error) {
	if strings.TrimSpace(cfg.Mongo.URI) == "" {
		return &MongoStore{}, nil
	}
	client, err := mongo.Connect(options.Client().ApplyURI(cfg.Mongo.URI))
	if err != nil {
		return nil, err
	}
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := client.Ping(pingCtx, nil); err != nil {
		return nil, err
	}
	return &MongoStore{client: client, db: client.Database(cfg.Mongo.Database)}, nil
}

// Close disconnects (nil-safe when disabled).
func (m *MongoStore) Close(ctx context.Context) error {
	if m == nil || m.client == nil {
		return nil
	}
	return m.client.Disconnect(ctx)
}

// Database exposes the handle for repo construction. Returns nil when
// disabled — repo reads on a nil database degrade gracefully.
func (m *MongoStore) Database() *mongo.Database {
	if m == nil {
		return nil
	}
	return m.db
}

// EnsureIndexes creates the same indexes the Python backend declares in
// app/infra/mongo.py (idempotent) so app-quiz works even when the Python
// backend is not running.
func (m *MongoStore) EnsureIndexes(ctx context.Context) error {
	if m == nil || m.db == nil {
		return nil
	}
	_, err := m.db.Collection("quiz_questions").Indexes().CreateMany(ctx, []mongo.IndexModel{
		{Keys: bson.D{{Key: "question_uuid", Value: 1}}, Options: options.Index().SetUnique(true)},
		{Keys: bson.D{{Key: "quiz_uuid", Value: 1}, {Key: "created_at", Value: 1}}},
		{Keys: bson.D{{Key: "uid", Value: 1}, {Key: "created_at", Value: -1}}},
		{Keys: bson.D{{Key: "bvid", Value: 1}}},
	})
	return err
}
