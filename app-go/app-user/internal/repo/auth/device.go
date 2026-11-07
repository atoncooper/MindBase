package repo

import (
	"time"

	"app-user/internal/model/auth"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// DeviceRepo — user_device upsert/list.
type DeviceRepo struct{}

func NewDeviceRepo() *DeviceRepo { return &DeviceRepo{} }

// Upsert inserts or refreshes a device fingerprint row for a user in ONE
// statement (INSERT ... ON DUPLICATE KEY UPDATE): the old SELECT-then-UPDATE
// cost two round trips on every login and raced on concurrent first logins.
func (r *DeviceRepo) Upsert(db *gorm.DB, d *model.UserDevice) error {
	now := time.Now()
	d.LastActiveAt = &now
	if d.CreatedAt == nil {
		d.CreatedAt = &now
	}
	return db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "device_id"}},
		DoUpdates: clause.Assignments(map[string]any{"last_active_at": now}),
	}).Create(d).Error
}

// ListByUID returns the user's non-deleted devices, most recent first.
func (r *DeviceRepo) ListByUID(db *gorm.DB, uid int64) ([]model.UserDevice, error) {
	var rows []model.UserDevice
	err := db.Where("uid = ? AND deleted_at IS NULL", uid).
		Order("last_active_at DESC").Find(&rows).Error
	return rows, err
}
