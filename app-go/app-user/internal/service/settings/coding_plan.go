// Coding Plan business logic — settings domain.
//
// Moved out of the auth domain: a Coding Plan is per-user configuration (a
// third-party subscription the user adds in settings), not an identity
// concern. The table (coding_plans) and its DDL/ownedTables entry live in the
// settings domain too; the app_pay config and AES cipher are injected by main.
// Provider URLs/catalog live in default.yaml settings.coding_plan.providers.
package settings

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
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
	ErrCodingPlanModelsFailed  = errors.New("无法获取该 Coding Plan 的模型列表")
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
	db            *gorm.DB
	cipher        *security.Cipher
	plans         *settingsrepo.CodingPlanRepo
	membership    *MembershipClient
	http          *http.Client
	providers     []config.CodingPlanProviderConfig
	providerIndex map[string]int
}

// NewCodingPlanService wires the service against the shared MySQL connection,
// the app_pay membership config (passed in from the auth config section) and
// the AES cipher injected by main.
func NewCodingPlanService(
	db *gorm.DB,
	appPay config.AppPayConfig,
	cipher *security.Cipher,
	providers []config.CodingPlanProviderConfig,
) *CodingPlanService {
	index := make(map[string]int, len(providers))
	for i, p := range providers {
		index[strings.ToLower(strings.TrimSpace(p.Name))] = i
	}
	return &CodingPlanService{
		db:            db,
		cipher:        cipher,
		plans:         settingsrepo.NewCodingPlanRepo(),
		membership:    NewMembershipClient(appPay),
		providers:     providers,
		providerIndex: index,
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
	if _, ok := s.provider(provider); !ok {
		return nil, codingPlanInvalid("provider 不在支持列表中")
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
		if _, ok := s.provider(provider); !ok {
			return nil, codingPlanInvalid("provider 不在支持列表中")
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
