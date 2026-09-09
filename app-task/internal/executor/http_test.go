package executor

import (
	"context"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func mustHTTP(t *testing.T, opts HTTPOptions) *HTTPExecutor {
	t.Helper()
	return NewHTTPExecutor(opts)
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

// CA 惰性加载：ca_file 指向不存在的文件时，构造不报错，首次派发报 TLS setup
// 错误（retryable）；补上合法 CA 文件后同一次部署内自愈（失败态不缓存）。
func TestCAFileLazyLoadAndSelfHeal(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	caPath := filepath.Join(t.TempDir(), "ca.crt")
	e := mustHTTP(t, HTTPOptions{Timeout: 5 * time.Second, InsecureSkipVerify: true, CAFile: caPath})
	h := e.Handler()
	task := Task{ID: "j1", Meta: map[string]any{"executor_url": srv.URL}}

	err := h(context.Background(), task)
	if err == nil || !strings.Contains(err.Error(), "CA file") || !strings.Contains(err.Error(), "retry") {
		t.Fatalf("missing CA file must yield retryable TLS setup error, got %v", err)
	}

	// 补上 CA 文件（PEM 编码的 httptest 服务端证书即可通过解析；InsecureSkipVerify=true
	// 时 RootCAs 不参与校验，这里只验证「文件出现 → client 构建成功 → 派发自愈」）
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw})
	if err := os.WriteFile(caPath, certPEM, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := h(context.Background(), task); err != nil {
		t.Fatalf("after CA file appears the executor must self-heal, got %v", err)
	}
}

// ca_file 内容不是合法 PEM → TLS setup 错误，且不是 InsecureSkipVerify 的静默降级。
func TestCAFileInvalidPEMRejected(t *testing.T) {
	caPath := filepath.Join(t.TempDir(), "ca.crt")
	if err := os.WriteFile(caPath, []byte("not a pem"), 0o600); err != nil {
		t.Fatal(err)
	}
	e := mustHTTP(t, HTTPOptions{Timeout: time.Second, CAFile: caPath})
	task := Task{ID: "j", Meta: map[string]any{"executor_url": "https://127.0.0.1:1/x"}}
	err := e.Handler()(context.Background(), task)
	if err == nil || !strings.Contains(err.Error(), "CA certificate") {
		t.Fatalf("err = %v, want invalid CA error", err)
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
