package tests

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"app-content/internal/config"
	"app-content/internal/middleware"
	boardmodel "app-content/internal/model/board"

	boardrepo "app-content/internal/repo/board"
	boardrouter "app-content/internal/router/board"
	boardsvc "app-content/internal/service/board"
	"github.com/gin-gonic/gin"
)

// boardFakeMeta is an inert MetaStore: the middleware-level tests below never reach
// the service, and an accidental call fails loudly instead of touching a DB.
type boardFakeMeta struct{}

func (boardFakeMeta) GetByUUID(context.Context, int64, string) (*boardmodel.Board, error) {
	return nil, nil
}
func (boardFakeMeta) List(context.Context, int64, string, int, int) ([]boardmodel.Board, int64, error) {
	return nil, 0, nil
}
func (boardFakeMeta) TitleExists(context.Context, int64, string, string, string) (bool, error) {
	return false, nil
}
func (boardFakeMeta) Create(context.Context, *boardmodel.Board) error { return nil }
func (boardFakeMeta) UpdatePin(context.Context, int64, string, bool) (*boardmodel.Board, error) {
	return nil, nil
}
func (boardFakeMeta) SoftDelete(context.Context, int64, string) error { return nil }
func (boardFakeMeta) BumpVersion(context.Context, int64, string, int64, *string, *bool) (int64, error) {
	return 0, nil
}

// boardFakeDocs is an inert DocStore (same rationale as boardFakeMeta).
type boardFakeDocs struct{}

func (boardFakeDocs) ConditionalWrite(context.Context, string, int64, string) error { return nil }
func (boardFakeDocs) Get(context.Context, string) (*boardrepo.BoardDocument, error) {
	return nil, nil
}
func (boardFakeDocs) Restore(context.Context, string, int64, *boardrepo.BoardDocument) error {
	return nil
}

func newBoardEngine(t *testing.T) http.Handler {
	t.Helper()
	opts := middleware.Options{
		CORS: config.CORSConfig{AllowOrigins: []string{"http://localhost:3000"}},
		Headers: config.HeadersConfig{
			ContentTypeOptions: "nosniff", FrameOptions: "DENY",
			ReferrerPolicy: "no-referrer", PermissionsPolicy: "camera=()",
			HSTSEnabled: true, HSTSMaxAgeSeconds: 31536000,
		},
	}
	e := gin.New()
	opts.Apply(e)
	boardrouter.Register(e, boardsvc.NewBoardService(boardFakeMeta{}, boardFakeDocs{}, nil), "test-internal-key")
	installFallbacks(e)
	return e
}

func TestBoardRouterAuthContract(t *testing.T) {
	e := newBoardEngine(t)
	cases := []struct {
		name string
		req  *http.Request
		want int
	}{
		{"missing X-Uid", httptest.NewRequest(http.MethodGet, "/board/boards", nil), http.StatusUnauthorized},
		{"non-numeric X-Uid", reqWithHeader(http.MethodGet, "/board/boards", nil, "X-Uid", "abc"), http.StatusUnauthorized},
		{"zero X-Uid", reqWithHeader(http.MethodGet, "/board/boards", nil, "X-Uid", "0"), http.StatusUnauthorized},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			e.ServeHTTP(w, tc.req)
			if w.Code != tc.want {
				t.Fatalf("status = %d, want %d (body %s)", w.Code, tc.want, w.Body.String())
			}
		})
	}
}

// The M2M surface must require BOTH the gateway key-auth token (X-Internal-Key)
// and the acting user identity — the same defence-in-depth note/quiz have.
func TestBoardInternalRoutesRequireServiceToken(t *testing.T) {
	e := newBoardEngine(t)
	do := func(setup func(*http.Request)) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/internal/board/boards", nil)
		setup(req)
		w := httptest.NewRecorder()
		e.ServeHTTP(w, req)
		return w
	}
	withKey := func(req *http.Request, key string) {
		if key != "" {
			req.Header.Set("X-Internal-Key", key)
		}
	}
	if w := do(func(r *http.Request) {}); w.Code != http.StatusUnauthorized {
		t.Fatalf("missing key status = %d, want 401", w.Code)
	}
	if w := do(func(r *http.Request) { withKey(r, "wrong") }); w.Code != http.StatusUnauthorized {
		t.Fatalf("wrong key status = %d, want 401", w.Code)
	}
	if w := do(func(r *http.Request) { withKey(r, "test-internal-key") }); w.Code != http.StatusUnauthorized {
		t.Fatalf("missing X-Uid status = %d, want 401", w.Code)
	}
	w := do(func(r *http.Request) {
		withKey(r, "test-internal-key")
		r.Header.Set("X-Uid", "7")
	})
	if w.Code != http.StatusOK {
		t.Fatalf("authorized status = %d, want 200 (body %s)", w.Code, w.Body.String())
	}
}

func TestBoardRouterSecurityHeadersAndRequestID(t *testing.T) {
	e := newBoardEngine(t)
	req := reqWithHeader(http.MethodGet, "/board/boards", nil, "X-Request-Id", strings.Repeat("a", 100))
	w := httptest.NewRecorder()
	e.ServeHTTP(w, req)

	// No X-Uid → 401 (still exercises the middleware chain + headers).
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d", w.Code)
	}
	for k, want := range map[string]string{
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options":        "DENY",
		"Cache-Control":          "no-store",
	} {
		if got := w.Header().Get(k); got != want {
			t.Fatalf("%s = %q, want %q", k, got, want)
		}
	}
	if got := w.Header().Get("X-Request-Id"); len(got) != 64 {
		t.Fatalf("X-Request-Id length = %d, want 64 (truncated)", len(got))
	}
}

func TestBoardRouterCORS(t *testing.T) {
	e := newBoardEngine(t)
	preflight := func(origin string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodOptions, "/board/boards", nil)
		req.Header.Set("Origin", origin)
		w := httptest.NewRecorder()
		e.ServeHTTP(w, req)
		return w
	}

	allowed := preflight("http://localhost:3000")
	if allowed.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d", allowed.Code)
	}
	if got := allowed.Header().Get("Access-Control-Allow-Origin"); got != "http://localhost:3000" {
		t.Fatalf("ACAO = %q", got)
	}

	denied := preflight("https://evil.example")
	if got := denied.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("disallowed origin reflected: %q", got)
	}
}

func TestBoardRouterRejectsOversizedBody(t *testing.T) {
	e := newBoardEngine(t)
	body := `{"title":"x","content":"` + strings.Repeat("a", 9<<20+1024) + `"}`
	req := reqWithHeader(http.MethodPost, "/board/boards", strings.NewReader(body), "X-Uid", "7")
	w := httptest.NewRecorder()
	e.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest && w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized body status = %d (want 400/413)", w.Code)
	}
}

func reqWithHeader(method, target string, body *strings.Reader, k, v string) *http.Request {
	var r *http.Request
	if body == nil {
		r = httptest.NewRequest(method, target, nil)
	} else {
		r = httptest.NewRequest(method, target, body)
	}
	r.Header.Set(k, v)
	return r
}
