// Knowledge scope service — assembles the folder→video→page tree the AI side
// consumes over the internal M2M face. Pure read assembly; no business rules.
package service

import (
	"app-user/internal/utils"
	"context"
	"time"

	bilidto "app-user/internal/dto/bili"
	"app-user/internal/repo/bili"

	"gorm.io/gorm"
)

func formatTimePtr(t *time.Time) string {
	if t == nil {
		return ""
	}
	return utils.NaiveUTC(*t)
}

// KnowledgeScope resolves the user's folder/video/page tree for vectorization
// bookkeeping and ownership checks.
type KnowledgeScopeService struct {
	db   *gorm.DB
	repo *repo.KnowledgeScopeRepo
}

func NewKnowledgeScopeService(db *gorm.DB) *KnowledgeScopeService {
	return &KnowledgeScopeService{db: db, repo: repo.NewKnowledgeScopeRepo()}
}

func (s *KnowledgeScopeService) Scope(ctx context.Context, uid int64) (*bilidto.ScopeResult, error) {
	folders, err := s.repo.ListAliveFolders(ctx, s.db, uid)
	if err != nil {
		return nil, err
	}
	if len(folders) == 0 {
		return &bilidto.ScopeResult{Folders: []bilidto.ScopeFolder{}}, nil
	}

	mediaIDs := make([]int64, 0, len(folders))
	for _, f := range folders {
		mediaIDs = append(mediaIDs, f.MediaID)
	}
	collections, err := s.repo.ListCollectionByMediaIDs(ctx, s.db, mediaIDs)
	if err != nil {
		return nil, err
	}

	bvidSet := make(map[string]struct{}, len(collections))
	for _, c := range collections {
		if c.BvID != "" {
			bvidSet[c.BvID] = struct{}{}
		}
	}
	bvids := make([]string, 0, len(bvidSet))
	for b := range bvidSet {
		bvids = append(bvids, b)
	}
	videos, err := s.repo.ListVideosByBvids(ctx, s.db, bvids)
	if err != nil {
		return nil, err
	}
	pagesByBvid := make(map[string][]bilidto.ScopePage, len(videos))
	for _, v := range videos {
		title := ""
		if v.PageTitle != nil {
			title = *v.PageTitle
		}
		processed := v.IsProcessed != nil && *v.IsProcessed
		version := 0
		if v.Version != nil {
			version = *v.Version
		}
		pagesByBvid[v.BvID] = append(pagesByBvid[v.BvID], bilidto.ScopePage{
			CID:         v.CID,
			PageIndex:   v.PageIndex,
			PageTitle:   title,
			IsProcessed: processed,
			Version:     version,
		})
	}

	// collection.title is the video title; one entry per bvid (dedup across folders).
	videoTitle := make(map[string]string, len(collections))
	for _, c := range collections {
		if _, seen := videoTitle[c.BvID]; !seen {
			videoTitle[c.BvID] = c.Title
		}
	}

	out := make([]bilidto.ScopeFolder, 0, len(folders))
	for _, f := range folders {
		folderVideos := make([]bilidto.ScopeVideo, 0)
		seen := make(map[string]struct{})
		for _, c := range collections {
			if c.MediaID != f.MediaID {
				continue
			}
			if _, dup := seen[c.BvID]; dup {
				continue
			}
			seen[c.BvID] = struct{}{}
			pages := pagesByBvid[c.BvID]
			if pages == nil {
				pages = []bilidto.ScopePage{}
			}
			folderVideos = append(folderVideos, bilidto.ScopeVideo{BvID: c.BvID, Title: videoTitle[c.BvID], Pages: pages})
		}
		out = append(out, bilidto.ScopeFolder{
			MediaID:    f.MediaID,
			MediaCount: f.MediaCount,
			LastSyncAt: formatTimePtr(f.LastSyncAt),
			Videos:     folderVideos,
		})
	}
	return &bilidto.ScopeResult{Folders: out}, nil
}

// BvidBelongsToUser is the ownership check for knowledge-base deletion.
func (s *KnowledgeScopeService) BvidBelongsToUser(ctx context.Context, uid int64, bvid string) (bool, error) {
	return s.repo.BvidBelongsToUser(ctx, s.db, uid, bvid)
}
