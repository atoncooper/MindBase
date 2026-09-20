// Package upstream is the HTTP client for the app-board service, reached
// through the APISIX key-auth route /internal/board/* (proxy-rewrite strips
// the /internal prefix upstream). Identity model: every request carries the
// configured apikey plus the acting X-Uid; app-board scopes all queries to
// that uid.
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

	"app-board-mcp/internal/identity"
	"app-board-mcp/internal/logger"

	"github.com/google/uuid"
)

// BoardMeta mirrors app-board's API metadata shape (camelCase).
type BoardMeta struct {
	UUID      string    `json:"uuid"`
	Title     string    `json:"title"`
	Kind      string    `json:"kind"`
	Version   int64     `json:"version"`
	IsPinned  bool      `json:"isPinned"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// BoardDetail is the metadata plus the body JSON (nil when absent). Content
// is a JSON-encoded string on the wire (the editor document stored verbatim).
type BoardDetail struct {
	BoardMeta
	Content *string `json:"content"`
}

// BoardList is the paginated list envelope.
type BoardList struct {
	Items    []BoardMeta `json:"items"`
	Total    int64       `json:"total"`
	Page     int         `json:"page"`
	PageSize int         `json:"pageSize"`
}

// APIError is a non-2xx app-board response with the uniform
// {"detail", "request_id"} envelope.
type APIError struct {
	Status    int
	Detail    string
	RequestID string
}

func (e *APIError) Error() string {
	msg := fmt.Sprintf("app-board returned %d: %s", e.Status, e.Detail)
	if e.RequestID != "" {
		msg += fmt.Sprintf(" (request_id: %s)", e.RequestID)
	}
	return msg
}

// Client calls app-board via the gateway. Safe for concurrent use.
//
// Trace/identity model: the X-Request-Id is taken from ctx (injected by the
// tools layer / HTTP middleware) so one MCP call shares one id across every
// log line and the app-board access log. The acting X-Uid comes from the
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
		http:       &http.Client{Timeout: 60 * time.Second},
	}
}

// requestID returns the trace id for this call: ctx value first, else a new
// uuid. Explicitly attached to log attrs because the logger's context handler
// only injects ids that came through IntoContext.
func requestID(ctx context.Context) string {
	if id := logger.FromContext(ctx); id != logger.DefaultRequestID {
		return id
	}
	return uuid.NewString()
}

// actingUID resolves the board owner for one call: the identity context
// (service mode) wins, else the configured default (bearer clients).
func (c *Client) actingUID(ctx context.Context) int64 {
	if uid, ok := identity.FromContext(ctx); ok {
		return uid
	}
	return c.defaultUID
}

// do executes one gateway call. amend (variadic, usually nil) tweaks the
// request after the standard headers are set (e.g. If-Match).
func (c *Client) do(ctx context.Context, method, path string, query url.Values, body []byte, out any, amend ...func(*http.Request)) error {
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
	for _, fn := range amend {
		fn(req)
	}

	// Attach the id to ctx: the logger's context handler then injects it into
	// every log line below (no explicit attr, no duplicate key), and ctx
	// values flow into mcp-go handler contexts in both transports.
	ctx = logger.IntoContext(ctx, reqID)

	resp, err := c.http.Do(req)
	elapsed := time.Since(start)
	if err != nil {
		slog.ErrorContext(ctx, "[BOARDMCP] upstream unreachable",
			"module", "upstream", "method", method, "path", path,
			"elapsed", elapsed, "err", err)
		return fmt.Errorf("gateway unreachable (%s): %w", c.baseURL, err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(io.LimitReader(resp.Body, 17<<20)) // 8MB body + envelope headroom
	if err != nil {
		slog.ErrorContext(ctx, "[BOARDMCP] upstream read failed",
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
		log(ctx, "[BOARDMCP] upstream rejected",
			"module", "upstream", "method", method, "path", path,
			"status", apiErr.Status, "detail", apiErr.Detail, "elapsed", elapsed)
		return apiErr
	}

	slog.DebugContext(ctx, "[BOARDMCP] upstream request",
		"module", "upstream", "method", method, "path", path,
		"status", resp.StatusCode, "elapsed", elapsed)

	if out != nil && len(data) > 0 {
		if err := json.Unmarshal(data, out); err != nil {
			return fmt.Errorf("decode response: %w", err)
		}
	}
	return nil
}

// decodeError maps a non-2xx response to APIError using the uniform
// {"detail", "request_id"} envelope (falls back to the HTTP status text).
func decodeError(status int, data []byte) *APIError {
	apiErr := &APIError{Status: status, Detail: http.StatusText(status)}
	var envelope struct {
		Detail    string `json:"detail"`
		RequestID string `json:"request_id"`
	}
	if json.Unmarshal(data, &envelope) == nil && envelope.Detail != "" {
		apiErr.Detail = envelope.Detail
		apiErr.RequestID = envelope.RequestID
	}
	return apiErr
}

// List returns one page of board metadata. kind filters mindmap|whiteboard
// ("" = all); page/pageSize follow app-board's defaults (1 / 20, cap 100).
func (c *Client) List(ctx context.Context, kind string, page, pageSize int) (*BoardList, error) {
	q := url.Values{}
	q.Set("page", strconv.Itoa(page))
	q.Set("page_size", strconv.Itoa(pageSize))
	if kind != "" {
		q.Set("kind", kind)
	}
	var list BoardList
	if err := c.do(ctx, http.MethodGet, "/internal/board/boards", q, nil, &list); err != nil {
		return nil, err
	}
	return &list, nil
}

// Get fetches one board (meta + content). 404 covers missing, deleted, or
// not-owned boards — app-board does not distinguish them.
func (c *Client) Get(ctx context.Context, boardUUID string) (*BoardDetail, error) {
	var detail BoardDetail
	if err := c.do(ctx, http.MethodGet, "/internal/board/boards/"+url.PathEscape(boardUUID), nil, nil, &detail); err != nil {
		return nil, err
	}
	return &detail, nil
}

// CreateBody is the create payload. Content carries the editor document as a
// raw JSON token (object/array) or a pre-stringified JSON string — app-board
// stores either shape verbatim without double-encoding.
type CreateBody struct {
	Title   string          `json:"title,omitempty"`
	Kind    string          `json:"kind,omitempty"`
	Content json.RawMessage `json:"content,omitempty"`
}

func (c *Client) Create(ctx context.Context, body CreateBody) (*BoardMeta, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	var meta BoardMeta
	if err := c.do(ctx, http.MethodPost, "/internal/board/boards", nil, raw, &meta); err != nil {
		return nil, err
	}
	return &meta, nil
}

// UpdateBody is the update payload; nil fields are omitted (untouched).
type UpdateBody struct {
	Title    *string         `json:"title,omitempty"`
	Content  json.RawMessage `json:"content,omitempty"`
	IsPinned *bool           `json:"isPinned,omitempty"`
}

// Update replaces the given fields. ifMatch is the board's current version
// (mandatory optimistic lock; a stale value yields 409).
func (c *Client) Update(ctx context.Context, boardUUID string, ifMatch int64, body UpdateBody) (*BoardMeta, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	var meta BoardMeta
	amend := func(r *http.Request) { r.Header.Set("If-Match", strconv.FormatInt(ifMatch, 10)) }
	if err := c.do(ctx, http.MethodPut, "/internal/board/boards/"+url.PathEscape(boardUUID), nil, raw, &meta, amend); err != nil {
		return nil, err
	}
	return &meta, nil
}

// Delete soft-deletes a board (Mongo body is retained for manual recovery).
func (c *Client) Delete(ctx context.Context, boardUUID string) error {
	return c.do(ctx, http.MethodDelete, "/internal/board/boards/"+url.PathEscape(boardUUID), nil, nil, nil)
}

// SetPin toggles the pinned flag. Unlike Update, it does not bump the version.
func (c *Client) SetPin(ctx context.Context, boardUUID string, isPinned bool) (*BoardMeta, error) {
	raw, err := json.Marshal(map[string]bool{"isPinned": isPinned})
	if err != nil {
		return nil, err
	}
	var meta BoardMeta
	if err := c.do(ctx, http.MethodPatch, "/internal/board/boards/"+url.PathEscape(boardUUID)+"/pin", nil, raw, &meta); err != nil {
		return nil, err
	}
	return &meta, nil
}

// ErrConflict reports whether err is app-board's 409 (stale If-Match).
func ErrConflict(err error) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.Status == 409
}

// ErrNotFound reports whether err is app-board's 404.
func ErrNotFound(err error) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.Status == 404
}
