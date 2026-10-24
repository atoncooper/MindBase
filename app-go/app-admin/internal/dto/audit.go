package dto

// AuditItem is one /api/audit row of the admin_audit ledger.
type AuditItem struct {
	ID         int64  `json:"id"`
	Admin      string `json:"admin"`
	Action     string `json:"action"`
	TargetType string `json:"targetType"`
	TargetID   string `json:"targetId"`
	Detail     string `json:"detail,omitempty"`
	CreatedAt  string `json:"createdAt,omitempty"`
}

// AuditPage is the /api/audit list envelope.
type AuditPage struct {
	Items    []AuditItem `json:"items"`
	Total    int64       `json:"total"`
	Page     int         `json:"page"`
	PageSize int         `json:"pageSize"`
}
