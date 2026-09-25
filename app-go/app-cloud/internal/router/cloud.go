package router

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"app-cloud/internal/model"
	"app-cloud/internal/service"

	"github.com/gin-gonic/gin"
)

// registerCloud mounts the user-facing /cloud/* endpoints. Paths and response
// shapes match the Python backend's app/routers/cloud.py so the frontend's
// cloudApi keeps working unchanged.
func registerCloud(e *gin.Engine, d Deps) {
	g := e.Group("/cloud")
	registerShareRoutes(e, d, g)

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
	g.POST("/video/:upload_uuid/process", triggerProcess(d))
	g.POST("/video/:upload_uuid/reprocess", reprocess(d))
	g.GET("/video/:upload_uuid/status", getVideoStatus(d))
	g.GET("/video/:upload_uuid/preview", getDocumentPreview(d))
	g.GET("/video/:upload_uuid/raw", getVideoRaw(d))

	// ── quota / search (new) ──
	g.GET("/quota", getQuota(d))
	g.GET("/search", searchFiles(d))

	// ── trash (new) ──
	g.GET("/trash", listTrash(d))
	g.POST("/trash/:upload_uuid/restore", restoreTrash(d))
	g.DELETE("/trash/:upload_uuid", purgeTrashItem(d))
	g.DELETE("/trash", emptyTrash(d))
}

// ── upload ───────────────────────────────────────────────────────────

type uploadInitReq struct {
	Filename string `json:"filename" binding:"required"`
	FileSize int64  `json:"fileSize" binding:"required"`
	MimeType string `json:"mimeType" binding:"required"`
	FolderID *int64 `json:"folderId"`
}

func initUpload(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		var req uploadInitReq
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
		c.JSON(http.StatusOK, res)
	}
}

type heartbeatReq struct {
	SessionUUID string `json:"sessionUuid" binding:"required"`
}

func heartbeat(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req heartbeatReq
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusOK, gin.H{"ack": false})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ack": d.Upload.Heartbeat(c.Request.Context(), req.SessionUUID)})
	}
}

type uploadPartReq struct {
	PartNumber int    `json:"PartNumber"`
	ETag       string `json:"ETag"`
}

type completeReq struct {
	Parts []uploadPartReq `json:"parts" binding:"required"`
}

func completeUpload(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		var req completeReq
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "请求参数不合法")
			return
		}
		parts := make([]struct {
			PartNumber int
			ETag       string
		}, 0, len(req.Parts))
		for _, p := range req.Parts {
			parts = append(parts, struct {
				PartNumber int
				ETag       string
			}{p.PartNumber, p.ETag})
		}
		res, err := d.Upload.CompleteUpload(c.Request.Context(), c.Param("upload_uuid"), parts, uid)
		if err != nil {
			apiErr(c, http.StatusBadRequest, err.Error())
			return
		}
		c.JSON(http.StatusOK, res)
	}
}

func resumeUpload(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		res, err := d.Upload.ResumeUpload(c.Request.Context(), c.Param("upload_uuid"), uid)
		if err != nil {
			apiErr(c, http.StatusBadRequest, err.Error())
			return
		}
		c.JSON(http.StatusOK, res)
	}
}

// ── folders ──────────────────────────────────────────────────────────

func listFolders(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
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
		c.JSON(http.StatusOK, gin.H{"folders": buildFolderTree(rows, nil)})
	}
}

// buildFolderTree assembles the FolderTreeItem forest from a flat list.
func buildFolderTree(rows []model.CloudFolder, parent *int64) []gin.H {
	items := make([]gin.H, 0)
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
		item := gin.H{
			"id":          row.ID,
			"parent_id":   row.ParentID,
			"name":        row.Name,
			"video_count": count,
			"children":    buildFolderTree(rows, &row.ID),
		}
		items = append(items, item)
	}
	return items
}

type folderCreateReq struct {
	ParentID *int64 `json:"parentId"`
	Name     string `json:"name" binding:"required"`
}

func createFolder(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		var req folderCreateReq
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
		count := 0
		c.JSON(http.StatusCreated, gin.H{
			"id": row.ID, "parent_id": row.ParentID, "name": row.Name, "video_count": count,
		})
	}
}

type folderUpdateReq struct {
	Name      *string `json:"name"`
	ParentID  *int64  `json:"parentId"`
	SetParent bool    `json:"-"` // presence tracked via raw map below
}

func updateFolder(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		folderID, ok2 := parseID(c)
		if !ok2 {
			return
		}
		var body map[string]any
		if err := c.ShouldBindJSON(&body); err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "请求参数不合法")
			return
		}
		fields := map[string]any{}
		if v, present := body["name"]; present && v != nil {
			fields["name"] = v
		}
		if v, present := body["parentId"]; present {
			// explicit null moves to root; otherwise validate the target
			if v == nil {
				fields["parent_id"] = nil
			} else {
				pid, ok := toInt64(v)
				if !ok {
					apiErr(c, http.StatusUnprocessableEntity, "parentId 不合法")
					return
				}
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
		c.JSON(http.StatusOK, gin.H{
			"id": folder.ID, "parent_id": folder.ParentID, "name": folder.Name, "video_count": count,
		})
	}
}

func deleteFolder(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
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
		c.JSON(http.StatusOK, gin.H{"deleted": true, "affectedFiles": affected})
	}
}

// ── files ────────────────────────────────────────────────────────────

func listVideos(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
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
		videos := make([]videoItem, 0, len(rows))
		for i := range rows {
			videos = append(videos, toVideoItem(&rows[i]))
		}
		c.JSON(http.StatusOK, gin.H{
			"videos":   videos,
			"total":    total,
			"page":     page,
			"pageSize": pageSize,
			"hasMore":  int64(page*pageSize) < total,
		})
	}
}

// videoItem — list shape (VideoItem in app/response/cloud.py).
type videoItem struct {
	UploadUUID   string     `json:"upload_uuid"`
	OriginalName string     `json:"original_name"`
	FileSize     int64      `json:"file_size"`
	MimeType     string     `json:"mime_type"`
	Duration     *int       `json:"duration"`
	AsrStatus    string     `json:"asr_status"`
	VectorStatus string     `json:"vector_status"`
	Title        *string    `json:"title"`
	CoverURL     *string    `json:"cover_url"`
	CreatedAt    *time.Time `json:"createdAt"`
}

func toVideoItem(f *model.CloudFile) videoItem {
	item := videoItem{
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
	return item
}

func statusOrDefault(s *string) string {
	if s == nil || *s == "" {
		return "pending"
	}
	return *s
}

func getVideoDetail(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		f, err := d.Files.GetByUUID(d.DB, c.Param("upload_uuid"), uid)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		if f == nil {
			apiErr(c, http.StatusNotFound, "File not found")
			return
		}
		resp := toVideoDetail(f)
		if f.FolderID != nil {
			if folder, err := d.Folders.GetByID(d.DB, *f.FolderID, uid); err == nil && folder != nil {
				resp["folderName"] = folder.Name
			}
		}
		if asr := d.ASRPreview(c.Request.Context(), f.UploadUUID); asr != "" {
			resp["asrPreview"] = asr[:minStr(len(asr), 500)]
		}
		c.JSON(http.StatusOK, resp)
	}
}

func toVideoDetail(f *model.CloudFile) gin.H {
	resp := gin.H{
		"upload_uuid":        f.UploadUUID,
		"original_name":      f.OriginalName,
		"file_size":          f.FileSize,
		"mime_type":          f.MimeType,
		"duration":           f.Duration,
		"asr_status":         statusOrDefault(f.AsrStatus),
		"vector_status":      statusOrDefault(f.VectorStatus),
		"title":              f.Title,
		"cover_url":          f.CoverURL,
		"created_at":         f.CreatedAt,
		"description":        f.Description,
		"tags":               f.Tags,
		"folder_id":          f.FolderID,
		"folderName":         "",
		"asrPreview":         nil,
		"vector_chunk_count": intFromPtr(f.VectorChunkCount),
	}
	return resp
}

type videoUpdateReq struct {
	Title       *string   `json:"title"`
	Description *string   `json:"description"`
	Tags        *[]string `json:"tags"`
	FolderID    **int64   `json:"-"` // handled via raw map
}

func updateVideo(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		var body map[string]any
		if err := c.ShouldBindJSON(&body); err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "请求参数不合法")
			return
		}
		fields := map[string]any{}
		for _, key := range []string{"title", "description"} {
			if v, present := body[key]; present {
				fields[key] = v
			}
		}
		if v, present := body["tags"]; present && v != nil {
			tags, ok := toStringList(v)
			if !ok {
				apiErr(c, http.StatusUnprocessableEntity, "tags 不合法")
				return
			}
			fields["tags"] = tags
		}
		if v, present := body["folderId"]; present {
			if v == nil {
				fields["folder_id"] = nil
			} else {
				fid, ok := toInt64(v)
				if !ok {
					apiErr(c, http.StatusUnprocessableEntity, "folderId 不合法")
					return
				}
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
				resp["folderName"] = folder.Name
			}
		}
		c.JSON(http.StatusOK, resp)
	}
}

// deleteVideo — trash semantics: soft-delete only; MinIO/Mongo objects stay
// until the sweeper purges them (deleted_at + purge_after_days).
func deleteVideo(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
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
		c.JSON(http.StatusOK, gin.H{"deleted": true, "uploadUuid": c.Param("upload_uuid")})
	}
}

// triggerProcess — pipeline trigger (stub until C3 lands; keeps the endpoint
// contract so the frontend stays functional).
func triggerProcess(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		if d.Process == nil {
			apiErr(c, http.StatusServiceUnavailable, "处理管线未启用")
			return
		}
		if err := d.Process.Trigger(c.Request.Context(), c.Param("upload_uuid"), uid); err != nil {
			if err == service.ErrNotFound {
				apiErr(c, http.StatusNotFound, "File not found")
				return
			}
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		c.JSON(http.StatusOK, gin.H{"uploadUuid": c.Param("upload_uuid")})
	}
}

// reprocess — delete old vectors → re-parse → re-vectorize.
func reprocess(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		if d.Process == nil {
			apiErr(c, http.StatusServiceUnavailable, "处理管线未启用")
			return
		}
		taskID, err := d.Process.Reprocess(c.Request.Context(), c.Param("upload_uuid"), uid)
		if err != nil {
			if err == service.ErrNotFound {
				apiErr(c, http.StatusNotFound, "File not found")
				return
			}
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		c.JSON(http.StatusOK, gin.H{"uploadUuid": c.Param("upload_uuid"), "taskId": taskID})
	}
}

func getVideoStatus(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
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
		c.JSON(http.StatusOK, gin.H{
			"asr_status":       statusOrDefault(f.AsrStatus),
			"asrProgress":      0,
			"vector_status":    statusOrDefault(f.VectorStatus),
			"vectorChunkCount": count,
		})
	}
}

func getDocumentPreview(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
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
		var next any
		if hasMore {
			next = nextOffset
		}
		c.JSON(http.StatusOK, gin.H{
			"upload_uuid":  f.UploadUUID,
			"fileName":     f.OriginalName,
			"mime_type":    f.MimeType,
			"vectorizable": f.Vectorizable,
			"preview":      preview,
			"docMeta":      docMeta,
			"offset":       offset,
			"limit":        limit,
			"totalChars":   total,
			"hasMore":      hasMore,
			"nextOffset":   next,
		})
	}
}

// getVideoRaw — presigned GET (+ inline text content for text-like files).
func getVideoRaw(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
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
		url, err := d.Minio.PresignGet(c.Request.Context(), f.ObjectKey, ct, 0)
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
		c.JSON(http.StatusOK, gin.H{
			"url":      url,
			"content":  content,
			"mimeType": f.MimeType,
			"fileName": f.OriginalName,
			"fileSize": f.FileSize,
			"viewMode": viewMode,
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
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		used, quota, tier, pending, err := d.Quota.Usage(c.Request.Context(), uid)
		if err != nil {
			// Still answer with the fail-closed values + error flag.
			c.JSON(http.StatusOK, gin.H{
				"used": used, "quota": quota, "tier": tier, "pending": pending,
				"error": err.Error(),
			})
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"used": used, "quota": quota, "tier": tier, "pending": pending,
		})
	}
}

func searchFiles(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
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
		items := make([]videoItem, 0, len(rows))
		for i := range rows {
			items = append(items, toVideoItem(&rows[i]))
		}
		c.JSON(http.StatusOK, gin.H{"results": items, "total": len(items)})
	}
}

// ── trash ────────────────────────────────────────────────────────────

func listTrash(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		rows, err := d.Files.ListTrash(d.DB, uid)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		items := make([]gin.H, 0, len(rows))
		for i := range rows {
			f := &rows[i]
			purgeAt := timeOrNil(nil)
			if f.DeletedAt != nil {
				purge := f.DeletedAt.Add(time.Duration(d.Cfg.Trash.PurgeAfterDays) * 24 * time.Hour)
				purgeAt = &purge
			}
			items = append(items, gin.H{
				"upload_uuid":   f.UploadUUID,
				"original_name": f.OriginalName,
				"file_size":     f.FileSize,
				"mime_type":     f.MimeType,
				"deleted_at":    f.DeletedAt,
				"purge_at":      purgeAt,
			})
		}
		c.JSON(http.StatusOK, gin.H{"items": items, "total": len(items)})
	}
}

func restoreTrash(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		if err := d.Files.Restore(d.DB, c.Param("upload_uuid"), uid); err != nil {
			apiErr(c, http.StatusNotFound, "文件不在回收站中")
			return
		}
		c.JSON(http.StatusOK, gin.H{"restored": true, "upload_uuid": c.Param("upload_uuid")})
	}
}

// purgeTrashItem — immediate physical delete (MinIO + pipeline stores).
func purgeTrashItem(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		if err := d.Purge.PurgeFile(c.Request.Context(), c.Param("upload_uuid"), uid); err != nil {
			if err == service.ErrNotFound {
				apiErr(c, http.StatusNotFound, "文件不在回收站中")
				return
			}
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		c.JSON(http.StatusOK, gin.H{"purged": true, "upload_uuid": c.Param("upload_uuid")})
	}
}

func emptyTrash(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		count, err := d.Purge.PurgeAllForUser(c.Request.Context(), uid)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		c.JSON(http.StatusOK, gin.H{"purged": count})
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
	var v int64
	var err error
	v, err = strconv.ParseInt(trim(s), 10, 64)
	return v, err
}

func toStringList(v any) ([]string, bool) {
	switch t := v.(type) {
	case []string:
		return t, true
	case []any:
		out := make([]string, 0, len(t))
		for _, item := range t {
			s, ok := item.(string)
			if !ok {
				return nil, false
			}
			out = append(out, s)
		}
		return out, true
	default:
		return nil, false
	}
}

func toInt64(v any) (int64, bool) {
	switch n := v.(type) {
	case float64:
		return int64(n), true
	case string:
		id, err := strconv.ParseInt(n, 10, 64)
		return id, err == nil
	case int64:
		return n, true
	case int:
		return int64(n), true
	default:
		return 0, false
	}
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

func timeOrNil(t *time.Time) *time.Time { return t }

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
