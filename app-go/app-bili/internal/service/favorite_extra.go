// FavoriteService supplemental methods (folder management + organize flows).
package service

import (
	"context"
	"fmt"

	"app-bili/internal/bili"
	"app-bili/internal/model"
)

// ListOrSyncFolders serves the folder list; empty DB triggers an auto-sync
// (parity with the Python router's cache→DB→auto-sync chain; the Redis cache
// layer is not ported — direct DB reads at this volume are cheap).
func (s *FavoriteService) ListOrSyncFolders(ctx context.Context, uid int64, client *bili.Client) ([]model.FavoriteFolder, error) {
	folders, err := s.folders.ListByUID(ctx, s.db, uid)
	if err != nil {
		return nil, err
	}
	if len(folders) > 0 {
		return folders, nil
	}
	return s.SyncFolders(ctx, uid, client)
}

// SyncFolders fetches all folders from Bilibili and upserts them for uid.
func (s *FavoriteService) SyncFolders(ctx context.Context, uid int64, client *bili.Client) ([]model.FavoriteFolder, error) {
	raw, err := client.GetFavorites(ctx)
	if err != nil {
		return nil, err
	}
	var out []model.FavoriteFolder
	for _, f := range raw {
		if f.MediaID == 0 {
			continue
		}
		row, err := s.folders.UpsertFolder(ctx, s.db, uid, f.MediaID, f.Title, f.MediaCount, isDefaultFolder(f.Title, f.Type, f.FavState, f.Attr))
		if err != nil {
			return nil, err
		}
		out = append(out, *row)
	}
	return out, nil
}

// UpdateFolderSelected toggles is_selected (IDOR-safe: uid-scoped).
func (s *FavoriteService) UpdateFolderSelected(ctx context.Context, folderID int64, selected bool, uid int64) (bool, error) {
	return s.folders.UpdateSelected(ctx, s.db, folderID, uid, selected)
}

// DeleteFolder soft-deletes a local folder (never touches Bilibili data).
func (s *FavoriteService) DeleteFolder(ctx context.Context, folderID int64, uid int64) (bool, error) {
	return s.folders.SoftDelete(ctx, s.db, folderID, uid)
}

// OrganizePreview scans the default folder for candidates. The classification
// rule layer was removed in the Python version (everything lands as
// "待手动分类" with matched=0) — the Go port preserves exactly that contract.
func (s *FavoriteService) OrganizePreview(ctx context.Context, uid int64, client *bili.Client) (map[string]any, error) {
	raw, err := client.GetFavorites(ctx)
	if err != nil {
		return nil, err
	}
	var defaultMediaID int64
	for _, f := range raw {
		if isDefaultFolder(f.Title, f.Type, f.FavState, f.Attr) {
			defaultMediaID = f.MediaID
			break
		}
	}
	if defaultMediaID == 0 {
		return map[string]any{"message": "未找到默认收藏夹", "candidates": []any{}, "matched": 0}, nil
	}
	videos, err := client.GetAllFavoriteVideos(ctx, defaultMediaID)
	if err != nil {
		return nil, err
	}
	candidates := make([]map[string]any, 0, len(videos))
	for _, m := range videos {
		if m.BvID == "" || m.Attr == 9 || m.Title == "已失效视频" || m.Title == "已删除视频" {
			continue
		}
		rid, rtype := m.ID, m.Type
		if rid == 0 {
			rid, rtype = m.ID, 2
		}
		candidates = append(candidates, map[string]any{
			"bvid": m.BvID, "title": m.Title,
			"resource_id": rid, "resource_type": rtype,
			"reason": "待手动分类",
		})
	}
	return map[string]any{
		"default_media_id": defaultMediaID,
		"candidates":       candidates,
		"total":            len(candidates),
		"matched":          0,
	}, nil
}

// OrganizeExecute moves preview candidates into the given target folders.
func (s *FavoriteService) OrganizeExecute(ctx context.Context, uid int64, client *bili.Client, targetFolderIDs []int64) (map[string]any, error) {
	if len(targetFolderIDs) == 0 {
		return map[string]any{"moved": 0, "message": "未提供目标收藏夹"}, nil
	}
	raw, err := client.GetFavorites(ctx)
	if err != nil {
		return nil, err
	}
	var defaultMediaID int64
	for _, f := range raw {
		if isDefaultFolder(f.Title, f.Type, f.FavState, f.Attr) {
			defaultMediaID = f.MediaID
			break
		}
	}
	if defaultMediaID == 0 {
		return nil, &HTTPError{Status: 400, Message: "未找到默认收藏夹"}
	}
	videos, err := client.GetAllFavoriteVideos(ctx, defaultMediaID)
	if err != nil {
		return nil, err
	}
	moved := 0
	tar := targetFolderIDs[0] // single target: the Python v1 flow groups by one target per call
	var resources []string
	for _, m := range videos {
		if m.BvID == "" || m.Attr == 9 || m.Title == "已失效视频" || m.Title == "已删除视频" {
			continue
		}
		rid, rtype := m.ID, m.Type
		if rid == 0 {
			rid, rtype = m.ID, 2
		}
		if int64(rtype) == tar || tar == defaultMediaID {
			continue
		}
		resources = append(resources, fmt.Sprintf("%d:%d", rid, rtype))
	}
	if len(resources) > 0 {
		if _, err := client.MoveFavoriteResources(ctx, defaultMediaID, tar, resources); err != nil {
			return nil, err
		}
		moved = len(resources)
	}
	return map[string]any{"moved": moved, "target_folder_id": tar}, nil
}

// CleanInvalid delegates to the Bilibili clean endpoint (write flow).
func (s *FavoriteService) CleanInvalid(ctx context.Context, client *bili.Client, mediaID int64) (map[string]any, error) {
	return client.CleanFavorite(ctx, mediaID)
}

// foldersToJSON renders the FavoriteFolderResponse wire shape.
// FoldersToJSON renders the FavoriteFolderResponse wire shape.
func FoldersToJSON(folders []model.FavoriteFolder) []map[string]any {
	out := make([]map[string]any, 0, len(folders))
	for _, f := range folders {
		item := map[string]any{
			"id": f.ID, "media_id": f.MediaID, "title": f.Title,
			"media_count": derefIntPtr(f.MediaCount),
			"is_default":  derefBool(f.IsDefault),
			"is_selected": true,
		}
		if f.IsSelected != nil {
			item["is_selected"] = *f.IsSelected
		}
		if f.LastSyncAt != nil {
			item["last_sync_at"] = naiveUTC(*f.LastSyncAt)
		}
		out = append(out, item)
	}
	return out
}
