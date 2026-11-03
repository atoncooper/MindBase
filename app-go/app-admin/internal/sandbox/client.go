// Package sandbox is app-admin's thin HTTP client for the app-sandbox internal
// admin plane.
//
// Layer: outbound transport only — no business rules and no view DTOs of its
// own. The sandbox control plane is the single source of truth for leases,
// executions, quota and audit, so app-admin never reads sandbox_* tables and
// never re-implements filter/pagination semantics: requests are forwarded and
// the upstream JSON is passed through unchanged (fields may be added upstream
// without touching this proxy).
//
// Auth: a dedicated shared secret (`sandbox_admin.token`) sent as X-Admin-Token.
// It is NOT a user credential, NOT the APISIX consumer key, and never reaches
// the browser.
//
// Error contract (mapped by the router):
//   - ErrNotConfigured -> 503 "sandbox 管理未配置" (base_url + token not both set)
//   - *UpstreamError   -> echo the upstream 4xx status AND its {detail}
//   - ErrUnavailable   -> 502 "sandbox 服务不可用" (5xx, transport, bad payload)
//
// Upstream 401/403 is deliberately folded into ErrUnavailable instead of being
// echoed: the admin SPA treats any 401 as an expired session and would log the
// operator out, while those codes here only ever mean app-admin's own token is
// wrong — an operator cannot fix that, and it belongs in server logs.
package sandbox

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	// adminPrefix is the upstream internal admin API prefix.
	adminPrefix = "/internal/admin"
	// requestTimeout bounds one admin call. The list/detail endpoints are plain
	// MySQL reads, so 15s means "sandbox is wedged", not "slow query".
	requestTimeout = 15 * time.Second
	// maxResponseBytes caps one proxied payload: views are lists and previews,
	// never blobs.
	maxResponseBytes = 8 << 20
	// maxDetailRunes caps a passed-through detail so the console shows one line
	// and no internal stack text can flood the UI.
	maxDetailRunes = 500
)

var (
	// ErrNotConfigured — base_url and token are not both set. The router answers
	// 503 so the rest of the console keeps working.
	ErrNotConfigured = errors.New("sandbox 管理未配置")
	// ErrUnavailable — the control plane cannot answer meaningfully (5xx,
	// unreachable, timeout, malformed payload). The router answers 502.
	ErrUnavailable = errors.New("sandbox 服务不可用")
)

// UpstreamError is a 4xx rejection from app-sandbox (bad filter, unknown id,
// lease already gone, ...). The router echoes its status and detail verbatim so
// the console reads a precise API error instead of a generic 500.
type UpstreamError struct {
	Status int
	Detail string
}

func (e *UpstreamError) Error() string { return e.Detail }

// Client talks to app-sandbox's /internal/admin/* surface.
type Client struct {
	baseURL string
	token   string
	http    *http.Client
}

// NewClient trims both values and normalizes the base URL (no trailing slash).
// Either value missing leaves the client disabled: Enabled() false, every call
// returns ErrNotConfigured, and the console degrades to 503 for /api/sandbox/*
// only.
func NewClient(baseURL, token string) *Client {
	return &Client{
		baseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		token:   strings.TrimSpace(token),
		http:    &http.Client{Timeout: requestTimeout},
	}
}

// Enabled reports whether both the base URL and the admin token are wired.
func (c *Client) Enabled() bool { return c != nil && c.baseURL != "" && c.token != "" }

// Overview — GET /internal/admin/overview: lease/execution counters, last-24h
// executions and failures, quota switch.
func (c *Client) Overview(ctx context.Context) (json.RawMessage, error) {
	return c.do(ctx, http.MethodGet, "/overview", nil)
}

// Executions — GET /internal/admin/executions?uid=&projectId=&status=&from=&to=
// &page=&pageSize=. Returns the paged list view (no full stdout/stderr).
func (c *Client) Executions(ctx context.Context, query url.Values) (json.RawMessage, error) {
	return c.do(ctx, http.MethodGet, "/executions", query)
}

// Execution — GET /internal/admin/executions/{id}: previews, artifact metadata
// and the audit trail of one execution.
func (c *Client) Execution(ctx context.Context, id string) (json.RawMessage, error) {
	return c.do(ctx, http.MethodGet, "/executions/"+pathSegment(id), nil)
}

// CancelExecution — POST /internal/admin/executions/{id}/cancel. Idempotent
// upstream (a finished execution is a no-op); the response body may be empty.
func (c *Client) CancelExecution(ctx context.Context, id string) (json.RawMessage, error) {
	return c.do(ctx, http.MethodPost, "/executions/"+pathSegment(id)+"/cancel", nil)
}

// Leases — GET /internal/admin/leases?uid=&state=&page=&pageSize=.
func (c *Client) Leases(ctx context.Context, query url.Values) (json.RawMessage, error) {
	return c.do(ctx, http.MethodGet, "/leases", query)
}

// ReleaseLease — DELETE /internal/admin/leases/{id}: force-release (cancel the
// in-flight execution, delete the runtime sandbox, mark the lease terminated).
func (c *Client) ReleaseLease(ctx context.Context, id string) (json.RawMessage, error) {
	return c.do(ctx, http.MethodDelete, "/leases/"+pathSegment(id), nil)
}

// Quota — GET /internal/admin/quota?uid=&day=: one user's daily usage plus the
// tier limits.
func (c *Client) Quota(ctx context.Context, query url.Values) (json.RawMessage, error) {
	return c.do(ctx, http.MethodGet, "/quota", query)
}

// AuditLog — GET /internal/admin/audit?uid=&action=&from=&to=&page=&pageSize=:
// control-plane audit search (create/exec/release/deny/timeout/cancel).
func (c *Client) AuditLog(ctx context.Context, query url.Values) (json.RawMessage, error) {
	return c.do(ctx, http.MethodGet, "/audit", query)
}

// RuntimeConfig — GET /internal/admin/config: read-only runtime summary
// (runtime type, image, resources, lease TTL, admission/quota switches).
func (c *Client) RuntimeConfig(ctx context.Context) (json.RawMessage, error) {
	return c.do(ctx, http.MethodGet, "/config", nil)
}

// do issues one admin-plane request and returns the raw JSON body (nil for an
// empty 2xx response). rel is the path AFTER /internal/admin and already
// contains any id segment; query is appended verbatim (empty values are the
// caller's responsibility — the router only forwards present params).
func (c *Client) do(ctx context.Context, method, rel string, query url.Values) (json.RawMessage, error) {
	if !c.Enabled() {
		return nil, ErrNotConfigured
	}
	target := c.baseURL + adminPrefix + rel
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	// Bound the call below the client timeout as well, so a caller-side
	// cancellation (browser closed, admin navigated away) releases the upstream
	// request immediately instead of holding a sandbox DB connection.
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, method, target, nil)
	if err != nil {
		return nil, fmt.Errorf("%w: build request: %v", ErrUnavailable, err)
	}
	req.Header.Set("X-Admin-Token", c.token)
	req.Header.Set("Accept", "application/json")
	// Correlation id: app-sandbox logs it and its own audit rows keep it, so one
	// operator action stays traceable across both services.
	req.Header.Set("X-Request-Id", fmt.Sprintf("admin-sandbox-%d", time.Now().UnixNano()))

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return nil, fmt.Errorf("%w: read response: %v", ErrUnavailable, err)
	}

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		if len(bytes.TrimSpace(body)) == 0 {
			return nil, nil // 204 / empty 200 -> the router answers {"ok":true}
		}
		if !json.Valid(body) {
			return nil, fmt.Errorf("%w: malformed JSON payload", ErrUnavailable)
		}
		return json.RawMessage(body), nil
	}

	detail := upstreamDetail(body)
	// 4xx is a caller-side outcome and is echoed verbatim; 401/403 is excluded
	// because it means OUR token is wrong (see the package doc).
	if resp.StatusCode >= 400 && resp.StatusCode < 500 &&
		resp.StatusCode != http.StatusUnauthorized && resp.StatusCode != http.StatusForbidden {
		if detail == "" {
			detail = fmt.Sprintf("sandbox 上游拒绝请求（HTTP %d）", resp.StatusCode)
		}
		return nil, &UpstreamError{Status: resp.StatusCode, Detail: detail}
	}
	if detail != "" {
		slog.Warn("[SANDBOX_ADMIN] upstream rejection", "status", resp.StatusCode, "detail", detail)
	}
	return nil, fmt.Errorf("%w (HTTP %d)", ErrUnavailable, resp.StatusCode)
}

// pathSegment escapes one opaque upstream id (UUID) for a URL path.
func pathSegment(id string) string { return url.PathEscape(strings.TrimSpace(id)) }

// upstreamDetail extracts the {"detail": ...} contract text from an error body.
// A non-JSON body (proxy HTML, panic dump) yields "" so internal text is never
// echoed to the console; the result is rune-capped for one-line display.
func upstreamDetail(body []byte) string {
	var envelope struct {
		Detail string `json:"detail"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return ""
	}
	return truncateRunes(strings.TrimSpace(envelope.Detail), maxDetailRunes)
}

// truncateRunes caps s to n runes without splitting a multi-byte character
// (upstream details are Chinese/user-facing text).
func truncateRunes(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n])
}
