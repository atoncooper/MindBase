package tests

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"app-content/internal/middleware"

	"github.com/gin-gonic/gin"
)

func newMiddlewareEngine(token string) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	e := gin.New()
	e.Use(middleware.InternalAuth(token))
	e.GET("/internal/x", func(c *gin.Context) { c.JSON(200, gin.H{"ok": true}) })
	return e
}

func TestInternalAuthFailClosedWhenUnconfigured(t *testing.T) {
	e := newMiddlewareEngine("")
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/internal/x", nil)
	req.Header.Set("X-Internal-Key", "anything")
	e.ServeHTTP(w, req)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 (fail-closed)", w.Code)
	}
}

func TestInternalAuthRejectsWrongKey(t *testing.T) {
	e := newMiddlewareEngine("s3cret")
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/internal/x", nil)
	req.Header.Set("X-Internal-Key", "wrong")
	e.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}

	w = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/internal/x", nil)
	req.Header.Set("X-Internal-Key", "s3cret")
	e.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
}

// DTO validation reaches the handler only after binding tags accept the body.
func TestBoardDTOValidationRejectsInvalidKind(t *testing.T) {
	e := newBoardEngine(t)
	req := reqWithHeader(http.MethodPost, "/board/boards", stringsReader(`{"kind":"neon4j","title":"x"}`), "X-Uid", "7")
	w := httptest.NewRecorder()
	e.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for invalid kind", w.Code)
	}
}

func stringsReader(s string) *strings.Reader { return strings.NewReader(s) }
