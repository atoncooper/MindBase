// Package identity carries the acting board-owner uid through the request
// context. Service-mode requests (apikey + X-Uid headers, injected by the
// serve.Auth middleware) provide a per-request uid that flows into every tool
// handler and then into the upstream X-Uid header; bearer-token clients have
// no uid in ctx and fall back to the configured default.
package identity

import "context"

type contextKey struct{}

// modeKey marks how the request authenticated (service apikey vs external
// bearer token). Service mode carries a per-request uid; bearer mode acts as
// the configured fixed uid and may additionally be restricted to a tool
// allowlist (see kit.Wrap).
type modeKey struct{}

// Mode is the authentication mode of one MCP request.
type Mode int

const (
	// ModeService = trusted internal caller (apikey + per-request X-Uid).
	ModeService Mode = iota + 1
	// ModeBearer = external MCP host (Authorization: Bearer, fixed uid).
	ModeBearer
)

// IntoContext attaches the acting uid to ctx (service mode).

func IntoContext(ctx context.Context, uid int64) context.Context {
	return context.WithValue(ctx, contextKey{}, uid)
}

// IntoBearerContext marks ctx as authenticated by the external bearer token.
func IntoBearerContext(ctx context.Context) context.Context {
	return context.WithValue(ctx, modeKey{}, ModeBearer)
}

// ModeFromContext returns the authentication mode (ModeService when a uid is
// present, ModeBearer when explicitly marked, 0 for stdio/unauthenticated).
func ModeFromContext(ctx context.Context) Mode {
	if m, ok := ctx.Value(modeKey{}).(Mode); ok {
		return m
	}
	if _, ok := FromContext(ctx); ok {
		return ModeService
	}
	return 0
}

// FromContext returns the acting uid in ctx (ok=false when absent — bearer
// clients; handlers then fall back to the configured default uid).
func FromContext(ctx context.Context) (int64, bool) {
	if uid, ok := ctx.Value(contextKey{}).(int64); ok && uid > 0 {
		return uid, true
	}
	return 0, false
}
