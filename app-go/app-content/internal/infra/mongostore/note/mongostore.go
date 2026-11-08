// Package mongostore wraps the shared MongoDB database for the note domain.
// The client lifecycle belongs to internal/infra/mongo (one client per process).
package mongostore

import (
	"context"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// MongoStore exposes the note collections. Nil database = disabled Mongo
// (reads degrade to zero values, writes return repo.ErrContentDisabled).
type MongoStore struct {
	db *mongo.Database
}

// NewMongoStore wraps an already-connected database handle.
func NewMongoStore(db *mongo.Database) *MongoStore {
	return &MongoStore{db: db}
}

// Database exposes the handle for repo construction (nil when disabled).
func (m *MongoStore) Database() *mongo.Database {
	if m == nil {
		return nil
	}
	return m.db
}

// EnsureIndexes creates the same indexes the Python backend declares in
// app/infra/mongo.py (idempotent) so app-note works even when the Python
// backend is not running.
func (m *MongoStore) EnsureIndexes(ctx context.Context) error {
	if m == nil || m.db == nil {
		return nil
	}
	_, err := m.db.Collection("note_documents").Indexes().CreateMany(ctx, []mongo.IndexModel{
		{Keys: bson.D{{Key: "note_uuid", Value: 1}}, Options: options.Index().SetUnique(true)},
		{Keys: bson.D{{Key: "uid", Value: 1}, {Key: "updated_at", Value: -1}}},
	})
	if err != nil {
		return err
	}
	_, err = m.db.Collection("note_revisions").Indexes().CreateMany(ctx, []mongo.IndexModel{
		{Keys: bson.D{{Key: "note_uuid", Value: 1}, {Key: "created_at", Value: -1}}},
	})
	return err
}
