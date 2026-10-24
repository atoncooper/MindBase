// Guard tests for the app-admin-only content preview endpoint (plan/1.0.16
// disclosure follow-up): the shared-secret gate must fail closed when the
// token is unset and reject wrong tokens — both BEFORE any service/DB touch.
package router

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"app-cloud/internal/config"
	"app-cloud/internal/service"

	"github.com/gin-gonic/gin"
)

func newReviewRouter(t *testing.T, token string) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	cfg := &config.Config{}
	cfg.AdminReview.Token = token
	return New(Deps{Cfg: cfg, Share: service.NewShareService(nil, nil, 0)})
}

func reviewRequest(e *gin.Engine, token string) int {
	req := httptest.NewRequest(http.MethodGet,
		"/internal/cloud/admin-review/shares/1/files/1/preview", nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	return rec.Code
}

func TestAdminReviewFailsClosedWithoutToken(t *testing.T) {
	e := newReviewRouter(t, "")
	if got := reviewRequest(e, "anything"); got != http.StatusServiceUnavailable {
		t.Fatalf("empty configured token must disable the endpoint (503), got %d", got)
	}
}

func TestAdminReviewRejectsWrongToken(t *testing.T) {
	e := newReviewRouter(t, "secret-token")
	if got := reviewRequest(e, "wrong"); got != http.StatusUnauthorized {
		t.Fatalf("wrong bearer token must be 401, got %d", got)
	}
	if got := reviewRequest(e, ""); got != http.StatusUnauthorized {
		t.Fatalf("missing bearer token must be 401, got %d", got)
	}
	// Correct token reaches the service layer — a nil-backed service in this
	// test must therefore NOT be hit; we only assert the gate accepted it by
	// expecting the share-not-found uniform 404 from the (nil-db) service.
	if got := reviewRequest(e, "secret-token"); got != http.StatusInternalServerError &&
		got != http.StatusNotFound {
		t.Fatalf("valid token should pass the gate, got %d", got)
	}
}
