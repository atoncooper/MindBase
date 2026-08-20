package executor

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func mustHTTP(t *testing.T, opts HTTPOptions) *HTTPExecutor {
	t.Helper()
	e, err := NewHTTPExecutor(opts)
	if err != nil {
		t.Fatal(err)
	}
	return e
}

// https:// executor URL: TLS is transparent (httptest.NewTLSServer has a
// self-signed cert, so InsecureSkipVerify must be on for this test).
func TestHTTPSExecutor(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	e := mustHTTP(t, HTTPOptions{Timeout: 5 * time.Second, InsecureSkipVerify: true})
	task := Task{ID: "j1", Meta: map[string]any{"executor_url": srv.URL, "async": false}}
	if err := e.Handler()(context.Background(), task); err != nil {
		t.Fatalf("https executor: %v", err)
	}
}

// 默认(严格校验)打自签名 https 必须失败——证书校验未被意外关闭。
func TestHTTPSDefaultRejectsSelfSigned(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	e := mustHTTP(t, HTTPOptions{Timeout: 5 * time.Second})
	task := Task{ID: "j1", Meta: map[string]any{"executor_url": srv.URL}}
	err := e.Handler()(context.Background(), task)
	if err == nil || !strings.Contains(err.Error(), "certificate") {
		t.Fatalf("err = %v, want certificate validation error", err)
	}
}

// executor_url scheme 白名单：http/https 通过，其他拒绝。
func TestExecutorURLValidation(t *testing.T) {
	e := mustHTTP(t, HTTPOptions{Timeout: time.Second})
	h := e.Handler()

	for _, u := range []string{"", "ftp://exec:21/x", "file:///etc/passwd", "not-a-url"} {
		task := Task{ID: "j", Meta: map[string]any{"executor_url": u}}
		if err := h(context.Background(), task); err == nil {
			t.Fatalf("executor_url %q must be rejected", u)
		}
	}

	// 合法 URL 但不通 → 网络错误（retryable），不是 scheme 错误
	task := Task{ID: "j", Meta: map[string]any{"executor_url": "http://127.0.0.1:1/x"}}
	if err := h(context.Background(), task); err == nil {
		t.Fatal("unreachable executor must error")
	}
}
