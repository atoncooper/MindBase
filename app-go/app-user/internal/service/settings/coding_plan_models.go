package settings

import (
	"context"
	"fmt"
	"log/slog"

	settingsdto "app-user/internal/dto/settings"
	settingsmodel "app-user/internal/model/settings"
)

// ListModels returns the provider's model catalog for the chat model picker and
// the account editor. Redis serves warm calls; refresh=true forces a probe and
// rewrites the cache. Nothing is persisted in MySQL.
func (s *CodingPlanService) ListModels(ctx context.Context, uid, id int64, refresh bool) (*settingsdto.CodingPlanModels, error) {
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
	models, err := s.modelsForRow(ctx, row, refresh)
	if err != nil {
		return nil, err
	}
	slog.Info("[CODING_PLAN] models listed",
		"uid", uid, "plan_id", row.ID, "provider", row.Provider, "count", len(models), "refresh", refresh)
	return &settingsdto.CodingPlanModels{
		PlanID:   row.ID,
		Provider: row.Provider,
		Protocol: row.Protocol,
		Models:   models,
	}, nil
}

// InternalModels is the M2M face app-ts uses to pick the default model when the
// plan row has no explicit model. Shares the same Redis cache as the user face.
func (s *CodingPlanService) InternalModels(ctx context.Context, uid int64) (*settingsdto.CodingPlanModels, error) {
	if err := s.RequireVIP(ctx, uid); err != nil {
		return nil, err
	}
	row, _, err := s.defaultOrFirstEnabled(uid)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, ErrCodingPlanNotFound
	}
	models, err := s.modelsForRow(ctx, row, false)
	if err != nil {
		return nil, err
	}
	return &settingsdto.CodingPlanModels{
		PlanID:   row.ID,
		Provider: row.Provider,
		Protocol: row.Protocol,
		Models:   models,
	}, nil
}

// modelsForRow serves the catalog from Redis when warm, otherwise probes the
// provider once and caches the result.
func (s *CodingPlanService) modelsForRow(
	ctx context.Context,
	row *settingsmodel.CodingPlan,
	refresh bool,
) ([]string, error) {
	if !refresh {
		if models, ok := s.cachedModels(ctx, row.ID); ok {
			slog.Debug("[CODING_PLAN] models cache hit", "plan_id", row.ID, "count", len(models))
			return models, nil
		}
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
	s.storeModels(ctx, row.ID, models)
	return models, nil
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
