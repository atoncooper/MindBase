// The single controlled write onto the shared schema: UPDATE the four
// moderation columns of cloud_shares (moderation_status / moderation_reason /
// moderation_time / moderation_by) and append the admin_audit row in the SAME
// transaction. is_revoked is deliberately NEVER touched here — owner-revoke
// semantics belong to app-cloud (plan/1.0.16 section 5).
package repo

import (
	"strconv"
	"time"

	"app-admin/internal/db"
	"app-admin/internal/model"

	"gorm.io/gorm"
)

// ModerationUpdate applies one moderation decision. reason nil = clear the
// column (unban); non-nil = store it (ban / approve). found=false means the
// share id does not exist (nothing written, no audit row).
func ModerationUpdate(adminName string, shareID int64, status string, reason *string, action string, detail string) (found bool, err error) {
	now := time.Now()
	txErr := db.DB.Transaction(func(tx *gorm.DB) error {
		res := tx.Exec(
			"UPDATE cloud_shares SET moderation_status = ?, moderation_reason = ?, moderation_time = ?, moderation_by = ? WHERE id = ?",
			status, reason, now, adminName, shareID)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			found = false
			return nil
		}
		found = true
		target := int64ToString(shareID)
		audit := &model.AdminAudit{
			AdminName:  adminName,
			Action:     action,
			TargetType: strPtr("share"),
			TargetID:   strPtr(target),
			Detail:     strPtr(truncate(detail, 500)),
			CreatedAt:  ptrTime(now),
		}
		if err := tx.Create(audit).Error; err != nil {
			return err
		}
		return nil
	})
	if txErr != nil {
		return false, txErr
	}
	return found, nil
}

func ptrTime(t time.Time) *time.Time { return &t }

func int64ToString(v int64) string {
	return strconv.FormatInt(v, 10)
}
