// Internal workspace folder creation: app-ts research workspaces create their
// cloud-drive folder tree over the same apikey + ?uid= M2M guard as the other
// /internal/cloud endpoints. Folder semantics are identical to the user-facing
// POST /cloud/folders handler; only the identity source differs.
package router

import (
	"net/http"

	"app-cloud/internal/dto"
	"app-cloud/internal/middleware"
	"app-cloud/internal/model"

	"github.com/gin-gonic/gin"
)

func internalCreateFolder(d Deps) gin.HandlerFunc {
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
