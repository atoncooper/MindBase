package tests

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"app-user/internal/router/middleware"

	"github.com/gin-gonic/gin"
)

func TestAPIKeyGuardIsFailClosed(t *testing.T) {
	gin.SetMode(gin.ReleaseMode)
	e := gin.New()
	e.Use(middleware.APIKey("secret-key"))
	e.GET("/internal/x", func(c *gin.Context) { c.JSON(200, gin.H{"ok": true}) })

	for _, tc := range []struct {
		name string
		key  string
		want int
	}{
		{"missing", "", http.StatusUnauthorized},
		{"wrong", "nope", http.StatusUnauthorized},
		{"right", "secret-key", http.StatusOK},
	} {
		req := httptest.NewRequest(http.MethodGet, "/internal/x", nil)
		if tc.key != "" {
			req.Header.Set("apikey", tc.key)
		}
		w := httptest.NewRecorder()
		e.ServeHTTP(w, req)
		if w.Code != tc.want {
			t.Errorf("%s: status=%d want %d", tc.name, w.Code, tc.want)
		}
	}
}

func TestSecurityHeadersAndRequestID(t *testing.T) {
	gin.SetMode(gin.ReleaseMode)
	e := gin.New()
	e.Use(middleware.SecurityHeaders(), middleware.RequestID())
	e.GET("/health", func(c *gin.Context) { c.JSON(200, gin.H{"ok": true}) })

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.Header.Set("X-Request-Id", "gateway-id-123")
	w := httptest.NewRecorder()
	e.ServeHTTP(w, req)
	h := w.Header()
	if h.Get("X-Content-Type-Options") != "nosniff" || h.Get("X-Frame-Options") != "DENY" || h.Get("Cache-Control") != "no-store" {
		t.Fatalf("security headers missing: %v", h)
	}
	if got := h.Get("X-Request-Id"); got != "gateway-id-123" {
		t.Fatalf("request id = %q", got)
	}
}

func TestCORSWhitelist(t *testing.T) {
	gin.SetMode(gin.ReleaseMode)
	e := gin.New()
	e.Use(middleware.CORS([]string{"https://ok.example"}))
	e.GET("/x", func(c *gin.Context) { c.JSON(200, gin.H{"ok": true}) })

	// allowed origin is echoed with credentials
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Header.Set("Origin", "https://ok.example")
	w := httptest.NewRecorder()
	e.ServeHTTP(w, req)
	if w.Header().Get("Access-Control-Allow-Origin") != "https://ok.example" || w.Header().Get("Access-Control-Allow-Credentials") != "true" {
		t.Fatalf("allowed origin not echoed: %v", w.Header())
	}

	// unknown origin gets no ACAO
	req = httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Header.Set("Origin", "https://evil.example")
	w = httptest.NewRecorder()
	e.ServeHTTP(w, req)
	if w.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("unknown origin must not be echoed")
	}

	// preflight is short-circuited
	req = httptest.NewRequest(http.MethodOptions, "/x", nil)
	w = httptest.NewRecorder()
	e.ServeHTTP(w, req)
	if w.Code != http.StatusNoContent {
		t.Fatalf("OPTIONS = %d", w.Code)
	}
}
