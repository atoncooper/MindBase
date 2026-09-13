// Request-scoped trace support: mirrors the main app's request-id middleware
// (app/main.py) — header X-Request-Id is honored when present, generated
// otherwise, and injected into EVERY log line of the request.
//
// Go/slog equivalent of loguru's contextualize: a handler wrapper that reads
// the request id from the context. Service code logs with slog.*Context(ctx, …)
// and gets request_id on every line automatically — no explicit plumbing.

package logger

import (
	"context"

	"log/slog"
)

type contextKey struct{}

// DefaultRequestID is logged when no request id is in scope (background jobs).
const DefaultRequestID = "-"

// IntoContext attaches the request id to ctx.
func IntoContext(ctx context.Context, requestID string) context.Context {
	return context.WithValue(ctx, contextKey{}, requestID)
}

// FromContext returns the request id in ctx ("-" when absent).
func FromContext(ctx context.Context) string {
	if v, ok := ctx.Value(contextKey{}).(string); ok && v != "" {
		return v
	}
	return DefaultRequestID
}

// contextHandler injects the request_id attr from ctx into every record.
type contextHandler struct {
	slog.Handler
}

func (h *contextHandler) Handle(ctx context.Context, r slog.Record) error {
	if id := FromContext(ctx); id != DefaultRequestID {
		r.AddAttrs(slog.String("request_id", id))
	}
	return h.Handler.Handle(ctx, r)
}

// NewContextHandler wraps h so every emitted line carries the request id.
func NewContextHandler(h slog.Handler) slog.Handler {
	return &contextHandler{Handler: h}
}
