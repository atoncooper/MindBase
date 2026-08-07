// Package mongo initializes the MongoDB client (shared with main app).
package mongo

import (
	"context"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

var Client *mongo.Client
var DB *mongo.Database

// Init connects to MongoDB and pings it within timeoutMS.
func Init(uri, dbName string, timeoutMS int) error {
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMS)*time.Millisecond)
	defer cancel()
	client, err := mongo.Connect(ctx, options.Client().ApplyURI(uri))
	if err != nil {
		return fmt.Errorf("mongo connect: %w", err)
	}
	if err := client.Ping(ctx, nil); err != nil {
		return fmt.Errorf("mongo ping: %w", err)
	}
	Client = client
	DB = client.Database(dbName)
	return nil
}

func Close() error {
	if Client == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return Client.Disconnect(ctx)
}
