// VideoPages — 分P 列表（port of Python VideoService.list_pages_by_bvid）。
// AI 域迁走后，Milvus/Mongo 自动heal 不在本服务职责内：is_vectorized 直读
// video 表陈旧列（红线：app-bili 不写该列），前端以 vec-page 任务状态覆盖展示。
package service

import (
	"context"
	"log/slog"

	"app-bili/internal/bili"
	"app-bili/internal/model"
	"app-bili/internal/repo"

	"gorm.io/gorm"
)

type VideoPagesService struct {
	db *gorm.DB
}

func NewVideoPagesService(db *gorm.DB) *VideoPagesService {
	return &VideoPagesService{db: db}
}

// ListPagesByBvid returns every page (cid) of a bvid. First access fetches the
// page list from the B站 view API and persists it into the video ledger
// (Python parity: DB-empty → _fetch_pages → upsert → re-read).
func (s *VideoPagesService) ListPagesByBvid(ctx context.Context, bvid string, client *bili.Client) (map[string]any, error) {
	repoV := repo.NewVideoRepo()
	rows, err := repoV.ListByBvid(ctx, s.db, bvid)
	if err != nil {
		return nil, err
	}

	if len(rows) == 0 {
		if err := s.fetchAndStorePages(ctx, bvid, client); err != nil {
			return nil, err
		}
		rows, err = repoV.ListByBvid(ctx, s.db, bvid)
		if err != nil {
			return nil, err
		}
	}

	pages := make([]map[string]any, 0, len(rows))
	for _, v := range rows {
		processed := v.IsProcessed != nil && *v.IsProcessed
		vecState := "pending"
		if v.IsVectorized != nil && *v.IsVectorized != "" {
			vecState = *v.IsVectorized
		}
		chunks := 0
		if v.VectorChunks != nil {
			chunks = *v.VectorChunks
		}
		pages = append(pages, map[string]any{
			"cid":                v.CID,
			"page_index":         v.PageIndex,
			"page_title":         v.PageTitle,
			"is_processed":       processed,
			"is_vectorized":      vecState,
			"vector_chunk_count": chunks,
		})
	}

	return map[string]any{
		"bvid":       bvid,
		"pages":      pages,
		"page_count": len(pages),
		"is_stored":  len(rows) > 0,
	}, nil
}

// fetchAndStorePages pulls the page list from the view API and creates one
// video-ledger row per page. Multi-P videos use data.pages; single-P videos
// fall back to the view's own cid/title (Python parity).
func (s *VideoPagesService) fetchAndStorePages(ctx context.Context, bvid string, client *bili.Client) error {
	info, err := client.GetVideoInfo(ctx, bvid)
	if err != nil {
		return err
	}
	// GetVideoInfo 返回完整信封；页面列表在 data 里（Python 版返回 data["data"]）。
	data, _ := info["data"].(map[string]any)
	if data == nil {
		data = info
	}

	repoV := repo.NewVideoRepo()
	create := func(cid int64, pageIndex int, title string) error {
		if cid == 0 {
			return nil
		}
		t := title
		return repoV.Create(ctx, s.db, &model.Video{
			BvID:      bvid,
			CID:       cid,
			PageIndex: pageIndex,
			PageTitle: &t,
		})
	}

	pages, _ := data["pages"].([]any)
	if len(pages) > 0 {
		for pi, p := range pages {
			pm, _ := p.(map[string]any)
			cid := jsonInt64(pm["cid"])
			title, _ := pm["part"].(string)
			if err := create(cid, pi, title); err != nil {
				return err
			}
		}
		slog.Info("[VIDEOPAGES] pages stored from view API", "bvid", bvid, "pages", len(pages))
		return nil
	}

	// 单P：view 顶层的 cid/title。
	cid := jsonInt64(data["cid"])
	title, _ := data["title"].(string)
	if err := create(cid, 0, title); err != nil {
		return err
	}
	slog.Info("[VIDEOPAGES] single-page stored", "bvid", bvid, "cid", cid)
	return nil
}
