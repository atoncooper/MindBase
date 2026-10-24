// admin_audit ledger: every console operation (login / logout /
// change_password / ban / unban / approve) lands here — the moderation writes
// apppend inside the moderation transaction, the auth flows append directly.
package repo

import (
	"time"

	"app-admin/internal/db"
	"app-admin/internal/model"
)

// RecordAudit appends one ledger row. Failures surface to the caller instead
// of being swallowed: an audit gap on a moderation write is unacceptable.
func RecordAudit(adminName, action, targetType, targetID, detail string) error {
	a := &model.AdminAudit{
		AdminName:  adminName,
		Action:     action,
		TargetType: strPtr(targetType),
		TargetID:   strPtr(targetID),
		Detail:     strPtr(truncate(detail, 500)),
		CreatedAt:  ptrToday(time.Now()),
	}
	return db.DB.Create(a).Error
}

// AuditItem is one row for the /api/audit list.
type AuditItem struct {
	ID         int64
	AdminName  string
	Action     string
	TargetType *string
	TargetID   *string
	Detail     *string
	CreatedAt  *time.Time
}

// ListAudits pages the ledger newest-first, optionally filtered by action
// (exact) and admin name (exact). Returns one page plus the total.
func ListAudits(action, admin string, limit, offset int) ([]AuditItem, int64, error) {
	where := " WHERE 1=1"
	var args []any
	if action != "" {
		where += " AND action = ?"
		args = append(args, action)
	}
	if admin != "" {
		where += " AND admin_name = ?"
		args = append(args, admin)
	}

	var total int64
	if err := db.DB.Raw("SELECT COUNT(*) FROM admin_audit"+where, args...).Scan(&total).Error; err != nil {
		return nil, 0, err
	}

	rows, err := db.DB.Raw(
		"SELECT id, admin_name, action, target_type, target_id, detail, created_at "+
			"FROM admin_audit"+where+" ORDER BY id DESC LIMIT ? OFFSET ?",
		append(append([]any{}, args...), limit, offset)...).Rows()
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var items []AuditItem
	for rows.Next() {
		var it AuditItem
		if err := db.DB.ScanRows(rows, &it); err != nil {
			return nil, 0, err
		}
		items = append(items, it)
	}
	return items, total, rows.Err()
}

func ptrToday(t time.Time) *time.Time { return &t }
