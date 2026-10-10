// Page bookkeeping + scope resolution on the shared bilirag MySQL — port of
// the SQL slices of app/services/kg/service.py (process_page Phase 1/7,
// _select_pending_pages, stats pending count) and app/services/chat/scope.py
// (get_media_ids_for_uid / get_bvids_by_media_ids).
//
// Write surface is exactly two columns on `video` (kg_status, kg_version);
// everything else is read-only. All queries are parameterised.
package db

import (
	"context"
	"errors"
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

// BeginResult mirrors the Python process_page Phase 1 outcome.
type BeginResult struct {
	Found          bool
	AsrDone        bool
	Skip           bool
	Reason         string
	ContentVersion int64
	PageTitle      string
	PageIndex      int32
}

// ErrPageNotFound is returned when the video row does not exist.
var ErrPageNotFound = errors.New("video page not found")

// ResolveScope resolves favorite folders → bvids (dedup, order-stable).
// Empty folderIDs = all of the user's non-deleted folders. Port of
// chat/scope.get_media_ids_for_uid + get_bvids_by_media_ids.
func ResolveScope(ctx context.Context, uid int64, folderIDs []int64) ([]string, error) {
	q := DB.WithContext(ctx).Raw(
		"SELECT media_id FROM favorite_folders WHERE uid = ? AND deleted_at IS NULL",
		uid,
	)
	if len(folderIDs) > 0 {
		q = DB.WithContext(ctx).Raw(
			"SELECT media_id FROM favorite_folders WHERE uid = ? AND deleted_at IS NULL "+
				"AND media_id IN (?) ORDER BY updated_at DESC",
			uid, folderIDs,
		)
	} else {
		q = DB.WithContext(ctx).Raw(
			"SELECT media_id FROM favorite_folders WHERE uid = ? AND deleted_at IS NULL "+
				"ORDER BY updated_at DESC",
			uid,
		)
	}
	var mediaIDs []int64
	if err := q.Scan(&mediaIDs).Error; err != nil {
		return nil, err
	}
	seen := map[int64]bool{}
	uniq := make([]int64, 0, len(mediaIDs))
	for _, mid := range mediaIDs {
		if mid != 0 && !seen[mid] {
			seen[mid] = true
			uniq = append(uniq, mid)
		}
	}
	if len(uniq) == 0 {
		return nil, nil
	}
	var bvids []string
	if err := DB.WithContext(ctx).Raw(
		"SELECT bvid FROM collection WHERE media_id IN (?)", uniq,
	).Scan(&bvids).Error; err != nil {
		return nil, err
	}
	seenBv := map[string]bool{}
	out := make([]string, 0, len(bvids))
	for _, bv := range bvids {
		if bv != "" && !seenBv[bv] {
			seenBv[bv] = true
			out = append(out, bv)
		}
	}
	return out, nil
}

// SelectPendingPages picks pages whose ASR is done and whose kg extraction
// is missing / failed / stale. Port of service._select_pending_pages.
func SelectPendingPages(ctx context.Context, bvids []string, limit int32) ([]PendingPage, error) {
	if len(bvids) == 0 {
		return nil, nil
	}
	var rows []PendingPage
	err := DB.WithContext(ctx).Raw(
		"SELECT bvid, cid, page_index, page_title, version FROM video "+
			"WHERE bvid IN (?) AND is_processed = 1 "+
			"AND (kg_version IS NULL OR kg_status = 'failed' OR kg_version <> version) "+
			"LIMIT ?",
		bvids, limit,
	).Scan(&rows).Error
	return rows, err
}

// CountPendingPages is the scope-free stats counter (service.stats).
func CountPendingPages(ctx context.Context) (int64, error) {
	var n int64
	err := DB.WithContext(ctx).Raw(
		"SELECT COUNT(id) FROM video " +
			"WHERE is_processed = 1 " +
			"AND (kg_version IS NULL OR kg_status = 'failed' OR kg_version <> version)",
	).Scan(&n).Error
	return n, err
}

// BeginPage performs the idempotency check and marks the page processing.
// Port of process_page Phase 1: missing row / ASR not done → typed result;
// done-and-current (only when expectedVersion is unset) → skip=true;
// otherwise kg_status='processing'.
func BeginPage(ctx context.Context, bvid string, cid int64, expectedVersion *int64) (BeginResult, error) {
	var row struct {
		Bvid      string
		PageIndex int32
		PageTitle string
		IsProcess bool
		Version   int64
		KgStatus  *string
		KgVersion *int64
	}
	err := DB.WithContext(ctx).Raw(
		"SELECT bvid, page_index, page_title, is_processed AS is_process, version, "+
			"kg_status, kg_version FROM video WHERE bvid = ? AND cid = ?",
		bvid, cid,
	).Scan(&row).Error
	if err != nil {
		return BeginResult{}, err
	}
	if row.Bvid == "" {
		return BeginResult{Found: false, Reason: "video page not found"}, ErrPageNotFound
	}

	res := BeginResult{
		Found:     true,
		AsrDone:   row.IsProcess,
		PageTitle: row.PageTitle,
		PageIndex: row.PageIndex,
	}
	if !row.IsProcess {
		res.Reason = "ASR not done yet"
		return res, nil
	}
	if expectedVersion != nil {
		res.ContentVersion = *expectedVersion
	} else {
		res.ContentVersion = row.Version
	}
	if row.KgStatus != nil && *row.KgStatus == "done" &&
		row.KgVersion != nil && *row.KgVersion == res.ContentVersion &&
		expectedVersion == nil {
		res.Skip = true
		res.Reason = "up to date"
		return res, nil
	}
	if err := SetStatus(ctx, bvid, cid, "processing"); err != nil {
		return res, err
	}
	return res, nil
}

// MarkPageDone sets kg_status='done' + kg_version=content_version (Phase 7).
func MarkPageDone(ctx context.Context, bvid string, cid int64, contentVersion int64) error {
	return DB.WithContext(ctx).Exec(
		"UPDATE video SET kg_status = 'done', kg_version = ? WHERE bvid = ? AND cid = ?",
		contentVersion, bvid, cid,
	).Error
}

// MarkPageFailed marks the page failed (retryable) — failure isolation path.
func MarkPageFailed(ctx context.Context, bvid string, cid int64) error {
	return SetStatus(ctx, bvid, cid, "failed")
}

// SetStatus moves a page's kg_status to an arbitrary value. The only
// permitted writers of these two columns in the whole stack.
func SetStatus(ctx context.Context, bvid string, cid int64, status string) error {
	return DB.WithContext(ctx).Exec(
		"UPDATE video SET kg_status = ? WHERE bvid = ? AND cid = ?",
		status, bvid, cid,
	).Error
}

// PageTitles returns (bvid, page_index) → page_title for evidence annotation
// (retriever._page_titles). Missing titles fall back at the caller/cypher
// layer to "P{n+1}".
func PageTitles(ctx context.Context, bvids []string) (map[PageKey]string, error) {
	out := map[PageKey]string{}
	if len(bvids) == 0 {
		return out, nil
	}
	var rows []struct {
		Bvid      string
		PageIndex int32
		PageTitle *string
	}
	if err := DB.WithContext(ctx).Raw(
		"SELECT bvid, page_index, page_title FROM video WHERE bvid IN (?)",
		bvids,
	).Scan(&rows).Error; err != nil {
		return nil, err
	}
	for _, r := range rows {
		title := ""
		if r.PageTitle != nil {
			title = *r.PageTitle
		}
		if title == "" {
			title = "P" + itoa(int(r.PageIndex)+1)
		}
		out[PageKey{Bvid: r.Bvid, PageIndex: r.PageIndex}] = title
	}
	return out, nil
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
