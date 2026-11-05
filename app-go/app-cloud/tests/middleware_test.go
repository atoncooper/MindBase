package tests

// Middleware behaviour is exercised directly here so the onion can be
// verified without going through every route's service wiring.

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"app-cloud/internal/config"
	"app-cloud/internal/middleware"

	"github.com/gin-gonic/gin"
)

func TestRequireUIDInjectsValidatedIdentity(t *testing.T) {
	gin.SetMode(gin.TestMode)
	e := gin.New()
	e.Use(middleware.RequireUID())
	e.GET("/probe", func(c *gin.Context) { c.String(http.StatusOK, "%d", middleware.UIDFrom(c)) })

	missing := httptest.NewRecorder()
	e.ServeHTTP(missing, httptest.NewRequest(http.MethodGet, "/probe", nil))
	if missing.Code != http.StatusUnauthorized {
		t.Fatalf("missing X-Uid status = %d, want 401", missing.Code)
	}

	bad := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/probe", nil)
	req.Header.Set("X-Uid", "not-a-number")
	e.ServeHTTP(bad, req)
	if bad.Code != http.StatusUnauthorized {
		t.Fatalf("invalid X-Uid status = %d, want 401", bad.Code)
	}

	ok := httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/probe", nil)
	req.Header.Set("X-Uid", "42")
	e.ServeHTTP(ok, req)
	if ok.Code != http.StatusOK || ok.Body.String() != "42" {
		t.Fatalf("valid X-Uid = %d %q, want 200 42", ok.Code, ok.Body.String())
	}
}

func TestRequireInternalKeyFailsClosed(t *testing.T) {
	gin.SetMode(gin.TestMode)
	e := gin.New()
	e.Use(middleware.RequireInternalKey(nil))
	e.GET("/probe", func(c *gin.Context) { c.Status(http.StatusOK) })

	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/probe", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("unconfigured internal key status = %d, want 503", rec.Code)
	}

	e2 := gin.New()
	e2.Use(middleware.RequireInternalKey(&config.Config{Internal: config.InternalConfig{APIKey: "secret"}}))
	e2.GET("/probe", func(c *gin.Context) { c.Status(http.StatusOK) })
	rec = httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/probe", nil)
	req.Header.Set("apikey", "wrong")
	e2.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong internal key status = %d, want 401", rec.Code)
	}
}

func TestRequireCapabilityIsRouteLevelGate(t *testing.T) {
	gin.SetMode(gin.TestMode)
	e := gin.New()
	e.GET("/probe", middleware.RequireCapability(false, "capability unavailable"), func(c *gin.Context) {
		c.Status(http.StatusOK)
	})
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/probe", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("unavailable capability status = %d, want 503", rec.Code)
	}
}
