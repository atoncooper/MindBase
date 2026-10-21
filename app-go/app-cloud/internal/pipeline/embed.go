package pipeline

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"app-cloud/internal/circuit"
	"app-cloud/internal/config"
)

// Embedder calls the Higress AI gateway's OpenAI-compatible embeddings
// endpoint (/v1/embeddings, DashScope text-embedding-v4, 1024 dims).
// RED LINE: changing the model changes the vector space — the Milvus
// cloud_drive collection must be fully rebuilt in that case.
type Embedder struct {
	cfg    config.EmbeddingConfig
	client *http.Client
	br     *circuit.Breaker
}

func NewEmbedder(cfg config.EmbeddingConfig) *Embedder {
	return &Embedder{cfg: cfg, client: &http.Client{
		Timeout:   60 * time.Second,
		Transport: &http.Transport{Proxy: http.ProxyFromEnvironment},
	}, br: circuit.New(5, 30*time.Second)}
}

type embeddingsRequest struct {
	Model string   `json:"model"`
	Input []string `json:"input"`
}

type embeddingsResponse struct {
	Data []struct {
		Index     int       `json:"index"`
		Embedding []float32 `json:"embedding"`
	} `json:"data"`
	Error *struct {
		Message string `json:"message"`
		Type    string `json:"type"`
	} `json:"error"`
}

// Embed batch-embeds texts (order-preserving, batched by BatchSize).
func (e *Embedder) Embed(ctx context.Context, texts []string) ([][]float32, error) {
	if len(texts) == 0 {
		return nil, nil
	}
	if e.cfg.APIKey == "" || e.cfg.BaseURL == "" {
		return nil, fmt.Errorf("embedding gateway not configured (AI_GATEWAY__API_KEY / AI_GATEWAY__BASE_URL)")
	}
	if !e.br.Allow() {
		// Downstream trip: fail fast — the durable outbox retries later.
		return nil, fmt.Errorf("%w: embedding gateway", circuit.ErrOpen)
	}
	batch := e.cfg.BatchSize
	if batch <= 0 {
		batch = 10
	}
	out := make([][]float32, 0, len(texts))
	for start := 0; start < len(texts); start += batch {
		end := start + batch
		if end > len(texts) {
			end = len(texts)
		}
		vecs, err := e.embedBatch(ctx, texts[start:end])
		if err != nil {
			e.br.OnFailure()
			return nil, err
		}
		e.br.OnSuccess()
		out = append(out, vecs...)
	}
	if e.cfg.Dimension > 0 {
		for _, v := range out {
			if len(v) != e.cfg.Dimension {
				return nil, fmt.Errorf("embedding dimension mismatch: got %d, want %d (RED LINE: model/dim change requires full Milvus rebuild)", len(v), e.cfg.Dimension)
			}
		}
	}
	return out, nil
}

// embedBatch runs one batch with bounded retries: transport errors and
// HTTP 429/5xx are transient (gateway saturation, upstream blips) and get up
// to embedMaxAttempts attempts with linear backoff; other 4xx are permanent
// (auth, malformed request) and fail immediately. The whole loop respects
// the caller ctx — the pipeline run bounds it anyway.
const embedMaxAttempts = 3

func (e *Embedder) embedBatch(ctx context.Context, texts []string) ([][]float32, error) {
	var lastErr error
	for attempt := 1; attempt <= embedMaxAttempts; attempt++ {
		v, status, err := e.embedOnce(ctx, texts)
		if err == nil {
			return v, nil
		}
		lastErr = err
		transient := status == 0 || status == http.StatusTooManyRequests || status >= 500
		if !transient || attempt == embedMaxAttempts {
			return nil, lastErr
		}
		slog.Warn("[PIPELINE_EMBED] transient embedding failure — retrying",
			"attempt", attempt, "status", status, "err", err)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Duration(attempt) * 500 * time.Millisecond):
		}
	}
	return nil, lastErr
}

func (e *Embedder) embedOnce(ctx context.Context, texts []string) ([][]float32, int, error) {
	payload, err := json.Marshal(embeddingsRequest{Model: e.cfg.Model, Input: texts})
	if err != nil {
		return nil, 0, err
	}
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		trimRight(e.cfg.BaseURL, "/")+"/embeddings", bytes.NewReader(payload))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Authorization", "Bearer "+e.cfg.APIKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := e.client.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("embedding transport: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return nil, resp.StatusCode, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, resp.StatusCode, fmt.Errorf("embedding http %d: %.200s", resp.StatusCode, string(body))
	}
	var out embeddingsResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, resp.StatusCode, fmt.Errorf("embedding response decode: %w", err)
	}
	if out.Error != nil && out.Error.Message != "" {
		return nil, resp.StatusCode, fmt.Errorf("embedding api error: %s", out.Error.Message)
	}
	if len(out.Data) != len(texts) {
		return nil, resp.StatusCode, fmt.Errorf("embedding count mismatch: got %d, want %d", len(out.Data), len(texts))
	}
	vecs := make([][]float32, len(texts))
	for _, d := range out.Data {
		if d.Index < 0 || d.Index >= len(vecs) {
			return nil, resp.StatusCode, fmt.Errorf("embedding index out of range: %d", d.Index)
		}
		vecs[d.Index] = d.Embedding
	}
	return vecs, resp.StatusCode, nil
}

func trimRight(s, cut string) string {
	for len(s) >= len(cut) && s[len(s)-len(cut):] == cut {
		s = s[:len(s)-len(cut)]
	}
	return s
}