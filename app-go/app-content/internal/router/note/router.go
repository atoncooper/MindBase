// Package router wires the note domain onto the shared HTTP engine. Security
// primitives live in internal/middleware; DTOs live in internal/dto/note.
package router

import (
	"app-content/internal/middleware"
	"app-content/internal/service/note"

	"github.com/gin-gonic/gin"
)

// Deps carries the wired services into the route registrations.
type Deps struct {
	Notes          *service.NoteService
	InternalAPIKey string
}

// Register mounts the note routes on the shared engine owned by the
// composition root. It never creates an engine or listener of its own.
func Register(e *gin.Engine, d Deps) {
	registerNotes(e, d.Notes, d.InternalAPIKey)
}

// apiErr keeps the historical call-site name inside this package.
func apiErr(c *gin.Context, status int, detail string) {
	middleware.Error(c, status, detail)
}
