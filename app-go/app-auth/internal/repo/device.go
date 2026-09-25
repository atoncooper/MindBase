package repo

import (
	"time"

	"app-auth/internal/model"

	"gorm.io/gorm"
)

// DeviceRepo — user_device upsert/list.
type DeviceRepo struct{}

func NewDeviceRepo() *DeviceRepo { return &DeviceRepo{} }

// Upsert inserts or refreshes a device fingerprint row for a user.
func (r *DeviceRepo) Upsert(db *gorm.DB, d *model.UserDevice) error {
	now := time.Now()
	if d.LastActiveAt == nil {
		d.LastActiveAt = &now
	}
	var existing model.UserDevice
	err := db.Where("device_id = ?", d.DeviceID).First(&existing).Error
	if err != nil {
		if err == gorm.ErrRecordNotFound {
			if d.CreatedAt == nil {
				d.CreatedAt = &now
			}
			return db.Create(d).Error
		}
		return err
	}
	// Keep the first-seen metadata, refresh only activity fields.
	return db.Model(&model.UserDevice{}).Where("device_id = ?", d.DeviceID).
		Updates(map[string]any{"last_active_at": now}).Error
}

// ListByUID returns the user's non-deleted devices, most recent first.
func (r *DeviceRepo) ListByUID(db *gorm.DB, uid int64) ([]model.UserDevice, error) {
	var rows []model.UserDevice
	err := db.Where("uid = ? AND deleted_at IS NULL", uid).
		Order("last_active_at DESC").Find(&rows).Error
	return rows, err
}
