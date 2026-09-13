// Package router wires the Gin engine and HTTP handlers.
//
//	router.go — engine assembly: New / middleware / health
//	board.go  — /board/* endpoints + X-Uid middleware
package router

import (
	"log/slog"
	"net/http"
	"strings"

	"app-board/internal/config"
	"app-board/internal/logger"
	"app-board/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

func New(svc *service.BoardService, cfg *config.Config) *gin.Engine {
	if !cfg.App.Debug {
		gin.SetMode(gin.ReleaseMode)
	}
	e := gin.New()
	// Trust no proxy: X-Forwarded-For is client-controlled behind the
	// gateway, so gin always uses the peer address (the APISIX pod).
	_ = e.SetTrustedProxies(nil)
	e.Use(logger.GinLogger())
	e.Use(logger.GinRecovery())
	e.Use(requestID())
	e.Use(corsMiddleware(cfg.Security.CORS.AllowOrigins))
	e.Use(bodyLimit(maxBodyBytes))

	r := &Router{svc: svc, cfg: cfg}
	r.registerRoutes(e)
	return e
}

type Router struct {
	svc *service.BoardService
	cfg *config.Config
}

// maxBodyBytes caps request bodies: one board body is capped at 8MB anyway;
// this leaves headroom for the JSON envelope (title etc.).
const maxBodyBytes = 9 << 20

// bodyLimit wraps the request body with http.MaxBytesReader.
func bodyLimit(n int64) gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.Body != nil {
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, n)
		}
		c.Next()
	}
}

func (r *Router) registerRoutes(e *gin.Engine) {
	e.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "healthy", "service": "app-board"})
	})

	registerBoardRoutes(e, r.svc)
}

// jsonError writes the uniform error envelope {"detail": ...}.
func jsonError(c *gin.Context, status int, detail string) {
	c.JSON(status, gin.H{"detail": detail})
}

// requireXUid extracts and validates the APISIX-injected X-Uid header.
// app-board never validates bili_session itself: the gateway's forward-auth
// already did. No valid X-Uid reaching this service means the request
// bypassed the gateway — refuse it.
func requireXUid() gin.HandlerFunc {
	return func(c *gin.Context) {
		raw := strings.TrimSpace(c.GetHeader("X-Uid"))
		if raw == "" {
			jsonError(c, http.StatusBadRequest, "missing X-Uid (gateway auth required)")
			c.Abort()
			return
		}
		uid, err := parsePositiveInt64(raw)
		if err != nil {
			jsonError(c, http.StatusBadRequest, "invalid X-Uid")
			c.Abort()
			return
		}
		c.Set("uid", uid)
		c.Next()
	}
}

// corsMiddleware reflects allow-listed origins. /board/* is same-origin when
// browsed through the nginx entry, but the :3000 dev/direct entry fetches the
// API base cross-origin (http://localhost), so preflights must be answered
// here — mirrors the main app's CORS allow-list (localhost/127.0.0.1:3000).
func corsMiddleware(allowOrigins []string) gin.HandlerFunc {
	allowed := make(map[string]bool, len(allowOrigins))
	for _, o := range allowOrigins {
		allowed[o] = true
	}
	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		if allowed[origin] {
			c.Header("Access-Control-Allow-Origin", origin)
			c.Header("Access-Control-Allow-Credentials", "true")
			c.Header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
			// If-Match: optimistic lock; X-Request-Id: trace propagation;
			// X-Requested-With: frontendv2 client.ts sends it on EVERY request,
			// so the preflight must allow it or the browser blocks the request.
			c.Header("Access-Control-Allow-Headers",
				"Authorization, Content-Type, If-Match, X-Request-Id, X-Requested-With")
			c.Header("Access-Control-Max-Age", "600")
			c.Header("Vary", "Origin")
		}
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}

// requestID assigns a trace id to every request, mirroring the main app's
// request-id middleware (app/main.py): an inbound X-Request-Id (e.g. from
// APISIX's request-id plugin) is honored, otherwise one is generated. The id
// is echoed on the response, attached to the request context (so every
// slog.*Context log line in this request carries it — see logger/context.go),
// and available as "request_id" in the gin context for error responses.
func requestID() gin.HandlerFunc {
	return func(c *gin.Context) {
		id := strings.TrimSpace(c.GetHeader("X-Request-Id"))
		if id == "" {
			id = strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
		}
		if len(id) > 64 { // header-length guard against abuse
			id = id[:64]
		}
		c.Set("request_id", id)
		c.Header("X-Request-Id", id)
		c.Request = c.Request.WithContext(logger.IntoContext(c.Request.Context(), id))
		c.Next()
	}
}

// internalError logs the underlying cause (with the request's trace id via
// ctx) and answers with a generic detail plus the request_id — the caller
// reports that id and ops can locate the exact log lines (mirrors the main
// app's 500 shape {"detail", "request_id"}).
func internalError(c *gin.Context, err error, context string) {
	slog.ErrorContext(c.Request.Context(), "[BOARD] request failed",
		"context", context, "err", err)
	c.JSON(http.StatusInternalServerError, gin.H{
		"detail":     "internal storage error",
		"request_id": requestIDFrom(c),
	})
}

// requestIDFrom returns the trace id assigned by the requestID middleware.
func requestIDFrom(c *gin.Context) string {
	if v, ok := c.Get("request_id"); ok {
		if id, ok := v.(string); ok {
			return id
		}
	}
	return "-"
}
