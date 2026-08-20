// Package repo: data access for app-task's mail delivery queue.
package repo

import (
	"time"

	"app-task/internal/db"
	"app-task/internal/model"

	"gorm.io/gorm"
)

func CreateEmail(m *model.EmailMessage) error {
	return db.DB.Create(m).Error
}

// ListDueEmails returns pending emails whose retry window has passed.
func ListDueEmails(limit int) ([]model.EmailMessage, error) {
	var out []model.EmailMessage
	err := db.DB.Where(
		"status = ? AND (next_retry_at IS NULL OR next_retry_at <= ?)",
		"pending", time.Now().UTC(),
	).Order("created_at ASC").Limit(limit).Find(&out).Error
	return out, err
}

func MarkEmailSent(emailID string) error {
	return db.DB.Model(&model.EmailMessage{}).
		Where("email_id = ?", emailID).
		Updates(map[string]any{"status": "sent", "sent_at": time.Now().UTC()}).Error
}

// MarkEmailDryRun marks an email as dry_run (no API key configured); distinct
// from sent so real delivery is distinguishable.
func MarkEmailDryRun(emailID, reason string) error {
	return db.DB.Model(&model.EmailMessage{}).
		Where("email_id = ?", emailID).
		Updates(map[string]any{"status": "dry_run", "last_error": reason}).Error
}

// MarkEmailFailed bumps retry_count; if final, status=failed, else pending with
// nextRetryAt as the exact retry time.
func MarkEmailFailed(emailID, errMsg string, retryCount int, nextRetryAt *time.Time, final bool) error {
	status := "pending"
	if final {
		status = "failed"
	}
	values := map[string]any{
		"retry_count": retryCount,
		"last_error":  errMsg,
		"status":      status,
	}
	if nextRetryAt != nil {
		values["next_retry_at"] = *nextRetryAt
	}
	return db.DB.Model(&model.EmailMessage{}).
		Where("email_id = ?", emailID).Updates(values).Error
}

// ListEmails returns the mail queue across all senders, newest first (admin
// console). Empty status = no status filter.
func ListEmails(status string, limit, offset int) ([]model.EmailMessage, error) {
	if limit <= 0 {
		limit = 50
	}
	var out []model.EmailMessage
	q := db.DB.Order("id DESC")
	if status != "" {
		q = q.Where("status = ?", status)
	}
	err := q.Limit(limit).Offset(offset).Find(&out).Error
	return out, err
}

// CountEmails counts queued emails, optionally filtered by status.
func CountEmails(status string) (int64, error) {
	var n int64
	q := db.DB.Model(&model.EmailMessage{})
	if status != "" {
		q = q.Where("status = ?", status)
	}
	err := q.Count(&n).Error
	return n, err
}

// CountEmailsByStatus returns email counts grouped by status (dashboard).
func CountEmailsByStatus() (map[string]int64, error) {
	var rows []struct {
		Status string `gorm:"column:status"`
		Count  int64  `gorm:"column:count"`
	}
	err := db.DB.Model(&model.EmailMessage{}).
		Select("status, COUNT(*) AS count").
		Group("status").Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	out := make(map[string]int64, len(rows))
	for _, r := range rows {
		out[r.Status] = r.Count
	}
	return out, nil
}

// GetEmailByID returns one queued email by its email_id.
func GetEmailByID(emailID string) (*model.EmailMessage, error) {
	var e model.EmailMessage
	err := db.DB.Where("email_id = ?", emailID).First(&e).Error
	if err == gorm.ErrRecordNotFound {
		return nil, nil
	}
	return &e, err
}

// ResetEmailForRetry moves a failed email back to pending so the worker
// delivers it again (manual retry from the admin console). Only transitions
// failed -> pending; returns false when the email is not in failed state.
func ResetEmailForRetry(emailID string) (bool, error) {
	tx := db.DB.Model(&model.EmailMessage{}).
		Where("email_id = ? AND status = ?", emailID, "failed").
		Updates(map[string]any{
			"status":       "pending",
			"retry_count":  0,
			"next_retry_at": nil,
			"last_error":    nil,
		})
	return tx.RowsAffected > 0, tx.Error
}
