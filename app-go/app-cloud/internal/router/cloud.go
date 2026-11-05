package router

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"app-cloud/internal/dto"
	"app-cloud/internal/middleware"
	"app-cloud/internal/model"
	"app-cloud/internal/service"

	"github.com/gin-gonic/gin"
)

// registerCloud mounts the user-facing /cloud/* endpoints. Handlers only bind
// requests, call services and map the results onto the wire DTOs in
// internal/dto — the JSON contract lives there.
func registerCloud(e *gin.Engine, d Deps) {
	g := e.Group("/cloud")
	g.Use(middleware.RequireUID())
	registerShareRoutes(e, d, g)
	registerRefRoutes(g, d) // 1.0.16 — /cloud/refs 引用面

	// ── upload ──
	g.POST("/upload/init", initUpload(d))
	g.POST("/upload/heartbeat", heartbeat(d))
	g.POST("/upload/:upload_uuid/complete", completeUpload(d))
	g.POST("/upload/:upload_uuid/resume", resumeUpload(d))

	// ── folders ──
	g.GET("/folders", listFolders(d))
	g.POST("/folders", createFolder(d))
	g.PATCH("/folders/:folder_id", updateFolder(d))
	g.DELETE("/folders/:folder_id", deleteFolder(d))

	// ── files (list / detail / update / delete) ──
	g.GET("/videos", listVideos(d))
	g.GET("/video/:upload_uuid", getVideoDetail(d))
	g.PATCH("/video/:upload_uuid", updateVideo(d))
	g.DELETE("/video/:upload_uuid", deleteVideo(d))
	g.POST("/video/:upload_uuid/process", middleware.RequireCapability(d.Process != nil, "处理管线未启用"), triggerProcess(d))
	g.POST("/video/:upload_uuid/reprocess", middleware.RequireCapability(d.Process != nil, "处理管线未启用"), reprocess(d))
	g.GET("/video/:upload_uuid/status", getVideoStatus(d))
	g.GET("/video/:upload_uuid/preview", getDocumentPreview(d))
	g.GET("/video/:upload_uuid/raw", getVideoRaw(d))

	// ── quota / search (new) ──
	g.GET("/quota", getQuota(d))
	g.GET("/search", searchFiles(d))

	// ── document intelligence: summary / semantic search / similar files ──
	registerCloudAI(g, d)

	// ── trash (new) ──
	g.GET("/trash", listTrash(d))
	g.POST("/trash/:upload_uuid/restore", restoreTrash(d))
	g.DELETE("/trash/:upload_uuid", purgeTrashItem(d))
	g.DELETE("/trash", emptyTrash(d))
}

// ── upload ───────────────────────────────────────────────────────────

func initUpload(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		var req dto.UploadInitRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "请求参数不合法")
			return
		}
		res, err := d.Upload.InitUpload(c.Request.Context(), uid,
			req.Filename, req.FileSize, req.MimeType, req.FolderID)
		if err != nil {
			if _, isQuota := err.(*service.QuotaExceededError); isQuota {
				apiErr(c, http.StatusRequestEntityTooLarge, err.Error())
				return
			}
			apiErr(c, http.StatusBadRequest, err.Error())
			return
		}
		c.JSON(http.StatusOK, uploadInitResponse(res))
	}
}

func uploadInitResponse(res *service.UploadInitResult) dto.UploadInitResponse {
	presigned := make([]dto.UploadPresignedItem, 0, len(res.PresignedURLs))
	for _, p := range res.PresignedURLs {
		presigned = append(presigned, dto.UploadPresignedItem{
			ChunkIndex: p.ChunkIndex,
			ChunkSize:  p.ChunkSize,
			URL:        p.URL,
		})
	}
	return dto.UploadInitResponse{
		UploadUUID:    res.UploadUUID,
		SessionUUID:   res.SessionUUID,
		MinioUploadID: res.MinioUploadID,
		ChunkCount:    res.ChunkCount,
		ChunkSize:     res.ChunkSize,
		PresignedURLs: presigned,
	}
}

func heartbeat(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		var req dto.UploadHeartbeatRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusOK, dto.UploadHeartbeatResponse{Ack: false})
			return
		}
		c.JSON(http.StatusOK, dto.UploadHeartbeatResponse{
			Ack: d.Upload.Heartbeat(c.Request.Context(), req.SessionUUID, uid),
		})
	}
}

func completeUpload(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		var req dto.UploadCompleteRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "请求参数不合法")
			return
		}
		parts := make([]service.UploadPart, 0, len(req.Parts))
		for _, p := range req.Parts {
			parts = append(parts, service.UploadPart{PartNumber: p.PartNumber, ETag: p.ETag})
		}
		res, err := d.Upload.CompleteUpload(c.Request.Context(), c.Param("upload_uuid"), parts, uid)
		if err != nil {
			apiErr(c, http.StatusBadRequest, err.Error())
			return
		}
		c.JSON(http.StatusOK, dto.UploadCompleteResponse{
			UploadUUID: res.UploadUUID,
			ETag:       res.ETag,
			Status:     res.Status,
		})
	}
}

func resumeUpload(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		res, err := d.Upload.ResumeUpload(c.Request.Context(), c.Param("upload_uuid"), uid)
		if err != nil {
			apiErr(c, http.StatusBadRequest, err.Error())
			return
		}
		pending := make([]dto.UploadResumeChunk, 0, len(res.PendingChunks))
		for _, p := range res.PendingChunks {
			pending = append(pending, dto.UploadResumeChunk{
				ChunkIndex: p.ChunkIndex,
				ChunkSize:  p.ChunkSize,
				URL:        p.URL,
			})
		}
		c.JSON(http.StatusOK, dto.UploadResumeResponse{
			UploadUUID:    res.UploadUUID,
			MinioUploadID: res.MinioUploadID,
			PendingChunks: pending,
		})
	}
}

// ── folders ──────────────────────────────────────────────────────────

func listFolders(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		rows, err := d.Folders.ListByUID(d.DB, uid)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		// Repair stale video_count (legacy data), parity with recalc_all_counts.
		if err := d.Folders.UpdateCounts(d.DB, uid); err != nil {
			// best-effort; tree still served
			_ = err
		}
		_ = rows
		// Re-fetch with repaired counts.
		rows, err = d.Folders.ListByUID(d.DB, uid)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		c.JSON(http.StatusOK, dto.FolderTreeResponse{Folders: buildFolderTree(rows, nil)})
	}
}

// buildFolderTree assembles the FolderItem forest from a flat list.
func buildFolderTree(rows []model.CloudFolder, parent *int64) []dto.FolderItem {
	items := make([]dto.FolderItem, 0)
	for i := range rows {
		row := rows[i]
		// match parent: both nil (root) or equal ids
		if (row.ParentID == nil) != (parent == nil) {
			continue
		}
		if parent != nil && (row.ParentID == nil || *row.ParentID != *parent) {
			continue
		}
		count := 0
		if row.VideoCount != nil {
			count = *row.VideoCount
		}
		items = append(items, dto.FolderItem{
			ID:         row.ID,
			ParentID:   row.ParentID,
			Name:       row.Name,
			VideoCount: count,
			Children:   buildFolderTree(rows, &row.ID),
		})
	}
	return items
}

func createFolder(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		var req dto.FolderCreateRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "请求参数不合法")
			return
		}
		if req.ParentID != nil {
			parent, err := d.Folders.GetByID(d.DB, *req.ParentID, uid)
			if err != nil {
				apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
				return
			}
			if parent == nil {
				apiErr(c, http.StatusBadRequest, "父文件夹不存在")
				return
			}
		}
		row := &model.CloudFolder{UID: uid, ParentID: req.ParentID, Name: req.Name}
		if err := d.Folders.Create(d.DB, row); err != nil {
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		c.JSON(http.StatusCreated, dto.FolderResponse{
			ID: row.ID, ParentID: row.ParentID, Name: row.Name, VideoCount: 0,
		})
	}
}

func updateFolder(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		folderID, ok2 := parseID(c)
		if !ok2 {
			return
		}
		var req dto.FolderUpdateRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "请求参数不合法")
			return
		}
		if req.ParentInvalid {
			apiErr(c, http.StatusUnprocessableEntity, "parentId 不合法")
			return
		}
		fields := map[string]any{}
		if req.NameSet && req.Name != nil {
			fields["name"] = *req.Name
		}
		if req.ParentSet {
			// explicit null moves to root; otherwise validate the target
			if req.ParentID == nil {
				fields["parent_id"] = nil
			} else {
				pid := *req.ParentID
				if pid == folderID {
					apiErr(c, http.StatusBadRequest, "不能将文件夹移动到自己")
					return
				}
				parent, err := d.Folders.GetByID(d.DB, pid, uid)
				if err != nil {
					apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
					return
				}
				if parent == nil {
					apiErr(c, http.StatusBadRequest, "目标文件夹不存在")
					return
				}
				fields["parent_id"] = pid
			}
		}
		if err := d.Folders.Update(d.DB, folderID, uid, fields); err != nil {
			apiErr(c, http.StatusBadRequest, "文件夹不存在或已删除")
			return
		}
		folder, fetchErr := d.Folders.GetByID(d.DB, folderID, uid)
		if fetchErr != nil || folder == nil {
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		count := 0
		if folder.VideoCount != nil {
			count = *folder.VideoCount
		}
		c.JSON(http.StatusOK, dto.FolderResponse{
			ID: folder.ID, ParentID: folder.ParentID, Name: folder.Name, VideoCount: count,
		})
	}
}

func deleteFolder(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		folderID, ok := parseID(c)
		if !ok {
			return
		}
		force := c.Query("force") == "true"
		ids, err := d.Folders.SubtreeIDs(d.DB, folderID, uid, force)
		if err != nil || len(ids) == 0 {
			apiErr(c, http.StatusForbidden, "文件夹不存在")
			return
		}
		// Trash semantics: soft-delete folder subtree; files inside are
		// soft-deleted too so they land in the trash (restorable).
		affected, err := d.Files.SoftDeleteByFolderIDs(d.DB, uid, ids)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		if _, err := d.Folders.SoftDeleteTree(d.DB, ids, uid); err != nil {
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		// A force-deleted subtree's folder shares are dropped (the subtree ids
		// cover shares pointing at any level). Soft deletes stay restorable and
		// are NOT revoked; their shares resolve uniformly as 404 until restore.
		if force {
			_ = d.Share.RevokeAllForFolders(ids)
		}
		c.JSON(http.StatusOK, dto.FolderDeleteResponse{Deleted: true, AffectedFiles: affected})
	}
}

// ── files ────────────────────────────────────────────────────────────

func listVideos(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		var folderID *int64
		if v := c.Query("folderId"); v != "" {
			id, err := parseInt64(v)
			if err != nil {
				apiErr(c, http.StatusUnprocessableEntity, "folderId 不合法")
				return
			}
			folderID = &id
		}
		page := clampInt(c.DefaultQuery("page", "1"), 1, 1<<31)
		pageSize := clampInt(c.DefaultQuery("pageSize", "50"), 1, 200)
		rows, total, err := d.Files.ListByFolder(d.DB, uid, folderID,
			page, pageSize, c.DefaultQuery("sort", "created_at"), c.DefaultQuery("order", "desc"))
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		videos := make([]dto.VideoItem, 0, len(rows))
		for i := range rows {
			videos = append(videos, toVideoItem(&rows[i]))
		}
		c.JSON(http.StatusOK, dto.VideoListResponse{
			Videos:   videos,
			Total:    total,
			Page:     page,
			PageSize: pageSize,
			HasMore:  int64(page*pageSize) < total,
		})
	}
}

func toVideoItem(f *model.CloudFile) dto.VideoItem {
	return dto.VideoItem{
		UploadUUID:   f.UploadUUID,
		OriginalName: f.OriginalName,
		FileSize:     f.FileSize,
		MimeType:     f.MimeType,
		Duration:     f.Duration,
		AsrStatus:    statusOrDefault(f.AsrStatus),
		VectorStatus: statusOrDefault(f.VectorStatus),
		Title:        f.Title,
		CoverURL:     f.CoverURL,
		CreatedAt:    f.CreatedAt,
	}
}

func statusOrDefault(s *string) string {
	if s == nil || *s == "" {
		return "pending"
	}
	return *s
}

func getVideoDetail(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		f, err := d.Files.GetByUUID(d.DB, c.Param("upload_uuid"), uid)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		if f == nil {
			apiErr(c, http.StatusNotFound, "File not found")
			return
		}
		if d.Process != nil {
			// Stale reconcile so the detail view stops spinning on a zombie
			// "processing" row (crash / panic / hang mid-run).
			d.Process.ReconcileStaleProcessing(f)
		}
		resp := toVideoDetail(f)
		if f.FolderID != nil {
			if folder, err := d.Folders.GetByID(d.DB, *f.FolderID, uid); err == nil && folder != nil {
				resp.FolderName = folder.Name
			}
		}
		if asr := d.ASRPreview(c.Request.Context(), f.UploadUUID); asr != "" {
			preview := asr[:minStr(len(asr), 500)]
			resp.AsrPreview = &preview
		}
		c.JSON(http.StatusOK, resp)
	}
}

func toVideoDetail(f *model.CloudFile) dto.VideoDetailResponse {
	return dto.VideoDetailResponse{
		UploadUUID:       f.UploadUUID,
		OriginalName:     f.OriginalName,
		FileSize:         f.FileSize,
		MimeType:         f.MimeType,
		Duration:         f.Duration,
		AsrStatus:        statusOrDefault(f.AsrStatus),
		VectorStatus:     statusOrDefault(f.VectorStatus),
		Title:            f.Title,
		CoverURL:         f.CoverURL,
		CreatedAt:        f.CreatedAt,
		Description:      f.Description,
		Tags:             f.Tags,
		FolderID:         f.FolderID,
		FolderName:       "",
		AsrPreview:       nil,
		VectorChunkCount: intFromPtr(f.VectorChunkCount),
	}
}

func updateVideo(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		var req dto.VideoUpdateRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "请求参数不合法")
			return
		}
		if req.TagsInvalid {
			apiErr(c, http.StatusUnprocessableEntity, "tags 不合法")
			return
		}
		if req.FolderInvalid {
			apiErr(c, http.StatusUnprocessableEntity, "folderId 不合法")
			return
		}
		fields := map[string]any{}
		if req.TitleSet {
			if req.Title == nil {
				fields["title"] = nil
			} else {
				fields["title"] = *req.Title
			}
		}
		if req.DescriptionSet {
			if req.Description == nil {
				fields["description"] = nil
			} else {
				fields["description"] = *req.Description
			}
		}
		if req.TagsSet {
			fields["tags"] = req.Tags
		}
		if req.FolderSet {
			if req.FolderID == nil {
				fields["folder_id"] = nil
			} else {
				fid := *req.FolderID
				folder, err := d.Folders.GetByID(d.DB, fid, uid)
				if err != nil {
					apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
					return
				}
				if folder == nil {
					apiErr(c, http.StatusBadRequest, "目标文件夹不存在")
					return
				}
				fields["folder_id"] = fid
			}
		}
		if err := d.Files.UpdateMeta(d.DB, c.Param("upload_uuid"), uid, fields); err != nil {
			apiErr(c, http.StatusNotFound, "File not found")
			return
		}
		f, err := d.Files.GetByUUID(d.DB, c.Param("upload_uuid"), uid)
		if err != nil || f == nil {
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		resp := toVideoDetail(f)
		if f.FolderID != nil {
			if folder, err := d.Folders.GetByID(d.DB, *f.FolderID, uid); err == nil && folder != nil {
				resp.FolderName = folder.Name
			}
		}
		c.JSON(http.StatusOK, resp)
	}
}

// deleteVideo — trash semantics: soft-delete only; MinIO/Mongo objects stay
// until the sweeper purges them (deleted_at + purge_after_days).
func deleteVideo(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		f, err := d.Files.GetByUUID(d.DB, c.Param("upload_uuid"), uid)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		if f == nil {
			apiErr(c, http.StatusNotFound, "File not found")
			return
		}
		if err := d.Files.SoftDelete(d.DB, c.Param("upload_uuid"), uid); err != nil {
			apiErr(c, http.StatusNotFound, "File not found")
			return
		}
		// A trashed file must not stay shareable.
		_ = d.Share.RevokeAllForFile(f.ID)
		c.JSON(http.StatusOK, dto.VideoDeleteResponse{
			Deleted: true, UploadUUID: c.Param("upload_uuid"),
		})
	}
}

// triggerProcess — marks processing and returns; the pipeline runs in the
// background goroutine (status updates arrive via the WS bridge).
func triggerProcess(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		if err := d.Process.Trigger(c.Request.Context(), c.Param("upload_uuid"), uid); err != nil {
			if errors.Is(err, service.ErrNotFound) {
				apiErr(c, http.StatusNotFound, "File not found")
				return
			}
			if errors.Is(err, service.ErrAlreadyProcessing) || errors.Is(err, service.ErrAlreadyDone) {
				apiErr(c, http.StatusConflict, err.Error())
				return
			}
			if errors.Is(err, service.ErrTooManyUserTasks) || errors.Is(err, service.ErrQueueFull) {
				// Admission control (capacity layer): shed load as 429 with the
				// user-facing reason, never 500.
				apiErr(c, http.StatusTooManyRequests, err.Error())
				return
			}
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		c.JSON(http.StatusOK, dto.VideoProcessResponse{UploadUUID: c.Param("upload_uuid")})
	}
}

// reprocess — delete old vectors → re-parse → re-vectorize.
func reprocess(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		taskID, err := d.Process.Reprocess(c.Request.Context(), c.Param("upload_uuid"), uid)
		if err != nil {
			switch {
			case errors.Is(err, service.ErrNotFound):
				apiErr(c, http.StatusNotFound, "File not found")
			case errors.Is(err, service.ErrAlreadyProcessing):
				apiErr(c, http.StatusConflict, err.Error())
			case errors.Is(err, service.ErrReprocessTooSoon):
				apiErr(c, http.StatusTooManyRequests, err.Error())
			default:
				apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			}
			return
		}
		c.JSON(http.StatusOK, dto.VideoReprocessResponse{
			UploadUUID: c.Param("upload_uuid"), TaskID: taskID,
		})
	}
}

func getVideoStatus(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		f, err := d.Files.GetByUUID(d.DB, c.Param("upload_uuid"), uid)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		if f == nil {
			apiErr(c, http.StatusNotFound, "File not found")
			return
		}
		count := intFromPtr(f.VectorChunkCount)
		if d.Process != nil {
			// Stale reconcile: a row stuck in "processing" past the deadline
			// (crash / panic / hang) flips to failed so the user can retry.
			d.Process.ReconcileStaleProcessing(f)
		}
		// Read-time reconcile: DB says done but Milvus lost the vectors
		// (collection rebuilt) → flip to failed so the user can reprocess.
		if f.VectorStatus != nil && *f.VectorStatus == "done" && d.Process != nil {
			actual, err := d.Process.CountChunks(c.Request.Context(), f.UploadUUID)
			if err == nil {
				count = actual
				if actual == 0 {
					failed := "failed"
					if err := d.Files.UpdateMeta(d.DB, f.UploadUUID, uid,
						map[string]any{"vector_status": failed}); err == nil {
						count = 0
					}
				}
			}
		}
		c.JSON(http.StatusOK, dto.VideoStatusResponse{
			AsrStatus:        statusOrDefault(f.AsrStatus),
			AsrProgress:      0,
			VectorStatus:     statusOrDefault(f.VectorStatus),
			VectorChunkCount: count,
		})
	}
}

func getDocumentPreview(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		f, err := d.Files.GetByUUID(d.DB, c.Param("upload_uuid"), uid)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		if f == nil {
			apiErr(c, http.StatusNotFound, "File not found")
			return
		}
		offset := clampInt(c.DefaultQuery("offset", "0"), 0, 10_000_000)
		limit := clampInt(c.DefaultQuery("limit", "5000"), 1, 20000)

		preview, total, docMeta := d.DocumentPreview(c.Request.Context(), uid, f.UploadUUID, offset, limit)
		nextOffset := offset + len(preview)
		hasMore := nextOffset < total
		var next *int
		if hasMore {
			next = &nextOffset
		}
		c.JSON(http.StatusOK, dto.DocumentPreviewResponse{
			UploadUUID:   f.UploadUUID,
			FileName:     f.OriginalName,
			MimeType:     f.MimeType,
			Vectorizable: f.Vectorizable,
			Preview:      preview,
			DocMeta:      docMeta,
			Offset:       offset,
			Limit:        limit,
			TotalChars:   total,
			HasMore:      hasMore,
			NextOffset:   next,
		})
	}
}

// getVideoRaw — presigned GET (+ inline text content for text-like files).
func getVideoRaw(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		f, err := d.Files.GetByUUID(d.DB, c.Param("upload_uuid"), uid)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		if f == nil {
			apiErr(c, http.StatusNotFound, "File not found")
			return
		}
		viewMode := classifyViewMode(f.MimeType)
		ct := ""
		if viewMode == "pdf" || viewMode == "video" || viewMode == "audio" || viewMode == "image" {
			ct = f.MimeType
		}
		url, err := d.Minio.PresignGet(c.Request.Context(), f.ObjectKey, ct, "", 0)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "Raw file unavailable")
			return
		}
		var content *string
		// Inline text content for text-like files (≤5 MB) to avoid a
		// cross-origin fetch against MinIO (parity).
		if (viewMode == "text" || viewMode == "markdown" || viewMode == "html") && f.FileSize <= 5_000_000 {
			if data, err := d.Minio.GetObject(c.Request.Context(), f.ObjectKey); err == nil {
				s := string(data)
				content = &s
			}
		}
		c.JSON(http.StatusOK, dto.RawFileResponse{
			URL:      url,
			Content:  content,
			MimeType: f.MimeType,
			FileName: f.OriginalName,
			FileSize: f.FileSize,
			ViewMode: viewMode,
		})
	}
}

// classifyViewMode — parity with the Python _classify_view_mode.
func classifyViewMode(mime string) string {
	m := lower(mime)
	switch {
	case hasPrefix(m, "video/"):
		return "video"
	case hasPrefix(m, "audio/"):
		return "audio"
	case hasPrefix(m, "image/"):
		return "image"
	case m == "application/pdf":
		return "pdf"
	case m == "text/html":
		return "html"
	case contains(m, "markdown") || m == "text/x-markdown":
		return "markdown"
	case hasPrefix(m, "text/") || m == "application/json" ||
		m == "application/xml" || m == "application/javascript" ||
		m == "application/x-yaml":
		return "text"
	default:
		return "unsupported"
	}
}

// ── quota / search ───────────────────────────────────────────────────

func getQuota(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		used, quota, tier, pending, err := d.Quota.Usage(c.Request.Context(), uid)
		if err != nil {
			// Still answer with the fail-closed values + error flag.
			c.JSON(http.StatusOK, dto.QuotaResponse{
				Used: used, Quota: quota, Tier: tier, Pending: pending, Error: err.Error(),
			})
			return
		}
		c.JSON(http.StatusOK, dto.QuotaResponse{
			Used: used, Quota: quota, Tier: tier, Pending: pending,
		})
	}
}

func searchFiles(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		q := trim(c.Query("q"))
		if q == "" {
			apiErr(c, http.StatusUnprocessableEntity, "缺少搜索关键词 q")
			return
		}
		rows, err := d.Files.SearchByName(d.DB, uid, q, 50)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		items := make([]dto.VideoItem, 0, len(rows))
		for i := range rows {
			items = append(items, toVideoItem(&rows[i]))
		}
		c.JSON(http.StatusOK, dto.SearchFilesResponse{Results: items, Total: len(items)})
	}
}

// ── trash ────────────────────────────────────────────────────────────

func listTrash(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		rows, err := d.Files.ListTrash(d.DB, uid)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		items := make([]dto.TrashItem, 0, len(rows))
		for i := range rows {
			f := &rows[i]
			var purgeAt *time.Time
			if f.DeletedAt != nil {
				purge := f.DeletedAt.Add(time.Duration(d.Cfg.Trash.PurgeAfterDays) * 24 * time.Hour)
				purgeAt = &purge
			}
			items = append(items, dto.TrashItem{
				UploadUUID:   f.UploadUUID,
				OriginalName: f.OriginalName,
				FileSize:     f.FileSize,
				MimeType:     f.MimeType,
				DeletedAt:    f.DeletedAt,
				PurgeAt:      purgeAt,
			})
		}
		c.JSON(http.StatusOK, dto.TrashListResponse{Items: items, Total: len(items)})
	}
}

func restoreTrash(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		if err := d.Files.Restore(d.DB, c.Param("upload_uuid"), uid); err != nil {
			apiErr(c, http.StatusNotFound, "文件不在回收站中")
			return
		}
		c.JSON(http.StatusOK, dto.TrashRestoreResponse{
			Restored: true, UploadUUID: c.Param("upload_uuid"),
		})
	}
}

// purgeTrashItem — immediate physical delete (MinIO + pipeline stores).
func purgeTrashItem(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		if err := d.Purge.PurgeFile(c.Request.Context(), c.Param("upload_uuid"), uid); err != nil {
			if err == service.ErrNotFound {
				apiErr(c, http.StatusNotFound, "文件不在回收站中")
				return
			}
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		c.JSON(http.StatusOK, dto.TrashPurgeResponse{
			Purged: true, UploadUUID: c.Param("upload_uuid"),
		})
	}
}

func emptyTrash(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		count, err := d.Purge.PurgeAllForUser(c.Request.Context(), uid)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		c.JSON(http.StatusOK, dto.EmptyTrashResponse{Purged: count})
	}
}

// ── small helpers ────────────────────────────────────────────────────

func parseID(c *gin.Context) (int64, bool) {
	id, err := parseInt64(c.Param("folder_id"))
	if err != nil {
		apiErr(c, http.StatusUnprocessableEntity, "路径参数不合法")
		return 0, false
	}
	return id, true
}

func parseInt64(s string) (int64, error) {
	return strconv.ParseInt(trim(s), 10, 64)
}

func clampInt(s string, lo, hi int) int {
	n, err := strconv.Atoi(trim(s))
	if err != nil {
		return lo
	}
	if n < lo {
		return lo
	}
	if n > hi {
		return hi
	}
	return n
}

func intFromPtr(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}

func trim(s string) string        { return strings.TrimSpace(s) }
func lower(s string) string       { return strings.ToLower(s) }
func hasPrefix(s, p string) bool  { return strings.HasPrefix(s, p) }
func contains(s, sub string) bool { return strings.Contains(s, sub) }
func minStr(a, b int) int {
	if a < b {
		return a
	}
	return b
}
