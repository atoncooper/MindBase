// Internal folder listing: the account domain (app-user) provisions the
// per-user default drive folder ("agent/") when a user is created, so it must
// read the user's root folder list over the same apikey + ?uid= M2M guard as the
// other /internal/cloud endpoints. Folder semantics are identical to the
// user-facing folder tree; only the identity source differs.
package router

import (
	"net/http"
	"strconv"
	"strings"

	"app-cloud/internal/dto"
	"app-cloud/internal/middleware"
	"app-cloud/internal/model"

	"github.com/gin-gonic/gin"
)

// FolderListFunc lists one level of a user's folder tree (parentID nil = root),
// ordered by name. Production binds it to *repo.FolderRepo.ListByParent; the
// function type keeps the black-box HTTP suite independent of MySQL.
type FolderListFunc func(uid int64, parentID *int64) ([]model.CloudFolder, error)

// folderLister binds the folder repo to the service DB. A service built without
// a DB (route-registration smoke tests) yields a nil lister, which the handler
// reports as 503 instead of panicking.
func folderLister(d Deps) FolderListFunc {
	if d.Folders == nil || d.DB == nil {
		return nil
	}
	return func(uid int64, parentID *int64) ([]model.CloudFolder, error) {
		return d.Folders.ListByParent(d.DB, uid, parentID)
	}
}

// InternalListFolders — GET /internal/cloud/folders?uid=&parent_id=
// Lists the folders directly under parent_id (absent = root) for the uid
// resolved by RequireInternalUID, ordered by name.
func InternalListFolders(list FolderListFunc) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		var parentID *int64
		if raw := strings.TrimSpace(c.Query("parent_id")); raw != "" {
			id, err := strconv.ParseInt(raw, 10, 64)
			if err != nil || id <= 0 {
				apiErr(c, http.StatusUnprocessableEntity, "parent_id 不合法")
				return
			}
			parentID = &id
		}
		if list == nil {
			apiErr(c, http.StatusServiceUnavailable, "文件夹服务暂不可用")
			return
		}
		rows, err := list(uid, parentID)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		items := make([]dto.InternalFolderItem, 0, len(rows))
		for _, row := range rows {
			items = append(items, dto.InternalFolderItem{
				ID:       row.ID,
				Name:     row.Name,
				ParentID: row.ParentID,
			})
		}
		c.JSON(http.StatusOK, dto.InternalFolderListResponse{Items: items})
	}
}
