// Audit service: thin read passthrough over the admin_audit ledger with page
// validation (writes happen inside the moderation transaction and auth flow).
//
// Wire DTOs live in internal/dto; this package only maps repo rows into them.
package service

import (
	"app-admin/internal/dto"
	"app-admin/internal/repo"
)

type AuditService struct{}

func NewAuditService() *AuditService { return &AuditService{} }

// List pages the ledger newest-first. action / admin are exact-match filters.
func (s *AuditService) List(action, admin string, page, pageSize int) (*dto.AuditPage, error) {
	if err := validatePage(page, pageSize); err != nil {
		return nil, err
	}
	limit, offset := pageWindow(page, pageSize)
	rows, total, err := repo.ListAudits(action, admin, limit, offset)
	if err != nil {
		return nil, err
	}
	items := make([]dto.AuditItem, 0, len(rows))
	for _, a := range rows {
		items = append(items, dto.AuditItem{
			ID:         a.ID,
			Admin:      a.AdminName,
			Action:     a.Action,
			TargetType: safeStr(a.TargetType),
			TargetID:   safeStr(a.TargetID),
			Detail:     safeStr(a.Detail),
			CreatedAt:  rfc3339(a.CreatedAt),
		})
	}
	return &dto.AuditPage{Items: items, Total: total, Page: page, PageSize: pageSize}, nil
}
