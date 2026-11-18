package settings

import (
	"context"
	"fmt"
	"log/slog"

	settingsdto "app-user/internal/dto/settings"
)

// ListModels returns the provider's model catalog for the chat model picker.
// It probes on demand (not during configuration) and never persists anything.
func (s *CodingPlanService) ListModels(ctx context.Context, uid, id int64) (*settingsdto.CodingPlanModels, error) {
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
	base := s.effectiveBaseURL(row.Provider, row.Protocol, row.BaseURL)
	_, models, detail, modelsErr := s.probeModels(
		ctx,
		row.Provider,
		row.Protocol,
		base,
		apiKey,
		fmt.Sprintf("coding-plan-models-%d", row.ID),
	)
	if modelsErr != nil {
		return nil, fmt.Errorf("%w: %s", ErrCodingPlanModelsFailed, detail)
	}
	slog.Info("[CODING_PLAN] models listed", "uid", uid, "plan_id", row.ID, "provider", row.Provider, "count", len(models))
	return &settingsdto.CodingPlanModels{
		PlanID:   row.ID,
		Provider: row.Provider,
		Protocol: row.Protocol,
		Models:   models,
	}, nil
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
	base := s.effectiveBaseURL(row.Provider, row.Protocol, row.BaseURL)
	result := s.probe(
		ctx,
		row.Provider,
		row.Protocol,
		base,
		derefString(row.Model),
		apiKey,
		fmt.Sprintf("coding-plan-test-%d", row.ID),
	)
	slog.Info("[CODING_PLAN] plan tested",
		"uid", uid, "plan_id", row.ID, "provider", row.Provider, "model", derefString(row.Model), "ok", result.OK)
	return result, nil
}
