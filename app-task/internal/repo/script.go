// Package repo: data access for the Lua script table + audit log.
package repo

import (
	"errors"

	"app-task/internal/db"
	"app-task/internal/model"

	"gorm.io/gorm"
)

// ErrScriptNotFound is returned when a script_id does not exist.
var ErrScriptNotFound = errors.New("script not found")

// CreateScript inserts a new script version. The caller must set Version.
func CreateScript(s *model.Script) error {
	return db.DB.Create(s).Error
}

// GetLatestScript returns the newest version of a script_id.
func GetLatestScript(scriptID string) (*model.Script, error) {
	var s model.Script
	err := db.DB.Where("script_id = ?", scriptID).Order("version DESC").First(&s).Error
	if err == gorm.ErrRecordNotFound {
		return nil, ErrScriptNotFound
	}
	if err != nil {
		return nil, err
	}
	return &s, nil
}

// GetScript returns a specific (script_id, version); version 0 = latest.
func GetScript(scriptID string, version int) (*model.Script, error) {
	if version <= 0 {
		return GetLatestScript(scriptID)
	}
	var s model.Script
	err := db.DB.Where("script_id = ? AND version = ?", scriptID, version).First(&s).Error
	if err == gorm.ErrRecordNotFound {
		return nil, ErrScriptNotFound
	}
	if err != nil {
		return nil, err
	}
	return &s, nil
}

// NextScriptVersion returns version+1 for an existing script_id, or 1.
func NextScriptVersion(scriptID string) (int, error) {
	latest, err := GetLatestScript(scriptID)
	if err == ErrScriptNotFound {
		return 1, nil
	}
	if err != nil {
		return 0, err
	}
	return latest.Version + 1, nil
}

// CreateScriptLog appends an audit entry for a script change (upload/edit).
func CreateScriptLog(l *model.ScriptLog) error {
	return db.DB.Create(l).Error
}

// ListScriptLogs returns the audit trail for a script_id, newest first.
func ListScriptLogs(scriptID string, limit int) ([]model.ScriptLog, error) {
	if limit <= 0 {
		limit = 50
	}
	var out []model.ScriptLog
	err := db.DB.Where("script_id = ?", scriptID).
		Order("id DESC").Limit(limit).Find(&out).Error
	return out, err
}

// ListScripts returns one row per script_id (latest version), ordered by name.
func ListScripts() ([]model.Script, error) {
	// latest per script_id: join against the max version (portable SQL).
	var out []model.Script
	err := db.DB.Raw(
		`SELECT s.* FROM script s` +
		` JOIN (SELECT script_id, MAX(version) AS v FROM script GROUP BY script_id) m` +
		` ON m.script_id = s.script_id AND m.v = s.version ORDER BY s.name`,
	).Scan(&out).Error
	return out, err
}

// ListScriptVersions returns every version of a script_id, newest first
// (admin console history view).
func ListScriptVersions(scriptID string) ([]model.Script, error) {
	var out []model.Script
	err := db.DB.Where("script_id = ?", scriptID).
		Order("version DESC").Find(&out).Error
	return out, err
}

// CountScripts returns the number of distinct script_ids (dashboard).
func CountScripts() (int64, error) {
	var n int64
	err := db.DB.Model(&model.Script{}).
		Distinct("script_id").Count(&n).Error
	return n, err
}

// UpdateScriptEnabled flips the enabled flag on the latest version of a
// script_id (management toggle; does not create a new version).
func UpdateScriptEnabled(scriptID string, enabled bool) error {
	// Resolve the latest version first: MySQL forbids updating a table while
	// its own subquery reads the same table ("target table for update in FROM
	// clause"), so we cannot do version = (SELECT MAX(version) ...) inline.
	latest, err := GetLatestScript(scriptID)
	if err != nil {
		return err
	}
	return db.DB.Model(&model.Script{}).
		Where("script_id = ? AND version = ?", scriptID, latest.Version).
		Update("enabled", enabled).Error
}