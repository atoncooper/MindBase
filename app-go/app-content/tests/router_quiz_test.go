package tests

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"app-content/internal/config"
	"app-content/internal/middleware"
	quizrouter "app-content/internal/router/quiz"
	quizsvc "app-content/internal/service/quiz"

	"github.com/gin-gonic/gin"
)

func newQuizEngine(t *testing.T) http.Handler {
	t.Helper()
	opts := middleware.Options{CORS: config.CORSConfig{AllowOrigins: []string{"http://localhost:3000"}}}
	e := gin.New()
	opts.Apply(e)
	quizrouter.Register(e, quizrouter.Deps{Quiz: quizsvc.New(nil, nil), InternalAPIKey: "test-internal-key"})
	installFallbacks(e)
	return e
}

func TestQuizRouterProtectedEndpointsRequireXUid(t *testing.T) {
	e := newQuizEngine(t)
	for _, target := range []string{"/quiz/history", "/quiz/wrong-answers", "/quiz/export", "/internal/quiz/wrong-answers"} {
		req := httptest.NewRequest(http.MethodGet, target, nil)
		w := httptest.NewRecorder()
		e.ServeHTTP(w, req)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("%s status = %d, want 401", target, w.Code)
		}
	}
}

func TestQuizRouterInternalRejectsUIDMismatch(t *testing.T) {
	e := newQuizEngine(t)
	// The body uid disagrees with the gateway identity → 403 before any store
	// access (works with a nil DB/Mongo, proving the check is in the handler).
	body := strings.NewReader(`{"uid":2,"task_id":"t1","prompt":"p","question_count":3}`)
	req := httptest.NewRequest(http.MethodPost, "/internal/quiz/tasks", body)
	req.Header.Set("X-Uid", "1")
	req.Header.Set("X-Internal-Key", "test-internal-key")
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	e.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (body %s)", w.Code, w.Body.String())
	}
}

func TestQuizRouterRejectsOversizedBody(t *testing.T) {
	e := newQuizEngine(t)
	body := strings.NewReader(`{"uid":1,"questions":["` + strings.Repeat("a", 4<<20+1024) + `"]}`)
	req := httptest.NewRequest(http.MethodPost, "/internal/quiz/tasks", body)
	req.Header.Set("X-Uid", "1")
	req.Header.Set("X-Internal-Key", "test-internal-key")
	w := httptest.NewRecorder()
	e.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest && w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized body status = %d (want 400/413)", w.Code)
	}
}

func TestQuizRouterUnknownRouteIsJSON(t *testing.T) {
	e := newQuizEngine(t)
	w := httptest.NewRecorder()
	e.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/no-such-route", nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "detail") {
		t.Fatalf("body %q is not the JSON detail envelope", w.Body.String())
	}
}
