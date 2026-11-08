// Package redis owns the ONE Redis client used by the whole app-content
// process (board read cache + quiz quota/share cache share the connection).
package redis

import (
	"context"
	"fmt"
	"strings"
	"time"

	redisclient "github.com/redis/go-redis/v9"
)

// New connects and pings. An empty URL disables Redis (nil client, no error);
// callers degrade gracefully.
func New(ctx context.Context, url string) (*redisclient.Client, error) {
	if strings.TrimSpace(url) == "" {
		return nil, nil
	}
	opts, err := redisclient.ParseURL(url)
	if err != nil {
		return nil, fmt.Errorf("parse redis url: %w", err)
	}
	client := redisclient.NewClient(opts)
	pingCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if err := client.Ping(pingCtx).Err(); err != nil {
		_ = client.Close()
		return nil, fmt.Errorf("ping redis: %w", err)
	}
	return client, nil
}

// Close closes the shared client (nil-safe).
func Close(client *redisclient.Client) error {
	if client == nil {
		return nil
	}
	return client.Close()
}

// Ping checks liveness (nil client = disabled, treated as healthy).
func Ping(ctx context.Context, client *redisclient.Client) error {
	if client == nil {
		return nil
	}
	return client.Ping(ctx).Err()
}
