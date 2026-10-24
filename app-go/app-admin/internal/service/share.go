// Share-moderation service: reads shares for the admin list / detail and
// applies the moderation transitions (ban / unban / approve) through the
// single controlled UPDATE. Never touches is_revoked.
//
// Wire DTOs live in internal/dto; this package only assembles them from repo
// rows and owns the business rules (filters, pagination, moderation semantics).
package service

import (
	"errors"
	"fmt"

	"app-admin/internal/cloud"
	"app-admin/internal/dto"
	"app-admin/internal/repo"
)

var (
	ErrShareNotFound = errors.New("share not found")
	// ErrReviewTargetNotFound — the requested file is not part of the share's
	// previewable scope (not the file-share target / not a live folder member).
	ErrReviewTargetNotFound = errors.New("review target not found")
)

var validStatusFilters = map[string]bool{
	"active": true, "approved": true, "banned": true,
}

// ListSharesParams captures /api/shares query params.
type ListSharesParams struct {
	Status  string
	UID     int64
	UIDSet  bool
	Revoked *bool
	// Available filters on target liveness (nil = all, true = reviewable,
	// false = dead-target legacy rows kept for audit).
	Available *bool
	Q         string
	Page      int
	PageSize  int
}

// ShareService now carries the app-cloud review client (nil = preview disabled).
type ShareService struct {
	review *cloud.Client
}

func NewShareService(review *cloud.Client) *ShareService {
	return &ShareService{review: review}
}

// itemFromRow maps the repo row into the JSON item.
func itemFromRow(r *repo.ShareRow) dto.ShareItem {
	item := dto.ShareItem{
		ID:               r.ID,
		TargetType:       r.TargetType,
		Name:             r.Name(),
		OwnerUid:         r.UID,
		OwnerNickname:    safeStr(r.OwnerNickname),
		HasCode:          r.ExtractionCode != nil && *r.ExtractionCode != "",
		ExpiresAt:        rfc3339(r.ExpiresAt),
		ViewCount:        r.ViewCount,
		DownloadCount:    r.DownloadCount,
		IsRevoked:        r.IsRevoked,
		ContentAvailable: r.TargetAvailable,
		ContentReviewAck: r.ContentReviewAck != nil && *r.ContentReviewAck,
		ModerationStatus: r.ModerationStatus,
		ModerationReason: safeStr(r.ModerationReason),
		ModerationTime:   rfc3339(r.ModerationTime),
		ModerationBy:     safeStr(r.ModerationBy),
		CreatedAt:        rfc3339(r.CreatedAt),
	}
	if r.TargetType != "folder" && r.TargetAvailable {
		item.FileCount = 1
		if r.FileSize != nil {
			item.TotalSize = *r.FileSize
		}
	}
	return item
}

// aggregateFolders batches the folder-share subtree aggregation into ONE
// recursive-CTE query for the whole page (roots carried via t.root_id).
func (s *ShareService) aggregateFolders(rows []repo.ShareRow) map[int64]struct{ Count, Size int64 } {
	out := make(map[int64]struct{ Count, Size int64 })
	var roots []int64
	for i := range rows {
		if rows[i].TargetType == "folder" && rows[i].FolderID != nil && *rows[i].FolderID > 0 {
			roots = append(roots, *rows[i].FolderID)
		}
	}
	if len(roots) == 0 {
		return out
	}
	agg, err := repo.FolderAggregates(roots)
	if err != nil {
		return out
	}
	for i := range rows {
		if rows[i].TargetType == "folder" && rows[i].FolderID != nil {
			if a, ok := agg[*rows[i].FolderID]; ok {
				out[rows[i].ID] = a
			}
		}
	}
	return out
}

// List returns one moderation list page.
func (s *ShareService) List(p ListSharesParams) (*dto.SharePage, error) {
	if p.Status != "" && !validStatusFilters[p.Status] {
		return nil, errors.New("status must be one of active / approved / banned")
	}
	if err := validatePage(p.Page, p.PageSize); err != nil {
		return nil, err
	}
	limit, offset := pageWindow(p.Page, p.PageSize)
	rows, total, err := repo.ListShares(repo.ShareFilters{
		Status: p.Status, UID: p.UID, UIDSet: p.UIDSet, Revoked: p.Revoked,
		Available: p.Available, Q: p.Q, Limit: limit, Offset: offset,
	})
	if err != nil {
		return nil, err
	}
	aggregates := s.aggregateFolders(rows)

	items := make([]dto.ShareItem, 0, len(rows))
	for i := range rows {
		item := itemFromRow(&rows[i])
		if rows[i].TargetType == "folder" {
			if agg, ok := aggregates[rows[i].ID]; ok {
				item.FileCount = agg.Count
				item.TotalSize = agg.Size
			}
			// A folder share with zero live files has nothing to review.
			item.ContentAvailable = item.ContentAvailable && item.FileCount > 0
		}
		items = append(items, item)
	}
	return &dto.SharePage{Items: items, Total: total, Page: p.Page, PageSize: p.PageSize}, nil
}

// Detail resolves one share with its (capped) metadata-only files list.
func (s *ShareService) Detail(id int64) (*dto.ShareDetail, error) {
	if id <= 0 {
		return nil, errors.New("share id must be a positive integer")
	}
	row, err := repo.GetShare(id)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, ErrShareNotFound
	}
	item := itemFromRow(row)
	detail := &dto.ShareDetail{
		ShareItem: item,
		Files:     []dto.FileMeta{},
	}

	if row.TargetType == "folder" {
		var folderID int64
		if row.FolderID != nil {
			folderID = *row.FolderID
		}
		files, truncated, err := repo.FolderFiles(folderID)
		if err != nil {
			return nil, err
		}
		var totalSize int64
		for _, f := range files {
			detail.Files = append(detail.Files, dto.FileMeta{ID: f.ID, Name: f.Name, Size: f.Size, MimeType: f.MimeType, Path: f.Path})
			totalSize += f.Size
		}
		detail.FileCount = int64(len(files))
		detail.TotalSize = totalSize
		detail.Truncated = truncated
		detail.ContentAvailable = detail.ContentAvailable && detail.FileCount > 0
	} else {
		fm, err := repo.FileShareFile(row.FileID)
		if err != nil {
			return nil, err
		}
		detail.FileCount = 0
		if fm != nil {
			detail.FileCount = 1
			detail.Files = append(detail.Files, dto.FileMeta{ID: row.FileID, Name: fm.Name, Size: fm.Size, MimeType: fm.MimeType, Path: fm.Path})
			detail.TotalSize = fm.Size
		} else {
			detail.ContentAvailable = false
		}
	}
	return detail, nil
}

// Ban marks a share banned (reason REQUIRED). Admin-only at the router.
func (s *ShareService) Ban(adminName string, id int64, reason string) error {
	if isBlank(reason) {
		return errors.New("reason is required")
	}
	return s.apply(adminName, id, "banned", &reason, "ban", reason)
}

// Unban returns a share to moderation_status=active and clears
// reason / time / by (contract wording); the optional reason only feeds the
// audit detail.
func (s *ShareService) Unban(adminName string, id int64, reason string) error {
	detail := reason
	if isBlank(detail) {
		detail = "(no reason given)"
	}
	return s.apply(adminName, id, "active", nil, "unban", "unban; reason: "+detail)
}

// Approve marks a share approved (reason optional).
func (s *ShareService) Approve(adminName string, id int64, reason string) error {
	var r *string
	if !isBlank(reason) {
		r = &reason
	}
	detail := reason
	if isBlank(detail) {
		detail = "(no reason given)"
	}
	return s.apply(adminName, id, "approved", r, "approve", "approve; reason: "+detail)
}

func (s *ShareService) apply(adminName string, id int64, status string, reason *string, action, detail string) error {
	if id <= 0 {
		return errors.New("share id must be a positive integer")
	}
	found, err := repo.ModerationUpdate(adminName, id, status, reason, action, detail)
	if err != nil {
		return err
	}
	if !found {
		return ErrShareNotFound
	}
	return nil
}

// Preview issues a controlled content preview for ONE file of one share
// (admin role enforced at the router). Rules:
//   - the share must exist (any moderation state — banned shares are exactly
//     what an admin needs to look at when handling a report);
//   - a file share resolves only its own target; a folder share only live
//     members of its (capped) subtree — the validated detail file list;
//   - the reviewer may inspect any recorded share (banned / revoked / expired /
//     pre-disclosure legacy shares included); app-cloud enforces only the
//     share's target scope, not public liveness or the user's ack;
//   - every granted preview is audited BEFORE the URL is minted.
func (s *ShareService) Preview(adminName string, shareID, fileID int64) (*dto.PreviewGrant, error) {
	if shareID <= 0 || fileID <= 0 {
		return nil, errors.New("share id / file id must be positive integers")
	}
	if s.review == nil {
		return nil, errors.New("content review preview is not configured")
	}
	row, err := repo.GetShare(shareID)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, ErrShareNotFound
	}
	if row.TargetType == "folder" {
		files, _, err := repo.FolderFiles(derefInt64(row.FolderID))
		if err != nil {
			return nil, err
		}
		member := false
		for _, f := range files {
			if f.ID == fileID {
				member = true
				break
			}
		}
		if !member {
			return nil, ErrReviewTargetNotFound
		}
	} else if row.FileID != fileID {
		return nil, ErrReviewTargetNotFound
	}

	grant, err := s.review.PreviewFile(shareID, fileID)
	if err != nil {
		return nil, err
	}
	// Include the file name so the audit ledger is self-explanatory without
	// joining cloud_files later (the preview itself is ephemeral).
	detail := fmt.Sprintf("preview file_id=%d viewMode=%s file_name=%s",
		fileID, grant.ViewMode, truncateRunes(grant.FileName, 200))
	if aerr := repo.RecordAudit(adminName, "preview_content", "share",
		fmt.Sprintf("%d", shareID), detail); aerr != nil {
		return nil, aerr
	}
	return &dto.PreviewGrant{
		URL:       grant.URL,
		ViewMode:  grant.ViewMode,
		MimeType:  grant.MimeType,
		FileName:  grant.FileName,
		FileSize:  grant.FileSize,
		ExpiresIn: grant.ExpiresIn,
		Text:      grant.Text,
		Truncated: grant.Truncated,
	}, nil
}

func derefInt64(p *int64) int64 {
	if p == nil {
		return 0
	}
	return *p
}
