// Summarizer — L1 routing payload generator: calls the Higress gateway's
// chat-completions endpoint with a small model and returns a strict,
// structured document summary. A stateless gateway adapter (same category as
// the MinIO/Mongo clients) — the orchestration around it lives in RunSync.
package service

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"app-cloud/internal/circuit"
	"app-cloud/internal/config"
)

// Summary is the structured document summary consumed by the L1 routing
// layer. SizeChars is computed server-side (rune count of the extracted
// text), never trusted from the model.
type Summary struct {
	Overview         string   `json:"overview" bson:"overview"`
	Topics           []string `json:"topics" bson:"topics"`
	Entities         []string `json:"entities" bson:"entities"`
	KeyPoints        []string `json:"key_points" bson:"key_points"`
	AnswersQuestions []string `json:"answers_questions" bson:"answers_questions"`
	Language         string   `json:"language" bson:"language"`
	SizeChars        int      `json:"size_chars" bson:"size_chars"`
}

const systemPrompt = `你是文档摘要引擎。阅读用户提供的文档，输出严格 JSON（不要 markdown 代码块、不要解释文字），字段如下：
{
  "overview": "不超过300字的文档概览",
  "topics": ["3-8个主题词，名词短语，中文"],
  "entities": ["0-15个具名实体：人物/产品/技术/组织"],
  "key_points": ["3-6条关键论点，每条一句话"],
  "answers_questions": ["2-5条这篇文档能回答的问题示例"],
  "language": "zh 或 en"
}
所有字段必须存在；列表可以为空但不可缺失。`

const maxAttempts = 2

type Summarizer struct {
	cfg    config.SummaryConfig
	apiKey string
	base   string
	client *http.Client
	br     *circuit.Breaker
}

// NewSummarizer builds the summarizer. Credentials/base URL are shared with
// the embedding config (same Higress gateway).
func NewSummarizer(cfg config.SummaryConfig, apiKey, baseURL string) *Summarizer {
	return &Summarizer{
		cfg: cfg, apiKey: apiKey, base: strings.TrimRight(baseURL, "/"),
		client: &http.Client{Timeout: 90 * time.Second, Transport: &http.Transport{Proxy: http.ProxyFromEnvironment}},
		br:     circuit.New(5, 30*time.Second),
	}
}

// Enabled reports whether the stage should run. An empty model means the
// operator has not wired a small model into the gateway yet — skip cleanly
// instead of failing every upload.
func (s *Summarizer) Enabled() bool {
	return s != nil && s.cfg.Enabled && strings.TrimSpace(s.cfg.Model) != "" &&
		s.apiKey != "" && s.base != ""
}

// ModelName exposes the configured model — persisted with the summary so the
// query layer can attribute routing payloads to a model version.
func (s *Summarizer) ModelName() string {
	if s == nil {
		return ""
	}
	return s.cfg.Model
}

type chatRequest struct {
	Model       string        `json:"model"`
	Messages    []chatMessage `json:"messages"`
	Temperature float64       `json:"temperature"`
	MaxTokens   int           `json:"max_tokens,omitempty"`
}

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatResponse struct {
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
}

// Summarize summarizes the (already extracted) document text. One retry on
// transport/5xx/parse failures; non-2xx 4xx errors fail immediately.
func (s *Summarizer) Summarize(ctx context.Context, title, text string) (*Summary, error) {
	if !s.br.Allow() {
		// Downstream trip: fail fast — the durable outbox retries later.
		return nil, fmt.Errorf("%w: summary gateway", circuit.ErrOpen)
	}
	if s.cfg.MaxInputChars > 0 && len(text) > s.cfg.MaxInputChars {
		// Byte truncation may split a rune (a CJK char is 3 bytes) — trim back
		// to the last valid rune boundary: DecodeLastRuneInString reports
		// RuneError/size 1 for an incomplete or invalid tail.
		cut := text[:s.cfg.MaxInputChars]
		for len(cut) > 0 {
			if r, size := utf8.DecodeLastRuneInString(cut); !(r == utf8.RuneError && size == 1) {
				break
			}
			cut = cut[:len(cut)-1]
		}
		text = cut + "\n\n[文档过长，已截断]"
	}
	user := "文档标题：" + title + "\n\n文档正文：\n" + text

	var lastErr error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		sum, status, err := s.once(ctx, user)
		if err == nil {
			s.br.OnSuccess()
			return sum, nil
		}
		lastErr = err
		if status != -1 {
			// transport / HTTP errors trip the breaker; format violations
			// (status -1) are model misbehaviour on a healthy gateway — neutral.
			s.br.OnFailure()
		}
		transient := status == 0 || status == http.StatusTooManyRequests || status >= 500 || status == -1
		if !transient || attempt == maxAttempts {
			return nil, lastErr
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Duration(attempt) * 500 * time.Millisecond):
		}
	}
	return nil, lastErr
}

// status sentinel -1 marks a response body that arrived but failed JSON
// extraction (retryable — the model may not have followed the format).
func (s *Summarizer) once(ctx context.Context, user string) (*Summary, int, error) {
	reqBody := chatRequest{
		Model: s.cfg.Model,
		Messages: []chatMessage{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: user},
		},
		Temperature: 0.2,
		MaxTokens:   s.cfg.MaxOutputTok,
	}
	payload, err := json.Marshal(reqBody)
	if err != nil {
		return nil, 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.base+"/chat/completions", bytes.NewReader(payload))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Authorization", "Bearer "+s.apiKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("summary transport: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return nil, resp.StatusCode, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, resp.StatusCode, fmt.Errorf("summary http %d: %.200s", resp.StatusCode, string(body))
	}
	var out chatResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, resp.StatusCode, fmt.Errorf("summary response decode: %w", err)
	}
	if len(out.Choices) == 0 || strings.TrimSpace(out.Choices[0].Message.Content) == "" {
		return nil, resp.StatusCode, fmt.Errorf("summary empty completion")
	}
	sum, err := parseSummaryJSON(out.Choices[0].Message.Content)
	if err != nil {
		return nil, -1, err // retryable: format violation
	}
	return sum, resp.StatusCode, nil
}

// parseSummaryJSON tolerates markdown fences and stray prose around the
// JSON object — small models routinely wrap output in ```json blocks.
func parseSummaryJSON(content string) (*Summary, error) {
	c := strings.TrimSpace(content)
	c = strings.TrimPrefix(c, "```json")
	c = strings.TrimPrefix(c, "```")
	c = strings.TrimSuffix(c, "```")
	start := strings.Index(c, "{")
	end := strings.LastIndex(c, "}")
	if start < 0 || end <= start {
		return nil, fmt.Errorf("summary output contains no JSON object")
	}
	c = c[start : end+1]
	var sum Summary
	if err := json.Unmarshal([]byte(c), &sum); err != nil {
		return nil, fmt.Errorf("summary json unmarshal: %w", err)
	}
	if strings.TrimSpace(sum.Overview) == "" {
		return nil, fmt.Errorf("summary json missing overview")
	}
	return &sum, nil
}
