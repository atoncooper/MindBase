package router

import (
	"errors"
	"net/http"
	"strconv"

	"app-cloud/internal/dto"
	"app-cloud/internal/middleware"
	"app-cloud/internal/service"

	"github.com/gin-gonic/gin"
)

// registerRefRoutes — the /cloud/refs face. All endpoints are X-Uid
// authenticated; saving does NOT need attest (it is a logged-in action, unlike
// the public share access face).
func registerRefRoutes(cloudGroup *gin.RouterGroup, d Deps) {
	cloudGroup.POST("/refs", saveRef(d))
	cloudGroup.GET("/refs", listRefs(d))
	cloudGroup.DELETE("/refs/:ref_id", deleteRef(d))
	cloudGroup.GET("/refs/:ref_id/raw", rawRef(d))
}

// saveRef — POST /cloud/refs
// body: {token: string, code?: string, targetFolderId?: number|null}
// → {saved: number, rootFolderId?: number}
func saveRef(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		var body dto.SaveRefRequest
		if err := c.ShouldBindJSON(&body); err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "参数不合法")
			return
		}
		res, err := d.Ref.SaveShare(c.Request.Context(), uid, body.Token, body.Code, body.TargetFolderID)
		if err != nil {
			mapRefErr(c, err)
			return
		}
		c.JSON(http.StatusOK, dto.SaveRefResponse{
			Saved:        res.Saved,
			RootFolderID: res.RootFolderID,
		})
	}
}

// listRefs — GET /cloud/refs?folderId= → {refs, total} (folderId 缺省 = 根).
func listRefs(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		var folderID *int64
		if v := c.Query("folderId"); v != "" {
			id, err := strconv.ParseInt(v, 10, 64)
			if err != nil || id <= 0 {
				apiErr(c, http.StatusUnprocessableEntity, "folderId 不合法")
				return
			}
			folderID = &id
		}
		res, err := d.Ref.ListRefs(uid, folderID)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		refs := make([]dto.RefItem, 0, len(res.Refs))
		for _, r := range res.Refs {
			refs = append(refs, dto.RefItem{
				ID:               r.ID,
				Name:             r.Name,
				Size:             r.Size,
				MimeType:         r.MimeType,
				FolderID:         r.FolderID,
				Status:           r.Status,
				ShareID:          r.ShareID,
				SourceUploadUUID: r.SourceUploadUUID,
				SourceName:       r.SourceName,
				CreatedAt:        r.CreatedAt,
				IsRef:            true,
			})
		}
		c.JSON(http.StatusOK, dto.RefListResponse{Refs: refs, Total: res.Total})
	}
}

// deleteRef — DELETE /cloud/refs/{id} (uid-checked soft delete).
func deleteRef(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		id, err := strconv.ParseInt(c.Param("ref_id"), 10, 64)
		if err != nil || id <= 0 {
			apiErr(c, http.StatusUnprocessableEntity, "ref_id 不合法")
			return
		}
		if err := d.Ref.DeleteRef(uid, id); err != nil {
			apiErr(c, http.StatusNotFound, "引用不存在")
			return
		}
		c.JSON(http.StatusOK, dto.RefDeleteResponse{Deleted: true})
	}
}

// rawRef — GET /cloud/refs/{id}/raw?download=1 → presigned URL through the
// ORIGINAL object (BuildAccess disposition/XSS policy). Invalidated refs
// read uniformly as 404「引用已失效」 and are flipped dead in the same pass.
func rawRef(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		id, err := strconv.ParseInt(c.Param("ref_id"), 10, 64)
		if err != nil || id <= 0 {
			apiErr(c, http.StatusUnprocessableEntity, "ref_id 不合法")
			return
		}
		download := c.Query("download") == "1" || c.Query("download") == "true"
		grant, err := d.Ref.RawRef(c.Request.Context(), uid, id, download)
		if err != nil {
			mapRefErr(c, err)
			return
		}
		c.JSON(http.StatusOK, dto.RefRawResponse{
			URL:       grant.URL,
			ViewMode:  grant.ViewMode,
			MimeType:  grant.MimeType,
			FileName:  grant.FileName,
			FileSize:  grant.FileSize,
			ExpiresIn: grant.ExpiresIn,
		})
	}
}

// mapRefErr — uniform ref error mapping (失效统一 404).
func mapRefErr(c *gin.Context, err error) {
	switch {
	case errors.Is(err, service.ErrRefDead):
		apiErr(c, http.StatusNotFound, err.Error())
	case errors.Is(err, service.ErrShareNotFound):
		apiErr(c, http.StatusNotFound, "分享不存在或已失效")
	case errors.Is(err, service.ErrRefTooMany):
		apiErr(c, http.StatusUnprocessableEntity, err.Error())
	case errors.Is(err, service.ErrRefDestMissing):
		apiErr(c, http.StatusBadRequest, err.Error())
	case errors.Is(err, service.ErrShareCodeRequired):
		apiErr(c, http.StatusUnauthorized, err.Error())
	case errors.Is(err, service.ErrShareCodeWrong):
		apiErr(c, http.StatusForbidden, err.Error())
	case errors.Is(err, service.ErrNotFound):
		apiErr(c, http.StatusNotFound, "引用不存在")
	default:
		apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
	}
}
