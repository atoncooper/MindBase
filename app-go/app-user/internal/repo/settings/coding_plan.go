// Coding Plan repository — user-owned third-party coding-plan endpoints
// (settings domain). Every read is scoped by uid so one account can never
// address another's row. Moved from internal/repo/auth when the table's
// ownership moved to the settings DDL.
package repo

import (
	"time"

	"app-user/internal/model/settings"

	"gorm.io/gorm"
)

// CodingPlanRepo is the data access for coding_plans.
type CodingPlanRepo struct{}

func NewCodingPlanRepo() *CodingPlanRepo { return &CodingPlanRepo{} }

// ListByUID returns the caller's plans in creation order.
func (r *CodingPlanRepo) ListByUID(db *gorm.DB, uid int64) ([]model.CodingPlan, error) {
	var rows []model.CodingPlan
	err := db.Where("uid = ?", uid).Order("id ASC").Find(&rows).Error
	return rows, err
}

// GetByID returns one plan only when it belongs to uid (nil = not found).
func (r *CodingPlanRepo) GetByID(db *gorm.DB, uid, id int64) (*model.CodingPlan, error) {
	var row model.CodingPlan
	err := db.Where("uid = ? AND id = ?", uid, id).First(&row).Error
	if err == gorm.ErrRecordNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// FirstEnabled returns the oldest enabled plan for uid (internal M2M face).
func (r *CodingPlanRepo) FirstEnabled(db *gorm.DB, uid int64) (*model.CodingPlan, error) {
	var row model.CodingPlan
	err := db.Where("uid = ? AND enabled = ?", uid, true).Order("id ASC").First(&row).Error
	if err == gorm.ErrRecordNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// CountByUID counts the caller's plans (max-5 rule).
func (r *CodingPlanRepo) CountByUID(db *gorm.DB, uid int64) (int64, error) {
	var n int64
	err := db.Model(&model.CodingPlan{}).Where("uid = ?", uid).Count(&n).Error
	return n, err
}

// Create inserts one plan and fills its generated id.
func (r *CodingPlanRepo) Create(db *gorm.DB, plan *model.CodingPlan) error {
	return db.Create(plan).Error
}

// UpdateFields patches the caller's plan; returns false when no owned row
// matched (deleted concurrently / wrong owner).
func (r *CodingPlanRepo) UpdateFields(db *gorm.DB, uid, id int64, fields map[string]any) (bool, error) {
	if len(fields) == 0 {
		return true, nil
	}
	if _, ok := fields["updated_at"]; !ok {
		fields["updated_at"] = time.Now()
	}
	res := db.Model(&model.CodingPlan{}).Where("uid = ? AND id = ?", uid, id).Updates(fields)
	return res.RowsAffected > 0, res.Error
}

// Delete removes the caller's plan; returns false when nothing matched.
func (r *CodingPlanRepo) Delete(db *gorm.DB, uid, id int64) (bool, error) {
	res := db.Where("uid = ? AND id = ?", uid, id).Delete(&model.CodingPlan{})
	return res.RowsAffected > 0, res.Error
}
