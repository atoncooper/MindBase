// Package upstream is the HTTP client for the app-quiz service, reached
// through the APISIX key-auth route /internal/quiz/* (consumed by the
// quiz_internal route, priority 100). Identity model: every request carries
// the configured apikey plus the acting X-Uid; app-quiz scopes all queries
// to that uid and answers cross-user reads with 404.
package upstream

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"app-quiz-mcp/internal/identity"
	"app-quiz-mcp/internal/logger"

	"github.com/google/uuid"
)

// APIError is a non-2xx app-quiz response with the {"detail": ...} envelope.
type APIError struct {
	Status int
	Detail string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("app-quiz returned %d: %s", e.Status, e.Detail)
}

// Client calls app-quiz via the gateway. Safe for concurrent use.
//
// Trace/identity model: the X-Request-Id is taken from ctx (injected by the
// tools layer / HTTP middleware) so one MCP call shares one id across every
// log line and the app-quiz access log. The acting X-Uid comes from the
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

// actingUID resolves the quiz owner for one call: the identity context
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
		slog.ErrorContext(ctx, "[QUIZMCP] upstream unreachable",
			"module", "upstream", "method", method, "path", path,
			"elapsed", elapsed, "err", err)
		return fmt.Errorf("gateway unreachable (%s): %w", c.baseURL, err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<21)) // 2MB: 256KB content + envelope headroom
	if err != nil {
		slog.ErrorContext(ctx, "[QUIZMCP] upstream read failed",
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
		log(ctx, "[QUIZMCP] upstream rejected",
			"module", "upstream", "method", method, "path", path,
			"status", apiErr.Status, "detail", apiErr.Detail, "elapsed", elapsed)
		return apiErr
	}

	slog.DebugContext(ctx, "[QUIZMCP] upstream request",
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

// ── quiz writes ─────────────────────────────────────────────────────

// AgentQuestion is one question authored by the quiz agent.
type AgentQuestion struct {
	Question    string   `json:"question"`
	Options     []string `json:"options,omitempty"`
	Answer      string   `json:"answer"`
	Explanation string   `json:"explanation"`
}

// CreateQuizBody is the payload for POST /internal/quiz/sets.
type CreateQuizBody struct {
	UID       int64           `json:"uid"`
	Title     string          `json:"title"`
	Questions []AgentQuestion `json:"questions"`
}

// Create persists a complete quiz set (MySQL metadata + Mongo questions) and
// returns the quiz_uuid.
func (c *Client) CreateQuiz(ctx context.Context, body CreateQuizBody) (string, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return "", fmt.Errorf("marshal request: %w", err)
	}
	var out struct {
		QuizUUID string `json:"quiz_uuid"`
	}
	if err := c.do(ctx, http.MethodPost, "/internal/quiz/sets", nil, payload, &out, nil); err != nil {
		return "", err
	}
	if out.QuizUUID == "" {
		return "", fmt.Errorf("app-quiz returned an empty quiz_uuid")
	}
	return out.QuizUUID, nil
}

// AgentVerdict is one per-question grading verdict.
type AgentVerdict struct {
	Index    int    `json:"index"`
	Verdict  string `json:"verdict"`
	Feedback string `json:"feedback"`
}

// CreateGradingBody is the payload for POST /internal/quiz/gradings.
type CreateGradingBody struct {
	UID         int64          `json:"uid"`
	QuizUUID    string         `json:"quiz_uuid,omitempty"`
	Score       int            `json:"score"`
	Total       int            `json:"total"`
	PerQuestion []AgentVerdict `json:"per_question"`
}

// SaveGrading persists a conversational grading result and returns the
// submission_uuid.
func (c *Client) SaveGrading(ctx context.Context, body CreateGradingBody) (string, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return "", fmt.Errorf("marshal request: %w", err)
	}
	var out struct {
		SubmissionUUID string `json:"submission_uuid"`
	}
	if err := c.do(ctx, http.MethodPost, "/internal/quiz/gradings", nil, payload, &out, nil); err != nil {
		return "", err
	}
	if out.SubmissionUUID == "" {
		return "", fmt.Errorf("app-quiz returned an empty submission_uuid")
	}
	return out.SubmissionUUID, nil
}
