// Endpoint registrations — favorites v2, favorites organize (v1 write ops),
// knowledge build/sync, and ASR. Wire shapes mirror the Python routers.
package router

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"

	"app-bili/internal/bili"
	"app-bili/internal/service"

	"github.com/gin-gonic/gin"
)

func registerFavorites(e *gin.Engine, d Deps) {
	g := e.Group("/favorites/v2")

	g.GET("/list", func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		client, _, err := d.Resolver.Resolve(c.Request.Context(), uid)
		if respondCredErr(c, err) {
			return
		}
		folders, err := d.Fav.ListOrSyncFolders(c.Request.Context(), uid, client)
		if serviceErr(c, err) {
			return
		}
		writeJSON(c, http.StatusOK, service.FoldersToJSON(folders))
	})

	g.POST("/sync", func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		client, _, err := d.Resolver.Resolve(c.Request.Context(), uid)
		if respondCredErr(c, err) {
			return
		}
		folders, err := d.Fav.SyncFolders(c.Request.Context(), uid, client)
		if serviceErr(c, err) {
			return
		}
		writeJSON(c, http.StatusOK, gin.H{"folders": service.FoldersToJSON(folders), "total": len(folders)})
	})

	g.PATCH("/:folder_id/selected", func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		folderID, perr := strconv.ParseInt(c.Param("folder_id"), 10, 64)
		selected, qerr := strconv.ParseBool(c.Query("is_selected"))
		if perr != nil || qerr != nil {
			apiErr(c, http.StatusBadRequest, "invalid folder_id or is_selected")
			return
		}
		ok2, err := d.Fav.UpdateFolderSelected(c.Request.Context(), folderID, selected, uid)
		if serviceErr(c, err) {
			return
		}
		if !ok2 {
			apiErr(c, http.StatusNotFound, "Folder not found")
			return
		}
		writeJSON(c, http.StatusOK, gin.H{"folder_id": folderID, "is_selected": selected})
	})

	g.DELETE("/:folder_id", func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		folderID, perr := strconv.ParseInt(c.Param("folder_id"), 10, 64)
		if perr != nil {
			apiErr(c, http.StatusBadRequest, "invalid folder_id")
			return
		}
		ok2, err := d.Fav.DeleteFolder(c.Request.Context(), folderID, uid)
		if serviceErr(c, err) {
			return
		}
		if !ok2 {
			apiErr(c, http.StatusNotFound, "Folder not found or already deleted")
			return
		}
		writeJSON(c, http.StatusOK, gin.H{"message": "Deleted", "folder_id": folderID})
	})

	// 分P 列表（bvid → cids + ASR/向量化状态）—— Python favorites_v2 第五端点，
	// Go 版此前漏移植（前端视频详情页 404「接口不存在」）。
	g.GET("/video/:bvid/pages", func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		bvid := c.Param("bvid")
		if bvid == "" {
			apiErr(c, http.StatusBadRequest, "invalid bvid")
			return
		}
		client, _, err := d.Resolver.Resolve(c.Request.Context(), uid)
		if respondCredErr(c, err) {
			return
		}
		result, err := d.Pages.ListPagesByBvid(c.Request.Context(), bvid, client)
		if serviceErr(c, err) {
			return
		}
		writeJSON(c, http.StatusOK, result)
	})

	g.GET("/media/:media_id/videos", func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		mediaID, perr := strconv.ParseInt(c.Param("media_id"), 10, 64)
		if perr != nil {
			apiErr(c, http.StatusBadRequest, "invalid media_id")
			return
		}
		page, pageSize := pagination(c, 1, 20)
		client, _, err := d.Resolver.Resolve(c.Request.Context(), uid)
		if respondCredErr(c, err) {
			return
		}
		result, err := d.Fav.ListVideosByMediaID(c.Request.Context(), uid, mediaID, client, page, pageSize,
			func(ctx context.Context, uid2, folderID int64) error {
				_, serr := d.Fav.SyncVideos(ctx, uid2, folderID, client)
				return serr
			})
		if serviceErr(c, err) {
			return
		}
		writeJSON(c, http.StatusOK, result)
	})
}

// organize — v1 write operations (B站收藏夹整理/清理), uid-credential based.
func registerOrganize(e *gin.Engine, d Deps) {
	g := e.Group("/favorites/organize")
	g.POST("/preview", func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		client, _, err := d.Resolver.Resolve(c.Request.Context(), uid)
		if respondCredErr(c, err) {
			return
		}
		result, err := d.Fav.OrganizePreview(c.Request.Context(), uid, client)
		if serviceErr(c, err) {
			return
		}
		writeJSON(c, http.StatusOK, result)
	})
	g.POST("/execute", func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		var req struct {
			FolderIDs []int64 `json:"folder_ids"`
		}
		_ = c.ShouldBindJSON(&req)
		client, _, err := d.Resolver.Resolve(c.Request.Context(), uid)
		if respondCredErr(c, err) {
			return
		}
		result, err := d.Fav.OrganizeExecute(c.Request.Context(), uid, client, req.FolderIDs)
		if serviceErr(c, err) {
			return
		}
		writeJSON(c, http.StatusOK, result)
	})
	g.POST("/clean-invalid", func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		var req struct {
			FolderID int64 `json:"folder_id"`
		}
		if err := c.ShouldBindJSON(&req); err != nil || req.FolderID <= 0 {
			apiErr(c, http.StatusBadRequest, "folder_id is required")
			return
		}
		client, _, err := d.Resolver.Resolve(c.Request.Context(), uid)
		if respondCredErr(c, err) {
			return
		}
		result, err := d.Fav.CleanInvalid(c.Request.Context(), client, req.FolderID)
		if serviceErr(c, err) {
			return
		}
		writeJSON(c, http.StatusOK, result)
	})
}

func registerKnowledge(e *gin.Engine, d Deps) {
	g := e.Group("/knowledge")

	g.POST("/folders/sync", func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		var req struct {
			FolderIDs []int64 `json:"folder_ids"`
		}
		_ = c.ShouldBindJSON(&req)
		task, err := d.Build.TryStartBuild(c.Request.Context(), uid, req.FolderIDs)
		if serviceErr(c, err) {
			return
		}
		writeJSON(c, http.StatusOK, task)
	})

	g.POST("/build", func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		var req struct {
			FolderIDs    []int64  `json:"folder_ids"`
			ExcludeBvids []string `json:"exclude_bvids"`
		}
		_ = c.ShouldBindJSON(&req)
		task, err := d.Build.TryStartBuild(c.Request.Context(), uid, req.FolderIDs)
		if serviceErr(c, err) {
			return
		}
		writeJSON(c, http.StatusOK, task)
	})

	g.GET("/build/active", func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		task, err := d.Build.ActiveTask(c.Request.Context(), uid)
		if serviceErr(c, err) {
			return
		}
		writeJSON(c, http.StatusOK, task)
	})

	g.GET("/build/status/:task_id", func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		task, err := d.Build.TaskStatus(c.Request.Context(), uid, c.Param("task_id"))
		if serviceErr(c, err) {
			return
		}
		writeJSON(c, http.StatusOK, task)
	})
}

func registerASR(e *gin.Engine, d Deps) {
	g := e.Group("/asr")

	g.GET("/content", func(c *gin.Context) {
		if _, ok := currentUID(c); !ok {
			return
		}
		bvid, cid, ok2 := bvidCid(c)
		if !ok2 {
			return
		}
		result, err := d.ASR.GetContent(c.Request.Context(), bvid, cid)
		if serviceErr(c, err) {
			return
		}
		writeJSON(c, http.StatusOK, result)
	})

	g.POST("/create", func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		var req struct {
			BvID      string `json:"bvid"`
			CID       int64  `json:"cid"`
			PageIndex int    `json:"page_index"`
			PageTitle string `json:"page_title"`
		}
		if err := c.ShouldBindJSON(&req); err != nil || req.BvID == "" || req.CID == 0 {
			apiErr(c, http.StatusBadRequest, "bvid and cid are required")
			return
		}
		result, err := d.ASR.CreateTask(c.Request.Context(), uid, req.BvID, req.CID, req.PageIndex, req.PageTitle)
		if serviceErr(c, err) {
			return
		}
		writeJSON(c, http.StatusOK, result)
	})

	g.POST("/update", func(c *gin.Context) {
		if _, ok := currentUID(c); !ok {
			return
		}
		var req struct {
			BvID      string `json:"bvid"`
			CID       int64  `json:"cid"`
			PageIndex int    `json:"page_index"`
			Content   string `json:"content"`
		}
		if err := c.ShouldBindJSON(&req); err != nil || req.BvID == "" {
			apiErr(c, http.StatusBadRequest, "bvid and content are required")
			return
		}
		if err := d.ASR.UpdateContent(c.Request.Context(), req.BvID, req.CID, req.PageIndex, req.Content); err != nil {
			serviceErr(c, err)
			return
		}
		writeJSON(c, http.StatusOK, gin.H{"success": true, "message": "更新成功"})
	})

	g.POST("/reasr", func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		var req struct {
			BvID      string `json:"bvid"`
			CID       int64  `json:"cid"`
			PageIndex int    `json:"page_index"`
		}
		if err := c.ShouldBindJSON(&req); err != nil || req.BvID == "" {
			apiErr(c, http.StatusBadRequest, "bvid is required")
			return
		}
		result, err := d.ASR.ReASR(c.Request.Context(), uid, req.BvID, req.PageIndex)
		if serviceErr(c, err) {
			return
		}
		writeJSON(c, http.StatusOK, result)
	})

	g.GET("/status/:task_id", func(c *gin.Context) {
		if _, ok := currentUID(c); !ok {
			return
		}
		writeJSON(c, http.StatusOK, d.ASR.GetTaskStatus(c.Request.Context(), c.Param("task_id")))
	})

	g.GET("/versions", func(c *gin.Context) {
		if _, ok := currentUID(c); !ok {
			return
		}
		bvid, cid, ok2 := bvidCid(c)
		if !ok2 {
			return
		}
		versions, err := d.ASR.ListVersions(c.Request.Context(), bvid, cid)
		if serviceErr(c, err) {
			return
		}
		writeJSON(c, http.StatusOK, versions)
	})
}

// ── helpers ──────────────────────────────────────────────────────────

func pagination(c *gin.Context, defPage, defSize int) (int, int) {
	page, pageSize := defPage, defSize
	if v, err := strconv.Atoi(c.Query("page")); err == nil && v >= 1 {
		page = v
	}
	if v, err := strconv.Atoi(c.Query("page_size")); err == nil && v >= 1 && v <= 20 {
		pageSize = v
	}
	return page, pageSize
}

func bvidCid(c *gin.Context) (string, int64, bool) {
	bvid := c.Query("bvid")
	cid, err := strconv.ParseInt(c.Query("cid"), 10, 64)
	if bvid == "" || err != nil {
		apiErr(c, http.StatusBadRequest, "bvid and cid are required")
		return "", 0, false
	}
	return bvid, cid, true
}

// respondCredErr maps the credential resolution failure onto the wire.
//
// ErrNotLinked (no bilibili binding) is NOT an auth failure — the session is
// valid, the user just hasn't linked a bilibili account yet. It maps to 409
// so the frontend can show a "bind bilibili" prompt; mapping it to 401 made
// client.ts treat it as "session expired" and log the user out on every
// favorites call from an email-registered account. Everything else is a
// server-side resolution failure (500, non-leaking detail).
func respondCredErr(c *gin.Context, err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, bili.ErrNotLinked) {
		apiErr(c, http.StatusConflict, "B站账号未绑定，请先在个人中心扫码绑定")
		return true
	}
	slog.Error("[BILI] credential resolve failed", "err", err)
	apiErr(c, http.StatusInternalServerError, "获取B站凭据失败，请稍后重试")
	return true
}
