package router

import (
	"errors"
	"net/http"
	"strconv"

	"app-cloud/internal/model"
	"app-cloud/internal/service"

	"github.com/gin-gonic/gin"
)

// registerShareRoutes mounts the owner share endpoints (inside the /cloud
// group) and the PUBLIC /cloud/s/* endpoints (no auth — reached via the
// dedicated nginx location without auth_request).
func registerShareRoutes(e *gin.Engine, d Deps, cloudGroup *gin.RouterGroup) {
	// owner endpoints
	cloudGroup.POST("/video/:upload_uuid/share", createShare(d))
	cloudGroup.GET("/video/:upload_uuid/shares", listShares(d))
	cloudGroup.DELETE("/shares/:share_id", revokeShare(d))

	// public endpoints (token in path; no identity)
	pub := e.Group("/cloud/s")
	pub.GET("/:token", shareInfo(d))
	pub.POST("/:token/access", shareAccess(d))

	// ops endpoint: per-uid ledger vs MinIO drift report (loopback-only port;
	// unauthenticated by design, see §2.14 deployment notes)
	e.GET("/internal/cloud/reconcile", reconcileHandler(d))
}

// reconcileHandler — GET /internal/cloud/reconcile?uid=
func reconcileHandler(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uidStr := c.Query("uid")
		if uidStr == "" {
			apiErr(c, http.StatusUnprocessableEntity, "缺少 uid 参数")
			return
		}
		uid, err := strconv.ParseInt(uidStr, 10, 64)
		if err != nil || uid <= 0 {
			apiErr(c, http.StatusUnprocessableEntity, "uid 不合法")
			return
		}
		rep, err := d.Reconciler.ReconcileUser(c.Request.Context(), uid)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "对账失败: "+err.Error())
			return
		}
		c.JSON(http.StatusOK, rep)
	}
}

// createShare — POST /cloud/video/{uuid}/share
// body: {code?: string, expiresInDays?: int, maxDownloads?: int|null}
func createShare(d Deps) gin.HandlerFunc {
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
		var body struct {
			Code          string `json:"code"`
			ExpiresInDays int    `json:"expiresInDays"`
			MaxDownloads  *int   `json:"maxDownloads"`
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			// empty body is fine — defaults apply
			body = struct {
				Code          string `json:"code"`
				ExpiresInDays int    `json:"expiresInDays"`
				MaxDownloads  *int   `json:"maxDownloads"`
			}{}
		}
		share, err := d.Share.CreateShare(uid, f.ID, body.Code, body.ExpiresInDays, body.MaxDownloads)
		if err != nil {
			if errors.Is(err, service.ErrNotFound) {
				apiErr(c, http.StatusNotFound, "File not found")
				return
			}
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		c.JSON(http.StatusCreated, shareView(share, true))
	}
}

// listShares — GET /cloud/video/{uuid}/shares
func listShares(d Deps) gin.HandlerFunc {
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
		rows, err := d.Share.ListShares(uid, f.ID)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		out := make([]gin.H, 0, len(rows))
		for i := range rows {
			out = append(out, shareView(&rows[i], false))
		}
		c.JSON(http.StatusOK, gin.H{"shares": out, "total": len(out)})
	}
}

// revokeShare — DELETE /cloud/shares/{id}
func revokeShare(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		id, err := strconv.ParseInt(c.Param("share_id"), 10, 64)
		if err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "share_id 不合法")
			return
		}
		if err := d.Share.Revoke(uid, id); err != nil {
			apiErr(c, http.StatusNotFound, "分享不存在")
			return
		}
		c.JSON(http.StatusOK, gin.H{"revoked": true})
	}
}

// shareInfo — GET /cloud/s/{token} (PUBLIC): metadata + whether a code is
// required. Invalid shares read as 404 (no state enumeration).
func shareInfo(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		sf, err := d.Share.ResolveShare(c.Param("token"), true)
		if err != nil {
			apiErr(c, http.StatusNotFound, "分享不存在或已失效")
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"fileName":     sf.File.OriginalName,
			"fileSize":     sf.File.FileSize,
			"mimeType":     sf.File.MimeType,
			"requiresCode": sf.Share.ExtractionCode != nil,
			"createdAt":    sf.Share.CreatedAt,
			"expiresAt":    sf.Share.ExpiresAt,
		})
	}
}

// shareAccess — POST /cloud/s/{token} (PUBLIC)
// body: {code?: string, download?: bool} → presigned URL (15 min) + counters.
func shareAccess(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var body struct {
			Code     string `json:"code"`
			Download bool   `json:"download"`
		}
		_ = c.ShouldBindJSON(&body)
		sf, err := d.Share.ResolveShare(c.Param("token"), false)
		if err != nil {
			apiErr(c, http.StatusNotFound, "分享不存在或已失效")
			return
		}
		if cerr := d.Share.CheckCode(sf.Share, body.Code); cerr != nil {
			if errors.Is(cerr, service.ErrShareCodeRequired) {
				apiErr(c, http.StatusUnauthorized, cerr.Error())
				return
			}
			apiErr(c, http.StatusForbidden, cerr.Error())
			return
		}
		if body.Download && sf.Share.MaxDownloads != nil && sf.Share.DownloadCount >= *sf.Share.MaxDownloads {
			apiErr(c, http.StatusNotFound, "分享不存在或已失效")
			return
		}
		res, err := d.Share.BuildAccess(c.Request.Context(), sf, body.Download)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		c.JSON(http.StatusOK, res)
	}
}

// shareView renders the owner-facing share shape (code never returned).
func shareView(s *model.CloudShare, withToken bool) gin.H {
	out := gin.H{
		"id":             s.ID,
		"file_id":        s.FileID,
		"has_code":       s.ExtractionCode != nil,
		"expires_at":     s.ExpiresAt,
		"max_downloads":  s.MaxDownloads,
		"view_count":     s.ViewCount,
		"download_count": s.DownloadCount,
		"is_revoked":     s.IsRevoked,
		"created_at":     s.CreatedAt,
	}
	if withToken {
		out["share_token"] = s.ShareToken
		out["share_url"] = "/cloud/s/" + s.ShareToken
	}
	return out
}
