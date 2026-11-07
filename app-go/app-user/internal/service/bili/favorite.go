// FavoriteService — favorites sync & query. Port of
// app/services/favorite/service.py including both anti-deletion guards:
// an empty remote list never deletes local rows, and invalid entries
// (attr==9 / 已失效视频 / 已删除视频) are skipped on insert.
package service

import (
	"app-user/internal/utils"
	"context"
	"log/slog"

	"app-user/internal/bili/bili"
	"app-user/internal/model/bili"
	"app-user/internal/repo/bili"

	"gorm.io/gorm"
)

type FavoriteService struct {
	db         *gorm.DB
	folders    *repo.FolderRepo
	collection *repo.CollectionRepo
}

func NewFavoriteService(db *gorm.DB) *FavoriteService {
	return &FavoriteService{db: db, folders: repo.NewFolderRepo(), collection: repo.NewCollectionRepo()}
}

// isDefaultFolder mirrors the Python default-folder heuristic.
func isDefaultFolder(title string, folderType, favState, attr int) bool {
	if folderType == 1 || favState == 1 || attr == 1 {
		return true
	}
	return title == "默认收藏夹"
}

// SyncVideos performs the full-replace sync of one folder's videos.
func (s *FavoriteService) SyncVideos(ctx context.Context, uid, folderID int64, client *bili.Client) (map[string]any, error) {
	folder, err := s.getFolderOrRaise(ctx, folderID, uid)
	if err != nil {
		return nil, err
	}

	raw, err := client.GetAllFavoriteVideos(ctx, folder.MediaID)
	if err != nil {
		return nil, err
	}

	// Anti-deletion: empty remote list ⇒ touch nothing (API hiccup must not
	// wipe the local knowledge base).
	if len(raw) == 0 {
		slog.Warn("[FAV] empty video list — skipping sync", "media_id", folder.MediaID)
		return map[string]any{"total": 0, "added": 0}, nil
	}

	added := 0
	rows := make([]model.Collection, 0, len(raw))
	for _, m := range raw {
		if m.BvID == "" {
			continue
		}
		if m.Attr == 9 || m.Title == "已失效视频" || m.Title == "已删除视频" {
			continue
		}
		row := model.Collection{
			MediaID:     folder.MediaID,
			BvID:        m.BvID,
			Title:       m.Title,
			Cover:       utils.StrPtr(m.Cover),
			Duration:    utils.IntPtr(m.Duration),
			OwnerName:   utils.StrPtr(m.Upper.Name),
			OwnerMid:    int64Ptr(m.Upper.Mid),
			Description: utils.StrPtr(m.Intro),
		}
		if m.UGC.FirstCID > 0 {
			cid := m.UGC.FirstCID
			row.CID = &cid
		}
		rows = append(rows, row)
		added++
	}
	// Single transaction: delete + bulk insert + folder touch either all commit
	// or all roll back. A partial failure previously left the folder empty (or
	// with duplicated rows after a retry while the delete had committed).
	if err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := s.collection.DeleteByMediaID(ctx, tx, folder.MediaID); err != nil {
			return err
		}
		if err := s.collection.BulkInsert(ctx, tx, rows); err != nil {
			return err
		}
		return s.folders.TouchSync(ctx, tx, folder.ID, added)
	}); err != nil {
		return nil, err
	}
	slog.Info("[FAV] videos synced", "media_id", folder.MediaID, "added", added)
	return map[string]any{"total": added, "added": added}, nil
}

// ListVideosByMediaID — paginated list with auto-sync on empty cache.
func (s *FavoriteService) ListVideosByMediaID(ctx context.Context, uid, mediaID int64,
	client *bili.Client, page, pageSize int, syncFn func(ctx context.Context, uid, folderID int64) error) (map[string]any, error) {
	folder, err := s.getFolderByMediaID(ctx, uid, mediaID)
	if err != nil {
		return nil, err
	}
	// The COUNT doubles as the auto-sync sentinel and as the pagination total.
	// Warm requests issue exactly one COUNT; only the cold-start request (which
	// just wrote a fresh batch) re-counts to return an exact total.
	count, err := s.collection.CountByMediaID(ctx, s.db, mediaID)
	if err != nil {
		return nil, err
	}
	coldStart := count == 0
	if coldStart && syncFn != nil {
		slog.Info("[FAV] auto-syncing videos", "media_id", mediaID)
		if err := syncFn(ctx, uid, folder.ID); err != nil {
			return nil, err
		}
	}
	var rows []model.Collection
	offset := (page - 1) * pageSize
	// Stable order: created_at DESC, id DESC — synced rows share the same
	// created_at second, so the id tie-breaker is required to keep pagination
	// deterministic (backed by ix_collection_media_created).
	if err := s.db.WithContext(ctx).Where("media_id = ?", mediaID).
		Order("created_at DESC, id DESC").Offset(offset).Limit(pageSize).Find(&rows).Error; err != nil {
		return nil, err
	}
	total := count
	if coldStart {
		total, err = s.collection.CountByMediaID(ctx, s.db, mediaID)
		if err != nil {
			return nil, err
		}
	}
	videos := make([]map[string]any, 0, len(rows))
	for _, r := range rows {
		videos = append(videos, map[string]any{
			"id": r.ID, "bvid": r.BvID, "title": r.Title,
			"cover": utils.DerefStr(r.Cover), "duration": utils.DerefInt(r.Duration),
			"owner": utils.DerefStr(r.OwnerName), "cid": utils.DerefInt64(r.CID),
			"is_selected": true,
			"synced_at":   utils.NaiveUTC(r.CreatedAt),
		})
	}
	return map[string]any{
		"folder_id": folder.ID, "media_id": mediaID, "folder_title": folder.Title,
		"videos": videos, "total": total, "page": page, "page_size": pageSize,
		"has_more": int64(offset+pageSize) < total,
	}, nil
}

func (s *FavoriteService) getFolderOrRaise(ctx context.Context, id, uid int64) (*model.FavoriteFolder, error) {
	f, err := s.folders.GetByID(ctx, s.db, id)
	if err != nil {
		return nil, err
	}
	if f == nil {
		return nil, &utils.HTTPError{Status: 404, Message: "Folder not found"}
	}
	if f.DeletedAt != nil {
		return nil, &utils.HTTPError{Status: 404, Message: "Folder has been deleted"}
	}
	if f.UID != nil && *f.UID != uid {
		return nil, &utils.HTTPError{Status: 404, Message: "Access denied to this folder"}
	}
	return f, nil
}

func (s *FavoriteService) getFolderByMediaID(ctx context.Context, uid, mediaID int64) (*model.FavoriteFolder, error) {
	var f model.FavoriteFolder
	err := s.db.WithContext(ctx).Where("uid = ? AND media_id = ? AND deleted_at IS NULL", uid, mediaID).First(&f).Error
	if err == gorm.ErrRecordNotFound {
		return nil, &utils.HTTPError{Status: 404, Message: "Folder not found — sync folders first"}
	}
	if err != nil {
		return nil, err
	}
	return &f, nil
}

func int64Ptr(v int64) *int64 {
	if v == 0 {
		return nil
	}
	return &v
}
