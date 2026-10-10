// BuildService — knowledge-base build orchestration (sync + ASR only).
// Port of app/services/knowledge_build/{build_service,sync_service}.py with
// the vectorization phase REMOVED: each page's ASR completion publishes a
// `bili:page_ready` Redis event and the Python AI stack triggers its own
// /vec/page/create. Concurrency discipline mirrors the Python singleton:
// one active build per uid (the same SESSDATA in parallel trips B站 risk
// control), random pauses between folders and videos.
package service

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"app-bili/internal/bili"
	"app-bili/internal/config"
	"app-bili/internal/events"
	"app-bili/internal/model"
	"app-bili/internal/repo"

	"gorm.io/gorm"
)

type BuildService struct {
	cfg      *config.Config
	db       *gorm.DB
	fav      *FavoriteService
	asr      *ASRPageService
	tasks    *repo.TaskRepo
	videos   *repo.VideoRepo
	events   EventPublisher
	resolver Resolver
}

func NewBuildService(cfg *config.Config, db *gorm.DB, fav *FavoriteService,
	asr *ASRPageService, events EventPublisher, resolver Resolver) *BuildService {
	return &BuildService{
		cfg: cfg, db: db, fav: fav, asr: asr,
		tasks: repo.NewTaskRepo(), videos: repo.NewVideoRepo(),
		events: events, resolver: resolver,
	}
}

// TryStartBuild refuses a second concurrent build for the same uid and
// returns the active task instead (reused=true).
func (s *BuildService) TryStartBuild(ctx context.Context, uid int64, folderIDs []int64) (map[string]any, error) {
	if active, err := s.tasks.FindActiveBuildByUID(ctx, s.db, uid); err != nil {
		return nil, err
	} else if active != nil {
		return map[string]any{
			"task_id": active.TaskID, "status": derefStr(active.Status),
			"progress": derefInt(active.Progress), "reused": true,
		}, nil
	}
	uidCopy := uid
	taskID := "build-" + newTaskID()
	target := repo.MustJSON(map[string]any{"folder_ids": folderIDs})
	if _, err := s.tasks.Create(ctx, s.db, &uidCopy, taskID, "build", target); err != nil {
		return nil, err
	}
	s.asr.setLive(taskID, "pending", 0, "排队中")

	flowCtx := context.Background()
	go s.runBuild(flowCtx, uid, taskID, folderIDs)
	return map[string]any{"task_id": taskID, "status": "pending", "progress": 0, "reused": false}, nil
}

// runBuild executes folder → video → page ASR with progress + events.
func (s *BuildService) runBuild(ctx context.Context, uid int64, taskID string, folderIDs []int64) {
	taskRow, _ := s.tasks.GetByTaskID(ctx, s.db, taskID)
	if taskRow == nil {
		return
	}
	_ = s.tasks.Start(ctx, s.db, taskRow.ID)
	s.notify(ctx, uid, taskID, "processing", 5, "开始构建", nil)

	client, _, err := s.resolver.Resolve(ctx, uid)
	if err != nil {
		s.failBuild(ctx, taskRow.ID, taskID, uid, err.Error())
		return
	}

	type cursor map[string]any
	var totalAdded, totalRemoved, foldersProcessed int

	// Folder sync (folders list when unspecified: all of the user's folders).
	folderList := folderIDs
	if len(folderList) == 0 {
		folders, err := client.GetFavorites(ctx)
		if err != nil {
			s.failBuild(ctx, taskRow.ID, taskID, uid, err.Error())
			return
		}
		for _, f := range folders {
			folderList = append(folderList, f.MediaID)
		}
	}

	for i, mediaID := range folderList {
		cursorInfo := cursor{
			"folder_index":   i,
			"total_folders":  len(folderList),
			"current_folder": mediaID,
		}
		s.notify(ctx, uid, taskID, "processing", 10, fmt.Sprintf("同步收藏夹 %d/%d", i+1, len(folderList)), cursorInfo)

		// Resolve folder row (sync creates it when missing).
		synced, err := s.fav.SyncVideos(ctx, uid, mediaID2FolderID(ctx, s.db, uid, mediaID), client)
		if err != nil {
			s.failBuild(ctx, taskRow.ID, taskID, uid, fmt.Sprintf("收藏夹 %d 同步失败: %v", mediaID, err))
			return
		}
		totalAdded += synced["added"].(int)
		foldersProcessed++

		// Per-video pages → ASR.
		if err := s.buildFolderASR(ctx, uid, mediaID, taskID, client, cursorInfo); err != nil {
			s.failBuild(ctx, taskRow.ID, taskID, uid, err.Error())
			return
		}

		bili.SleepJitter(ctx, 2000, 5000) // folder pause (parity)
	}

	result := repo.MustJSON(map[string]any{
		"folders_processed": foldersProcessed,
		"videos_added":      totalAdded,
		"videos_removed":    totalRemoved,
	})
	_ = s.tasks.Complete(ctx, s.db, taskRow.ID, result)
	slog.Info("[BUILD] done", "task_id", taskID, "uid", uid, "folders", foldersProcessed)
	s.notify(ctx, uid, taskID, "done", 100, "构建完成", nil)
}

// buildFolderASR walks each video in the folder, resolves its pages via the
// view API, and ensures ASR for every page (publishing page_ready events).
func (s *BuildService) buildFolderASR(ctx context.Context, uid int64, mediaID int64, taskID string, client *bili.Client, cursor map[string]any) error {
	var rows []model.Collection
	if err := s.db.WithContext(ctx).Where("media_id = ?", mediaID).
		Order("id ASC").Find(&rows).Error; err != nil {
		return err
	}
	for vi, row := range rows {
		cursor["video_index"] = vi
		cursor["total_videos_in_folder"] = len(rows)
		cursor["current_video_title"] = row.Title
		s.notify(ctx, uid, taskID, "processing", 40, fmt.Sprintf("处理视频 %d/%d：%s", vi+1, len(rows), row.Title), cursor)

		// Multi-page resolution: the collection row carries first_cid only;
		// the view API expands to the full page list.
		info, err := client.GetVideoInfo(ctx, row.BvID)
		if err != nil {
			slog.Warn("[BUILD] view failed — skipping video", "bvid", row.BvID, "err", err)
			continue
		}
		pages, _ := info["pages"].([]any)
		if len(pages) == 0 {
			continue
		}
		for pi, p := range pages {
			page, _ := p.(map[string]any)
			cid := jsonInt64(page["cid"])
			if cid == 0 {
				continue
			}
			pageTitle, _ := page["part"].(string)
			status, err := s.asr.CreateTask(ctx, uid, row.BvID, cid, pi, pageTitle)
			if err != nil {
				slog.Warn("[BUILD] asr create failed", "bvid", row.BvID, "cid", cid, "err", err)
				continue
			}
			// Wait for the page task to finish (the page_ready event has
			// already been published by the pipeline on success).
			if tid, _ := status["task_id"].(string); tid != "" {
				s.waitForPage(ctx, tid)
			}
			bili.SleepJitter(ctx, s.cfg.Bili.VideoDelayMinMS, s.cfg.Bili.VideoDelayMaxMS)
		}
	}
	return nil
}

func (s *BuildService) waitForPage(ctx context.Context, taskID string) {
	deadline := time.Now().Add(30 * time.Minute)
	for time.Now().Before(deadline) {
		st := s.asr.GetTaskStatus(ctx, taskID)
		if st["status"] == "done" || st["status"] == "failed" {
			return
		}
		select {
		case <-time.After(3 * time.Second):
		case <-ctx.Done():
			return
		}
	}
}

func (s *BuildService) failBuild(ctx context.Context, rowID int64, taskID string, uid int64, msg string) {
	slog.Warn("[BUILD] failed", "task_id", taskID, "uid", uid, "err", msg)
	_ = s.tasks.Fail(ctx, s.db, rowID, msg)
	s.notify(ctx, uid, taskID, "failed", 100, msg, nil)
}

func (s *BuildService) notify(ctx context.Context, uid int64, taskID, status string, progress int, msg string, cursor map[string]any) {
	s.asr.setLive(taskID, status, progress, msg)
	s.events.Task(ctx, events.TaskEvent{
		TaskID: taskID, TaskType: "build", Status: status,
		Progress: progress, Message: msg, CurrentStep: cursor,
	})
}

// mediaID2FolderID resolves the folder row id for a bilibili media_id,
// creating the row when missing (parity with _get_or_create_folder).
func mediaID2FolderID(ctx context.Context, db *gorm.DB, uid, mediaID int64) int64 {
	var f model.FavoriteFolder
	err := db.Where("uid = ? AND media_id = ?", uid, mediaID).First(&f).Error
	if err == nil {
		return f.ID
	}
	title := fmt.Sprintf("收藏夹 %d", mediaID)
	row, err := repo.NewFolderRepo().UpsertFolder(ctx, db, uid, mediaID, title, 0, false)
	if err != nil {
		return 0
	}
	return row.ID
}

// ActiveTask returns the user's running build task or null.
func (s *BuildService) ActiveTask(ctx context.Context, uid int64) (map[string]any, error) {
	active, err := s.tasks.FindActiveBuildByUID(ctx, s.db, uid)
	if err != nil {
		return nil, err
	}
	if active == nil {
		return map[string]any{"task_id": nil, "status": "none", "progress": 0}, nil
	}
	return map[string]any{"task_id": active.TaskID, "status": derefStr(active.Status), "progress": derefInt(active.Progress)}, nil
}

// TaskStatus reads the durable async_tasks row (survives restarts).
func (s *BuildService) TaskStatus(ctx context.Context, uid int64, taskID string) (map[string]any, error) {
	row, err := s.tasks.GetByTaskID(ctx, s.db, taskID)
	if err != nil {
		return nil, err
	}
	if row == nil || (row.UID != nil && *row.UID != uid) {
		return map[string]any{"task_id": taskID, "status": "unknown", "progress": 0, "message": "任务不存在"}, nil
	}
	out := map[string]any{
		"task_id": row.TaskID, "status": derefStr(row.Status),
		"progress": derefInt(row.Progress), "error": derefStr(row.Error),
		"target": jsonRaw(row.Target), "steps": jsonRaw(derefStr(row.Steps)),
		"result": jsonRaw(derefStr(row.Result)),
	}
	if row.CompletedAt != nil {
		out["completed_at"] = naiveUTC(*row.CompletedAt)
	}
	return out, nil
}

func jsonRaw(s string) any {
	if s == "" {
		return nil
	}
	var v any
	if jsonUnmarshal(s, &v) != nil {
		return nil
	}
	return v
}
