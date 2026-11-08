// Package mongo owns the ONE MongoDB client used by the whole app-content
// process. Collections and indexes stay with the domain packages.
package mongo

import (
	"context"
	"fmt"
	"time"

	mongodriver "go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Connect dials and pings the shared MongoDB.
func Connect(ctx context.Context, uri string, timeoutSeconds int) (*mongodriver.Client, error) {
	timeout := time.Duration(timeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	pingCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	client, err := mongodriver.Connect(options.Client().ApplyURI(uri))
	if err != nil {
		return nil, fmt.Errorf("connect mongo: %w", err)
	}
	if err := client.Ping(pingCtx, nil); err != nil {
		_ = client.Disconnect(pingCtx)
		return nil, fmt.Errorf("ping mongo: %w", err)
	}
	return client, nil
}

// Close disconnects the shared client (nil-safe).
func Close(ctx context.Context, client *mongodriver.Client) error {
	if client == nil {
		return nil
	}
	return client.Disconnect(ctx)
}

// EnsureBoardIndexes creates the board_documents unique index (board_uuid is
// the logical primary key and the conflict guard for concurrent upserts).
func EnsureBoardIndexes(ctx context.Context, db *mongodriver.Database) error {
	if db == nil {
		return nil
	}
	_, err := db.Collection("board_documents").Indexes().CreateOne(ctx, mongodriver.IndexModel{
		Keys:    map[string]int{"board_uuid": 1},
		Options: options.Index().SetUnique(true),
	})
	if err != nil {
		return fmt.Errorf("ensure board_documents index: %w", err)
	}
	return nil
}
