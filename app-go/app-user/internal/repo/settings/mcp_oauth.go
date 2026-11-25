// MCP OAuth repository — per-connection OAuth credentials and pending
// authorization states (settings domain). Scoped by uid like every other
// settings table.
package repo

import (
	"time"

	"app-user/internal/model/settings"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// MCPOAuthRepo is the data access for user_mcp_oauth / user_mcp_oauth_states.
type MCPOAuthRepo struct{}

func NewMCPOAuthRepo() *MCPOAuthRepo { return &MCPOAuthRepo{} }

// Get returns the OAuth credentials of one owned connection (nil = none).
func (r *MCPOAuthRepo) Get(db *gorm.DB, uid, serverID int64) (*model.UserMCPOAuth, error) {
	var row model.UserMCPOAuth
	err := db.Where("uid = ? AND server_id = ?", uid, serverID).First(&row).Error
	if err == gorm.ErrRecordNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// Upsert writes (or replaces) the credentials of one connection.
func (r *MCPOAuthRepo) Upsert(db *gorm.DB, row *model.UserMCPOAuth) error {
	return db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "uid"}, {Name: "server_id"}},
		UpdateAll: true,
	}).Create(row).Error
}

// Delete removes the credentials of one connection.
func (r *MCPOAuthRepo) Delete(db *gorm.DB, uid, serverID int64) (bool, error) {
	res := db.Where("uid = ? AND server_id = ?", uid, serverID).Delete(&model.UserMCPOAuth{})
	return res.RowsAffected > 0, res.Error
}

// CreateState stores one pending authorization request.
func (r *MCPOAuthRepo) CreateState(db *gorm.DB, st *model.UserMCPOAuthState) error {
	return db.Create(st).Error
}

// GetState returns a pending request by state (nil = unknown/expired).
func (r *MCPOAuthRepo) GetState(db *gorm.DB, state string) (*model.UserMCPOAuthState, error) {
	var row model.UserMCPOAuthState
	err := db.Where("state = ?", state).First(&row).Error
	if err == gorm.ErrRecordNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// DeleteState consumes a state; false = it was already consumed.
func (r *MCPOAuthRepo) DeleteState(db *gorm.DB, state string) (bool, error) {
	res := db.Where("state = ?", state).Delete(&model.UserMCPOAuthState{})
	return res.RowsAffected > 0, res.Error
}

// DeleteExpiredStates prunes abandoned authorization attempts.
func (r *MCPOAuthRepo) DeleteExpiredStates(db *gorm.DB, now time.Time) error {
	return db.Where("expires_at < ?", now).Delete(&model.UserMCPOAuthState{}).Error
}
