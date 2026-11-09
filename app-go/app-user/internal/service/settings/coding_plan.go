// Coding Plan business logic — settings domain.
//
// Moved out of the auth domain: a Coding Plan is per-user configuration (a
// third-party subscription the user adds in settings), not an identity
// concern. The table (coding_plans) and its DDL/ownedTables entry live in the
// settings domain too; the app_pay config and AES cipher are injected by main.
package settings

import (
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

	"app-user/internal/config"
	settingsdto "app-user/internal/dto/settings"
	"app-user/internal/infra/security"
	settingsmodel "app-user/internal/model/settings"
	settingsrepo "app-user/internal/repo/settings"

	"gorm.io/gorm"
)

// Coding Plan limits / validation bounds.
const (
	maxCodingPlansPerUID   = 5
	maxCodingPlanLabel     = 100
	maxCodingPlanBaseURL   = 500
	maxCodingPlanModel     = 200
	maxCodingPlanAPIKey    = 4096
	maxProbeModels         = 50
	codingPlanProbeTimeout = 15 * time.Second
	codingPlanProbeDetail  = 160
)

// Coding Plan business errors — the router maps them to HTTP status codes.
var (
	ErrCodingPlanVIPOnly       = errors.New("Coding Plan 仅 VIP/SVIP 可用")
	ErrMembershipUnavailable   = errors.New("会员校验服务暂不可用，请稍后重试")
	ErrCodingPlanNotFound      = errors.New("Coding Plan 不存在")
	ErrCodingPlanLimit         = errors.New("最多添加 5 个 Coding Plan")
	ErrCodingPlanDecryptFailed = errors.New("Coding Plan 凭据解密失败")
)

// CodingPlanValidationError marks caller-fixable input errors (HTTP 400).
type CodingPlanValidationError struct{ msg string }

func (e *CodingPlanValidationError) Error() string { return e.msg }

func codingPlanInvalid(format string, args ...any) error {
	return &CodingPlanValidationError{msg: fmt.Sprintf(format, args...)}
}

// CodingPlanInput is a create payload (already bound by the router DTO).
type CodingPlanInput struct {
	Provider string
	Protocol string
	Label    string
	BaseURL  string
	Model    string
	APIKey   string
	Enabled  *bool
}

// CodingPlanPatch is a partial update; nil fields are untouched and an empty
// APIKey means "keep the stored key".
type CodingPlanPatch struct {
	Provider *string
	Protocol *string
	Label    *string
	BaseURL  *string
	Model    *string
	APIKey   *string
	Enabled  *bool
}

// CodingPlanInternal is the M2M payload (plaintext key only on this face).
type CodingPlanInternal struct {
	ID       int64
	Provider string
	Protocol string
	Label    string
	BaseURL  string
	Model    string
	APIKey   string
}

// CodingPlanService owns user CRUD, the VIP/SVIP gate and the internal
// first-enabled-plan lookup for the in-site code agent.
type CodingPlanService struct {
	db         *gorm.DB
	cipher     *security.Cipher
	plans      *settingsrepo.CodingPlanRepo
	membership *MembershipClient
	http       *http.Client
}

// NewCodingPlanService wires the service against the shared MySQL connection,
// the app_pay membership config (passed in from the auth config section) and
// the AES cipher injected by main.
func NewCodingPlanService(db *gorm.DB, appPay config.AppPayConfig, cipher *security.Cipher) *CodingPlanService {
	return &CodingPlanService{
		db:         db,
		cipher:     cipher,
		plans:      settingsrepo.NewCodingPlanRepo(),
		membership: NewMembershipClient(appPay),
		http: &http.Client{
			Timeout:   codingPlanProbeTimeout,
			Transport: &http.Transport{Proxy: http.ProxyFromEnvironment},
		},
	}
}

// RequireVIP enforces the membership gate: vip/svip only, fail-closed when the
// pay service cannot be reached.
func (s *CodingPlanService) RequireVIP(ctx context.Context, uid int64) error {
	return RequireVIPTier(ctx, s.membership, uid)
}

// RequireVIPTier is the exported gate seam for the black-box tests in tests/.
// Production callers use CodingPlanService.RequireVIP.
func RequireVIPTier(ctx context.Context, membership *MembershipClient, uid int64) error {
	tier, err := membership.Tier(ctx, uid)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrMembershipUnavailable, err)
	}
	if tier != TierVIP && tier != TierSVIP {
		return ErrCodingPlanVIPOnly
	}
	return nil
}

// ListPlans returns the caller's plans (key masked, never plaintext).
func (s *CodingPlanService) ListPlans(ctx context.Context, uid int64) ([]settingsdto.CodingPlan, error) {
	if err := s.RequireVIP(ctx, uid); err != nil {
		return nil, err
	}
	rows, err := s.plans.ListByUID(s.db, uid)
	if err != nil {
		return nil, err
	}
	out := make([]settingsdto.CodingPlan, 0, len(rows))
	for i := range rows {
		out = append(out, *s.toDTO(&rows[i]))
	}
	return out, nil
}

// CreatePlan adds a plan (max 5 per uid), encrypting the API key at rest.
func (s *CodingPlanService) CreatePlan(ctx context.Context, uid int64, in CodingPlanInput) (*settingsdto.CodingPlan, error) {
	if err := s.RequireVIP(ctx, uid); err != nil {
		return nil, err
	}
	provider, err := NormalizeCodingPlanProvider(in.Provider)
	if err != nil {
		return nil, err
	}
	protocol, err := NormalizeCodingPlanProtocol(in.Protocol)
	if err != nil {
		return nil, err
	}
	label, err := NormalizeCodingPlanLabel(in.Label, provider)
	if err != nil {
		return nil, err
	}
	baseURL, err := NormalizeCodingPlanBaseURL(in.BaseURL)
	if err != nil {
		return nil, err
	}
	modelName, err := NormalizeCodingPlanModel(in.Model)
	if err != nil {
		return nil, err
	}
	apiKey, err := NormalizeCodingPlanAPIKey(in.APIKey, true)
	if err != nil {
		return nil, err
	}
	count, err := s.plans.CountByUID(s.db, uid)
	if err != nil {
		return nil, err
	}
	if count >= maxCodingPlansPerUID {
		return nil, ErrCodingPlanLimit
	}
	enc, err := s.cipher.Encrypt(apiKey)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	enabled := true
	if in.Enabled != nil {
		enabled = *in.Enabled
	}
	row := &settingsmodel.CodingPlan{
		UID:       uid,
		Provider:  provider,
		Protocol:  protocol,
		Label:     &label,
		BaseURL:   baseURL,
		Model:     &modelName,
		APIKeyEnc: enc,
		Enabled:   &enabled,
		CreatedAt: &now,
		UpdatedAt: &now,
	}
	if err := s.plans.Create(s.db, row); err != nil {
		return nil, err
	}
	slog.Info("[CODING_PLAN] plan created",
		"uid", uid, "plan_id", row.ID, "provider", provider, "protocol", protocol, "model", modelName)
	return s.toDTO(row), nil
}

// UpdatePlan patches owned fields; an empty api_key keeps the stored ciphertext.
func (s *CodingPlanService) UpdatePlan(ctx context.Context, uid, id int64, patch CodingPlanPatch) (*settingsdto.CodingPlan, error) {
	if err := s.RequireVIP(ctx, uid); err != nil {
		return nil, err
	}
	row, err := s.plans.GetByID(s.db, uid, id)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, ErrCodingPlanNotFound
	}
	fields := map[string]any{}
	provider := row.Provider
	if patch.Provider != nil {
		provider, err = NormalizeCodingPlanProvider(*patch.Provider)
		if err != nil {
			return nil, err
		}
		fields["provider"] = provider
	}
	if patch.Protocol != nil {
		protocol, perr := NormalizeCodingPlanProtocol(*patch.Protocol)
		if perr != nil {
			return nil, perr
		}
		fields["protocol"] = protocol
	}
	if patch.Label != nil {
		label, lerr := NormalizeCodingPlanLabel(*patch.Label, provider)
		if lerr != nil {
			return nil, lerr
		}
		fields["label"] = label
	}
	if patch.BaseURL != nil {
		baseURL, berr := NormalizeCodingPlanBaseURL(*patch.BaseURL)
		if berr != nil {
			return nil, berr
		}
		fields["base_url"] = baseURL
	}
	if patch.Model != nil {
		model, merr := NormalizeCodingPlanModel(*patch.Model)
		if merr != nil {
			return nil, merr
		}
		fields["model"] = model
	}
	if patch.APIKey != nil {
		if key := strings.TrimSpace(*patch.APIKey); key != "" {
			if len(key) > maxCodingPlanAPIKey {
				return nil, codingPlanInvalid("API Key 过长")
			}
			enc, eerr := s.cipher.Encrypt(key)
			if eerr != nil {
				return nil, eerr
			}
			fields["api_key_enc"] = enc
		}
	}
	if patch.Enabled != nil {
		fields["enabled"] = *patch.Enabled
	}
	if len(fields) == 0 {
		return s.toDTO(row), nil
	}
	ok, err := s.plans.UpdateFields(s.db, uid, id, fields)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, ErrCodingPlanNotFound
	}
	refreshed, err := s.plans.GetByID(s.db, uid, id)
	if err != nil {
		return nil, err
	}
	if refreshed == nil {
		return nil, ErrCodingPlanNotFound
	}
	slog.Info("[CODING_PLAN] plan updated",
		"uid", uid, "plan_id", id, "provider", refreshed.Provider, "model", derefString(refreshed.Model))
	return s.toDTO(refreshed), nil
}

// DeletePlan removes one owned plan.
func (s *CodingPlanService) DeletePlan(ctx context.Context, uid, id int64) error {
	if err := s.RequireVIP(ctx, uid); err != nil {
		return err
	}
	ok, err := s.plans.Delete(s.db, uid, id)
	if err != nil {
		return err
	}
	if !ok {
		return ErrCodingPlanNotFound
	}
	slog.Info("[CODING_PLAN] plan deleted", "uid", uid, "plan_id", id)
	return nil
}

// Test probes the configured endpoint (models list, then a minimal chat call).
// It never persists anything and never echoes the API key.
func (s *CodingPlanService) Test(ctx context.Context, uid, id int64) (*settingsdto.CodingPlanTestResponse, error) {
	if err := s.RequireVIP(ctx, uid); err != nil {
		return nil, err
	}
	row, err := s.plans.GetByID(s.db, uid, id)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, ErrCodingPlanNotFound
	}
	apiKey, err := s.cipher.Decrypt(row.APIKeyEnc)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrCodingPlanDecryptFailed, err)
	}
	result := s.probe(ctx, row.Protocol, row.BaseURL, derefString(row.Model), apiKey)
	slog.Info("[CODING_PLAN] plan tested",
		"uid", uid, "plan_id", row.ID, "provider", row.Provider, "model", derefString(row.Model), "ok", result.OK)
	return result, nil
}

// InternalGet returns the oldest enabled plan with a decrypted key for the AI
// stack M2M face. Callers must already be authenticated by the internal key.
func (s *CodingPlanService) InternalGet(ctx context.Context, uid int64) (*CodingPlanInternal, error) {
	if err := s.RequireVIP(ctx, uid); err != nil {
		return nil, err
	}
	row, err := s.plans.FirstEnabled(s.db, uid)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, ErrCodingPlanNotFound
	}
	apiKey, err := s.cipher.Decrypt(row.APIKeyEnc)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrCodingPlanDecryptFailed, err)
	}
	slog.Info("[CODING_PLAN] internal plan served",
		"uid", uid, "plan_id", row.ID, "provider", row.Provider, "model", derefString(row.Model))
	return &CodingPlanInternal{
		ID:       row.ID,
		Provider: row.Provider,
		Protocol: row.Protocol,
		Label:    derefString(row.Label),
		BaseURL:  row.BaseURL,
		Model:    derefString(row.Model),
		APIKey:   apiKey,
	}, nil
}

// ── DTO mapping / masking ───────────────────────────────────────────────────

func (s *CodingPlanService) toDTO(row *settingsmodel.CodingPlan) *settingsdto.CodingPlan {
	key, err := s.cipher.Decrypt(row.APIKeyEnc)
	if err != nil {
		slog.Warn("[CODING_PLAN] mask decrypt failed", "uid", row.UID, "plan_id", row.ID, "err", err)
		key = "****"
	}
	v := settingsdto.NewCodingPlanView(
		row.ID, row.Provider, row.Protocol, derefString(row.Label), row.BaseURL,
		derefString(row.Model), key, row.Enabled == nil || *row.Enabled,
		row.CreatedAt, row.UpdatedAt,
	)
	return &v
}

// BuildCodingPlanDTO is the exported seam for the black-box tests in tests/:
// it returns the masked response DTO without exposing the service internals.
func BuildCodingPlanDTO(cipher *security.Cipher, row *settingsmodel.CodingPlan) *settingsdto.CodingPlan {
	return (&CodingPlanService{cipher: cipher}).toDTO(row)
}

// ── validation ───────────────────────────────────────────────────────

// supportedCodingPlanProviders keeps provider identifiers stable for the stored
// rows and lets the UI offer common coding-plan subscriptions without a schema
// change (provider is a varchar(32) slug).
var supportedCodingPlanProviders = map[string]bool{
	"opencode":     true,
	"opencode_zen": true,
	"opencode_go":  true,
	"kimi":         true,
	"glm":          true,
	"minimax":      true,
	"qwen":         true,
	"deepseek":     true,
	"custom":       true,
}

func NormalizeCodingPlanProvider(raw string) (string, error) {
	p := strings.ToLower(strings.TrimSpace(raw))
	if supportedCodingPlanProviders[p] {
		return p, nil
	}
	return "", codingPlanInvalid("provider 不在支持列表中")
}

func NormalizeCodingPlanProtocol(raw string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "openai":
		return "openai", nil
	case "anthropic":
		return "anthropic", nil
	default:
		return "", codingPlanInvalid("protocol 必须是 openai 或 anthropic")
	}
}

func NormalizeCodingPlanLabel(raw, provider string) (string, error) {
	label := strings.TrimSpace(raw)
	if label == "" {
		label = provider
	}
	if len([]rune(label)) > maxCodingPlanLabel {
		return "", codingPlanInvalid("名称不能超过 %d 个字符", maxCodingPlanLabel)
	}
	return label, nil
}

func NormalizeCodingPlanBaseURL(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", codingPlanInvalid("请填写 base_url")
	}
	if len(value) > maxCodingPlanBaseURL {
		return "", codingPlanInvalid("base_url 过长")
	}
	u, err := url.Parse(value)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "", codingPlanInvalid("base_url 必须是合法的 http(s) 地址")
	}
	if u.User != nil {
		return "", codingPlanInvalid("base_url 不能包含用户名或密码")
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return "", codingPlanInvalid("base_url 不能包含查询参数或片段")
	}
	return strings.TrimRight(value, "/"), nil
}

func NormalizeCodingPlanModel(raw string) (string, error) {
	model := strings.TrimSpace(raw)
	if model == "" {
		return "", codingPlanInvalid("请填写 model")
	}
	if len([]rune(model)) > maxCodingPlanModel {
		return "", codingPlanInvalid("model 过长")
	}
	return model, nil
}

func NormalizeCodingPlanAPIKey(raw string, required bool) (string, error) {
	key := strings.TrimSpace(raw)
	if key == "" {
		if required {
			return "", codingPlanInvalid("请填写 api_key")
		}
		return "", nil
	}
	if len(key) > maxCodingPlanAPIKey {
		return "", codingPlanInvalid("api_key 过长")
	}
	return key, nil
}

func derefString(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// ── probe (models list → minimal chat) ───────────────────────────────

// ProbeCodingPlan is the exported seam for the black-box tests in tests/:
// it runs the same models-list → chat fallback probe with no persistence.
func ProbeCodingPlan(ctx context.Context, client *http.Client, protocol, baseURL, model, apiKey string) *settingsdto.CodingPlanTestResponse {
	if client == nil {
		client = &http.Client{
			Timeout:   codingPlanProbeTimeout,
			Transport: &http.Transport{Proxy: http.ProxyFromEnvironment},
		}
	}
	return (&CodingPlanService{http: client}).probe(ctx, protocol, baseURL, model, apiKey)
}

func (s *CodingPlanService) probe(ctx context.Context, protocol, baseURL, model, apiKey string) *settingsdto.CodingPlanTestResponse {
	base := strings.TrimRight(baseURL, "/")

	modelsStatus, models, modelsDetail, modelsErr := s.probeModels(ctx, protocol, base, apiKey)
	if modelsErr == nil && modelsStatus == http.StatusOK {
		return &settingsdto.CodingPlanTestResponse{OK: true, Message: "连接成功", Models: models}
	}

	chatStatus, chatDetail, chatErr := s.probeChat(ctx, protocol, base, model, apiKey)
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

func (s *CodingPlanService) probeModels(ctx context.Context, protocol, base, apiKey string) (int, []string, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/models", nil)
	if err != nil {
		return 0, nil, "", err
	}
	applyCodingPlanProbeAuth(req, protocol, apiKey)
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
	var payload struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if json.Unmarshal(body, &payload) != nil {
		return resp.StatusCode, nil, "", nil
	}
	models := make([]string, 0, len(payload.Data))
	for _, item := range payload.Data {
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

func (s *CodingPlanService) probeChat(ctx context.Context, protocol, base, model, apiKey string) (int, string, error) {
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
	applyCodingPlanProbeAuth(req, protocol, apiKey)
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

func applyCodingPlanProbeAuth(req *http.Request, protocol, apiKey string) {
	if protocol == "anthropic" {
		req.Header.Set("x-api-key", apiKey)
		req.Header.Set("anthropic-version", "2023-06-01")
		return
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
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
