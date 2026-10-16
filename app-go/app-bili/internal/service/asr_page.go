// ASRPageService — per-page ASR orchestration and state machine. Port of
// app/services/asr_page_service.py (the task store is async_tasks instead of
// the Python in-memory dict — crash-safe). RED LINE: never touch the
// vectorized*/kg* columns; failure always leaves is_processed=false so MySQL
// can never claim content the Mongo body does not hold.
package service

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"app-bili/internal/asr"
	"app-bili/internal/bili"
	"app-bili/internal/config"
	"app-bili/internal/events"
	"app-bili/internal/model"
	"app-bili/internal/repo"

	"gorm.io/gorm"
)

type ASRPageService struct {
	cfg         *config.Config
	db          *gorm.DB
	videos      *repo.VideoRepo
	versions    *repo.VideoVersionRepo
	tasks       *repo.TaskRepo
	content     *repo.ASRContentRepo
	transcriber *asr.Transcriber
	events      EventPublisher
	resolver    Resolver

	// in-memory progress mirror for fast /asr/status reads (async_tasks is
	// the durable store; the mirror only accelerates polling).
	mu   sync.RWMutex
	live map[string]*liveTask
}

type liveTask struct {
	status   string
	progress int
	message  string
}

// EventPublisher is the Redis event surface (implemented by events.Publisher).
type EventPublisher interface {
	Task(ctx context.Context, ev events.TaskEvent)
	PageReady(ctx context.Context, ev events.PageReadyEvent)
}

func NewASRPageService(cfg *config.Config, db *gorm.DB, content *repo.ASRContentRepo,
	transcriber *asr.Transcriber, events EventPublisher, resolver Resolver) *ASRPageService {
	return &ASRPageService{
		cfg: cfg, db: db,
		videos: repo.NewVideoRepo(), versions: repo.NewVideoVersionRepo(),
		tasks: repo.NewTaskRepo(), content: content, transcriber: transcriber,
		events: events, resolver: resolver, live: map[string]*liveTask{},
	}
}

func (s *ASRPageService) setLive(taskID, status string, progress int, msg string) {
	s.mu.Lock()
	s.live[taskID] = &liveTask{status, progress, msg}
	s.mu.Unlock()
}

// CreateTask is idempotent: processed pages return done immediately;
// an existing pending/processing task is reused.
func (s *ASRPageService) CreateTask(ctx context.Context, uid int64, bvid string, cid int64, pageIndex int, pageTitle string) (map[string]any, error) {
	existing, err := s.videos.GetByBvidCid(ctx, s.db, bvid, cid)
	if err != nil {
		return nil, err
	}
	if existing != nil && existing.IsProcessed != nil && *existing.IsProcessed {
		return map[string]any{"task_id": "", "status": "done", "progress": 100, "message": "已处理", "reused": true}, nil
	}

	// Any live task for this page (async_tasks + mirror)?
	if existing != nil {
		if task := s.findLiveTaskForPage(ctx, bvid, cid); task != nil {
			return map[string]any{"task_id": task.TaskID, "status": liveStr(task.Status), "progress": derefInt(task.Progress), "message": "任务进行中", "reused": true}, nil
		}
	}

	if existing == nil {
		pt := pageTitle
		fv := false
		ver := 1
		row := &model.Video{BvID: bvid, CID: cid, PageIndex: pageIndex, PageTitle: &pt, IsProcessed: &fv, Version: &ver}
		if err := s.videos.Create(ctx, s.db, row); err != nil {
			return nil, err
		}
		existing = row
	}

	taskID := "asr-" + newTaskID()
	target := repo.MustJSON(map[string]any{"bvid": bvid, "cid": cid, "page_index": pageIndex})
	uidCopy := uid
	task, err := s.tasks.Create(ctx, s.db, &uidCopy, taskID, "asr", target)
	if err != nil {
		return nil, err
	}
	_ = task
	s.setLive(taskID, "pending", 0, "排队中")

	// Background processing (strong reference — the goroutine owns the flow).
	flowCtx := context.Background()
	go s.ProcessPage(flowCtx, uid, taskID, existing.ID, bvid, cid, pageIndex)

	return map[string]any{"task_id": taskID, "status": "pending", "progress": 0, "message": "已创建", "reused": false}, nil
}

func (s *ASRPageService) findLiveTaskForPage(ctx context.Context, bvid string, cid int64) *model.AsyncTask {
	// async_tasks rows whose target matches the page and status pending/processing.
	var rows []model.AsyncTask
	if err := s.db.WithContext(ctx).
		Where("task_type = ? AND status IN (?, ?)", "asr", "pending", "processing").
		Order("id DESC").Limit(50).Find(&rows).Error; err != nil {
		return nil
	}
	for i := range rows {
		var target map[string]any
		if jsonUnmarshal(rows[i].Target, &target) != nil {
			continue
		}
		if target["bvid"] == bvid && jsonInt64(target["cid"]) == cid {
			return &rows[i]
		}
	}
	return nil
}

// ProcessPage runs the full pipeline: progress 10 获取音频 → 25 下载 → 55 ASR
// → 85 落库 → 100 done. Failures mark the task failed and force
// is_processed=false.
func (s *ASRPageService) ProcessPage(ctx context.Context, uid int64, taskID string, videoRowID int64, bvid string, cid int64, pageIndex int) {
	client, _, err := s.resolver.Resolve(ctx, uid)
	if err != nil {
		s.failTask(ctx, taskID, videoRowID, err.Error())
		return
	}

	step := func(progress int, msg string) {
		s.setLive(taskID, "processing", progress, msg)
		_ = s.tasks.UpdateProgress(ctx, s.db, s.taskRowID(taskID), progress, "", "")
		s.events.Task(ctx, events.TaskEvent{TaskID: taskID, TaskType: "asr", Status: "processing", Progress: progress, Message: msg})
	}

	step(10, "获取音频信息")
	audioURL := client.GetAudioURL(ctx, bvid, cid)
	if audioURL == "" {
		s.failTask(ctx, taskID, videoRowID, "无法获取音频流地址")
		return
	}

	var (
		text  string
		tmp   = filepath.Join(s.cfg.ASR.TmpDir, fmt.Sprintf("%s_%d_%d", bvid, cid, time.Now().UnixMilli()))
		files []string
	)
	defer func() {
		for _, f := range files {
			_ = os.Remove(f)
		}
	}()
	_ = asr.EnsureTmpDir(s.cfg.ASR.TmpDir)

	step(25, "下载音频")
	// 本地下载优先：把 B 站 CDN 的 m4s 音频 URL 直接交给 DashScope 抓取不可靠 ——
	// 其抓取器无 Referer/B 站 Cookie，CDN 可能拒绝，且 DASH 音频分段在抓取侧
	// 常解封装失败，产出的转写为空（实测「ASR 结果过短或为空」）。本地下载带
	// 完整 Cookie/UA，ffmpeg 转 wav 后经 DashScope 临时 OSS 上传，质量稳定；
	// URL 直传仅作网络失败时的兜底。CDN 握手偶发超时（海外镜像/代理出口），
	// 下载失败重试 2 次（1.5s/3s 退避）。
	local := tmp + ".m4s"
	ok, derr := client.DownloadAudioToFile(ctx, audioURL, local)
	for attempt := 1; (derr != nil || !ok) && attempt <= 2; attempt++ {
		slog.Warn("[ASR] audio download retry", "attempt", attempt, "err", derr)
		select {
		case <-time.After(time.Duration(1500*attempt) * time.Millisecond):
		case <-ctx.Done():
			s.failTask(ctx, taskID, videoRowID, "下载音频取消")
			return
		}
		ok, derr = client.DownloadAudioToFile(ctx, audioURL, local)
	}
	files = append(files, local)
	downloaded := derr == nil && ok
	if downloaded {
		if st, _ := os.Stat(local); st == nil || st.Size() < 1024 {
			downloaded = false
		}
	}

	if downloaded {
		if st, serr := os.Stat(local); serr == nil {
			slog.Info("[ASR][DEBUG] downloaded", "size", st.Size())
		}
		step(40, "音频预处理")
		wav := tmp + ".wav"
		if terr := asr.TranscodeToWav(ctx, local, wav); terr != nil {
			s.failTask(ctx, taskID, videoRowID, fmt.Sprintf("音频转码失败: %v", terr))
			return
		}
		files = append(files, wav)

		step(55, "Running ASR")
		chunkSeconds := 1200
		chunks, serr := asr.SplitWav(ctx, wav, s.cfg.ASR.TmpDir, chunkSeconds)
		if serr == nil && len(chunks) > 1 {
			for _, ch := range chunks {
				files = append(files, ch)
			}
			text = s.transcribeChunks(ctx, chunks)
		} else {
			text, err = s.transcriber.TranscribeLocal(ctx, wav)
			slog.Info("[ASR][DEBUG] local transcription", "text_len", len([]rune(text)), "err", err)
			if err != nil {
				text = ""
			}
		}
	} else {
		slog.Info("[ASR][DEBUG] local download failed — falling back to URL transcription", "derr", derr)
		// 本地下载失败（网络）→ 回退：URL 直传给 DashScope 抓取
		if derr != nil {
			s.failTask(ctx, taskID, videoRowID, fmt.Sprintf("下载音频失败: %v", derr))
			return
		}
		if asr.ProbeAudioURL(ctx, nil, audioURL) {
			text, err = s.transcriber.TranscribeURL(ctx, audioURL)
			slog.Info("[ASR][DEBUG] url transcription", "text_len", len([]rune(text)), "err", err)
			if err != nil {
				s.failTask(ctx, taskID, videoRowID, fmt.Sprintf("转写失败: %v", err))
				return
			}
		} else {
			s.failTask(ctx, taskID, videoRowID, "无法获取音频流地址")
			return
		}
	}

	if strings.TrimSpace(text) == "" || len([]rune(strings.TrimSpace(text))) < s.cfg.ASR.MinTextChars {
		s.failTask(ctx, taskID, videoRowID, "ASR 结果过短或为空")
		return
	}

	step(85, "写入数据库")
	row, err := s.videos.GetByBvidCid(ctx, s.db, bvid, cid)
	if err != nil || row == nil {
		s.failTask(ctx, taskID, videoRowID, fmt.Sprintf("video row lost: %v", err))
		return
	}
	prevVersion := 1
	if row.Version != nil {
		prevVersion = *row.Version
	}
	newVersion := prevVersion + 1
	pageTitle := ""
	if row.PageTitle != nil {
		pageTitle = *row.PageTitle
	}
	if _, err := s.content.SaveASR(ctx, &repo.ASRDoc{
		VideoID: bili.BVToAV(bvid), BvID: bvid, CID: cid, PageIndex: pageIndex,
		PageTitle: pageTitle, Content: text, ContentSource: "asr", Version: 1,
	}); err != nil {
		s.failTask(ctx, taskID, videoRowID, fmt.Sprintf("写入 Mongo 失败: %v", err))
		return
	}
	if err := s.versions.InsertLatest(ctx, s.db, bvid, cid, pageIndex, newVersion, "asr"); err != nil {
		s.failTask(ctx, taskID, videoRowID, fmt.Sprintf("写入版本失败: %v", err))
		return
	}
	if err := s.videos.MarkProcessed(ctx, s.db, row.ID, prevVersion); err != nil {
		s.failTask(ctx, taskID, videoRowID, fmt.Sprintf("更新状态失败: %v", err))
		return
	}

	s.setLive(taskID, "done", 100, "完成")
	_ = s.tasks.Complete(ctx, s.db, s.taskRowID(taskID), repo.MustJSON(map[string]any{"bvid": bvid, "cid": cid, "version": newVersion}))
	slog.Info("[ASR] page done", "bvid", bvid, "cid", cid, "version", newVersion, "task_id", taskID)
	s.events.Task(ctx, events.TaskEvent{TaskID: taskID, TaskType: "asr", Status: "done", Progress: 100, Message: "完成"})
	s.events.PageReady(ctx, events.PageReadyEvent{UID: uid, BvID: bvid, CID: cid, Version: newVersion, TaskID: taskID})
}

// transcribeChunks runs chunk transcriptions with bounded parallelism,
// preserving order; failed chunks are skipped (parity with the Python
// chunked path).
func (s *ASRPageService) transcribeChunks(ctx context.Context, chunks []string) string {
	conc := s.cfg.ASR.ChunkConcurrency
	if conc < 1 {
		conc = 3
	}
	results := make([]string, len(chunks))
	sem := make(chan struct{}, conc)
	var wg sync.WaitGroup
	for i, chunk := range chunks {
		wg.Add(1)
		go func(i int, chunk string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			text, err := s.transcriber.TranscribeLocal(ctx, chunk)
			if err == nil {
				results[i] = text
			}
		}(i, chunk)
	}
	wg.Wait()
	return strings.Join(results, "\n")
}

func (s *ASRPageService) failTask(ctx context.Context, taskID string, videoRowID int64, msg string) {
	slog.Warn("[ASR] page failed", "task_id", taskID, "video_row", videoRowID, "err", msg)
	s.setLive(taskID, "failed", 100, msg)
	if videoRowID > 0 {
		_ = s.videos.MarkUnprocessed(ctx, s.db, videoRowID)
	}
	_ = s.tasks.Fail(ctx, s.db, s.taskRowID(taskID), msg)
	s.events.Task(ctx, events.TaskEvent{TaskID: taskID, TaskType: "asr", Status: "failed", Progress: 100, Message: msg})
}

// taskRowID resolves the async_tasks.id for a task_id (cached miss tolerated).
func (s *ASRPageService) taskRowID(taskID string) int64 {
	if row, err := s.tasks.GetByTaskID(context.Background(), s.db, taskID); err == nil && row != nil {
		return row.ID
	}
	return 0
}

// GetContent — MongoDB first, MySQL fallback (parity with get_content).
func (s *ASRPageService) GetContent(ctx context.Context, bvid string, cid int64) (map[string]any, error) {
	out := map[string]any{"exists": false}
	row, err := s.videos.GetByBvidCid(ctx, s.db, bvid, cid)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return out, nil
	}
	out["exists"] = true
	out["bvid"] = bvid
	out["cid"] = cid
	out["page_index"] = row.PageIndex
	out["page_title"] = derefStr(row.PageTitle)
	out["content_source"] = derefStr(row.ContentSource)
	out["version"] = derefInt(row.Version)
	out["is_processed"] = derefBool(row.IsProcessed)
	out["content"] = ""
	if row.IsProcessed != nil && *row.IsProcessed {
		if doc, merr := s.content.GetLatest(ctx, bvid, cid); merr == nil && doc != nil {
			out["content"] = doc.Content
			out["content_source"] = doc.ContentSource
			out["version"] = doc.Version
		}
	}
	return out, nil
}

// UpdateContent overwrites content as user_edit (no version bump).
func (s *ASRPageService) UpdateContent(ctx context.Context, bvid string, cid int64, pageIndex int, content string) error {
	row, err := s.videos.GetByBvidCid(ctx, s.db, bvid, cid)
	if err != nil {
		return err
	}
	if row == nil {
		return fmt.Errorf("video page not found")
	}
	pageTitle := derefStr(row.PageTitle)
	if err := s.content.UpsertContent(ctx, &repo.ASRDoc{
		BvID: bvid, CID: cid, PageIndex: pageIndex, PageTitle: pageTitle,
		Content: content, ContentSource: "user_edit", Version: 1,
	}); err != nil {
		return err
	}
	return s.videos.MarkUserEdit(ctx, s.db, row.ID)
}

// ReASR snapshots the old version, resets state and starts a new task.
func (s *ASRPageService) ReASR(ctx context.Context, uid int64, bvid string, pageIndex int) (map[string]any, error) {
	row, err := s.videos.GetByBvidIndex(ctx, s.db, bvid, pageIndex)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, &HTTPError{Status: http.StatusNotFound, Message: "video page not found"}
	}
	prevVersion := 1
	if row.Version != nil {
		prevVersion = *row.Version
	}
	if err := s.versions.InsertLatest(ctx, s.db, bvid, row.CID, row.PageIndex, prevVersion, derefStr(row.ContentSource)); err != nil {
		return nil, err
	}
	if err := s.videos.MarkUnprocessed(ctx, s.db, row.ID); err != nil {
		return nil, err
	}
	if err := s.db.WithContext(ctx).Model(&model.Video{}).Where("id = ?", row.ID).
		Update("version", prevVersion+1).Error; err != nil {
		return nil, err
	}
	return s.CreateTask(ctx, uid, bvid, row.CID, row.PageIndex, derefStr(row.PageTitle))
}

// GetTaskStatus polls the durable store first, then the mirror.
func (s *ASRPageService) GetTaskStatus(_ context.Context, taskID string) map[string]any {
	s.mu.RLock()
	lv := s.live[taskID]
	s.mu.RUnlock()
	if lv != nil {
		return map[string]any{"task_id": taskID, "status": lv.status, "progress": lv.progress, "message": lv.message}
	}
	return map[string]any{"task_id": taskID, "status": "unknown", "progress": 0, "message": "任务不存在或已过期"}
}

// ListVersions merges Mongo docs with MySQL rows (Mongo first).
func (s *ASRPageService) ListVersions(ctx context.Context, bvid string, cid int64) ([]map[string]any, error) {
	docs, err := s.content.ListVersions(ctx, bvid, cid, 100)
	if err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(docs))
	for _, d := range docs {
		preview := d.Content
		if len([]rune(preview)) > 100 {
			preview = string([]rune(preview)[:100]) + "…"
		}
		out = append(out, map[string]any{
			"version":         d.Version,
			"content_source":  d.ContentSource,
			"content_preview": preview,
			"is_latest":       d.IsLatest,
			"created_at":      naiveUTC(d.CreatedAt),
		})
	}
	return out, nil
}
