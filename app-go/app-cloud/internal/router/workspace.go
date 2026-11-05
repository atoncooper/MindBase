// /workspaces — RAG 工作区 CRUD + 绑定（camelCase wire 契约，Python FastAPI
// by_alias 遗产；前端 workspaceApi 零改动）。身份 = 网关注入 X-Uid。
package router

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"app-cloud/internal/dto"
	"app-cloud/internal/middleware"
	"app-cloud/internal/model"
	"app-cloud/internal/repo"

	"github.com/gin-gonic/gin"
)

func registerWorkspaces(e *gin.Engine, d Deps) {
	g := e.Group("/workspaces")
	g.Use(middleware.RequireUID())
	wsRepo := repo.NewWorkspaceRepo()

	g.GET("", func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		rows, err := wsRepo.ListByUID(c.Request.Context(), d.DB, uid)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "内部错误")
			return
		}
		out := make([]dto.Workspace, 0, len(rows))
		for i := range rows {
			bindings, _ := wsRepo.GetBindings(c.Request.Context(), d.DB, rows[i].ID, uid)
			out = append(out, toWorkspaceResponse(&rows[i], bindings))
		}
		c.JSON(http.StatusOK, out)
	})

	g.POST("", func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		var body dto.WorkspaceCreateRequest
		if err := c.ShouldBindJSON(&body); err != nil || strings.TrimSpace(body.Name) == "" {
			apiErr(c, http.StatusBadRequest, "name 必填")
			return
		}
		name := body.Name
		if len(name) < 1 || len(name) > 200 {
			apiErr(c, http.StatusBadRequest, "name 长度须在 1-200 之间")
			return
		}
		row, err := wsRepo.Create(c.Request.Context(), d.DB, uid, name, body.Description, body.Icon, body.Color)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "内部错误")
			return
		}
		c.JSON(http.StatusCreated, toWorkspaceResponse(row, nil))
	})

	g.GET("/:workspace_id", func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		id, valid := parseWorkspaceID(c)
		if !valid {
			return
		}
		row, err := wsRepo.GetByID(c.Request.Context(), d.DB, id, uid)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "内部错误")
			return
		}
		if row == nil {
			apiErr(c, http.StatusNotFound, "工作区不存在")
			return
		}
		bindings, _ := wsRepo.GetBindings(c.Request.Context(), d.DB, id, uid)
		c.JSON(http.StatusOK, toWorkspaceResponse(row, bindings))
	})

	g.PATCH("/:workspace_id", func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		id, valid := parseWorkspaceID(c)
		if !valid {
			return
		}
		var body dto.WorkspaceUpdateRequest
		if err := c.ShouldBindJSON(&body); err != nil {
			apiErr(c, http.StatusBadRequest, "请求体格式错误")
			return
		}
		row, err := wsRepo.Update(c.Request.Context(), d.DB, id, uid, body.Name, body.Description, body.Icon, body.Color)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "内部错误")
			return
		}
		if row == nil {
			apiErr(c, http.StatusNotFound, "工作区不存在")
			return
		}
		bindings, _ := wsRepo.GetBindings(c.Request.Context(), d.DB, id, uid)
		c.JSON(http.StatusOK, toWorkspaceResponse(row, bindings))
	})

	g.DELETE("/:workspace_id", func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		id, valid := parseWorkspaceID(c)
		if !valid {
			return
		}
		deleted, err := wsRepo.SoftDelete(c.Request.Context(), d.DB, id, uid)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "内部错误")
			return
		}
		if !deleted {
			apiErr(c, http.StatusNotFound, "工作区不存在")
			return
		}
		c.JSON(http.StatusOK, dto.WorkspaceDeleteResponse{Deleted: true})
	})

	g.POST("/:workspace_id/bindings", func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		id, valid := parseWorkspaceID(c)
		if !valid {
			return
		}
		ws, err := wsRepo.GetByID(c.Request.Context(), d.DB, id, uid)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "内部错误")
			return
		}
		if ws == nil {
			apiErr(c, http.StatusNotFound, "工作区不存在")
			return
		}
		var body dto.WorkspaceBindingRequest
		if err := c.ShouldBindJSON(&body); err != nil {
			apiErr(c, http.StatusBadRequest, "请求体格式错误")
			return
		}
		if body.BindType != "folder" && body.BindType != "file" {
			apiErr(c, http.StatusBadRequest, "bindType 必须是 folder 或 file")
			return
		}
		// ownership validation of the bound target
		if body.BindType == "folder" {
			if body.FolderID == nil || *body.FolderID <= 0 {
				apiErr(c, http.StatusBadRequest, "folderId 必填")
				return
			}
			exists, err := wsRepo.FolderExists(c.Request.Context(), d.DB, *body.FolderID, uid)
			if err != nil {
				apiErr(c, http.StatusInternalServerError, "内部错误")
				return
			}
			if !exists {
				apiErr(c, http.StatusForbidden, "文件夹不存在或不属于你")
				return
			}
		}
		if body.BindType == "file" {
			if body.UploadUUID == nil || strings.TrimSpace(*body.UploadUUID) == "" {
				apiErr(c, http.StatusBadRequest, "uploadUuid 必填")
				return
			}
			exists, err := wsRepo.FileExists(c.Request.Context(), d.DB, strings.TrimSpace(*body.UploadUUID), uid)
			if err != nil {
				apiErr(c, http.StatusInternalServerError, "内部错误")
				return
			}
			if !exists {
				apiErr(c, http.StatusForbidden, "文件不存在或不属于你")
				return
			}
		}
		includeSub := true
		if body.IncludeSubfolders != nil {
			includeSub = *body.IncludeSubfolders
		}
		if err := wsRepo.AddBinding(c.Request.Context(), d.DB, id, uid, body.BindType, body.FolderID, body.UploadUUID, includeSub); err != nil {
			apiErr(c, http.StatusInternalServerError, "内部错误")
			return
		}
		if _, err := wsRepo.ExpandAndRecalc(c.Request.Context(), d.DB, id, uid); err != nil {
			apiErr(c, http.StatusInternalServerError, "内部错误")
			return
		}
		updated, _ := wsRepo.GetByID(c.Request.Context(), d.DB, id, uid)
		bindings, _ := wsRepo.GetBindings(c.Request.Context(), d.DB, id, uid)
		c.JSON(http.StatusOK, toWorkspaceResponse(updated, bindings))
	})

	g.DELETE("/:workspace_id/bindings/:binding_id", func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		id, valid := parseWorkspaceID(c)
		if !valid {
			return
		}
		bindingID, err := strconv.ParseInt(c.Param("binding_id"), 10, 64)
		if err != nil || bindingID <= 0 {
			apiErr(c, http.StatusBadRequest, "invalid binding_id")
			return
		}
		removed, err := wsRepo.RemoveBinding(c.Request.Context(), d.DB, bindingID, id, uid)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "内部错误")
			return
		}
		if !removed {
			apiErr(c, http.StatusNotFound, "绑定不存在")
			return
		}
		if _, err := wsRepo.ExpandAndRecalc(c.Request.Context(), d.DB, id, uid); err != nil {
			apiErr(c, http.StatusInternalServerError, "内部错误")
			return
		}
		c.JSON(http.StatusOK, dto.WorkspaceDeleteResponse{Deleted: true})
	})

	g.GET("/:workspace_id/files", func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		id, valid := parseWorkspaceID(c)
		if !valid {
			return
		}
		ws, err := wsRepo.GetByID(c.Request.Context(), d.DB, id, uid)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "内部错误")
			return
		}
		if ws == nil {
			apiErr(c, http.StatusNotFound, "工作区不存在")
			return
		}
		files, err := wsRepo.ExpandAndRecalc(c.Request.Context(), d.DB, id, uid)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "内部错误")
			return
		}
		items := make([]dto.WorkspaceFileItem, 0, len(files))
		for _, f := range files {
			status := "pending"
			if f.VectorStatus != nil && *f.VectorStatus != "" {
				status = *f.VectorStatus
			}
			chunks := 0
			if f.VectorChunkCount != nil {
				chunks = *f.VectorChunkCount
			}
			items = append(items, dto.WorkspaceFileItem{
				UploadUUID:       f.UploadUUID,
				OriginalName:     f.OriginalName,
				MimeType:         f.MimeType,
				Vectorizable:     true,
				VectorStatus:     status,
				VectorChunkCount: chunks,
			})
		}
		c.JSON(http.StatusOK, items)
	})
}

// toWorkspaceResponse maps a workspace row + bindings onto the wire shape.
func toWorkspaceResponse(ws *model.Workspace, bindings []model.WorkspaceBinding) dto.Workspace {
	out := make([]dto.WorkspaceBinding, 0, len(bindings))
	for _, b := range bindings {
		out = append(out, dto.WorkspaceBinding{
			ID:                b.ID,
			BindType:          b.BindType,
			FolderID:          b.FolderID,
			FolderName:        nil,
			UploadUUID:        b.UploadUUID,
			FileName:          nil,
			IncludeSubfolders: b.IncludeSubfolders,
		})
	}
	return dto.Workspace{
		ID: ws.ID, Name: ws.Name, Description: ws.Description, Icon: ws.Icon, Color: ws.Color,
		FileCount: ws.FileCount, ChunkCount: ws.ChunkCount, Bindings: out,
		CreatedAt: isoOrEmpty(ws.CreatedAt), UpdatedAt: isoOrEmpty(ws.UpdatedAt),
	}
}

// parseWorkspaceID parses the workspace_id path param (distinct from
// cloud.go's folder_id parseID).
func parseWorkspaceID(c *gin.Context) (int64, bool) {
	id, err := strconv.ParseInt(c.Param("workspace_id"), 10, 64)
	if err != nil || id <= 0 {
		apiErr(c, http.StatusBadRequest, "invalid workspace_id")
		return 0, false
	}
	return id, true
}

// isoOrEmpty renders naive-UTC isoformat (Python datetime.isoformat() parity).
func isoOrEmpty(t *time.Time) string {
	if t == nil {
		return ""
	}
	return t.UTC().Format("2006-01-02T15:04:05")
}
