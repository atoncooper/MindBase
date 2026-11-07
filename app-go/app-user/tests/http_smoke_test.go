package tests

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"app-user/internal/config"
	authrouter "app-user/internal/router/auth"
	bilirouter "app-user/internal/router/bili"
	settingsrouter "app-user/internal/router/settings"

	"github.com/gin-gonic/gin"
)

func newEngines() (*gin.Engine, *gin.Engine, *gin.Engine) {
	return authrouter.New(authrouter.Deps{Cfg: &config.AuthConfig{}}),
		bilirouter.New(bilirouter.Deps{Cfg: &config.BiliConfig{}}),
		settingsrouter.New(settingsrouter.Deps{Cfg: &config.SettingsConfig{}})
}

func doGET(t *testing.T, e *gin.Engine, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	w := httptest.NewRecorder()
	e.ServeHTTP(w, req)
	return w
}

// TestHealthEndpoints: every listener keeps its own /health semantics.
func TestHealthEndpoints(t *testing.T) {
	authEngine, biliEngine, settingsEngine := newEngines()
	for name, e := range map[string]*gin.Engine{"auth": authEngine, "bili": biliEngine, "settings": settingsEngine} {
		if w := doGET(t, e, "/health"); w.Code != http.StatusOK {
			t.Errorf("%s /health = %d, want 200 (body %s)", name, w.Code, w.Body.String())
		}
	}
}

// TestIdentityGuards: user-facing routes still require the gateway-injected
// X-Uid (the process split used to be irrelevant here; now it is one binary).
func TestIdentityGuards(t *testing.T) {
	_, biliEngine, settingsEngine := newEngines()
	if w := doGET(t, biliEngine, "/favorites/v2/list"); w.Code != http.StatusUnauthorized {
		t.Errorf("bili favorites without X-Uid = %d, want 401", w.Code)
	}
	if w := doGET(t, settingsEngine, "/preferences"); w.Code != http.StatusUnauthorized {
		t.Errorf("settings preferences without X-Uid = %d, want 401", w.Code)
	}
}

// TestAuthHealthDegraded: the auth readiness probe must surface Redis/MySQL
// dependency failures instead of always answering 200.
func TestAuthHealthDegraded(t *testing.T) {
	e := authrouter.New(authrouter.Deps{
		Cfg:    &config.AuthConfig{},
		Health: func(ctx context.Context) error { return errors.New("redis down") },
	})
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	w := httptest.NewRecorder()
	e.ServeHTTP(w, req)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("/health = %d, want 503 (body %s)", w.Code, w.Body.String())
	}
}

// TestAuthHealthRedisDegraded: Redis is optional (cache/limiter degradation),
// so a Redis outage is visible in the body but must not fail readiness.
func TestAuthHealthRedisDegraded(t *testing.T) {
	e := authrouter.New(authrouter.Deps{
		Cfg:         &config.AuthConfig{},
		Health:      func(ctx context.Context) error { return nil },
		RedisHealth: func(ctx context.Context) error { return errors.New("redis down") },
	})
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	w := httptest.NewRecorder()
	e.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("/health = %d, want 200 (body %s)", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "down") {
		t.Fatalf("body does not report redis down: %s", w.Body.String())
	}
}

// TestMetricsEndpoints: latency histograms are exposed on the auth listener
// for a scraper (Prometheus) and for quick local percentile checks.
func TestMetricsEndpoints(t *testing.T) {
	e := authrouter.New(authrouter.Deps{Cfg: &config.AuthConfig{}})
	w := doGET(t, e, "/metrics")
	if w.Code != http.StatusOK {
		t.Fatalf("/metrics = %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "appuser_http_request_duration_seconds") {
		t.Fatalf("/metrics body missing histogram: %s", w.Body.String())
	}
	w = doGET(t, e, "/debug/latency")
	if w.Code != http.StatusOK {
		t.Fatalf("/debug/latency = %d", w.Code)
	}
}
