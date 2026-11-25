// MCP repository — per-user third-party MCP connections (settings domain).
// Every read is scoped by uid, so one account can never address another's row.
// The table is owned by internal/infra/db/settings (user configuration, not
// identity), next to coding_plans.
package repo

import (
	"time"

	"app-user/internal/model/settings"

	"gorm.io/gorm"
)

// MCPRepo is the data access for user_mcp_servers.
type MCPRepo struct{}

func NewMCPRepo() *MCPRepo { return &MCPRepo{} }

// ListByUID returns the caller's connections in creation order.
func (r *MCPRepo) ListByUID(db *gorm.DB, uid int64) ([]model.UserMCPServer, error) {
	var rows []model.UserMCPServer
	err := db.Where("uid = ?", uid).Order("id ASC").Find(&rows).Error
	return rows, err
}

// GetByID returns one connection only when it belongs to uid (nil = not found).
func (r *MCPRepo) GetByID(db *gorm.DB, uid, id int64) (*model.UserMCPServer, error) {
	var row model.UserMCPServer
	err := db.Where("uid = ? AND id = ?", uid, id).First(&row).Error
	if err == gorm.ErrRecordNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// GetByName returns one connection by its per-user unique name.
func (r *MCPRepo) GetByName(db *gorm.DB, uid int64, name string) (*model.UserMCPServer, error) {
	var row model.UserMCPServer
	err := db.Where("uid = ? AND name = ?", uid, name).First(&row).Error
	if err == gorm.ErrRecordNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// CountByUID counts the caller's connections (per-user limit).
func (r *MCPRepo) CountByUID(db *gorm.DB, uid int64) (int64, error) {
	var n int64
	err := db.Model(&model.UserMCPServer{}).Where("uid = ?", uid).Count(&n).Error
	return n, err
}

// Create inserts one connection and fills its generated id.
func (r *MCPRepo) Create(db *gorm.DB, row *model.UserMCPServer) error {
	return db.Create(row).Error
}

// UpdateFields patches the caller's connection; false when no owned row
// matched (deleted concurrently / wrong owner).
func (r *MCPRepo) UpdateFields(db *gorm.DB, uid, id int64, fields map[string]any) (bool, error) {
	if len(fields) == 0 {
		return true, nil
	}
	if _, ok := fields["updated_at"]; !ok {
		fields["updated_at"] = time.Now()
	}
	res := db.Model(&model.UserMCPServer{}).Where("uid = ? AND id = ?", uid, id).Updates(fields)
	return res.RowsAffected > 0, res.Error
}

// Delete removes the caller's connection; false when nothing matched.
func (r *MCPRepo) Delete(db *gorm.DB, uid, id int64) (bool, error) {
	res := db.Where("uid = ? AND id = ?", uid, id).Delete(&model.UserMCPServer{})
	return res.RowsAffected > 0, res.Error
}
