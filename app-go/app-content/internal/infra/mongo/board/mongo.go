// Package mongo initializes the MongoDB client (mongo-driver v2).
//
// app-board shares the main app's Mongo instance (db "MindBase") and stores
// board bodies in the `board_documents` collection: {board_uuid, version,
// content, updated_at}. content is the verbatim JSON produced by the editors
// (simple-mind-map tree / Excalidraw scene) kept as a string — atomic whole-
// document replace, no key-mangling risk, 16MB cap is plenty for one board.
package mongo

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

var DB *mongo.Database

// Init connects to Mongo and ensures the board_documents unique index.
func Init(uri, dbName string, timeoutSeconds int) error {
	timeout := time.Duration(timeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	client, err := mongo.Connect(options.Client().ApplyURI(uri))
	if err != nil {
		return fmt.Errorf("connect mongo: %w", err)
	}
	if err := client.Ping(ctx, nil); err != nil {
		return fmt.Errorf("ping mongo: %w", err)
	}
	DB = client.Database(dbName)

	// board_uuid is the logical primary key: unique index doubles as the
	// conflict guard for concurrent upserts (duplicate key -> 409 upstream).
	col := DB.Collection("board_documents")
	_, err = col.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys:    map[string]int{"board_uuid": 1},
		Options: options.Index().SetUnique(true),
	})
	if err != nil {
		return fmt.Errorf("ensure board_documents index: %w", err)
	}
	slog.Info("[MONGO] connected", "db", dbName)
	return nil
}

// Close disconnects the client (best-effort at shutdown).
func Close(ctx context.Context) error {
	if DB == nil {
		return nil
	}
	return DB.Client().Disconnect(ctx)
}
