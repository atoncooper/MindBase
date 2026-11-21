package service

import (
	"context"
	"log/slog"
	"time"

	"app-cloud/internal/config"
	"app-cloud/internal/infra/cache"
	"app-cloud/internal/model"
	"app-cloud/internal/repo"

	"gorm.io/gorm"
)

// FolderService owns the per-user folder-tree read path. The tree is cached
// as []model.CloudFolder (any value type; nothing here is string-specific).
// The cache backend is selected by infra/cache/factory; this service only
// depends on the generic cache.LoadingCache contract.
type FolderService struct {
	db      *gorm.DB
	folders *repo.FolderRepo
	cache   cache.LoadingCache[int64, []model.CloudFolder]
	ttl     time.Duration
}

// NewFolderService wires the folder-tree cache.
func NewFolderService(cfg *config.Config, db *gorm.DB, folders *repo.FolderRepo,
	cache cache.LoadingCache[int64, []model.CloudFolder]) *FolderService {
	if cache == nil {
		panic("service: folder cache is required")
	}
	ttl := time.Duration(cfg.Folder.CacheTTL) * time.Second
	if ttl <= 0 {
		ttl = 15 * time.Second
	}
	return &FolderService{db: db, folders: folders, cache: cache, ttl: ttl}
}

// List returns the user's active folder rows, refreshing counts on a miss.
// Cache hits bypass both the SELECT and the UpdateCounts write.
func (s *FolderService) List(ctx context.Context, uid int64) ([]model.CloudFolder, error) {
	return s.cache.GetOrLoad(ctx, uid, s.ttl, 0,
		func(ctx context.Context, key int64) ([]model.CloudFolder, error) {
			// Repair stale video_count before reading. This is the only DB write
			// on a cache miss; the previous implementation did it on every GET.
			if err := s.folders.UpdateCounts(s.db, key); err != nil {
				slog.Warn("[CLOUD_FOLDER] update_counts failed; serving rows", "uid", key, "err", err)
			}
			rows, err := s.folders.ListByUID(s.db, key)
			if err != nil {
				return nil, err
			}
			return rows, nil
		})
}

// Invalidate drops one user's cached tree after a folder/file mutation.
func (s *FolderService) Invalidate(ctx context.Context, uid int64) {
	s.cache.Delete(ctx, uid)
}
