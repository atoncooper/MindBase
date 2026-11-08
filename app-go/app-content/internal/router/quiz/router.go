// Package router wires the quiz domain onto the shared HTTP engine. Security
// primitives live in internal/middleware; request DTOs in internal/dto/quiz.
package router

import (
	"encoding/json"
	"net/http"

	"app-content/internal/middleware"
	"app-content/internal/service/quiz"

	"github.com/gin-gonic/gin"
)

// Deps carries the wired services into the route registrations.
type Deps struct {
	Quiz           *service.Store
	InternalAPIKey string
}

// Register mounts the quiz routes on the shared engine owned by the
// composition root. It never creates an engine or listener of its own.
func Register(e *gin.Engine, d Deps) {
	registerQuiz(e, d.Quiz)
	registerInternalQuiz(e, d.Quiz, d.InternalAPIKey)
	registerTaskQuiz(e, d.Quiz)
}

func apiErr(c *gin.Context, status int, detail string) {
	middleware.Error(c, status, detail)
}

func currentUID(c *gin.Context) (int64, bool) {
	return middleware.CurrentUID(c)
}

// renderTyped converts a service payload into its typed wire DTO. The DTO is
// the HTTP contract; any decode failure is a server bug (500).
func renderTyped[T any](c *gin.Context, payload map[string]interface{}) {
	raw, err := json.Marshal(payload)
	if err == nil {
		var out T
		if err = json.Unmarshal(raw, &out); err == nil {
			c.JSON(http.StatusOK, out)
			return
		}
	}
	c.Error(err) //nolint:errcheck // recorded for the access log
	apiErr(c, http.StatusInternalServerError, "响应序列化失败")
}
