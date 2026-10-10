// user_preferences KV access (uid + pref_key composite PK; values are JSON
// strings). Port of app/repository/user_preference_repository.py.
package repo

import (
	"context"
	"time"

	"gorm.io/gorm"
)

type PreferenceRow struct {
	UID       int64      `gorm:"column:uid"`
	PrefKey   string     `gorm:"column:pref_key"`
	PrefValue string     `gorm:"column:pref_value"`
	UpdatedAt *time.Time `gorm:"column:updated_at"`
}

// GetAllPreferences returns {key: raw JSON value} for the user.
func GetAllPreferences(ctx context.Context, db *gorm.DB, uid int64) (map[string]string, error) {
	var rows []PreferenceRow
	err := db.WithContext(ctx).
		Where("uid = ?", uid).
		Find(&rows).Error
	if err != nil {
		return nil, err
	}
	out := make(map[string]string, len(rows))
	for _, r := range rows {
		out[r.PrefKey] = r.PrefValue
	}
	return out, nil
}

// UpsertPreference writes one key (select-then-insert/update parity).
func UpsertPreference(ctx context.Context, db *gorm.DB, uid int64, key string, value string) error {
	now := time.Now().UTC()
	res := db.WithContext(ctx).Exec(
		"UPDATE user_preferences SET pref_value = ?, updated_at = ? WHERE uid = ? AND pref_key = ?",
		value, now, uid, key,
	)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected > 0 {
		return nil
	}
	return db.WithContext(ctx).Exec(
		"INSERT INTO user_preferences (uid, pref_key, pref_value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
		uid, key, value, now, now,
	).Error
}
