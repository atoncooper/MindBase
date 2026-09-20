// Package serve provides the HTTP hardening middlewares for the
// streamable-http MCP endpoint:
//
//	RequestID  — X-Request-Id trace (honors inbound, echoes, into ctx)
//	AccessLog  — one structured line per request, leveled by status
//	BodyCap    — request body size cap (413)
//	RateLimit  — token bucket (429 + Retry-After)
//	Inflight   — concurrent request cap (503 + Retry-After)
//	Auth       — bearer token + Origin validation (401/403)
//
// Threat model: the endpoint is loopback-bound but still a local attack
// surface (any local process, and browsers via DNS rebinding — the MCP spec
// mandates Origin validation for streamable-http servers). The middlewares
// assume the caller already bound the listener to loopback; they add auth
// and resource bounds on top. Only /mcp goes through the full chain; /health
// stays an unauthenticated probe.
package serve

import (
	"crypto/subtle"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"app-board-mcp/internal/identity"
	"app-board-mcp/internal/logger"

	"github.com/google/uuid"
	"golang.org/x/time/rate"
)

// Chain composes middlewares so Chain(a, b, c)(h) runs a(b(c(h))).
func Chain(mws ...func(http.Handler) http.Handler) func(http.Handler) http.Handler {
	return func(h http.Handler) http.Handler {
		for i := len(mws) - 1; i >= 0; i-- {
			h = mws[i](h)
		}
		return h
	}
}

// writeDetail answers with the repo's uniform error envelope.
func writeDetail(w http.ResponseWriter, status int, detail string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"detail": detail})
}

// RequestID honors an inbound X-Request-Id (generated otherwise, capped at 64
// chars), echoes it on the response, and injects it into the request context
// so every log line of this request — access log, tool calls and upstream
// calls — shares one trace id.
func RequestID() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id := strings.TrimSpace(r.Header.Get("X-Request-Id"))
			if id == "" {
				id = strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
			}
			if len(id) > 64 {
				id = id[:64]
			}
			w.Header().Set("X-Request-Id", id)
			next.ServeHTTP(w, r.WithContext(logger.IntoContext(r.Context(), id)))
		})
	}
}

// statusRecorder captures status code and body size for the access log.
type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Write(b []byte) (int, error) {
	n, err := r.ResponseWriter.Write(b)
	r.bytes += n
	return n, err
}

// AccessLog writes one structured line per HTTP request (module=http),
// leveled by status: >=500 error, >=400 warn, else info.
func AccessLog() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
			next.ServeHTTP(rec, r)

			attrs := []slog.Attr{
				slog.String("module", "http"),
				slog.String("method", r.Method),
				slog.String("path", r.URL.Path),
				slog.Int("status", rec.status),
				slog.Int("size", rec.bytes),
				slog.Duration("latency", time.Since(start)),
				// request_id is injected by the logger's context handler from
				// the request ctx (set by RequestID) — no explicit attr here.
			}
			level := slog.LevelInfo
			switch {
			case rec.status >= 500:
				level = slog.LevelError
			case rec.status >= 400:
				level = slog.LevelWarn
			}
			slog.LogAttrs(r.Context(), level, "[BOARDMCP] http request", attrs...)
		})
	}
}

// BodyCap caps the request body (Content-Length pre-check plus a hard
// MaxBytesReader). The MCP endpoint carries documents up to app-board's 8MB
// limit, so the cap sits slightly above it.
func BodyCap(max int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.ContentLength > max {
				writeDetail(w, http.StatusRequestEntityTooLarge, "request body too large")
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, max)
			next.ServeHTTP(w, r)
		})
	}
}

// RateLimit applies a token bucket. A single global limiter is enough for a
// loopbound single-user server; per-client keys would be theater.
func RateLimit(l *rate.Limiter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !l.Allow() {
				w.Header().Set("Retry-After", "1")
				writeDetail(w, http.StatusTooManyRequests, "rate limit exceeded, retry later")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// Inflight caps concurrent requests (non-blocking): over the cap answers 503
// instead of queueing, bounding worst-case fan-out toward app-board regardless
// of request shape (list_boards search fans out up to 10 upstream calls).
func Inflight(max int) func(http.Handler) http.Handler {
	sem := make(chan struct{}, max)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
				next.ServeHTTP(w, r)
			default:
				w.Header().Set("Retry-After", "1")
				writeDetail(w, http.StatusServiceUnavailable, "server busy, retry later")
			}
		})
	}
}

// Auth enforces (1) Origin validation — browsers always send Origin, MCP
// hosts do not; rejecting unknown origins kills DNS-rebinding attempts — and
// (2) one of two credentials:
//
//   - service mode (trusted internal callers, e.g. the main-app backend):
//     header `apikey: <serviceKey>` plus a per-request `X-Uid`; the parsed uid
//     is injected into the request context and flows into every tool handler
//     and then into the upstream X-Uid. Mirrors the APISIX board_internal
//     trust model — key holders are trusted to pick the uid.
//   - bearer mode (single-user MCP hosts): `Authorization: Bearer <token>`,
//     constant-time compared; the acting uid is the configured default.
//
// Either serviceKey or token may be empty (that mode is then unavailable);
// at least one must be set — main refuses to start otherwise.
func Auth(token, serviceKey string, allowedOrigins []string) func(http.Handler) http.Handler {
	allowed := make(map[string]bool, len(allowedOrigins))
	for _, o := range allowedOrigins {
		allowed[strings.TrimSpace(o)] = true
	}
	bearer := "Bearer " + token
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if origin := strings.TrimSpace(r.Header.Get("Origin")); origin != "" && !allowed[origin] {
				writeDetail(w, http.StatusForbidden, "origin not allowed")
				return
			}

			// Service mode takes precedence when the caller presents the
			// apikey header — a wrong key must not fall through to bearer.
			if presented := strings.TrimSpace(r.Header.Get("apikey")); presented != "" {
				if subtle.ConstantTimeCompare([]byte(presented), []byte(serviceKey)) != 1 || serviceKey == "" {
					writeDetail(w, http.StatusUnauthorized, "invalid service apikey")
					return
				}
				uid, err := strconv.ParseInt(strings.TrimSpace(r.Header.Get("X-Uid")), 10, 64)
				if err != nil || uid <= 0 {
					writeDetail(w, http.StatusUnauthorized, "service mode requires a valid X-Uid header")
					return
				}
				next.ServeHTTP(w, r.WithContext(identity.IntoContext(r.Context(), uid)))
				return
			}

			provided := strings.TrimSpace(r.Header.Get("Authorization"))
			if provided == "" {
				w.Header().Set("WWW-Authenticate", `Bearer realm="app-board-mcp"`)
				writeDetail(w, http.StatusUnauthorized, "missing bearer token")
				return
			}
			if subtle.ConstantTimeCompare([]byte(provided), []byte(bearer)) != 1 || token == "" {
				writeDetail(w, http.StatusUnauthorized, "invalid bearer token")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
