package settings

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	settingsdto "app-user/internal/dto/settings"
)

// ── probe (models list → minimal chat) ───────────────────────────────

// ProbeCodingPlan is the exported seam for the black-box tests in tests/:
// it runs the same models-list → chat fallback probe with no persistence.
func ProbeCodingPlan(ctx context.Context, client *http.Client, protocol, baseURL, model, apiKey string) *settingsdto.CodingPlanTestResponse {
	return ProbeCodingPlanWithProvider(ctx, client, "", protocol, baseURL, model, apiKey, "")
}

// ProbeCodingPlanWithProvider is ProbeCodingPlan plus the provider/session
// metadata needed by OpenCode's x-opencode-session routing header.
func ProbeCodingPlanWithProvider(
	ctx context.Context,
	client *http.Client,
	provider, protocol, baseURL, model, apiKey, sessionID string,
) *settingsdto.CodingPlanTestResponse {
	if client == nil {
		client = &http.Client{
			Timeout:   codingPlanProbeTimeout,
			Transport: &http.Transport{Proxy: http.ProxyFromEnvironment},
		}
	}
	return (&CodingPlanService{http: client}).probe(ctx, provider, protocol, baseURL, model, apiKey, sessionID)
}

func (s *CodingPlanService) probe(
	ctx context.Context,
	provider, protocol, baseURL, model, apiKey, sessionID string,
) *settingsdto.CodingPlanTestResponse {
	base := strings.TrimRight(baseURL, "/")

	modelsStatus, models, modelsDetail, modelsErr := s.probeModels(ctx, provider, protocol, base, apiKey, sessionID)
	if modelsErr == nil && modelsStatus == http.StatusOK {
		return &settingsdto.CodingPlanTestResponse{OK: true, Message: "连接成功", Models: models}
	}

	chatStatus, chatDetail, chatErr := s.probeChat(ctx, provider, protocol, base, model, apiKey, sessionID)
	if chatErr == nil && chatStatus >= 200 && chatStatus < 300 {
		return &settingsdto.CodingPlanTestResponse{OK: true, Message: "连接成功（聊天探测）"}
	}

	parts := make([]string, 0, 2)
	if modelsErr != nil {
		parts = append(parts, "模型列表请求失败")
	} else {
		parts = append(parts, fmt.Sprintf("模型列表 HTTP %d", modelsStatus))
	}
	if chatErr != nil {
		parts = append(parts, "聊天探测请求失败")
	} else {
		parts = append(parts, fmt.Sprintf("聊天探测 HTTP %d", chatStatus))
	}
	message := "连接失败：" + strings.Join(parts, "，")
	if detail := firstNonEmpty(chatDetail, modelsDetail); detail != "" {
		message += "（" + detail + "）"
	}
	return &settingsdto.CodingPlanTestResponse{OK: false, Message: message}
}

func (s *CodingPlanService) probeModels(
	ctx context.Context,
	provider, protocol, base, apiKey, sessionID string,
) (int, []string, string, error) {
	base = strings.TrimRight(base, "/")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.modelsURL(provider, protocol, base), nil)
	if err != nil {
		return 0, nil, "", err
	}
	applyCodingPlanProbeHeaders(req, provider, protocol, apiKey, sessionID)
	resp, err := s.http.Do(req)
	if err != nil {
		return 0, nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return resp.StatusCode, nil, SanitizeProbeDetail(resp.Body, apiKey), nil
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		// Authenticated and reachable; an unreadable body only loses the model list.
		return resp.StatusCode, nil, "", nil
	}
	type modelItem struct {
		ID string `json:"id"`
	}
	var payload struct {
		Data   []modelItem `json:"data"`
		Models []modelItem `json:"models"`
	}
	if json.Unmarshal(body, &payload) != nil {
		return resp.StatusCode, nil, "", nil
	}
	// OpenAI-compatible providers return {data:[...]}; some Console endpoints
	// return {models:[...]}. Accept both so the chat picker can list models.
	items := append(payload.Data, payload.Models...)
	models := make([]string, 0, len(items))
	for _, item := range items {
		if item.ID == "" {
			continue
		}
		models = append(models, item.ID)
		if len(models) >= maxProbeModels {
			break
		}
	}
	return resp.StatusCode, models, "", nil
}

func (s *CodingPlanService) probeChat(
	ctx context.Context,
	provider, protocol, base, model, apiKey, sessionID string,
) (int, string, error) {
	base = strings.TrimRight(base, "/")
	endpoint := base + "/chat/completions"
	payload := map[string]any{
		"model":      model,
		"max_tokens": 1,
		"stream":     false,
		"messages":   []map[string]string{{"role": "user", "content": "ping"}},
	}
	if protocol == "anthropic" {
		endpoint = base + "/messages"
		payload = map[string]any{
			"model":      model,
			"max_tokens": 1,
			"messages":   []map[string]string{{"role": "user", "content": "ping"}},
		}
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return 0, "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(string(body)))
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("Content-Type", "application/json")
	applyCodingPlanProbeHeaders(req, provider, protocol, apiKey, sessionID)
	resp, err := s.http.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return resp.StatusCode, SanitizeProbeDetail(resp.Body, apiKey), nil
	}
	return resp.StatusCode, "", nil
}

const openCodeSessionBase62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

// opencodeSessionID derives OpenCode's required `ses_` + 12 hex + 14 base62
// shape from a stable seed (chat session or plan id). It must be stable across
// all requests of a conversation so OpenCode can route/cache consistently.
func opencodeSessionID(seed string) string {
	sum := sha256.Sum256([]byte(seed))
	var b strings.Builder
	b.WriteString("ses_")
	b.WriteString(fmt.Sprintf("%x", sum[:6]))
	for _, v := range sum[6:20] {
		b.WriteByte(openCodeSessionBase62[int(v)%62])
	}
	return b.String()
}

func applyCodingPlanProbeHeaders(req *http.Request, provider, protocol, apiKey, sessionID string) {
	if protocol == "anthropic" {
		req.Header.Set("x-api-key", apiKey)
		req.Header.Set("anthropic-version", "2023-06-01")
	} else {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}
	// OpenCode Go/Console ask clients to send a stable conversation id and a
	// product-specific User-Agent; without the header the router complains it
	// "cannot be routed efficiently".
	isOpenCode := strings.HasPrefix(strings.ToLower(strings.TrimSpace(provider)), "opencode") ||
		req.URL.Hostname() == "opencode.ai"
	if !isOpenCode {
		return
	}
	session := strings.TrimSpace(sessionID)
	if session == "" {
		session = "coding-plan-probe"
	}
	req.Header.Set("x-opencode-session", opencodeSessionID(session))
	req.Header.Set("User-Agent", "MindBase/1.0 (coding-plan)")
}

// SanitizeProbeDetail extracts a short, key-free upstream error message. It
// never returns the raw body verbatim: the configured API key is redacted and
// control characters / excessive length are stripped.
func SanitizeProbeDetail(body io.Reader, apiKey string) string {
	raw, _ := io.ReadAll(io.LimitReader(body, 2048))
	text := strings.TrimSpace(string(raw))
	if text == "" {
		return ""
	}
	if apiKey != "" {
		text = strings.ReplaceAll(text, apiKey, "***")
	}
	var payload struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
		Message string `json:"message"`
	}
	if json.Unmarshal([]byte(text), &payload) == nil {
		if payload.Error.Message != "" {
			text = payload.Error.Message
		} else if payload.Message != "" {
			text = payload.Message
		}
	}
	text = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == '\t' {
			return ' '
		}
		if r < 0x20 {
			return -1
		}
		return r
	}, text)
	text = strings.Join(strings.Fields(text), " ")
	if apiKey != "" {
		text = strings.ReplaceAll(text, apiKey, "***")
	}
	if runes := []rune(text); len(runes) > codingPlanProbeDetail {
		text = string(runes[:codingPlanProbeDetail]) + "…"
	}
	return text
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
