// Package service holds the board business logic: the two-store optimistic
// commit (MySQL metadata + Mongo body) and the ownership rules.
//
// Concurrency model for PUT: the Mongo conditional write (expected version
// -> stored version+1) is the serialization point; the MySQL conditional
// bump confirms it. A writer that loses either store rolls back its Mongo
// write and answers 409, so the two stores can only converge to the winner's
// state (no lost update, no version skew serving stale bodies).
package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"app-board/internal/cache"
	"app-board/internal/model"
	"app-board/internal/repo"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// Sentinel errors mapped to HTTP status codes by the router layer.
var (
	ErrNotFound      = errors.New("board not found")   // -> 404 (also covers "not yours")
	ErrConflict      = errors.New("version conflict")  // -> 409
	ErrPrecondition  = errors.New("if-match required") // -> 428
	ErrInvalidInput  = errors.New("invalid input")     // -> 400
	ErrDuplicateName = errors.New("同名看板已存在")      // -> 400 (user-facing copy)
	ErrStorage       = errors.New("storage error")     // -> 500
	ErrContentTooBig = errors.New("content too large") // -> 413
)

const (
	KindMindmap    = "mindmap"
	KindWhiteboard = "whiteboard"
	// MaxContentBytes caps one board body. Mongo's per-document cap is 16MB;
	// this leaves ample headroom for the envelope fields.
	MaxContentBytes = 8 << 20
	// maxCacheableContentBytes skips the Redis detail cache for big bodies
	// (Redis is shared; 8MB entries would crowd out the rest of the cache).
	maxCacheableContentBytes = 1 << 20
)

// MetaStore is the metadata interface implemented by repo.BoardRepo.
type MetaStore interface {
	GetByUUID(ctx context.Context, uid int64, uuid string) (*model.Board, error)
	List(ctx context.Context, uid int64, kind string, page, pageSize int) ([]model.Board, int64, error)
	TitleExists(ctx context.Context, uid int64, kind, title, excludeUUID string) (bool, error)
	Create(ctx context.Context, b *model.Board) error
	UpdatePin(ctx context.Context, uid int64, uuid string, pinned bool) (*model.Board, error)
	SoftDelete(ctx context.Context, uid int64, uuid string) error
	BumpVersion(ctx context.Context, uid int64, uuid string, expectedVersion int64, title *string, pinned *bool) (int64, error)
}

// BoardService wires the metadata store, the body store and the read cache.
//
// Caching contract: cache-aside on reads only. Writes commit to the stores
// first (MySQL version is the authority — never cached) and then invalidate
// the affected keys, so a cache hit can only be at most one TTL old, and in
// practice always fresh after the writer's own request completes.
type BoardService struct {
	meta  MetaStore
	docs  repo.DocStore
	cache cache.CacheStore
}

func NewBoardService(meta MetaStore, docs repo.DocStore, readCache cache.CacheStore) *BoardService {
	if readCache == nil {
		readCache = cache.NoopCache{}
	}
	return &BoardService{meta: meta, docs: docs, cache: readCache}
}

// Cache keys. detail MUST carry uid: ownership is enforced by the DB query,
// so a uuid-only key would leak one user's board to another via cache hit.
const (
	cacheKeyDetailFmt = "board:detail:%d:%s"     // board:detail:{uid}:{uuid}
	cacheKeyListFmt   = "board:list:%d:%s:%d:%d" // board:list:{uid}:{kind}:{page}:{pageSize}
	cacheKeyKindAll   = "all"                    // list "kind filter unset" bucket
)

func (s *BoardService) detailKey(uid int64, boardUUID string) string {
	return fmt.Sprintf(cacheKeyDetailFmt, uid, boardUUID)
}

func (s *BoardService) listPrefix(uid int64) string {
	return fmt.Sprintf("board:list:%d:", uid)
}

func (s *BoardService) listKey(uid int64, kind string, page, pageSize int) string {
	if kind == "" {
		kind = cacheKeyKindAll
	}
	return fmt.Sprintf(cacheKeyListFmt, uid, kind, page, pageSize)
}

// BoardMeta is the API-facing metadata shape (camelCase via router).
type BoardMeta struct {
	UUID      string    `json:"uuid"`
	Title     string    `json:"title"`
	Kind      string    `json:"kind"`
	Version   int64     `json:"version"`
	IsPinned  bool      `json:"isPinned"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// BoardDetail is the metadata plus the body JSON (nil when absent).
type BoardDetail struct {
	BoardMeta
	Content *string `json:"content"`
}

// truncateRunes shortens s to at most n runes WITHOUT splitting a multi-byte
// sequence — a byte-slice cut can produce invalid UTF-8, which MySQL tolerates
// but Mongo/BSON rejects outright (the "Invalid UTF-8 string in BSON" class
// of failures). VARCHAR(255) counts characters, so n = 255.
func truncateRunes(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n])
}

func ptr[T any](v T) *T { return &v }

func toMeta(b *model.Board) BoardMeta {
	return BoardMeta{
		UUID:      b.UUID,
		Title:     b.Title,
		Kind:      b.Kind,
		Version:   b.Version,
		IsPinned:  b.IsPinned,
		CreatedAt: b.CreatedAt,
		UpdatedAt: b.UpdatedAt,
	}
}

func validateKind(kind string) error {
	if kind != KindMindmap && kind != KindWhiteboard {
		return fmt.Errorf("%w: kind must be mindmap or whiteboard", ErrInvalidInput)
	}
	return nil
}

// ensureUniqueTitle rejects a title that another non-deleted board of the
// same uid+kind already uses. Empty titles skip the check (they render as
// 未命名 in clients and legacy rows may carry ""). Returns the normalized
// title.
func (s *BoardService) ensureUniqueTitle(ctx context.Context, uid int64, kind, title, excludeUUID string) (string, error) {
	title = truncateRunes(strings.TrimSpace(title), 255)
	if title == "" {
		return "", nil
	}
	exists, err := s.meta.TitleExists(ctx, uid, kind, title, excludeUUID)
	if err != nil {
		return "", fmt.Errorf("%w: check duplicate title: %v", ErrStorage, err)
	}
	if exists {
		return "", ErrDuplicateName
	}
	return title, nil
}

// Create makes a new board and returns its metadata. content may be
// empty (create-then-edit flow).
func (s *BoardService) Create(ctx context.Context, uid int64, title, kind, content string) (*BoardMeta, error) {
	if err := validateKind(kind); err != nil {
		return nil, err
	}
	if len(content) > MaxContentBytes {
		return nil, ErrContentTooBig
	}
	// 空标题归一为默认名（前端新建/导入都会给具体名，这里是 API 兜底）。
	if strings.TrimSpace(title) == "" {
		title = "未命名看板"
	}
	title, err := s.ensureUniqueTitle(ctx, uid, kind, title, "")
	if err != nil {
		return nil, err
	}
	b := &model.Board{
		UUID:    uuid.NewString(),
		UID:     uid,
		Title:   title,
		Kind:    kind,
		Version: 1,
	}
	if err := s.meta.Create(ctx, b); err != nil {
		return nil, fmt.Errorf("%w: create board meta: %v", ErrStorage, err)
	}
	// A new board changes every list page of the user; no detail exists yet.
	s.cache.DelByPrefix(ctx, s.listPrefix(uid))
	if content != "" {
		// Create path: expected 0 (no document) -> stored 1, mirroring the
		// metadata version. A failure here leaves a content-less board —
		// GET serves null content and the next PUT (If-Match: 1) heals it.
		if err := s.docs.ConditionalWrite(ctx, b.UUID, 0, content); err != nil {
			slog.ErrorContext(ctx, "[BOARD] create body write failed", "uuid", b.UUID, "err", err)
		}
	}
	meta := toMeta(b)
	return &meta, nil
}

// GetDetail returns the full board: metadata + content body (BoardDetail).
// 404 semantics: missing, soft-deleted, or
// owned by someone else (no existence leak across users).
func (s *BoardService) GetDetail(ctx context.Context, uid int64, boardUUID string) (*BoardDetail, error) {
	key := s.detailKey(uid, boardUUID)
	if v, ok := s.cache.Get(ctx, key); ok {
		var d BoardDetail
		if err := json.Unmarshal([]byte(v), &d); err == nil {
			return &d, nil
		}
		// Corrupt entry: treat as miss (Del below would race with refill).
	}
	b, err := s.meta.GetByUUID(ctx, uid, boardUUID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("%w: get board meta: %v", ErrStorage, err)
	}
	detail := &BoardDetail{BoardMeta: toMeta(b)}
	doc, err := s.docs.Get(ctx, boardUUID)
	if err != nil {
		return nil, fmt.Errorf("%w: get board body: %v", ErrStorage, err)
	}
	if doc != nil {
		detail.Content = &doc.Content
	}
	// Cap the read cache at 1MB per entry: bodies go up to 8MB and Redis is a
	// shared instance — caching every large body would crowd out everything
	// else. Big boards simply always hit the stores (they are also the rare
	// case; the editor keeps its own in-memory state anyway).
	if detail.Content == nil || len(*detail.Content) <= maxCacheableContentBytes {
		if b, err := json.Marshal(detail); err == nil {
			s.cache.Set(ctx, key, string(b))
		}
	}
	return detail, nil
}

// ListMetas returns one page of metadata ONLY ([]BoardMeta, no content body);
// use GetDetail when the body is needed.
func (s *BoardService) ListMetas(ctx context.Context, uid int64, kind string, page, pageSize int) ([]BoardMeta, int64, error) {
	if kind != "" && kind != KindMindmap && kind != KindWhiteboard {
		return nil, 0, fmt.Errorf("%w: unknown kind filter", ErrInvalidInput)
	}
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 20
	}
	key := s.listKey(uid, kind, page, pageSize)
	if v, ok := s.cache.Get(ctx, key); ok {
		var cached boardListPage
		if err := json.Unmarshal([]byte(v), &cached); err == nil {
			return cached.Items, cached.Total, nil
		}
	}
	boards, total, err := s.meta.List(ctx, uid, kind, page, pageSize)
	if err != nil {
		return nil, 0, fmt.Errorf("%w: list boards: %v", ErrStorage, err)
	}
	metas := make([]BoardMeta, 0, len(boards))
	for i := range boards {
		metas = append(metas, toMeta(&boards[i]))
	}
	if b, err := json.Marshal(boardListPage{Items: metas, Total: total}); err == nil {
		s.cache.Set(ctx, key, string(b))
	}
	return metas, total, nil
}

// boardListPage is the cache envelope for ListMetas results.
type boardListPage struct {
	Items []BoardMeta `json:"items"`
	Total int64       `json:"total"`
}

// UpdateParams carries the PUT body. Nil pointers = field untouched.
type UpdateParams struct {
	Title    *string
	Content  *string
	IsPinned *bool
}

// Update is the optimistic-lock commit for title/content/isPinned.
// It returns the fresh metadata (no content body). ifMatch must equal the current
// metadata version (missing -> 428, stale -> 409). Content-only updates and
// metadata-only updates both bump the version — clients always re-read.
func (s *BoardService) Update(ctx context.Context, uid int64, boardUUID string, ifMatch int64, p UpdateParams) (*BoardMeta, error) {
	if p.Content != nil && len(*p.Content) > MaxContentBytes {
		return nil, ErrContentTooBig
	}
	if p.Title != nil {
		p.Title = ptr(strings.TrimSpace(*p.Title))
	}

	b, err := s.meta.GetByUUID(ctx, uid, boardUUID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("%w: get board meta: %v", ErrStorage, err)
	}
	if ifMatch != b.Version {
		// Stale client (or raced between read and write) -> conflict.
		return nil, fmt.Errorf("%w: if-match %d != current %d", ErrConflict, ifMatch, b.Version)
	}
	// 重命名时校验同名（未改名/清空标题跳过）；校验放在乐观锁确认之后，
	// 失败不计入任何存储写入。
	if p.Title != nil && *p.Title != "" && *p.Title != b.Title {
		unique, err := s.ensureUniqueTitle(ctx, uid, b.Kind, *p.Title, boardUUID)
		if err != nil {
			return nil, err
		}
		p.Title = ptr(unique)
	}

	// Serialize content writers in Mongo first (conditional on current doc
	// version == metadata version). Metadata-only updates skip this.
	// priorDoc is captured for the rollback path (Restore deletes when nil,
	// i.e. the create-path where no body existed before).
	var priorDoc *repo.BoardDocument
	if p.Content != nil {
		priorDoc, err = s.docs.Get(ctx, boardUUID)
		if err != nil {
			return nil, fmt.Errorf("%w: read prior board body: %v", ErrStorage, err)
		}
		if err := s.docs.ConditionalWrite(ctx, boardUUID, b.Version, *p.Content); err != nil {
			if errors.Is(err, repo.ErrConflict) {
				return nil, fmt.Errorf("%w: concurrent body write", ErrConflict)
			}
			return nil, fmt.Errorf("%w: write board body: %v", ErrStorage, err)
		}
	}

	rows, err := s.meta.BumpVersion(ctx, uid, boardUUID, b.Version, p.Title, p.IsPinned)
	if err != nil {
		if p.Content != nil {
			s.rollbackDoc(ctx, boardUUID, b.Version+1, priorDoc)
		}
		return nil, fmt.Errorf("%w: bump board version: %v", ErrStorage, err)
	}
	if rows == 0 {
		// A concurrent writer bumped the metadata between our read and
		// write; undo our body write and report the conflict.
		if p.Content != nil {
			s.rollbackDoc(ctx, boardUUID, b.Version+1, priorDoc)
		}
		return nil, ErrConflict
	}

	// Committed: drop the affected read-cache entries (detail for this user
	// + every list page of the user, ordering/pin/title may have changed).
	s.cache.Del(ctx, s.detailKey(uid, boardUUID))
	s.cache.DelByPrefix(ctx, s.listPrefix(uid))

	updated, err := s.meta.GetByUUID(ctx, uid, boardUUID)
	if err != nil {
		return nil, fmt.Errorf("%w: reload board meta: %v", ErrStorage, err)
	}
	meta := toMeta(updated)
	return &meta, nil
}

// rollbackDoc best-effort restores the pre-write body after a lost race:
// prior==nil deletes the just-written doc (create path), otherwise the prior
// document is reinstated — both guarded on writtenVersion inside the store.
func (s *BoardService) rollbackDoc(ctx context.Context, boardUUID string, writtenVersion int64, prior *repo.BoardDocument) {
	if err := s.docs.Restore(ctx, boardUUID, writtenVersion, prior); err != nil {
		slog.ErrorContext(ctx, "[BOARD] body rollback failed", "uuid", boardUUID, "written_version", writtenVersion, "err", err)
	}
}

// SetPin flips the pinned flag (no version bump — not a content change)
// and returns the fresh metadata.
func (s *BoardService) SetPin(ctx context.Context, uid int64, boardUUID string, pinned bool) (*BoardMeta, error) {
	b, err := s.meta.UpdatePin(ctx, uid, boardUUID, pinned)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("%w: pin board: %v", ErrStorage, err)
	}
	s.cache.Del(ctx, s.detailKey(uid, boardUUID))
	s.cache.DelByPrefix(ctx, s.listPrefix(uid))
	meta := toMeta(b)
	return &meta, nil
}

// Delete soft-deletes the board (Mongo body retained for recovery).
// The board disappears from list/get but the body can be restored manually.
func (s *BoardService) Delete(ctx context.Context, uid int64, boardUUID string) error {
	err := s.meta.SoftDelete(ctx, uid, boardUUID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("%w: delete board: %v", ErrStorage, err)
	}
	s.cache.Del(ctx, s.detailKey(uid, boardUUID))
	s.cache.DelByPrefix(ctx, s.listPrefix(uid))
	return nil
}
