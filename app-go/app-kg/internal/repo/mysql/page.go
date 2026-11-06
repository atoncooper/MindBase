// Package mysql is the SQL data-access layer for the shared bilirag MySQL.
//
// Write surface is exactly two columns on `video` (kg_status, kg_version);
// everything else is read-only. All queries are parameterised; there is no
// DDL and no ORM model — app-kg owns no tables.
package mysql

import (
	"context"

	"gorm.io/gorm"
)

// PageKey identifies one video page for title lookups.
type PageKey struct {
	Bvid      string
	PageIndex int32
}

// PendingPage is one page selected for (re-)extraction.
type PendingPage struct {
	Bvid      string
	Cid       int64
	PageIndex int32
	PageTitle string
	Version   int64
}

// PageRow is the video-row projection the bookkeeping state machine needs.
type PageRow struct {
	Bvid      string
	PageIndex int32
	PageTitle string
	IsProcess bool
	Version   int64
	KgStatus  *string
	KgVersion *int64
}

// PageRepo — video / favorite_folders / collection access used by the KG
// bookkeeping and scope-resolution flows.
type PageRepo struct{ db *gorm.DB }

// New wires the repository onto the infra handle (see infra/mysql).
func New(db *gorm.DB) *PageRepo { return &PageRepo{db: db} }

// MediaIDs lists the user's non-deleted favorite-folder ids, newest first.
// Empty folderIDs = all folders. Port of chat/scope.get_media_ids_for_uid.
func (r *PageRepo) MediaIDs(ctx context.Context, uid int64, folderIDs []int64) ([]int64, error) {
	q := r.db.WithContext(ctx).Raw(
		"SELECT media_id FROM favorite_folders WHERE uid = ? AND deleted_at IS NULL "+
			"ORDER BY updated_at DESC",
		uid,
	)
	if len(folderIDs) > 0 {
		q = r.db.WithContext(ctx).Raw(
			"SELECT media_id FROM favorite_folders WHERE uid = ? AND deleted_at IS NULL "+
				"AND media_id IN (?) ORDER BY updated_at DESC",
			uid, folderIDs,
		)
	}
	var ids []int64
	err := q.Scan(&ids).Error
	return ids, err
}

// BvidsByMediaIDs maps folder media ids → bvids (collection table, read-only).
func (r *PageRepo) BvidsByMediaIDs(ctx context.Context, mediaIDs []int64) ([]string, error) {
	if len(mediaIDs) == 0 {
		return nil, nil
	}
	var bvids []string
	if err := r.db.WithContext(ctx).Raw(
		"SELECT bvid FROM collection WHERE media_id IN (?)", mediaIDs,
	).Scan(&bvids).Error; err != nil {
		return nil, err
	}
	return bvids, nil
}

// ListPending picks pages whose ASR is done and whose kg extraction is
// missing / failed / stale. Port of service._select_pending_pages.
func (r *PageRepo) ListPending(ctx context.Context, bvids []string, limit int32) ([]PendingPage, error) {
	if len(bvids) == 0 {
		return nil, nil
	}
	var rows []PendingPage
	err := r.db.WithContext(ctx).Raw(
		"SELECT bvid, cid, page_index, page_title, version FROM video "+
			"WHERE bvid IN (?) AND is_processed = 1 "+
			"AND (kg_version IS NULL OR kg_status = 'failed' OR kg_version <> version) "+
			"LIMIT ?",
		bvids, limit,
	).Scan(&rows).Error
	return rows, err
}

// CountPending is the scope-free stats counter (service.stats).
func (r *PageRepo) CountPending(ctx context.Context) (int64, error) {
	var n int64
	err := r.db.WithContext(ctx).Raw(
		"SELECT COUNT(id) FROM video " +
			"WHERE is_processed = 1 " +
			"AND (kg_version IS NULL OR kg_status = 'failed' OR kg_version <> version)",
	).Scan(&n).Error
	return n, err
}

// GetPage loads one video page row; (nil, nil) = the row does not exist.
func (r *PageRepo) GetPage(ctx context.Context, bvid string, cid int64) (*PageRow, error) {
	var row PageRow
	err := r.db.WithContext(ctx).Raw(
		"SELECT bvid, page_index, page_title, is_processed AS is_process, version, "+
			"kg_status, kg_version FROM video WHERE bvid = ? AND cid = ?",
		bvid, cid,
	).Scan(&row).Error
	if err != nil {
		return nil, err
	}
	if row.Bvid == "" {
		return nil, nil
	}
	return &row, nil
}

// SetStatus moves a page's kg_status to an arbitrary value. The only
// permitted writer of these two columns in the whole stack.
func (r *PageRepo) SetStatus(ctx context.Context, bvid string, cid int64, status string) error {
	return r.db.WithContext(ctx).Exec(
		"UPDATE video SET kg_status = ? WHERE bvid = ? AND cid = ?",
		status, bvid, cid,
	).Error
}

// MarkDone sets kg_status='done' + kg_version=content_version (Phase 7 of
// the bookkeeping flow).
func (r *PageRepo) MarkDone(ctx context.Context, bvid string, cid int64, contentVersion int64) error {
	return r.db.WithContext(ctx).Exec(
		"UPDATE video SET kg_status = 'done', kg_version = ? WHERE bvid = ? AND cid = ?",
		contentVersion, bvid, cid,
	).Error
}

// PageTitles returns (bvid, page_index) → page_title for evidence annotation
// (retriever._page_titles). A missing/empty title is returned as "" — the
// "P{n+1}" fallback is a presentation rule owned by the service layer.
func (r *PageRepo) PageTitles(ctx context.Context, bvids []string) (map[PageKey]string, error) {
	out := map[PageKey]string{}
	if len(bvids) == 0 {
		return out, nil
	}
	var rows []struct {
		Bvid      string
		PageIndex int32
		PageTitle *string
	}
	if err := r.db.WithContext(ctx).Raw(
		"SELECT bvid, page_index, page_title FROM video WHERE bvid IN (?)",
		bvids,
	).Scan(&rows).Error; err != nil {
		return nil, err
	}
	for _, row := range rows {
		title := ""
		if row.PageTitle != nil {
			title = *row.PageTitle
		}
		out[PageKey{Bvid: row.Bvid, PageIndex: row.PageIndex}] = title
	}
	return out, nil
}
