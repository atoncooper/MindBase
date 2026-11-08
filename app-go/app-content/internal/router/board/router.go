// Package router registers the board domain on the process-wide Gin engine.
// Auth, request-id, CORS, headers and body caps come from internal/middleware
// (applied once by the composition root); this package only registers routes
// and maps DTOs.
package router

import (
	boardsvc "app-content/internal/service/board"

	"github.com/gin-gonic/gin"
)

// Register mounts the board routes on the shared engine owned by the
// composition root. It never creates an engine or listener of its own.
//
// Two surfaces share the handlers: /board/* trusts the gateway-injected X-Uid
// (user traffic), while /internal/board/* additionally requires the service
// token injected by APISIX (M2M callers such as app-board-mcp) — defence in
// depth so a key-auth caller cannot reach the user surface directly.
func Register(e *gin.Engine, svc *boardsvc.BoardService, internalAPIKey string) {
	r := &Router{svc: svc}
	r.registerRoutes(e)
	registerInternalRoutes(e, svc, internalAPIKey)
}

type Router struct {
	svc *boardsvc.BoardService
}

func (r *Router) registerRoutes(e *gin.Engine) {
	registerBoardRoutes(e, r.svc)
}
