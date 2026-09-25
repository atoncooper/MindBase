package service

import (
	"context"

	"app-auth/internal/repo"

	"gorm.io/gorm"
)

// RBACService — role queries over rbac_role/rbac_user_role.
type RBACService struct {
	db   *gorm.DB
	rbac *repo.RBACRepo
}

func NewRBACService(db *gorm.DB) *RBACService {
	return &RBACService{db: db, rbac: repo.NewRBACRepo()}
}

// repoRef exposes the underlying repo (service-internal wiring).
func (s *RBACService) repoRef() *repo.RBACRepo { return s.rbac }

// SeedDefaults idempotently seeds the system roles at startup.
func (s *RBACService) SeedDefaults() error {
	return s.rbac.SeedDefaults(s.db)
}

// GetUserRoles returns the active role ids for a user.
func (s *RBACService) GetUserRoles(ctx context.Context, uid int64) ([]string, error) {
	return s.rbac.GetUserRoles(s.db, uid)
}

// GrantRole grants a role (idempotent when already active).
func (s *RBACService) GrantRole(ctx context.Context, uid int64, roleID string, grantedBy int64) error {
	return s.rbac.GrantRole(s.db, uid, roleID, grantedBy)
}
