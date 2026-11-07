// Package redis provides the single shared Redis client for app-user. Both the
// auth domain (token cache / captcha / throttling / rate limits) and the bili
// domain (event publisher) used to open their own clients; after the merge
// they share one connection pool.
package redis

import (
	"context"
	"log/slog"
	"strings"
	"time"

	goredis "github.com/redis/go-redis/v9"
)

// New returns a shared Redis client, or nil only when no URL is configured /
// the URL is invalid. A failed boot ping no longer discards the client: the
// go-redis client reconnects automatically on later commands, so a Redis that
// was still starting (or briefly down at boot) recovers without restarting
// app-user. Callers treat command errors as cache misses / fail-open, and the
// readiness probe reports the degraded state.
func New(url string) goredis.UniversalClient {
	if strings.TrimSpace(url) == "" {
		return nil
	}
	opts, err := goredis.ParseURL(url)
	if err != nil {
		slog.Warn("[REDIS] invalid url - running without Redis", "err", err)
		return nil
	}
	client := goredis.NewClient(opts)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := client.Ping(ctx).Err(); err != nil {
		slog.Warn("[REDIS] not reachable at boot - will retry on use", "err", err)
	}
	return client
}
