package serve

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"app-board-mcp/internal/identity"
	"app-board-mcp/internal/logger"

	"golang.org/x/time/rate"
)

const token = "test-token-123"

func okHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
}

// probe runs one request against h and returns status + body + headers.
func probe(t *testing.T, h http.Handler, headers map[string]string, body string) (int, string, http.Header) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(body))
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Code, rec.Body.String(), rec.Header()
}

func authHeaders(tok string) map[string]string {
	return map[string]string{"Authorization": "Bearer " + tok}
}

func TestAuthRequiresBearer(t *testing.T) {
	h := Auth(token, "", nil)(okHandler())

	code, body, _ := probe(t, h, nil, "{}")
	if code != http.StatusUnauthorized || !strings.Contains(body, "missing bearer token") {
		t.Errorf("no token: code=%d body=%s", code, body)
	}

	code, body, _ = probe(t, h, map[string]string{"Authorization": "Bearer wrong"}, "{}")
	if code != http.StatusUnauthorized || !strings.Contains(body, "invalid bearer token") {
		t.Errorf("wrong token: code=%d body=%s", code, body)
	}

	code, _, _ = probe(t, h, authHeaders(token), "{}")
	if code != http.StatusOK {
		t.Errorf("valid token: code=%d, want 200", code)
	}
}

func TestAuthRejectsBrowserOrigin(t *testing.T) {
	h := Auth(token, "", nil)(okHandler())

	// Browsers always send Origin (DNS rebinding defense); MCP hosts never do.
	code, _, _ := probe(t, h, map[string]string{"Origin": "http://evil.example", "Authorization": "Bearer " + token}, "{}")
	if code != http.StatusForbidden {
		t.Errorf("evil origin: code=%d, want 403", code)
	}

	code, _, _ = probe(t, h, authHeaders(token), "{}")
	if code != http.StatusOK {
		t.Errorf("no origin header: code=%d, want 200", code)
	}
}

func TestAuthAllowsListedOrigin(t *testing.T) {
	h := Auth(token, "", []string{"http://localhost:3000", "https://mind.example"})(okHandler())

	code, _, _ := probe(t, h, map[string]string{"Origin": "http://localhost:3000", "Authorization": "Bearer " + token}, "{}")
	if code != http.StatusOK {
		t.Errorf("allowlisted origin: code=%d, want 200", code)
	}
	code, _, _ = probe(t, h, map[string]string{"Origin": "https://other.example", "Authorization": "Bearer " + token}, "{}")
	if code != http.StatusForbidden {
		t.Errorf("unlisted origin: code=%d, want 403", code)
	}
}

const serviceKey = "service-key-456"

func uidHandler(t *testing.T, wantUID int64, seen *bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		uid, ok := identity.FromContext(r.Context())
		if !ok || uid != wantUID {
			t.Errorf("ctx uid = %d ok=%v, want %d", uid, ok, wantUID)
		}
		*seen = true
		w.WriteHeader(http.StatusOK)
	})
}

func TestAuthServiceMode(t *testing.T) {
	var seen bool
	h := Auth(token, serviceKey, nil)(uidHandler(t, 42, &seen))

	// Happy path: apikey + X-Uid -> per-request uid in ctx.
	code, _, _ := probe(t, h, map[string]string{"apikey": serviceKey, "X-Uid": "42"}, "{}")
	if code != http.StatusOK || !seen {
		t.Errorf("service mode happy path: code=%d seen=%v", code, seen)
	}

	// Wrong apikey must NOT fall through to bearer auth.
	seen = false
	code, _, _ = probe(t, h, map[string]string{"apikey": "wrong", "Authorization": "Bearer " + token, "X-Uid": "42"}, "{}")
	if code != http.StatusUnauthorized || seen {
		t.Errorf("wrong service key: code=%d seen=%v, want 401 and no pass-through", code, seen)
	}

	// apikey without (or with invalid) X-Uid is rejected.
	code, _, _ = probe(t, h, map[string]string{"apikey": serviceKey}, "{}")
	if code != http.StatusUnauthorized {
		t.Errorf("missing X-Uid: code=%d, want 401", code)
	}
	code, _, _ = probe(t, h, map[string]string{"apikey": serviceKey, "X-Uid": "not-a-number"}, "{}")
	if code != http.StatusUnauthorized {
		t.Errorf("non-numeric X-Uid: code=%d, want 401", code)
	}

	// Service mode unavailable when no service key is configured.
	h2 := Auth(token, "", nil)(okHandler())
	code, _, _ = probe(t, h2, map[string]string{"apikey": serviceKey, "X-Uid": "42"}, "{}")
	if code != http.StatusUnauthorized {
		t.Errorf("service key unset: code=%d, want 401", code)
	}
}

func TestRateLimit(t *testing.T) {
	// Burst 1, ~zero refill: first request passes, second must be rejected.
	l := rate.NewLimiter(rate.Limit(0.001), 1)
	h := RateLimit(l)(okHandler())

	code, _, _ := probe(t, h, nil, "{}")
	if code != http.StatusOK {
		t.Fatalf("first request: code=%d, want 200", code)
	}
	code, body, headers := probe(t, h, nil, "{}")
	if code != http.StatusTooManyRequests || !strings.Contains(body, "rate limit") {
		t.Errorf("second request: code=%d body=%s, want 429", code, body)
	}
	if headers.Get("Retry-After") == "" {
		t.Error("429 must carry Retry-After")
	}
}

func TestInflight(t *testing.T) {
	h := Inflight(1)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if release, ok := r.Context().Value(blockKey{}).(chan struct{}); ok {
			<-release // hold the single slot until the test says go
		}
		w.WriteHeader(http.StatusOK)
	}))

	release := make(chan struct{})
	ctx := withBlock(release)
	req1 := httptest.NewRequest(http.MethodPost, "/mcp", nil).WithContext(ctx)
	go h.ServeHTTP(httptest.NewRecorder(), req1)
	time.Sleep(50 * time.Millisecond) // let request 1 take the slot

	code, body, _ := probe(t, h, nil, "")
	if code != http.StatusServiceUnavailable || !strings.Contains(body, "busy") {
		t.Errorf("over-cap request: code=%d body=%s, want 503", code, body)
	}
	close(release)
}

type blockKey struct{}

func withBlock(ch chan struct{}) context.Context {
	return context.WithValue(context.Background(), blockKey{}, ch)
}

func TestBodyCap(t *testing.T) {
	h := BodyCap(16)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, err := io.ReadAll(r.Body)
		if err != nil {
			w.WriteHeader(http.StatusRequestEntityTooLarge)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))

	// Content-Length pre-check rejects before the handler runs.
	code, _, _ := probe(t, h, nil, strings.Repeat("x", 64))
	if code != http.StatusRequestEntityTooLarge {
		t.Errorf("oversized body: code=%d, want 413", code)
	}

	// Without Content-Length, MaxBytesReader trips on read.
	req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(strings.Repeat("x", 64)))
	req.ContentLength = -1 // simulate unknown length (chunked)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("oversized streamed body: code=%d, want 413", rec.Code)
	}

	// Within the cap: passes and body is intact (one byte short of the cap —
	// MaxBytesReader errors on the post-EOF probe at exactly n bytes).
	code, body, _ := probe(t, h, nil, "01234567")
	if code != http.StatusOK || body != "ok" {
		t.Errorf("within cap: code=%d body=%s", code, body)
	}
}

func TestRequestIDTraced(t *testing.T) {
	// Inbound header: honored, echoed, injected into ctx.
	h := RequestID()(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if id := logger.FromContext(r.Context()); id != "trace-9" {
			t.Errorf("ctx request_id = %q, want trace-9", id)
		}
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest(http.MethodPost, "/mcp", nil)
	req.Header.Set("X-Request-Id", "trace-9")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if got := rec.Header().Get("X-Request-Id"); got != "trace-9" {
		t.Errorf("echoed X-Request-Id = %q", got)
	}

	// Absent → generated 12-char id, still injected into ctx.
	h2 := RequestID()(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := logger.FromContext(r.Context()); len(got) != 12 || got == logger.DefaultRequestID {
			t.Errorf("ctx request_id = %q, want a generated 12-char id", got)
		}
		w.WriteHeader(http.StatusOK)
	}))
	rec2 := httptest.NewRecorder()
	h2.ServeHTTP(rec2, httptest.NewRequest(http.MethodPost, "/mcp", nil))
	if got := rec2.Header().Get("X-Request-Id"); len(got) != 12 {
		t.Errorf("generated X-Request-Id = %q, want 12 chars", got)
	}
}
