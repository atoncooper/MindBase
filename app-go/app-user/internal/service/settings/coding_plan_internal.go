package settings

import (
	"context"
	"fmt"
	"log/slog"

	settingsdto "app-user/internal/dto/settings"
	"app-user/internal/infra/security"
	settingsmodel "app-user/internal/model/settings"
)

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
		BaseURL:  s.effectiveBaseURL(row.Provider, row.Protocol, row.BaseURL),
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
		row.ID, row.Provider, row.Protocol, derefString(row.Label),
		s.effectiveBaseURL(row.Provider, row.Protocol, row.BaseURL),
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
