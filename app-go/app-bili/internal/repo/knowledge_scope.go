// Knowledge scope reads for the internal M2M face (/internal/bili/scope).
// Read-only joins over favorite_folders / collection / video so the AI side
// (app-ts) can resolve a user's folder→video→page tree without direct MySQL
// access. RED LINE: reads only — no writes, vectorized*/kg* columns ignored.
package repo

import (
	"context"

	"app-bili/internal/model"

	"gorm.io/gorm"
)

type KnowledgeScopeRepo struct{}

func NewKnowledgeScopeRepo() *KnowledgeScopeRepo { return &KnowledgeScopeRepo{} }

// ListAliveFolders returns the user's non-deleted favorite folders.
func (KnowledgeScopeRepo) ListAliveFolders(ctx context.Context, db *gorm.DB, uid int64) ([]model.FavoriteFolder, error) {
	var rows []model.FavoriteFolder
	err := db.WithContext(ctx).
		Where("uid = ? AND deleted_at IS NULL", uid).
		Order("id ASC").
		Find(&rows).Error
	return rows, err
}

// ListCollectionByMediaIDs returns collection rows for the given folders.
func (KnowledgeScopeRepo) ListCollectionByMediaIDs(ctx context.Context, db *gorm.DB, mediaIDs []int64) ([]model.Collection, error) {
	if len(mediaIDs) == 0 {
		return nil, nil
	}
	var rows []model.Collection
	err := db.WithContext(ctx).
		Where("media_id IN ?", mediaIDs).
		Order("id ASC").
		Find(&rows).Error
	return rows, err
}

// ListVideosByBvids returns page rows (ASR state) for the given bvids.
func (KnowledgeScopeRepo) ListVideosByBvids(ctx context.Context, db *gorm.DB, bvids []string) ([]model.Video, error) {
	if len(bvids) == 0 {
		return nil, nil
	}
	var rows []model.Video
	err := db.WithContext(ctx).
		Where("bvid IN ?", bvids).
		Order("bvid ASC, page_index ASC").
		Find(&rows).Error
	return rows, err
}

// BvidBelongsToUser reports whether the bvid appears in any alive folder of
// the user (the delete-from-knowledge ownership check).
func (KnowledgeScopeRepo) BvidBelongsToUser(ctx context.Context, db *gorm.DB, uid int64, bvid string) (bool, error) {
	var n int64
	err := db.WithContext(ctx).Table("collection").
		Joins("JOIN favorite_folders ON favorite_folders.media_id = collection.media_id").
		Where("favorite_folders.uid = ? AND favorite_folders.deleted_at IS NULL AND collection.bvid = ?", uid, bvid).
		Count(&n).Error
	return n > 0, err
}
