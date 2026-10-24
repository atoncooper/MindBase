// Share-moderation read side: cloud_shares joined with cloud_files /
// cloud_folders / user_profile for display metadata (name / size / counts /
// owner nickname). METADATA ONLY — no object keys, no MinIO. Folder shares
// aggregate their live subtree via recursive CTE with a hard 2000-item cap
// (plan/1.0.16 section 5).
package repo

import (
	"strings"
	"time"

	"app-admin/internal/db"
)

// Cap for recursive folder traversal / enumerations (contract red line).
const FolderFileCap = 2000

// ShareRow is one share as the admin plane sees it (list + detail base).
type ShareRow struct {
	ID             int64
	TargetType     string // 'file' | 'folder' (COALESCE(d, 'file') for legacy rows)
	UID            int64
	FileID         int64
	FolderID       *int64
	FileName       *string
	FolderName     *string
	OwnerNickname  *string
	ExtractionCode *string
	ExpiresAt      *time.Time
	CreatedAt      *time.Time
	ModerationTime *time.Time
	ViewCount      int
	DownloadCount  int
	IsRevoked      bool
	// TargetAvailable reports whether the share target still exists as a live
	// row (file not soft-deleted / folder not soft-deleted). Dead targets stay
	// listable for the audit trail but are NOT reviewable content.
	TargetAvailable  bool
	ContentReviewAck *bool // nil on legacy DBs / pre-disclosure shares
	ModerationStatus string
	ModerationReason *string
	ModerationBy     *string
	FileSize         *int64 // file shares: cloud_files.file_size
}

// Name resolves the display name: file name, else shared folder name, else
// empty (target row physically deleted).
func (s *ShareRow) Name() string {
	if s.FileName != nil && *s.FileName != "" {
		return *s.FileName
	}
	if s.FolderName != nil {
		return *s.FolderName
	}
	return ""
}

// FileMeta is one file inside a share (detail view) — metadata only.
type FileMeta struct {
	ID       int64 // cloud_files.id — the only handle the review plane may preview
	Name     string
	Size     int64
	MimeType string
	Path     string // folder shares: relative path inside the shared folder
}

// ShareFilters carries the /api/shares query params.
type ShareFilters struct {
	Status  string // "" | active | approved | banned
	UID     int64
	UIDSet  bool
	Revoked *bool
	// Available filters on target liveness: true = only shares whose target
	// file/folder still exists (the review queue), false = dead targets only.
	Available *bool
	Q         string // matches file name / folder name / owner nickname
	Limit     int
	Offset    int
}

// The canonical projection (shareColumnsSQL) includes the moderation columns
// and target_type so both list and detail share one query shape.
const shareBaseSQL = "FROM cloud_shares s " +
	"LEFT JOIN cloud_files f ON COALESCE(s.target_type, 'file') = 'file' AND f.id = s.file_id " +
	"LEFT JOIN cloud_folders fo ON s.target_type = 'folder' AND fo.id = s.folder_id " +
	"LEFT JOIN user_profile p ON p.uid = s.uid "

// targetAvailableSQL is true when the share's target row is still live. It is
// reused by both the projection and the available filter so list/queue and
// detail agree on what "reviewable content" means.
const targetAvailableSQL = "(CASE WHEN COALESCE(s.target_type, 'file') = 'folder' " +
	"THEN (fo.id IS NOT NULL AND fo.deleted_at IS NULL) " +
	"ELSE (f.id IS NOT NULL AND f.deleted_at IS NULL) END)"

func shareWhere(f *ShareFilters) (string, []any) {
	where := " WHERE 1=1"
	var args []any
	if f.Status != "" {
		if f.Status == "active" {
			// Legacy rows created before the app-cloud create-path fix carry an
			// empty moderation_status but semantically are "active" (pending).
			where += " AND (s.moderation_status = ? OR s.moderation_status = '')"
		} else {
			where += " AND s.moderation_status = ?"
		}
		args = append(args, f.Status)
	}
	if f.UIDSet {
		where += " AND s.uid = ?"
		args = append(args, f.UID)
	}
	if f.Revoked != nil {
		where += " AND s.is_revoked = ?"
		args = append(args, *f.Revoked)
	}
	if f.Available != nil {
		where += " AND " + targetAvailableSQL + " = ?"
		args = append(args, *f.Available)
	}
	if f.Q != "" {
		like := "%" + f.Q + "%"
		where += " AND (f.original_name LIKE ? OR fo.name LIKE ? OR p.nickname LIKE ?)"
		args = append(args, like, like, like)
	}
	return where, args
}

const shareColumnsSQL = "SELECT s.id, COALESCE(s.target_type, 'file') AS target_type, s.uid, " +
	"s.file_id AS file_id, s.folder_id AS folder_id, " +
	"f.original_name AS file_name, fo.name AS folder_name, p.nickname AS owner_nickname, " +
	"s.extraction_code, s.expires_at, s.created_at, s.moderation_time, " +
	"s.view_count, s.download_count, s.is_revoked, " +
	"s.moderation_status, s.moderation_reason, s.moderation_by, f.file_size AS file_size, " +
	"s.content_review_ack AS content_review_ack, " + targetAvailableSQL + " AS target_available "

// ListShares returns one DESC page (newest share id first) plus the total.
func ListShares(f ShareFilters) ([]ShareRow, int64, error) {
	where, args := shareWhere(&f)

	var total int64
	if err := db.DB.Raw("SELECT COUNT(*) "+shareBaseSQL+where, args...).Scan(&total).Error; err != nil {
		return nil, 0, err
	}

	rowsSQL := shareColumnsSQL + shareBaseSQL + where +
		" ORDER BY s.id DESC LIMIT ? OFFSET ?"
	args2 := append(append([]any{}, args...), f.Limit, f.Offset)
	rows, err := db.DB.Raw(rowsSQL, args2...).Rows()
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var items []ShareRow
	for rows.Next() {
		var it ShareRow
		if err := db.DB.ScanRows(rows, &it); err != nil {
			return nil, 0, err
		}
		items = append(items, it)
	}
	return items, total, rows.Err()
}

// GetShare fetches a single share row (nil when the id does not exist).
func GetShare(id int64) (*ShareRow, error) {
	var it ShareRow
	err := db.DB.Raw(
		shareColumnsSQL+shareBaseSQL+" WHERE s.id = ?", id).Scan(&it).Error
	if err != nil {
		return nil, err
	}
	if it.ID == 0 {
		return nil, nil
	}
	return &it, nil
}

// folderAggregateRow is one per-root subtree aggregation result.
type folderAggregateRow struct {
	RootID int64
	Cnt    int64
	Size   int64
}

// FolderAggregates computes, for every shared folder in the page, the count
// and total size of LIVE files across its whole (recursive, depth-capped)
// subtree in ONE query: recursive CTE carries the root id down the tree.
func FolderAggregates(rootIDs []int64) (map[int64]struct{ Count, Size int64 }, error) {
	out := make(map[int64]struct{ Count, Size int64 }, len(rootIDs))
	if len(rootIDs) == 0 {
		return out, nil
	}
	pruned := make([]int64, 0, len(rootIDs))
	for _, id := range rootIDs {
		if id > 0 {
			pruned = append(pruned, id)
		}
	}
	if len(pruned) == 0 {
		return out, nil
	}
	sql := "WITH RECURSIVE tree AS (" +
		"SELECT id, id AS root_id, 0 AS depth FROM cloud_folders WHERE id IN (?) AND deleted_at IS NULL " +
		"UNION ALL " +
		"SELECT f.id, t.root_id, t.depth + 1 FROM cloud_folders f JOIN tree t ON f.parent_id = t.id " +
		"WHERE f.deleted_at IS NULL AND t.depth < 100) " +
		"SELECT t.root_id, COUNT(*) AS cnt, COALESCE(SUM(cf.file_size), 0) AS size " +
		"FROM cloud_files cf JOIN tree t ON cf.folder_id = t.id " +
		"WHERE cf.deleted_at IS NULL GROUP BY t.root_id"
	rows, err := db.DB.Raw(sql, pruned).Rows()
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var r folderAggregateRow
		if err := db.DB.ScanRows(rows, &r); err != nil {
			return nil, err
		}
		out[r.RootID] = struct{ Count, Size int64 }{Count: min64(r.Cnt, FolderFileCap), Size: r.Size}
	}
	return out, rows.Err()
}

// FolderFiles lists the LIVE files of one shared folder subtree (relative
// path from the shared root; root folder itself contributes empty path).
// LIMIT cap+1 lets the caller detect truncation deterministically.
func FolderFiles(rootID int64) ([]FileMeta, bool, error) {
	if rootID <= 0 {
		return nil, false, nil
	}
	sql := "WITH RECURSIVE tree AS (" +
		"SELECT id, 0 AS depth, CAST('' AS CHAR(500)) AS path FROM cloud_folders WHERE id = ? AND deleted_at IS NULL " +
		"UNION ALL " +
		"SELECT f.id, t.depth + 1, CONCAT(t.path, '/', f.name) FROM cloud_folders f JOIN tree t ON f.parent_id = t.id " +
		"WHERE f.deleted_at IS NULL AND t.depth < 100) " +
		"SELECT cf.id AS id, cf.original_name AS name, cf.file_size AS size, cf.mime_type AS mime_type, " +
		"TRIM(LEADING '/' FROM t.path) AS path " +
		"FROM cloud_files cf JOIN tree t ON cf.folder_id = t.id " +
		"WHERE cf.deleted_at IS NULL " +
		"ORDER BY t.depth, cf.folder_id, cf.id LIMIT ?"
	rows, err := db.DB.Raw(sql, rootID, FolderFileCap+1).Rows()
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()

	var items []FileMeta
	for rows.Next() {
		var fm FileMeta
		if err := db.DB.ScanRows(rows, &fm); err != nil {
			return nil, false, err
		}
		items = append(items, fm)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	truncated := false
	if len(items) > FolderFileCap {
		items = items[:FolderFileCap]
		truncated = true
	}
	for i := range items {
		items[i].Path = strings.TrimPrefix(items[i].Path, "/")
	}
	return items, truncated, nil
}

// FileShareFile fetches the metadata of the single file behind a file share.
func FileShareFile(fileID int64) (*FileMeta, error) {
	var fm FileMeta
	err := db.DB.Raw(
		"SELECT id, original_name AS name, file_size AS size, mime_type AS mime_type, '' AS path "+
			"FROM cloud_files WHERE id = ? AND deleted_at IS NULL",
		fileID).Scan(&fm).Error
	if err != nil {
		return nil, err
	}
	if fm.Name == "" {
		return nil, nil
	}
	return &fm, nil
}

func min64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}
