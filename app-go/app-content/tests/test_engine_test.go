package tests

import (
	"app-content/internal/middleware"

	"github.com/gin-gonic/gin"
)

// installFallbacks mirrors the composition root's 404/405 envelope on an
// isolated test engine (production installs them in bootstrap.mountSystem).
func installFallbacks(e *gin.Engine) {
	e.HandleMethodNotAllowed = true
	e.NoRoute(middleware.JSONNotFound)
	e.NoMethod(middleware.JSONMethodNotAllowed)
}
