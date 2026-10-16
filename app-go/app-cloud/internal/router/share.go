package router

import (
	"errors"
	"net/http"
	"strconv"
	"time"

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
	cloudGroup.PATCH("/shares/:share_id/code", setShareCode(d))
	cloudGroup.DELETE("/shares/:share_id", revokeShare(d))

	// public endpoints (token in path; no identity)
	pub := e.Group("/cloud/s")
	pub.GET("/:token", shareInfo(d))
	pub.POST("/:token/attest", shareAttest(d))
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
		// 响应里的提取码从存储值解密取回（与属主列表同语义）
		code := ""
		if body.Code != "" {
			code = d.Share.ViewCode(share)
		}
		c.JSON(http.StatusCreated, shareView(share, true, code))
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
			// withToken=true：属主列表必须带 share_token/share_url，否则前端
			// 重开弹窗只看得到统计数字，无法查看/复制之前生成的链接。
			// extraction_code：属主可见的明文提取码（legacy 哈希行不可逆，为空）。
			out = append(out, shareView(&rows[i], true, d.Share.ViewCode(&rows[i])))
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
			// 浏览器设备证明挑战（签名 + token 绑定 + 10 分钟时效）
			"challenge": d.Attestor.Issue(c.Param("token"), time.Now()),
		})
	}
}

// shareAttest — POST /cloud/s/{token}/attest (PUBLIC): 浏览器设备证明。
// 页面 JS 用挑战计算临时指纹（挑战绑定，非跨站追踪标识）换取短时效票据，
// 后续 /access 必须携带 X-Fp + X-Ticket。裸脚本（curl/wget）没有浏览器
// 环境，无法自然通过此流程。
func shareAttest(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		var body struct {
			Challenge   string `json:"challenge"`
			Fingerprint string `json:"fingerprint"`
		}
		if err := c.ShouldBindJSON(&body); err != nil || !service.ValidFingerprint(body.Fingerprint) {
			apiErr(c, http.StatusUnprocessableEntity, "参数不合法")
			return
		}
		if !d.Attestor.VerifyChallenge(c.Param("token"), body.Challenge, time.Now()) {
			apiErr(c, http.StatusPreconditionFailed, "设备证明已过期，请刷新页面重试")
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"ticket":    d.Attestor.IssueTicket(c.Param("token"), body.Fingerprint, time.Now()),
			"expiresIn": service.TicketTTLSecs,
		})
	}
}

// shareAccess — POST /cloud/s/{token} (PUBLIC)
// body: {code?: string, download?: bool} → presigned URL (15 min) + counters.
// 设备证明闸门：需要 attest 签发的 (token, 指纹) 绑定票据。
func shareAccess(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		fp := c.GetHeader("X-Fp")
		ticket := c.GetHeader("X-Ticket")
		if !service.ValidFingerprint(fp) || !d.Attestor.VerifyTicket(c.Param("token"), fp, ticket, time.Now()) {
			apiErr(c, http.StatusPreconditionFailed, "请通过浏览器打开分享页后访问")
			return
		}
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
			if errors.Is(err, service.ErrShareDownloadCap) {
				// The cap was exhausted between resolve and access — uniform
				// 404 keeps the no-state-enumeration stance.
				apiErr(c, http.StatusNotFound, "分享不存在或已失效")
				return
			}
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		c.JSON(http.StatusOK, res)
	}
}

// shareView renders the owner-facing share shape. code（可能为空：legacy
// 哈希行不可逆）是属主可见的明文提取码 —— 公开端点不经过此函数。
func shareView(s *model.CloudShare, withToken bool, code string) gin.H {
	out := gin.H{
		"id":              s.ID,
		"file_id":         s.FileID,
		"has_code":        s.ExtractionCode != nil,
		"extraction_code": code,
		"expires_at":      s.ExpiresAt,
		"max_downloads":   s.MaxDownloads,
		"view_count":      s.ViewCount,
		"download_count":  s.DownloadCount,
		"is_revoked":      s.IsRevoked,
		"created_at":      s.CreatedAt,
	}
	if withToken {
		out["share_token"] = s.ShareToken
		out["share_url"] = "/cloud/s/" + s.ShareToken
	}
	return out
}

// setShareCode — PATCH /cloud/shares/{share_id}/code (owner)：重设/新增
// 提取码。链接与 token 不变，仅换码 —— 解决"忘记提取码"而无需重建分享。
func setShareCode(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		id, err := strconv.ParseInt(c.Param("share_id"), 10, 64)
		if err != nil || id <= 0 {
			apiErr(c, http.StatusUnprocessableEntity, "share_id 不合法")
			return
		}
		var body struct {
			Code string `json:"code" binding:"required"`
		}
		if err := c.ShouldBindJSON(&body); err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "参数不合法")
			return
		}
		if err := d.Share.SetCode(uid, id, body.Code); err != nil {
			apiErr(c, http.StatusBadRequest, err.Error())
			return
		}
		c.JSON(http.StatusOK, gin.H{"updated": true})
	}
}
