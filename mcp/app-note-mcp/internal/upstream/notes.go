// Package upstream is the HTTP client for the app-note service, reached
// through the APISIX key-auth route /internal/note/* (consumed by the
// note_internal route, priority 100). Identity model: every request carries
// the configured apikey plus the acting X-Uid; app-note scopes all queries
// to that uid and answers cross-user reads with 404.
package upstream

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
	"strconv"
	"time"

	"app-note-mcp/internal/identity"
	"app-note-mcp/internal/logger"

	"github.com/google/uuid"
)

// NoteMeta mirrors app-note's wire shape (snake_case, naive-UTC timestamps).
type NoteMeta struct {
	UUID          string `json:"uuid"`
	Title         string `json:"title"`
	TargetType    string `json:"target_type"`
	TargetID      string `json:"target_id"`
	ContentLength int    `json:"content_length"`
	IsPinned      bool   `json:"is_pinned"`
	RevisionCount int    `json:"revision_count"`
	CreatedAt     string `json:"created_at"`
	UpdatedAt     string `json:"updated_at"`
}

// NoteDetail is the metadata plus the markdown body and anchors.
type NoteDetail struct {
	NoteMeta
	ContentMD string `json:"content_md"`
}

// APIError is a non-2xx app-note response with the {"detail": ...} envelope.
type APIError struct {
	Status int
	Detail string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("app-note returned %d: %s", e.Status, e.Detail)
}

// Client calls app-note via the gateway. Safe for concurrent use.
//
// Trace/identity model: the X-Request-Id is taken from ctx (injected by the
// tools layer / HTTP middleware) so one MCP call shares one id across every
// log line and the app-note access log. The acting X-Uid comes from the
// identity context (service mode: per-request uid from the main-app backend);
// when ctx carries none, the configured default uid is used (bearer clients).
type Client struct {
	baseURL    string
	apiKey     string
	defaultUID int64
	http       *http.Client
}

func NewClient(baseURL, apiKey string, defaultUID int64) *Client {
	return &Client{
		baseURL:    baseURL,
		apiKey:     apiKey,
		defaultUID: defaultUID,
		http:       &http.Client{Timeout: 30 * time.Second},
	}
}

// requestID returns the trace id for this call: ctx value first, else a new
// uuid.
func requestID(ctx context.Context) string {
	if id := logger.FromContext(ctx); id != logger.DefaultRequestID {
		return id
	}
	return uuid.NewString()
}

// actingUID resolves the note owner for one call: the identity context
// (service mode) wins, else the configured default (bearer clients).
func (c *Client) actingUID(ctx context.Context) int64 {
	if uid, ok := identity.FromContext(ctx); ok {
		return uid
	}
	return c.defaultUID
}

// do executes one gateway call. out (when non-nil) decodes the JSON body;
// headers (when non-nil) captures the response headers (X-Total-Count).
func (c *Client) do(ctx context.Context, method, path string, query url.Values, body []byte, out any, headers http.Header) error {
	u := c.baseURL + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	reqID := requestID(ctx)
	start := time.Now()

	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, reader)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("apikey", c.apiKey)
	req.Header.Set("X-Uid", strconv.FormatInt(c.actingUID(ctx), 10))
	req.Header.Set("X-Request-Id", reqID)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	// Attach the id to ctx: the logger's context handler then injects it into
	// every log line below, and ctx values flow into mcp-go handler contexts
	// in both transports.
	ctx = logger.IntoContext(ctx, reqID)

	resp, err := c.http.Do(req)
	elapsed := time.Since(start)
	if err != nil {
		slog.ErrorContext(ctx, "[NOTEMCP] upstream unreachable",
			"module", "upstream", "method", method, "path", path,
			"elapsed", elapsed, "err", err)
		return fmt.Errorf("gateway unreachable (%s): %w", c.baseURL, err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<21)) // 2MB: 256KB content + envelope headroom
	if err != nil {
		slog.ErrorContext(ctx, "[NOTEMCP] upstream read failed",
			"module", "upstream", "method", method, "path", path,
			"elapsed", elapsed, "err", err)
		return fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		apiErr := decodeError(resp.StatusCode, data)
		// 4xx = caller-correctable (agent should adapt); 5xx = server-side.
		log := slog.WarnContext
		if apiErr.Status >= 500 {
			log = slog.ErrorContext
		}
		log(ctx, "[NOTEMCP] upstream rejected",
			"module", "upstream", "method", method, "path", path,
			"status", apiErr.Status, "detail", apiErr.Detail, "elapsed", elapsed)
		return apiErr
	}

	slog.DebugContext(ctx, "[NOTEMCP] upstream request",
		"module", "upstream", "method", method, "path", path,
		"status", resp.StatusCode, "elapsed", elapsed)

	if headers != nil {
		for k, vs := range resp.Header {
			headers[k] = vs
		}
	}
	if out != nil && len(data) > 0 {
		if err := json.Unmarshal(data, out); err != nil {
			return fmt.Errorf("decode response: %w", err)
		}
	}
	return nil
}

// decodeError maps a non-2xx response to APIError using the {"detail": ...}
// envelope (falls back to the HTTP status text). The 409 conflict detail is a
// nested object — flattened to "conflict" for the agent.
func decodeError(status int, data []byte) *APIError {
	apiErr := &APIError{Status: status, Detail: http.StatusText(status)}
	var envelope struct {
		Detail json.RawMessage `json:"detail"`
	}
	if json.Unmarshal(data, &envelope) == nil && len(envelope.Detail) > 0 {
		var s string
		if json.Unmarshal(envelope.Detail, &s) == nil && s != "" {
			apiErr.Detail = s
		} else {
			var obj map[string]any
			if json.Unmarshal(envelope.Detail, &obj) == nil {
				if e, ok := obj["error"].(string); ok && e != "" {
					apiErr.Detail = e
				}
			}
		}
	}
	return apiErr
}

// List returns one page of note metadata; total comes from the
// X-Total-Count header. targetType filters video|cloud_file ("" = all).
func (c *Client) List(ctx context.Context, targetType string, page, pageSize int) ([]NoteMeta, int, error) {
	q := url.Values{}
	q.Set("page", strconv.Itoa(page))
	q.Set("page_size", strconv.Itoa(pageSize))
	if targetType != "" {
		q.Set("target_type", targetType)
	}
	var notes []NoteMeta
	h := http.Header{}
	if err := c.do(ctx, http.MethodGet, "/internal/note/notes", q, nil, &notes, h); err != nil {
		return nil, 0, err
	}
	total, _ := strconv.Atoi(h.Get("X-Total-Count"))
	return notes, total, nil
}

// Get fetches one note (metadata + markdown body). 404 covers missing,
// deleted, or not-owned notes — app-note does not distinguish them.
func (c *Client) Get(ctx context.Context, noteUUID string) (*NoteDetail, error) {
	var detail NoteDetail
	if err := c.do(ctx, http.MethodGet, "/internal/note/notes/"+url.PathEscape(noteUUID), nil, nil, &detail, nil); err != nil {
		return nil, err
	}
	return &detail, nil
}

// CreateBody is the create payload (parity with the /internal/note API).
type CreateBody struct {
	Title      string `json:"title"`
	TargetType string `json:"target_type"`
	TargetID   string `json:"target_id"`
	ContentMD  string `json:"content_md"`
}

func (c *Client) Create(ctx context.Context, body CreateBody) (*NoteDetail, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	var detail NoteDetail
	if err := c.do(ctx, http.MethodPost, "/internal/note/notes", nil, raw, &detail, nil); err != nil {
		return nil, err
	}
	return &detail, nil
}

// UpdateBody is the update payload; nil fields are omitted (untouched).
// No If-Match: agent updates skip optimistic locking (user auto-save owns it;
// concurrent revision counts stay consistent via app-note's atomic SQL bump).
type UpdateBody struct {
	Title     *string `json:"title,omitempty"`
	ContentMD *string `json:"content_md,omitempty"`
	IsPinned  *bool   `json:"is_pinned,omitempty"`
}

func (c *Client) Update(ctx context.Context, noteUUID string, body UpdateBody) (*NoteDetail, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	var detail NoteDetail
	if err := c.do(ctx, http.MethodPatch, "/internal/note/notes/"+url.PathEscape(noteUUID), nil, raw, &detail, nil); err != nil {
		return nil, err
	}
	return &detail, nil
}

// ErrNotFound reports whether err is app-note's 404.
func ErrNotFound(err error) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.Status == 404
}
