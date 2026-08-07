package repo

import (
	"time"

	"app-task/internal/db"
	"app-task/internal/model"
)

// CreateNotification is a package-level variable so tests can stub it (e.g. to
// simulate a DB failure path in finalizeQuiz) without triggering a real error.
var CreateNotification = func(n *model.TaskQuizNotification) error {
	return db.DB.Create(n).Error
}

func ListPendingNotifications(limit int) ([]model.TaskQuizNotification, error) {
	var ns []model.TaskQuizNotification
	err := db.DB.Where("status = ?", "pending").Order("created_at ASC").
		Limit(limit).Find(&ns).Error
	return ns, err
}

func MarkNotificationSent(notificationID string) error {
	return db.DB.Model(&model.TaskQuizNotification{}).
		Where("notification_id = ?", notificationID).
		Updates(map[string]any{"status": "sent", "sent_at": time.Now().UTC()}).Error
}

// MarkNotificationDryRun marks a notification as dry_run (skipped because no
// EMAIL_API_KEY). Distinct from "sent" so real sends are distinguishable.
// ListPendingNotifications queries status='pending', so dry_run rows are not
// re-scanned on every worker tick.
func MarkNotificationDryRun(notificationID, reason string) error {
	return db.DB.Model(&model.TaskQuizNotification{}).
		Where("notification_id = ?", notificationID).
		Updates(map[string]any{"status": "dry_run", "last_error": reason}).Error
}

// MarkNotificationFailed bumps retry_count; if final, status=failed, else pending.
func MarkNotificationFailed(notificationID, errMsg string, retryCount int, final bool) error {
	status := "pending"
	if final {
		status = "failed"
	}
	return db.DB.Model(&model.TaskQuizNotification{}).
		Where("notification_id = ?", notificationID).
		Updates(map[string]any{
			"retry_count": retryCount,
			"last_error":  errMsg,
			"status":      status,
		}).Error
}
