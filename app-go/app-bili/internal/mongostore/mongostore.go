// Package mongostore — MongoDB connection management for app-bili, the
// counterpart of the db package (which owns MySQL). Collection read/write
// operations for asr_documents live in the repo package
// (repo.ASRContentRepo), mirroring the db/repo split used for MySQL.
//
// Same collection and document shape the Python backend used
// (app/repository/mongo_asr_repository.py) — zero data migration.
package mongostore

import (
	"context"
	"strings"
	"time"

	"app-bili/internal/config"

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
// disabled — repo operations on a nil database degrade gracefully.
func (m *MongoStore) Database() *mongo.Database {
	if m == nil {
		return nil
	}
	return m.db
}

// EnsureIndexes creates the same indexes the Python backend declares in
// app/infra/mongo.py (idempotent).
func (m *MongoStore) EnsureIndexes(ctx context.Context) error {
	if m == nil || m.db == nil {
		return nil
	}
	_, err := m.db.Collection("asr_documents").Indexes().CreateMany(ctx, []mongo.IndexModel{
		{Keys: bson.D{{Key: "bvid", Value: 1}, {Key: "cid", Value: 1}, {Key: "version", Value: -1}},
			Options: options.Index().SetName("idx_bvid_cid_version")},
		{Keys: bson.D{{Key: "bvid", Value: 1}, {Key: "cid", Value: 1}, {Key: "is_latest", Value: 1}},
			Options: options.Index().SetName("idx_bvid_cid_latest")},
		{Keys: bson.D{{Key: "video_id", Value: 1}},
			Options: options.Index().SetName("idx_video_id")},
	})
	return err
}
