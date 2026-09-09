package executor

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sync"
	"time"
)

// HTTPExecutor dispatches a task to a third-party executor over HTTP(S): it
// POSTs the opaque payload verbatim to task.ExecutorURL. The scheduler never
// interprets the payload — the executor is responsible for the business.
//
// The executor_url scheme may be http:// or https:// (TLS is transparent via
// net/http). For private CAs pass CAFile (PEM); for self-signed endpoints in
// trusted networks, InsecureSkipVerify opts out of certificate validation
// (explicitly — never set it in production).
//
// CA 惰性加载：CAFile 在首次派发时才读取，失败不缓存（下次派发重试），
// 而非构造时读取——纯调度栈没有挂 app-pay 的 CA 也能正常启动，
// app-pay 侧证书晚于 app-task 就绪时委托回调也能自愈。
//
// Execution model (per task):
//   sync  (async=false): 2xx response = success; other status = failure
//   async (async=true):  202 accepted → ErrAsync (task goes running, the
//                        executor reports the outcome via the callback
//                        endpoint /internal/task/{id}/complete)
type HTTPExecutor struct {
	opts HTTPOptions

	mu     sync.Mutex
	client *http.Client // nil = TLS 配置尚未成功构建（下次派发重试）
}

// HTTPOptions configures the HTTP executor transport.
type HTTPOptions struct {
	Timeout            time.Duration // per request timeout (default 30s)
	InsecureSkipVerify bool          // opt out of TLS cert validation (self-signed only)
	CAFile             string        // PEM file with a private CA to trust
}

func NewHTTPExecutor(opts HTTPOptions) *HTTPExecutor {
	if opts.Timeout <= 0 {
		opts.Timeout = 30 * time.Second
	}
	return &HTTPExecutor{opts: opts}
}

// clientForTLS lazily builds the HTTP client. CA 文件读取/解析失败返回错误且
// 不缓存失败态，允许后续派发（证书补齐后）自愈。
func (e *HTTPExecutor) clientForTLS() (*http.Client, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.client != nil {
		return e.client, nil
	}
	tlsCfg := &tls.Config{InsecureSkipVerify: e.opts.InsecureSkipVerify} //nolint:gosec // 显式配置项（自签名内网专用）
	if e.opts.CAFile != "" {
		pem, err := os.ReadFile(e.opts.CAFile)
		if err != nil {
			return nil, fmt.Errorf("read CA file: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, errors.New("no valid CA certificate in " + e.opts.CAFile)
		}
		tlsCfg.RootCAs = pool
	}
	e.client = &http.Client{
		Timeout:   e.opts.Timeout,
		Transport: &http.Transport{TLSClientConfig: tlsCfg},
	}
	return e.client, nil
}

// Handler returns the executor.Handler for task_type="http" (the default).
func (e *HTTPExecutor) Handler() Handler {
	return func(ctx context.Context, task Task) error {
		// Executor target + async flag ride in the task meta (scheduler adapts
		// them from the persisted task definition).
		rawURL, _ := task.Meta["executor_url"].(string)
		async, _ := task.Meta["async"].(bool)
		if err := validateExecutorURL(rawURL); err != nil {
			return err
		}
		client, err := e.clientForTLS()
		if err != nil {
			// TLS 配置错误（CA 缺失/非法）：按 transient 处理交给重试策略，
			// 证书补齐后自愈；重试耗尽走任务失败 + 兜底路径。
			return fmt.Errorf("%w: executor TLS setup: %v", ErrRetry, err)
		}
		var body io.Reader
		if len(task.Payload) > 0 {
			body = bytes.NewReader(task.Payload)
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, rawURL, body)
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/json")
		// Identify the task to the executor: it needs task_id to report back via
		// the completion callback / internal/email/send reference_id.
		req.Header.Set("X-Task-Id", task.ID)
		resp, err := client.Do(req)
		if err != nil {
			// Network-level failure (incl. TLS handshake): transient, let the
			// retry policy decide.
			return fmt.Errorf("%w: executor unreachable: %v", ErrRetry, err)
		}
		defer resp.Body.Close()
		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))

		// Async accepted takes precedence over the generic 2xx branch.
		if resp.StatusCode == http.StatusAccepted && async {
			return ErrAsync // accepted → running, callback will finalize
		}
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			return nil // sync success
		}
		return fmt.Errorf("executor returned %d: %s", resp.StatusCode, truncateBytes(respBody, 500))
	}
}

// validateExecutorURL restricts the executor target to http/https.
func validateExecutorURL(raw string) error {
	if raw == "" {
		return errors.New("http task missing executor_url")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("invalid executor_url %q: %w", raw, err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("unsupported executor_url scheme %q (only http/https)", u.Scheme)
	}
	if u.Host == "" {
		return fmt.Errorf("executor_url %q missing host", raw)
	}
	return nil
}

func truncateBytes(b []byte, n int) string {
	s := string(b)
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}
