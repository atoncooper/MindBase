// Coding Plan default selection (settings domain): at most one plan per user
// is the default chat model. Companion table keeps coding_plans CREATE-only.
package repo

import (
	"time"

	"app-user/internal/model/settings"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// GetDefault returns the caller's default plan selection (nil = none).
func (r *CodingPlanRepo) GetDefault(db *gorm.DB, uid int64) (*model.CodingPlanDefault, error) {
	var row model.CodingPlanDefault
	err := db.Where("uid = ?", uid).First(&row).Error
	if err == gorm.ErrRecordNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// SetDefault upserts the caller's default plan.
func (r *CodingPlanRepo) SetDefault(db *gorm.DB, uid, planID int64) error {
	now := time.Now()
	return db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "uid"}},
		UpdateAll: true,
	}).Create(&model.CodingPlanDefault{
		UID:       uid,
		PlanID:    planID,
		CreatedAt: &now,
		UpdatedAt: &now,
	}).Error
}

// ClearDefault removes the caller's default selection.
func (r *CodingPlanRepo) ClearDefault(db *gorm.DB, uid int64) error {
	return db.Where("uid = ?", uid).Delete(&model.CodingPlanDefault{}).Error
}

// ClearDefaultIfPlan removes the default only when it points at planID.
func (r *CodingPlanRepo) ClearDefaultIfPlan(db *gorm.DB, uid, planID int64) error {
	return db.Where("uid = ? AND plan_id = ?", uid, planID).Delete(&model.CodingPlanDefault{}).Error
}
