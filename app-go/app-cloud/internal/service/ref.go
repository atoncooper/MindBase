package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"app-cloud/internal/model"
	"app-cloud/internal/repo"

	"gorm.io/gorm"
)

// RefService — "save to my drive" references (plan/1.0.16 §4-refs). A ref is
// a ledger row pointing at the ORIGINAL file: it never copies the MinIO
// object and never counts toward quota. Reads re-validate the source chain
// (ref alive → source file alive → source share not revoked / not banned /
// not expired) and flip the ref to status='dead' when any leg breaks.
type RefService struct {
	db     *gorm.DB
	refs   *repo.RefRepo
	shares *repo.ShareRepo
	share  *ShareService // reuse ResolveShare/CheckCode/SharedFolderFiles + presign policy
}

func NewRefService(db *gorm.DB, share *ShareService) *RefService {
	return &RefService{
		db:     db,
		refs:   repo.NewRefRepo(),
		shares: repo.NewShareRepo(),
		share:  share,
	}
}

// Uniform-failure errors (router mapping):
//   - ErrRefDead        → 404「引用已失效」(also covers resolve failures)
//   - ErrRefDestMissing → 400「目标文件夹不存在」
//   - ErrRefTooMany     → 422（folder save over the 2000-member cap）
//   - ErrNotFound       → 404「引用不存在」(repo layer)
var (
	ErrRefDead        = errors.New("引用已失效")
	ErrRefDestMissing = errors.New("目标文件夹不存在")
	ErrRefTooMany     = errors.New("该分享包含的文件超过 2000 上限，无法保存引用")
)

// refFolderNameBytes — cloud_folders.name is varchar(200); keep room for the
// "-引用(N)" suffix (UTF-8 byte truncation, rune-safe).
const refFolderNameBytes = 200 - 16

// refFolderName rune-safe truncates a mirror name to the folder column limit.
func refFolderName(name string, maxBytes int) string {
	for len(name) > maxBytes {
		runes := []rune(name)
		name = string(runes[:len(runes)-1])
	}
	return name
}

// SaveShare — POST /cloud/refs body {token, code?, targetFolderId?}.
// Resolves the share with the PUBLIC semantics (banned/revoked/expired →
// 404; extraction code outcomes identical to share access), then either
// inserts one ref (file share) or mirrors the folder tree + one ref per
// member file (folder share). Idempotent: an already-alive ref for
// (uid, share_id, source_file_id) is skipped. NO attest — saving is a
// logged-in action. Response: {saved, rootFolderId?}.
func (s *RefService) SaveShare(ctx context.Context, uid int64, token, code string, targetFolderID *int64) (map[string]any, error) {
	sf, err := s.share.ResolveShare(token, false)
	if err != nil {
		return nil, err // uniform 404 at the router
	}
	if cerr := s.share.CheckCode(sf.Share, code); cerr != nil {
		return nil, cerr // router maps required→401 / wrong→403 (既有语义)
	}
	// Destination parent must exist and belong to the saver.
	var destParent *int64
	if targetFolderID != nil {
		var folders repo.FolderRepo
		f, ferr := folders.GetByID(s.db, *targetFolderID, uid)
		if ferr != nil {
			return nil, ferr
		}
		if f == nil {
			return nil, ErrRefDestMissing
		}
		destParent = targetFolderID
	}
	existing, err := s.refs.FindAliveExisting(s.db, uid, sf.Share.ID)
	if err != nil {
		return nil, err
	}
	have := make(map[int64]bool, len(existing))
	for _, r := range existing {
		have[r.SourceFileID] = true
	}

	if sf.File != nil {
		// ── file share → one ref at destParent ──
		if have[sf.File.ID] {
			return map[string]any{"saved": 0}, nil
		}
		if err := s.refs.Create(s.db, newRefRow(uid, sf.Share, sf.File, destParent)); err != nil {
			return nil, err
		}
		slog.Info("[CLOUD_REF] saved file", "uid", uid, "share_id", sf.Share.ID,
			"source_file_id", sf.File.ID, "saved", 1)
		return map[string]any{"saved": 1}, nil
	}

	// ── folder share → mirror tree + one ref per member file ──
	entries, truncated, err := s.share.SharedFolderFiles(sf.Share, SharedFilesLimit)
	if err != nil {
		return nil, err
	}
	if truncated {
		return nil, ErrRefTooMany
	}
	pending := make([]sharedFileEntry, 0, len(entries))
	for _, e := range entries {
		if !have[e.File.ID] {
			pending = append(pending, e)
		}
	}

	// Mirror tree is computed even on a full-idempotent re-save so the
	// response's rootFolderId stays truthful; mirrorFolder reuses folders
	// that belong to a previous save of this share instead of duplicating.
	rootID, mirror, err := s.ensureMirrorTree(uid, sf, destParent, existing)
	if err != nil {
		return nil, err
	}
	if len(pending) == 0 {
		out := map[string]any{"saved": 0}
		if rootID != 0 {
			out["rootFolderId"] = rootID
		}
		return out, nil
	}
	rows := make([]model.CloudRef, 0, len(pending))
	for _, e := range pending {
		dest := rootID
		if e.File.FolderID != nil {
			if id, ok := mirror[*e.File.FolderID]; ok {
				dest = id
			}
		}
		rows = append(rows, *newRefRow(uid, sf.Share, &e.File, &dest))
	}
	if err := s.refs.CreateBatch(s.db, rows); err != nil {
		return nil, err
	}
	slog.Info("[CLOUD_REF] saved folder", "uid", uid, "share_id", sf.Share.ID,
		"root_folder_id", rootID, "saved", len(rows), "skipped", len(existing))
	return map[string]any{"saved": len(rows), "rootFolderId": rootID}, nil
}

// ensureMirrorTree — reuse-or-create the mirrored subtree for this share.
// Mirror ownership is inferred from the saver's ALIVE refs of this share:
// any folder on a ref's ancestor chain belongs to the previous mirror and is
// reused; everything else is created with the contract's 重名"-引用(N)" suffix.
// Returns the mirror root id (0 when unknowable — e.g. all refs deleted) and
// the sourceFolderID→mirrorFolderID map.
func (s *RefService) ensureMirrorTree(uid int64, sf *shareFile, destParent *int64, existing []model.CloudRef) (int64, map[int64]int64, error) {
	if sf.Folder == nil || sf.Share.FolderID == nil {
		return 0, nil, ErrShareNotFound
	}
	// Folders previously used by this share's refs (+ ancestors).
	mine := make(map[int64]bool)
	for _, r := range existing {
		cur := r.FolderID
		for hops := 0; cur != nil && hops < 64; hops++ {
			if mine[*cur] {
				break
			}
			mine[*cur] = true
			var folders repo.FolderRepo
			f, err := folders.GetByID(s.db, *cur, uid)
			if err != nil || f == nil || f.ParentID == nil {
				break
			}
			cur = f.ParentID
		}
	}
	// Mirror root: reuse the ancestor chain root when it still dangles under
	// destParent; otherwise create (suffix when an unrelated folder claimed
	// the plain name).
	var rootID int64
	for _, r := range existing {
		cur := r.FolderID
		for hops := 0; cur != nil && hops < 64; hops++ {
			var folders repo.FolderRepo
			f, err := folders.GetByID(s.db, *cur, uid)
			if err != nil || f == nil {
				break
			}
			parentIsDest := (destParent == nil && f.ParentID == nil) ||
				(destParent != nil && f.ParentID != nil && *f.ParentID == *destParent)
			if parentIsDest {
				rootID = f.ID
				break
			}
			if f.ParentID == nil || !mine[*f.ParentID] {
				break
			}
			cur = f.ParentID
		}
		if rootID != 0 {
			break
		}
	}
	if rootID == 0 {
		root, err := s.mirrorFolder(uid, destParent, sf.Folder.Name, mine)
		if err != nil {
			return 0, nil, err
		}
		rootID = root.ID
	}

	// Source tree (share owner's folders), one query.
	var folders repo.FolderRepo
	srcList, err := folders.ListByUID(s.db, sf.Share.UID)
	if err != nil {
		return 0, nil, err
	}
	subIDs, err := folders.SubtreeIDs(s.db, *sf.Share.FolderID, sf.Share.UID, true)
	if err != nil {
		return 0, nil, err
	}
	inSub := make(map[int64]bool, len(subIDs))
	for _, id := range subIDs {
		inSub[id] = true
	}
	mirror := map[int64]int64{*sf.Share.FolderID: rootID}
	// DFS over the source subtree reusing/creating mirror folders by name.
	var walk func(srcID, destID int64) error
	walk = func(srcID, destID int64) error {
		for i := range srcList {
			src := &srcList[i]
			if src.ParentID == nil || *src.ParentID != srcID || !inSub[src.ID] {
				continue
			}
			created, cerr := s.mirrorFolder(uid, &destID, src.Name, mine)
			if cerr != nil {
				return cerr
			}
			mirror[src.ID] = created.ID
			if cerr := walk(src.ID, created.ID); cerr != nil {
				return cerr
			}
		}
		return nil
	}
	if err := walk(*sf.Share.FolderID, rootID); err != nil {
		return 0, nil, err
	}
	return rootID, mirror, nil
}

// mirrorFolder — idempotent single-folder mirror. Reuse a live folder with
// the same (uid, parent, name) ONLY when it belongs to this share's previous
// mirror (mine); otherwise claim a fresh name: plain when free, else the
// first free "-引用(N)" suffix (contract 重名追加语义).
func (s *RefService) mirrorFolder(uid int64, parent *int64, name string, mine map[int64]bool) (*model.CloudFolder, error) {
	var folders repo.FolderRepo
	name = refFolderName(name, refFolderNameBytes)
	q := s.db.Where("uid = ? AND deleted_at IS NULL", uid)
	if parent != nil {
		q = q.Where("parent_id = ?", *parent)
	} else {
		q = q.Where("parent_id IS NULL")
	}
	var siblings []model.CloudFolder
	if err := q.Order("id").Find(&siblings).Error; err != nil {
		return nil, err
	}
	for i := range siblings {
		if siblings[i].Name == name && mine[siblings[i].ID] {
			return &siblings[i], nil // previous save of this share — reuse
		}
	}
	if hasSiblingNamed(siblings, name) {
		for n := 2; n < 1000; n++ {
			candidate := fmt.Sprintf("%s-引用(%d)", name, n)
			if !hasSiblingNamed(siblings, candidate) {
				name = candidate
				break
			}
		}
	}
	row := &model.CloudFolder{UID: uid, ParentID: parent, Name: name}
	if err := folders.Create(s.db, row); err != nil {
		return nil, err
	}
	return row, nil
}

func hasSiblingNamed(rows []model.CloudFolder, name string) bool {
	for i := range rows {
		if rows[i].Name == name {
			return true
		}
	}
	return false
}

// newRefRow builds one ref row from the share + source file (snapshot name
// preserved; resolution always re-reads the live name).
func newRefRow(uid int64, sh *model.CloudShare, f *model.CloudFile, folderID *int64) *model.CloudRef {
	return &model.CloudRef{
		UID:              uid,
		ShareID:          sh.ID,
		SourceFileID:     f.ID,
		SourceUID:        f.UID,
		SourceUploadUUID: f.UploadUUID,
		Name:             f.OriginalName,
		FileSize:         f.FileSize,
		MimeType:         f.MimeType,
		FolderID:         folderID,
		Status:           "alive",
	}
}

// ListRefs — GET /cloud/refs?folderId=. {refs: RefItem[], total}. sourceName
// resolves the LIVE original name (bounded batch read); a missing source row
// falls back to the snapshot name.
func (s *RefService) ListRefs(uid int64, folderID *int64) (map[string]any, error) {
	const listLimit = 2000
	rows, err := s.refs.ListByFolder(s.db, uid, folderID, listLimit)
	if err != nil {
		return nil, err
	}
	total, err := s.refs.CountByFolder(s.db, uid, folderID)
	if err != nil {
		return nil, err
	}
	ids := make([]int64, 0, len(rows))
	for i := range rows {
		ids = append(ids, rows[i].SourceFileID)
	}
	live := make(map[int64]string, len(ids))
	if len(ids) > 0 {
		var srcs []model.CloudFile
		if err := s.db.Where("id IN ?", ids).Find(&srcs).Error; err == nil {
			for i := range srcs {
				live[srcs[i].ID] = srcs[i].OriginalName
			}
		}
	}
	items := make([]map[string]any, 0, len(rows))
	for i := range rows {
		r := &rows[i]
		sourceName := r.Name
		if n, ok := live[r.SourceFileID]; ok {
			sourceName = n
		}
		items = append(items, map[string]any{
			"id":               r.ID,
			"name":             r.Name,
			"size":             r.FileSize,
			"mimeType":         r.MimeType,
			"folderId":         r.FolderID,
			"status":           r.Status,
			"shareId":          r.ShareID,
			"sourceUploadUuid": r.SourceUploadUUID,
			"sourceName":       sourceName,
			"createdAt":        r.CreatedAt,
			"isRef":            true,
		})
	}
	return map[string]any{"refs": items, "total": total}, nil
}

// DeleteRef — DELETE /cloud/refs/{id} (uid-checked soft delete; the source
// file/folder and the share itself are untouched).
func (s *RefService) DeleteRef(uid, id int64) error {
	return s.refs.SoftDelete(s.db, id, uid)
}

// RawRef — GET /cloud/refs/{id}/raw. Re-resolves the ORIGINAL object through
// the source share with the SAME disposition/XSS policy as share access
// (BuildAccess 政策); no share cap consumption / download increment — a ref
// read is the ref owner's own access. Any invalidated leg flips the ref
// dead and reads uniformly as 404「引用已失效」.
func (s *RefService) RawRef(ctx context.Context, uid, id int64, download bool) (map[string]any, error) {
	ref, err := s.refs.GetOwned(s.db, id, uid)
	if err != nil {
		return nil, err
	}
	if ref == nil {
		return nil, ErrNotFound
	}
	if ref.Status != "alive" {
		return nil, ErrRefDead
	}
	fail := func(err error) (map[string]any, error) {
		_ = s.refs.MarkDead(s.db, ref.ID)
		if errors.Is(err, ErrNotFound) || errors.Is(err, ErrShareNotFound) {
			return nil, ErrRefDead
		}
		return nil, err
	}
	sh, err := s.shares.GetByIDAnyState(s.db, ref.ShareID)
	if err != nil {
		return nil, err
	}
	if sh == nil || sh.IsRevoked || sh.ModerationStatus == model.ModerationBanned ||
		(sh.ExpiresAt != nil && sh.ExpiresAt.Before(time.Now())) {
		return fail(ErrShareNotFound)
	}
	// Original file: exact identity match on (id, upload_uuid, source owner)
	// so a purged-and-re-uploaded row can never be substituted.
	var f model.CloudFile
	ferr := s.db.Where("id = ? AND upload_uuid = ? AND uid = ? AND deleted_at IS NULL",
		ref.SourceFileID, ref.SourceUploadUUID, ref.SourceUID).First(&f).Error
	if ferr != nil {
		if errors.Is(ferr, gorm.ErrRecordNotFound) {
			return fail(ErrShareNotFound)
		}
		return nil, ferr
	}
	// BuildAccess policy without the share cap/counters.
	viewMode := classifyViewMode(f.MimeType)
	previewable := viewMode == "pdf" || viewMode == "video" || viewMode == "audio" || viewMode == "image"
	ct := ""
	if previewable {
		ct = f.MimeType
	}
	disposition := ""
	if download || !previewable {
		// 下载/不可预览类型强制 attachment —— 与分享 access 同一防 XSS 立场
		//（presigned URL 经 /minio-proxy 同源回源，text/html 渲染 = 存储型 XSS）。
		disposition = fmt.Sprintf("attachment; filename*=UTF-8''%s", urlEscape(f.OriginalName))
	}
	url, err := s.share.minio.PresignGet(ctx, f.ObjectKey, ct, disposition, s.share.shareExpire)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"url":       url,
		"viewMode":  viewMode,
		"mimeType":  f.MimeType,
		"fileName":  f.OriginalName,
		"fileSize":  f.FileSize,
		"expiresIn": s.share.shareExpire,
	}, nil
}
