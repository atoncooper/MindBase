package service

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"app-task/internal/config"
)

// AppClient calls the main app's /internal/quiz/* endpoints (via APISIX key-auth).
// ASYNC model: RequestQuiz POSTs /generate-llm (returns immediately with
// generating/ready); GetQuizStatus polls GET /status/{task_id} until ready/failed.
type AppClient struct {
	baseURL    string
	apiKey     string
	llmPath    string
	statusPath string // /internal/quiz/status/
	httpClient *http.Client
}

func NewAppClient(cfg *config.Config) *AppClient {
	timeout := time.Duration(cfg.App.Timeout) * time.Second
	return &AppClient{
		baseURL:    cfg.App.BaseURL,
		apiKey:     cfg.App.ConsumerKey,
		llmPath:    cfg.App.GenerateLLMPath,
		statusPath: "/internal/quiz/status/",
		httpClient: &http.Client{Timeout: timeout},
	}
}

// QuizGenResponse is the response from both /generate-llm and /status/{task_id}.
type QuizGenResponse struct {
	Status string `json:"status"`           // generating | ready | failed
	Quiz   *Quiz  `json:"quiz,omitempty"`   // present when status=ready
	Error  string `json:"error,omitempty"`  // present when status=failed
}

// Quiz is the generated quiz content (when status=ready).
type Quiz struct {
	Question               string   `json:"question"`
	QuestionType           string   `json:"question_type"`
	Options                []string `json:"options"`
	Answer                 string   `json:"answer"`
	Difficulty             string   `json:"difficulty"`
	AnswerTimeLimitSeconds int      `json:"answer_time_limit_seconds"`
}

// RequestQuiz POSTs /generate-llm asynchronously. Returns immediately with
// the status (generating/ready). Idempotent: main app checks task_id and won't
// re-invoke the LLM if already generating/ready.
func (c *AppClient) RequestQuiz(taskID, prompt string, uid int64, difficulty string) (*QuizGenResponse, error) {
	if c.baseURL == "" {
		return nil, fmt.Errorf("app base_url not configured")
	}
	url := strings.TrimRight(c.baseURL, "/") + c.llmPath
	body, _ := json.Marshal(map[string]any{
		"task_id":    taskID,
		"prompt":     prompt,
		"uid":        uid,
		"difficulty": difficulty,
	})
	req, err := http.NewRequest("POST", url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("apikey", c.apiKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("generate-llm request: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("generate-llm failed: status=%d body=%s",
			resp.StatusCode, truncate(string(respBody), 200))
	}

	var data QuizGenResponse
	if err := json.Unmarshal(respBody, &data); err != nil {
		return nil, fmt.Errorf("decode generate-llm response: %w", err)
	}
	return &data, nil
}

// GetQuizStatus polls GET /status/{taskID}. Returns status + quiz (if ready).
func (c *AppClient) GetQuizStatus(taskID string) (*QuizGenResponse, error) {
	if c.baseURL == "" {
		return nil, fmt.Errorf("app base_url not configured")
	}
	url := strings.TrimRight(c.baseURL, "/") + c.statusPath + taskID
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("apikey", c.apiKey)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("quiz status request: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("quiz status failed: status=%d body=%s",
			resp.StatusCode, truncate(string(respBody), 200))
	}

	var data QuizGenResponse
	if err := json.Unmarshal(respBody, &data); err != nil {
		return nil, fmt.Errorf("decode quiz status response: %w", err)
	}
	return &data, nil
}
