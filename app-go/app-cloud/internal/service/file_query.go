package service

import (
	"context"
	"fmt"
	"sync"
	"time"

	"app-cloud/internal/infra/cache"
	"app-cloud/internal/model"
	"app-cloud/internal/repo"

	"gorm.io/gorm"
)

// FilePage is a cached file-list page plus its total.
type FilePage struct {
	Rows  []model.CloudFile
	Total int64
}

// CachedFile is a cached by-id lookup (Found distinguishes a cached miss).
type CachedFile struct {
	File  model.CloudFile
	Found bool
}

// FileQueryService provides short-TTL, per-uid-versioned caches for the
// read-heavy file list/search paths. A write bumps that uid's version and
// immediately makes all previous list/search keys stale; old entries age out
// naturally, so there is no global Clear() thundering herd.
//
// This is deliberately a read cache, not a source of truth: TTL is 5s/10s and
// every entry is keyed by uid + query, so users can never see another user's
// rows.
type FileQueryService struct {
	db          *gorm.DB
	files       *repo.FileRepo
	listCache   cache.LoadingCache[string, FilePage]
	searchCache cache.LoadingCache[string, []model.CloudFile]
	detailCache cache.LoadingCache[string, CachedFile]

	mu       sync.RWMutex
	versions map[int64]uint64

	listTTL   time.Duration
	searchTTL time.Duration
	detailTTL time.Duration
}

func NewFileQueryService(db *gorm.DB, files *repo.FileRepo,
	listCache cache.LoadingCache[string, FilePage],
	searchCache cache.LoadingCache[string, []model.CloudFile],
	detailCache cache.LoadingCache[string, CachedFile]) *FileQueryService {
	return &FileQueryService{
		db:          db,
		files:       files,
		listCache:   listCache,
		searchCache: searchCache,
		detailCache: detailCache,
		versions:    make(map[int64]uint64),
		listTTL:     5 * time.Second,
		searchTTL:   10 * time.Second,
		detailTTL:   5 * time.Second,
	}
}

// Invalidate bumps the uid version after a file/folder mutation. The list and
// search keys include this version, so the next read goes to MySQL. Other
// replicas converge within the 5s/10s TTLs (L1 only; Redis L2 can be added
// behind the same cache.LoadingCache contract later).
func (s *FileQueryService) Invalidate(uid int64) {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.versions[uid]++
	s.mu.Unlock()
}

func (s *FileQueryService) version(uid int64) uint64 {
	s.mu.RLock()
	v := s.versions[uid]
	s.mu.RUnlock()
	return v
}

func (s *FileQueryService) List(ctx context.Context, uid int64, folderID *int64,
	page, pageSize int, sortCol, order string) ([]model.CloudFile, int64, error) {
	folderKey := "root"
	if folderID != nil {
		folderKey = fmt.Sprintf("f%d", *folderID)
	}
	key := fmt.Sprintf("files:%d:%d:%s:%d:%d:%s:%s", uid, s.version(uid),
		folderKey, page, pageSize, sortCol, order)
	pageResult, err := s.listCache.GetOrLoad(ctx, key, s.listTTL, 0,
		func(ctx context.Context, _ string) (FilePage, error) {
			rows, total, err := s.files.ListByFolder(s.db, uid, folderID, page, pageSize, sortCol, order)
			if err != nil {
				return FilePage{}, err
			}
			return FilePage{Rows: rows, Total: total}, nil
		})
	if err != nil {
		return nil, 0, err
	}
	return pageResult.Rows, pageResult.Total, nil
}

func (s *FileQueryService) Search(ctx context.Context, uid int64, q string, limit int) ([]model.CloudFile, error) {
	key := fmt.Sprintf("search:%d:%d:%s:%d", uid, s.version(uid), q, limit)
	return s.searchCache.GetOrLoad(ctx, key, s.searchTTL, 0,
		func(ctx context.Context, _ string) ([]model.CloudFile, error) {
			return s.files.SearchByName(s.db, uid, q, limit)
		})
}

// Detail returns one cached file row. The cache is versioned per uid, so a
// write immediately makes the row stale for the next read.
func (s *FileQueryService) Detail(ctx context.Context, uid int64, uploadUUID string) (model.CloudFile, bool, error) {
	key := fmt.Sprintf("detail:%d:%d:%s", uid, s.version(uid), uploadUUID)
	lookup, err := s.detailCache.GetOrLoad(ctx, key, s.detailTTL, 0,
		func(ctx context.Context, _ string) (CachedFile, error) {
			file, err := s.files.GetByUUID(s.db, uploadUUID, uid)
			if err != nil {
				return CachedFile{}, err
			}
			if file == nil {
				return CachedFile{Found: false}, nil
			}
			return CachedFile{File: *file, Found: true}, nil
		})
	if err != nil {
		return model.CloudFile{}, false, err
	}
	return lookup.File, lookup.Found, nil
}
