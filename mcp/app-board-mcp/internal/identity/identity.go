// Package identity carries the acting board-owner uid through the request
// context. Service-mode requests (apikey + X-Uid headers, injected by the
// serve.Auth middleware) provide a per-request uid that flows into every tool
// handler and then into the upstream X-Uid header; bearer-token clients have
// no uid in ctx and fall back to the configured default.
package identity

import "context"

type contextKey struct{}

// IntoContext attaches the acting uid to ctx.
func IntoContext(ctx context.Context, uid int64) context.Context {
	return context.WithValue(ctx, contextKey{}, uid)
}

// FromContext returns the acting uid in ctx (ok=false when absent — bearer
// clients; handlers then fall back to the configured default uid).
func FromContext(ctx context.Context) (int64, bool) {
	if uid, ok := ctx.Value(contextKey{}).(int64); ok && uid > 0 {
		return uid, true
	}
	return 0, false
}
