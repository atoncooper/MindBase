package repo

import (
	"log/slog"
	"time"

	"app-auth/internal/model"

	"gorm.io/gorm"
)

// RBACRepo — rbac_role / rbac_user_role access.
type RBACRepo struct{}

func NewRBACRepo() *RBACRepo { return &RBACRepo{} }

// SeedDefaults idempotently seeds the system roles free/admin (parity with
// the Python RbacRepository.seed_defaults).
func (r *RBACRepo) SeedDefaults(db *gorm.DB) error {
	type seed struct {
		id, name, desc string
	}
	for _, s := range []seed{
		{"free", "免费用户", "Default role — basic Q&A and knowledge base"},
		{"admin", "管理员", "System admin — full access"},
	} {
		var n int64
		if err := db.Model(&model.RbacRole{}).Where("role_id = ?", s.id).Count(&n).Error; err != nil {
			return err
		}
		if n > 0 {
			continue
		}
		yes := true
		now := time.Now()
		row := model.RbacRole{
			RoleID:      s.id,
			Name:        s.name,
			Description: &s.desc,
			IsSystem:    &yes,
			CreatedAt:   &now,
			UpdatedAt:   &now,
		}
		if err := db.Create(&row).Error; err != nil {
			return err
		}
		slog.Info("[RBAC] seeded role", "role_id", s.id)
	}
	return nil
}

// GetUserRoles returns the active role ids for a user (used by verify to
// build the X-Roles header).
func (r *RBACRepo) GetUserRoles(db *gorm.DB, uid int64) ([]string, error) {
	var roles []string
	err := db.Model(&model.RbacUserRole{}).
		Where("uid = ? AND is_active = 1 AND (expires_at IS NULL OR expires_at > ?)", uid, time.Now()).
		Pluck("role_id", &roles).Error
	return roles, err
}

// GrantRole grants a role to a user (skipped when already active).
func (r *RBACRepo) GrantRole(db *gorm.DB, uid int64, roleID string, grantedBy int64) error {
	var n int64
	if err := db.Model(&model.RbacUserRole{}).
		Where("uid = ? AND role_id = ? AND is_active = 1", uid, roleID).
		Count(&n).Error; err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	now := time.Now()
	gb := grantedBy
	active := true
	return db.Create(&model.RbacUserRole{
		UID:       uid,
		RoleID:    roleID,
		GrantedBy: &gb,
		GrantedAt: &now,
		IsActive:  &active,
		CreatedAt: &now,
	}).Error
}
