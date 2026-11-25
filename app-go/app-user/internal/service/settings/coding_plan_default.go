package settings

import (
	"context"
	"log/slog"

	settingsmodel "app-user/internal/model/settings"
)

// SetDefault marks one owned, enabled plan as the chat default (at most one
// per user). The plan's model is the default model used by chat turns.
func (s *CodingPlanService) SetDefault(ctx context.Context, uid, id int64) error {
	if err := s.RequireVIP(ctx, uid); err != nil {
		return err
	}
	row, err := s.plans.GetByID(s.db, uid, id)
	if err != nil {
		return err
	}
	if row == nil {
		return ErrCodingPlanNotFound
	}
	if row.Enabled != nil && !*row.Enabled {
		return codingPlanInvalid("请先启用该套餐再设为默认")
	}
	if err := s.plans.SetDefault(s.db, uid, id); err != nil {
		return err
	}
	slog.Info("[CODING_PLAN] default plan set", "uid", uid, "plan_id", id)
	return nil
}

// ClearDefault removes the caller's default selection (chat falls back to the
// platform gateway unless a plan is picked explicitly).
func (s *CodingPlanService) ClearDefault(ctx context.Context, uid int64) error {
	if err := s.RequireVIP(ctx, uid); err != nil {
		return err
	}
	if err := s.plans.ClearDefault(s.db, uid); err != nil {
		return err
	}
	slog.Info("[CODING_PLAN] default plan cleared", "uid", uid)
	return nil
}

// defaultOrFirstEnabled prefers the user's default plan (when still enabled),
// otherwise the oldest enabled plan (explicit model picks only).
func (s *CodingPlanService) defaultOrFirstEnabled(uid int64) (*settingsmodel.CodingPlan, bool, error) {
	def, err := s.plans.GetDefault(s.db, uid)
	if err != nil {
		return nil, false, err
	}
	if def != nil {
		row, err := s.plans.GetByID(s.db, uid, def.PlanID)
		if err != nil {
			return nil, false, err
		}
		if row != nil && (row.Enabled == nil || *row.Enabled) {
			return row, true, nil
		}
	}
	row, err := s.plans.FirstEnabled(s.db, uid)
	if err != nil {
		return nil, false, err
	}
	return row, false, nil
}
