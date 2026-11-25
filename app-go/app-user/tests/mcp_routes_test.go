package tests

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"app-user/internal/config"
	settingsrouter "app-user/internal/router/settings"
)

// The per-user MCP surface lives in the settings domain: identity is the
// gateway-injected X-Uid, and a missing service (feature wired off) must be a
// clean 503 — never a 200 with an empty list that looks like "no connections".
func TestMCPRoutesRequireIdentity(t *testing.T) {
	e := settingsrouter.New(settingsrouter.Deps{Cfg: &config.SettingsConfig{}})
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/settings/mcp/servers"},
		{http.MethodPost, "/settings/mcp/servers"},
		{http.MethodPatch, "/settings/mcp/servers/1"},
		{http.MethodDelete, "/settings/mcp/servers/1"},
	} {
		req := httptest.NewRequest(tc.method, tc.path, nil)
		w := httptest.NewRecorder()
		e.ServeHTTP(w, req)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s without X-Uid = %d, want 401 (body %s)", tc.method, tc.path, w.Code, w.Body.String())
		}
	}
}

func TestMCPRoutesUnavailableWithoutService(t *testing.T) {
	e := settingsrouter.New(settingsrouter.Deps{Cfg: &config.SettingsConfig{}})
	req := httptest.NewRequest(http.MethodGet, "/settings/mcp/servers", nil)
	req.Header.Set("X-Uid", "1")
	w := httptest.NewRecorder()
	e.ServeHTTP(w, req)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("GET /settings/mcp/servers with no service = %d, want 503 (body %s)", w.Code, w.Body.String())
	}
}

// The internal M2M face must not be reachable without the shared key.
func TestMCPInternalFaceRequiresKey(t *testing.T) {
	e := settingsrouter.New(settingsrouter.Deps{Cfg: &config.SettingsConfig{}, InternalAPIKey: "secret-key"})
	req := httptest.NewRequest(http.MethodGet, "/internal/settings/mcp/1", nil)
	w := httptest.NewRecorder()
	e.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized && w.Code != http.StatusForbidden {
		t.Fatalf("internal MCP face without apikey = %d, want 401/403 (body %s)", w.Code, w.Body.String())
	}
}
