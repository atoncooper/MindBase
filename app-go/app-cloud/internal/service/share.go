package service

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"app-cloud/internal/minio"
	"app-cloud/internal/model"
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
		minio: mc, shareExpire: shareURLTTL,
	}
}

// ErrShareNotFound — uniform "invalid share" (router maps to 404).
var ErrShareNotFound = errors.New("分享不存在或已失效")

// ErrShareCodeRequired / ErrShareCodeWrong — extraction code outcomes.
var (
	ErrShareCodeRequired = errors.New("此分享需要提取码")
	ErrShareCodeWrong    = errors.New("提取码不正确")
	ErrShareDownloadCap  = errors.New("分享下载次数已达上限")
)

// CreateShare creates (or replaces) the owner's share for a file.
// code empty = no extraction code. expiresInDays 0 = permanent.
func (s *ShareService) CreateShare(uid, fileID int64, code string,
	expiresInDays int, maxDownloads *int) (*model.CloudShare, error) {
	// owner check: the file must belong to the caller
	f, err := s.files.GetByID(s.db, fileID, uid)
	if err != nil {
		return nil, err
	}
	if f == nil {
		return nil, ErrNotFound
	}
	token, err := randomTokenURL(32)
	if err != nil {
		return nil, err
	}
	row := &model.CloudShare{
		ShareToken:   token,
		UID:          uid,
		FileID:       fileID,
		MaxDownloads: maxDownloads,
	}
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
	slog.Info("[CLOUD_SHARE] created", "uid", uid, "file_id", fileID, "id", row.ID,
		"has_code", code != "", "expires_days", expiresInDays)
	return row, nil
}

// ListShares returns the owner's active shares for a file (codes hidden).
func (s *ShareService) ListShares(uid, fileID int64) ([]model.CloudShare, error) {
	return s.shares.ListByFile(s.db, uid, fileID)
}

// RevokeAllForFile revokes every active share of a file (called on delete).
func (s *ShareService) RevokeAllForFile(fileID int64) error {
	return s.shares.RevokeAllForFile(s.db, fileID)
}

// Revoke revokes one of the owner's shares.
func (s *ShareService) Revoke(uid, shareID int64) error {
	return s.shares.Revoke(s.db, shareID, uid)
}

// shareFile is the public view of a shared file.
type shareFile struct {
	Share *model.CloudShare
	File  *model.CloudFile
}

// ResolveShare validates a token (not expired / not revoked / file alive)
// and returns the share + file, or ErrShareNotFound. view=true bumps the
// view counter.
func (s *ShareService) ResolveShare(token string, countView bool) (*shareFile, error) {
	sh, err := s.shares.GetByToken(s.db, token)
	if err != nil {
		return nil, err
	}
	if sh == nil || sh.IsRevoked {
		return nil, ErrShareNotFound
	}
	if sh.ExpiresAt != nil && sh.ExpiresAt.Before(time.Now()) {
		return nil, ErrShareNotFound
	}
	if sh.MaxDownloads != nil && sh.DownloadCount >= *sh.MaxDownloads {
		return nil, ErrShareNotFound
	}
	var f model.CloudFile
	if err := s.db.Where("id = ? AND deleted_at IS NULL", sh.FileID).First(&f).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrShareNotFound
		}
		return nil, err
	}
	_ = s.shares.IncrView(s.db, sh.ID)
	return &shareFile{Share: sh, File: &f}, nil
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

// BuildAccess renders a presigned URL for the shared file (preview or
// download) and bumps the download counter when requested.
func (s *ShareService) BuildAccess(ctx context.Context, sf *shareFile, download bool) (map[string]any, error) {
	f := sf.File
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
