package service

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"app-cloud/internal/infra/minio"
	"app-cloud/internal/model"
	"app-cloud/internal/pipeline"
	"app-cloud/internal/repo"

	"gorm.io/gorm"
)

// ShareService — Baidu-style share links: token URL + optional 4-digit
// extraction code (stored hashed), optional expiry + download cap, view/
// download counters. Invalid/expired/revoked shares read uniformly (404)
// to prevent state enumeration — same stance as the notes/quiz shares.
type ShareService struct {
	db          *gorm.DB
	shares      *repo.ShareRepo
	files       *repo.FileRepo
	folders     *repo.FolderRepo
	minio       *minio.Client
	shareExpire int // presigned URL lifetime for share access (seconds)
}

func NewShareService(db *gorm.DB, mc *minio.Client, presignExpire int) *ShareService {
	shareURLTTL := 900 // 15 minutes — short-lived access grants
	if presignExpire > 0 && presignExpire < shareURLTTL {
		shareURLTTL = presignExpire
	}
	return &ShareService{
		db: db, shares: repo.NewShareRepo(), files: repo.NewFileRepo(),
		folders: repo.NewFolderRepo(), minio: mc, shareExpire: shareURLTTL,
	}
}

// ErrShareNotFound — uniform "invalid share" (router maps to 404).
var ErrShareNotFound = errors.New("分享不存在或已失效")

// ErrShareCodeRequired / ErrShareCodeWrong — extraction code outcomes.
var (
	ErrShareCodeRequired = errors.New("此分享需要提取码")
	ErrShareCodeWrong    = errors.New("提取码不正确")
	ErrShareDownloadCap  = errors.New("分享下载次数已达上限")
	// ErrLegalAckRequired — the compliance warning (plan/1.0.16 §一.2) was not
	// confirmed; the router maps it to 422. Backend-enforced, so no client can
	// create a share without the acknowledgment.
	ErrLegalAckRequired         = errors.New("请先阅读并同意分享规范")
	ErrContentReviewAckRequired = errors.New("请单独确认管理员内容审核告知")
)

// Admin-review preview outcomes. Reviewer access is deliberately independent of
// public liveness / disclosure state (see AdminReviewFile); these errors only
// describe renderability of the resolved file.
var (
	ErrPreviewUnsupported = errors.New("该文件类型暂不支持在线预览")
	ErrPreviewNoText      = errors.New("文档无可提取文本（扫描件或加密文件）")
	ErrPreviewTooLarge    = errors.New("文件过大，无法在线提取预览")
	ErrPreviewFailed      = errors.New("文档解析失败，无法在线预览")
)

const (
	// adminReviewTextMaxBytes bounds the object read for text extraction; the
	// console never needs a whole multi-hundred-MB video/archive.
	adminReviewTextMaxBytes = 32 << 20
	// adminReviewTextMaxRunes bounds the text returned to the console. The
	// app-admin client reads at most 4 MiB of the response, so the worst-case
	// JSON escaping of this cap stays well inside that budget.
	adminReviewTextMaxRunes = 120_000
)

// ContentReviewPolicyVersion changes whenever the user-facing disclosure
// about admin review of shared content changes materially.
const ContentReviewPolicyVersion = "2026-10-v1"

// CreateShare creates (or replaces) the owner's share for a file.
// code empty = no extraction code. expiresInDays 0 = permanent.
// legalAck MUST be true — the compliance warning (1.0.16) is enforced
// server-side; anything else maps to 422 at the router.
func (s *ShareService) CreateShare(uid, fileID int64, code string,
	expiresInDays int, maxDownloads *int, legalAck, contentReviewAck bool) (*model.CloudShare, error) {
	if !legalAck {
		return nil, ErrLegalAckRequired
	}
	if !contentReviewAck {
		return nil, ErrContentReviewAckRequired
	}
	// owner check: the file must belong to the caller
	f, err := s.files.GetByID(s.db, fileID, uid)
	if err != nil {
		return nil, err
	}
	if f == nil {
		return nil, ErrNotFound
	}
	policyVersion := ContentReviewPolicyVersion
	ackAt := time.Now()
	row := &model.CloudShare{
		UID:                        uid,
		FileID:                     fileID,
		MaxDownloads:               maxDownloads,
		TargetType:                 model.ShareTargetFile,
		LegalAck:                   true,
		ContentReviewAck:           true,
		ContentReviewPolicyVersion: &policyVersion,
		ContentReviewAckAt:         &ackAt,
		// Explicit active: GORM inserts every column, so a zero value would
		// bypass the column DEFAULT and hide the share from "待审核" filters.
		ModerationStatus: model.ModerationActive,
	}
	return s.createShareRow(uid, code, expiresInDays, row, map[string]any{"file_id": fileID})
}

// CreateFolderShare creates the owner's share for a FOLDER (1.0.16 §4).
// The public page then lists the folder subtree; access picks single files
// by fileId. Same body semantics as the file share.
func (s *ShareService) CreateFolderShare(uid, folderID int64, code string,
	expiresInDays int, maxDownloads *int, legalAck, contentReviewAck bool) (*model.CloudShare, error) {
	if !legalAck {
		return nil, ErrLegalAckRequired
	}
	if !contentReviewAck {
		return nil, ErrContentReviewAckRequired
	}
	// owner check: folder must belong to the caller and not be trashed.
	folder, err := s.folders.GetByID(s.db, folderID, uid)
	if err != nil {
		return nil, err
	}
	if folder == nil {
		return nil, ErrNotFound
	}
	policyVersion := ContentReviewPolicyVersion
	ackAt := time.Now()
	row := &model.CloudShare{
		UID:                        uid,
		FolderID:                   &folderID,
		MaxDownloads:               maxDownloads,
		TargetType:                 model.ShareTargetFolder,
		LegalAck:                   true,
		ContentReviewAck:           true,
		ContentReviewPolicyVersion: &policyVersion,
		ContentReviewAckAt:         &ackAt,
		ModerationStatus:           model.ModerationActive, // see CreateShare
	}
	return s.createShareRow(uid, code, expiresInDays, row, map[string]any{"folder_id": folderID})
}

// createShareRow — shared tail of both share creators: token/code/expiry
// minting + insert + audit log.
func (s *ShareService) createShareRow(uid int64, code string, expiresInDays int,
	row *model.CloudShare, logFields map[string]any) (*model.CloudShare, error) {
	token, err := randomTokenURL(32)
	if err != nil {
		return nil, err
	}
	row.ShareToken = token
	if code != "" {
		stored, serr := s.storeExtractionCode(code)
		if serr != nil {
			return nil, serr
		}
		row.ExtractionCode = &stored
	}
	if expiresInDays > 0 {
		exp := time.Now().AddDate(0, 0, expiresInDays)
		row.ExpiresAt = &exp
	}
	if err := s.shares.Create(s.db, row); err != nil {
		return nil, err
	}
	fields := []any{"uid", uid, "share_id", row.ID, "target_type", row.TargetType,
		"has_code", code != "", "expires_days", expiresInDays}
	for k, v := range logFields {
		fields = append(fields, k, v)
	}
	slog.Info("[CLOUD_SHARE] created", fields...)
	return row, nil
}

// ListShares returns the owner's active shares for a file (codes hidden).
func (s *ShareService) ListShares(uid, fileID int64) ([]model.CloudShare, error) {
	return s.shares.ListByFile(s.db, uid, fileID)
}

// ListFolderShares returns the owner's active shares for a folder (1.0.16).
func (s *ShareService) ListFolderShares(uid, folderID int64) ([]model.CloudShare, error) {
	return s.shares.ListByFolder(s.db, uid, folderID)
}

// RevokeAllForFile revokes every active share of a file (called on delete).
func (s *ShareService) RevokeAllForFile(fileID int64) error {
	return s.shares.RevokeAllForFile(s.db, fileID)
}

// RevokeAllForFolders revokes every active folder share under the deleted
// subtree (force folder delete — plan/1.0.16 §4).
func (s *ShareService) RevokeAllForFolders(folderIDs []int64) error {
	return s.shares.RevokeAllForFolders(s.db, folderIDs)
}

// Revoke revokes one of the owner's shares.
func (s *ShareService) Revoke(uid, shareID int64) error {
	return s.shares.Revoke(s.db, shareID, uid)
}

// shareFile is the resolved view of a share. Exactly one of File/Folder is
// set: file shares carry the target file; folder shares carry the target
// folder (members are listed/picked separately).
type shareFile struct {
	Share  *model.CloudShare
	File   *model.CloudFile
	Folder *model.CloudFolder
}

// ResolveShare validates a token (not expired / not revoked / not banned /
// cap not exhausted / target alive) and returns the share + its target, or
// ErrShareNotFound (uniform 404 — no state enumeration). view=true bumps the
// view counter. 1.0.16: banned shares read exactly like revoked ones.
func (s *ShareService) ResolveShare(token string, countView bool) (*shareFile, error) {
	sh, err := s.shares.GetByToken(s.db, token)
	if err != nil {
		return nil, err
	}
	if sh == nil || sh.IsRevoked {
		return nil, ErrShareNotFound
	}
	if sh.ModerationStatus == model.ModerationBanned {
		return nil, ErrShareNotFound
	}
	if sh.ExpiresAt != nil && sh.ExpiresAt.Before(time.Now()) {
		return nil, ErrShareNotFound
	}
	if sh.MaxDownloads != nil && sh.DownloadCount >= *sh.MaxDownloads {
		return nil, ErrShareNotFound
	}
	if sh.IsFolderShare() {
		if sh.FolderID == nil {
			return nil, ErrShareNotFound
		}
		var fo model.CloudFolder
		if err := s.db.Where("id = ? AND deleted_at IS NULL", sh.FolderID).First(&fo).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil, ErrShareNotFound
			}
			return nil, err
		}
		if countView {
			_ = s.shares.IncrView(s.db, sh.ID)
		}
		return &shareFile{Share: sh, Folder: &fo}, nil
	}
	var f model.CloudFile
	if err := s.db.Where("id = ? AND deleted_at IS NULL", sh.FileID).First(&f).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrShareNotFound
		}
		return nil, err
	}
	if countView {
		_ = s.shares.IncrView(s.db, sh.ID)
	}
	return &shareFile{Share: sh, File: &f}, nil
}

// sharedFileEntry — one live file of a folder share with its path relative
// to the shared folder root ("a/b"; "" = directly inside the root).
type sharedFileEntry struct {
	File model.CloudFile
	Path string
}

// storeExtractionCode — 密钥就绪存 AES-GCM 密文（属主可随时查看），
// 未配置密钥优雅降级为 legacy 哈希（不可查看，仅可校验/重设）。
func (s *ShareService) storeExtractionCode(code string) (string, error) {
	normalized := normalizeCode(code)
	if encryptionAvailable() {
		return encryptCode(normalized)
	}
	return hashExtractionCode(normalized), nil
}

// matchExtractionCode — 兼容两种存储格式（legacy 哈希 / v1 密文）。
func matchExtractionCode(code, stored string) bool {
	normalized := normalizeCode(code)
	if isEncryptedCode(stored) {
		plain, ok := decryptCode(stored)
		return ok && plain == normalized
	}
	return hashExtractionCode(normalized) == stored
}

// CheckCode verifies an extraction code (legacy hash or v1 ciphertext).
func (s *ShareService) CheckCode(sh *model.CloudShare, code string) error {
	if sh.ExtractionCode == nil {
		return nil // no code required
	}
	if code == "" {
		return ErrShareCodeRequired
	}
	if !matchExtractionCode(code, *sh.ExtractionCode) {
		return ErrShareCodeWrong
	}
	return nil
}

// ViewCode — 属主查看提取码明文。legacy 哈希行不可逆，返回空串
// （前端引导"重设提取码"）。
func (s *ShareService) ViewCode(sh *model.CloudShare) string {
	if sh.ExtractionCode == nil {
		return ""
	}
	if plain, ok := decryptCode(*sh.ExtractionCode); ok {
		return plain
	}
	return ""
}

// SetCode — 属主重设/新增提取码（链接与 token 保持不变，仅换码）。
func (s *ShareService) SetCode(uid, shareID int64, code string) error {
	normalized := normalizeCode(code)
	if len(normalized) < 3 || len(normalized) > 16 {
		return errors.New("提取码长度需为 3-16 位")
	}
	sh, err := s.shares.GetOwned(s.db, shareID, uid)
	if err != nil {
		return err
	}
	if sh == nil {
		return ErrNotFound
	}
	stored, serr := s.storeExtractionCode(normalized)
	if serr != nil {
		return serr
	}
	return s.shares.UpdateExtractionCode(s.db, shareID, stored)
}

// BuildAccess renders a presigned URL for the share's target file (preview
// or download) and bumps the download counter when requested.
func (s *ShareService) BuildAccess(ctx context.Context, sf *shareFile, download bool) (map[string]any, error) {
	return s.BuildAccessFor(ctx, sf, sf.File, download)
}

// BuildAccessFor renders a presigned URL for a SPECIFIC file of the share.
// File shares pass sf.File; folder shares pass the fileId-picked member
// (validated by FolderShareFile). The disposition/XSS/cap policy is one
// shared implementation — no fork between the two target types.
func (s *ShareService) BuildAccessFor(ctx context.Context, sf *shareFile, f *model.CloudFile, download bool) (map[string]any, error) {
	if f == nil {
		return nil, ErrShareNotFound
	}
	viewMode := classifyViewMode(f.MimeType)
	previewable := viewMode == "pdf" || viewMode == "video" || viewMode == "audio" || viewMode == "image"
	ct := ""
	if previewable {
		ct = f.MimeType
	}
	// 下载强制 attachment；不可在线预览的类型（html/text/svg 等）即便预览请求
	// 也强制 attachment —— 否则恶意上传的 HTML 会被浏览器在应用同源下渲染
	// （presigned URL 经 /minio-proxy 同源回源，存储型 XSS 面）。
	disposition := ""
	if download || !previewable {
		disposition = fmt.Sprintf("attachment; filename*=UTF-8''%s", urlEscape(f.OriginalName))
	}
	url, err := s.minio.PresignGet(ctx, f.ObjectKey, ct, disposition, s.shareExpire)
	if err != nil {
		return nil, err
	}
	if download {
		// Atomic cap gate: check + increment in one statement, before the
		// URL is handed out. Failure means the cap was just exhausted —
		// ErrShareDownloadCap maps to a uniform 404 at the router. (A presign
		// minted here but never returned simply expires with its 15-min TTL;
		// the cap is what must not be overshot.)
		ok, ierr := s.shares.TryIncrDownload(s.db, sf.Share.ID)
		if ierr != nil {
			return nil, ierr
		}
		if !ok {
			return nil, ErrShareDownloadCap
		}
	}
	return map[string]any{
		"url":       url,
		"viewMode":  viewMode,
		"mimeType":  f.MimeType,
		"fileName":  f.OriginalName,
		"fileSize":  f.FileSize,
		"expiresIn": s.shareExpire,
	}, nil
}

// BuildAdminReviewAccess renders a preview for the review plane:
//   - pdf / image / audio / video → the same short-lived INLINE presigned grant
//     as public sharing (never an attachment disposition, never a counter bump);
//   - every other document → server-side TEXT extraction with the existing
//     pipeline parsers (docx/xlsx/pptx/markdown/html/text). The console gets
//     plain text, never a URL and never rendered HTML — an attacker-uploaded
//     .html must not execute on the app origin (stored XSS).
func (s *ShareService) BuildAdminReviewAccess(ctx context.Context, share *model.CloudShare, file *model.CloudFile) (map[string]any, error) {
	if file == nil {
		return nil, ErrShareNotFound
	}
	switch classifyViewMode(file.MimeType) {
	case "pdf", "video", "audio", "image":
		return s.BuildAccessFor(ctx, &shareFile{Share: share, File: file}, file, false)
	}
	text, truncated, err := s.adminReviewText(ctx, file)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"viewMode":  "text",
		"mimeType":  file.MimeType,
		"fileName":  file.OriginalName,
		"fileSize":  file.FileSize,
		"expiresIn": 0,
		"text":      text,
		"truncated": truncated,
	}, nil
}

// adminReviewText extracts a bounded plain-text rendition of a document for
// content review. It reads the object through the existing MinIO client (the
// admin plane never holds storage credentials) and reuses the vectorization
// parsers, so no new dependency enters the image.
func (s *ShareService) adminReviewText(ctx context.Context, f *model.CloudFile) (string, bool, error) {
	if f.FileSize > adminReviewTextMaxBytes {
		return "", false, ErrPreviewTooLarge
	}
	raw, err := s.minio.GetObject(ctx, f.ObjectKey)
	if err != nil {
		return "", false, err
	}
	parsed, err := pipeline.Extract(f.MimeType, f.OriginalName, raw)
	if err != nil {
		switch {
		case errors.Is(err, pipeline.ErrNoParser):
			return "", false, ErrPreviewUnsupported
		case errors.Is(err, pipeline.ErrZipEntryTooLarge):
			return "", false, ErrPreviewTooLarge
		case errors.Is(err, pipeline.ErrEncryptedPDF), errors.Is(err, pipeline.ErrEmptyPDFText):
			return "", false, ErrPreviewNoText
		default:
			return "", false, ErrPreviewFailed
		}
	}
	text := strings.TrimSpace(parsed.Text)
	if text == "" {
		return "", false, ErrPreviewNoText
	}
	runes := []rune(text)
	truncated := len(runes) > adminReviewTextMaxRunes
	if truncated {
		text = strings.TrimSpace(string(runes[:adminReviewTextMaxRunes]))
	}
	return text, truncated, nil
}

// SharedFilesLimit — the public folder listing / ref saving enumeration cap
// (plan/1.0.16 §4/§4-refs): above 2000 members the payload is truncated
// (truncated: true) and saving the whole folder is rejected with 422.
const SharedFilesLimit = 2000

// SharedFolderFiles enumerates every live file under the shared folder's
// subtree (the SHARE OWNER's tree), labeled with paths relative to the
// shared root. Bounded by limit (contract cap = SharedFilesLimit);
// truncated reports whether the cap cut the list.
func (s *ShareService) SharedFolderFiles(sh *model.CloudShare, limit int) ([]sharedFileEntry, bool, error) {
	if sh.FolderID == nil {
		return nil, false, ErrShareNotFound
	}
	subIDs, err := s.folders.SubtreeIDs(s.db, *sh.FolderID, sh.UID, true)
	if err != nil {
		return nil, false, err
	}
	var files []model.CloudFile
	if err := s.db.Where("uid = ? AND folder_id IN ? AND deleted_at IS NULL", sh.UID, subIDs).
		Order("created_at DESC, id DESC").Limit(limit + 1).Find(&files).Error; err != nil {
		return nil, false, err
	}
	truncated := len(files) > limit
	if truncated {
		files = files[:limit]
	}
	paths, err := s.folderSubtreePaths(sh, subIDs)
	if err != nil {
		return nil, false, err
	}
	out := make([]sharedFileEntry, 0, len(files))
	for i := range files {
		p := ""
		if files[i].FolderID != nil {
			p = paths[*files[i].FolderID]
		}
		out = append(out, sharedFileEntry{File: files[i], Path: p})
	}
	return out, truncated, nil
}

// folderSubtreePaths — relative path label per subtree folder id, from the
// owner's full folder list (one bounded query).
func (s *ShareService) folderSubtreePaths(sh *model.CloudShare, subIDs []int64) (map[int64]string, error) {
	rows, err := s.folders.ListByUID(s.db, sh.UID)
	if err != nil {
		return nil, err
	}
	byID := make(map[int64]model.CloudFolder, len(rows))
	for i := range rows {
		byID[rows[i].ID] = rows[i]
	}
	out := make(map[int64]string, len(subIDs))
	for _, id := range subIDs {
		out[id] = folderRelativePath(byID, *sh.FolderID, id)
	}
	return out, nil
}

// folderRelativePath — pure path-label helper (unit-tested): "a/b" for a
// descendant folder, "" for the shared root itself. Defensive against
// dangling parents / cycles (bounded hops; a chain that never reaches the
// root reads as root-level rather than as a partial path).
func folderRelativePath(byID map[int64]model.CloudFolder, rootID, folderID int64) string {
	if folderID == rootID {
		return ""
	}
	var parts []string
	cur, ok := byID[folderID]
	reachedRoot := false
	for hops := 0; ok && hops < 64; hops++ {
		if cur.ID == rootID {
			reachedRoot = true
			break
		}
		parts = append(parts, cur.Name)
		if cur.ParentID == nil {
			break // not a descendant of the root
		}
		cur, ok = byID[*cur.ParentID]
	}
	if !reachedRoot {
		return "" // dangling chain / corrupted tree — treat as root-level
	}
	for i, j := 0, len(parts)-1; i < j; i, j = i+1, j-1 {
		parts[i], parts[j] = parts[j], parts[i]
	}
	return strings.Join(parts, "/")
}

// FolderShareFile — folder share access picker: fileID must be a LIVE file
// inside the shared folder tree. Anything else reads as ErrShareNotFound
// (uniform 404 — the tree structure stays non-enumerable).
func (s *ShareService) FolderShareFile(sh *model.CloudShare, fileID int64) (*model.CloudFile, error) {
	if sh.FolderID == nil {
		return nil, ErrShareNotFound
	}
	subIDs, err := s.folders.SubtreeIDs(s.db, *sh.FolderID, sh.UID, true)
	if err != nil {
		return nil, err
	}
	var f model.CloudFile
	err = s.db.Where("id = ? AND uid = ? AND folder_id IN ? AND deleted_at IS NULL", fileID, sh.UID, subIDs).
		First(&f).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrShareNotFound
		}
		return nil, err
	}
	return &f, nil
}

// AdminReviewFile resolves a single file for the app-admin review plane.
//
// REVIEWER ACCESS IS DELIBERATELY BROADER THAN PUBLIC ACCESS: moderation must
// be able to inspect any recorded share — including banned, revoked, expired
// and legacy shares created before the content-review disclosure existed —
// because reports frequently arrive after the owner revokes/expires a share.
// The share's target scope is still enforced (file-share target or live member
// of the shared folder tree); the admin plane can never reach an unshared file
// or a folder-tree sibling. Every preview is audited by app-admin BEFORE the
// grant is minted. The public path (/cloud/s/*) keeps its own liveness and
// disclosure semantics untouched.
func (s *ShareService) AdminReviewFile(shareID, fileID int64) (*model.CloudShare, *model.CloudFile, error) {
	if shareID <= 0 || fileID <= 0 {
		return nil, nil, ErrShareNotFound
	}
	share, err := s.shares.GetByIDAnyState(s.db, shareID)
	if err != nil {
		return nil, nil, err
	}
	if share == nil {
		return nil, nil, ErrShareNotFound
	}

	var file *model.CloudFile
	if share.IsFolderShare() {
		file, err = s.FolderShareFile(share, fileID)
	} else {
		if share.FileID != fileID {
			return nil, nil, ErrShareNotFound
		}
		file, err = s.files.GetByID(s.db, fileID, share.UID)
		if err == nil && file == nil {
			err = ErrShareNotFound
		}
	}
	if err != nil {
		return nil, nil, err
	}
	return share, file, nil
}

// hashExtractionCode stores codes hashed (SHA-256 + fixed pepper) — a DB
// leak must not reveal working extraction codes.
func hashExtractionCode(code string) string {
	peppered := "mindbase:share:" + normalizeCode(code)
	sum := sha256Sum([]byte(peppered))
	return hex.EncodeToString(sum[:])
}

func normalizeCode(code string) string {
	out := make([]byte, 0, len(code))
	for _, r := range code {
		if r != ' ' && r != '-' {
			out = append(out, byte(upperByte(byte(r))))
		}
	}
	return string(out)
}

func upperByte(b byte) byte {
	if b >= 'a' && b <= 'z' {
		return b - 32
	}
	return b
}

func randomTokenURL(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64URLEncode(b), nil
}
