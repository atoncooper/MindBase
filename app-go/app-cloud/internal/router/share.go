package router

import (
	"crypto/subtle"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"app-cloud/internal/model"
	"app-cloud/internal/service"

	"github.com/gin-gonic/gin"
)

// registerShareRoutes mounts the owner share endpoints (inside the /cloud
// group) and the PUBLIC /cloud/s/* endpoints (no auth — reached via the
// dedicated nginx location without auth_request).
func registerShareRoutes(e *gin.Engine, d Deps, cloudGroup *gin.RouterGroup) {
	// owner endpoints — file + folder (1.0.16)
	cloudGroup.POST("/video/:upload_uuid/share", createShare(d))
	cloudGroup.GET("/video/:upload_uuid/shares", listShares(d))
	cloudGroup.POST("/folders/:folder_id/share", createFolderShare(d))
	cloudGroup.GET("/folders/:folder_id/shares", listFolderShares(d))
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
	// app-admin-only preview grant; the separate shared token and share/file
	// scope checks keep the admin review plane away from arbitrary cloud files.
	e.GET("/internal/cloud/admin-review/shares/:share_id/files/:file_id/preview", adminReviewPreview(d))
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

// shareCreateBody — file / folder share creation payload (1.0.16): the
// compliance ack is mandatory — legalAck:false/missing → 422.
type shareCreateBody struct {
	Code             string `json:"code"`
	ExpiresInDays    int    `json:"expiresInDays"`
	MaxDownloads     *int   `json:"maxDownloads"`
	LegalAck         bool   `json:"legalAck"`
	ContentReviewAck bool   `json:"contentReviewAck"`
}

// createShare — POST /cloud/video/{uuid}/share
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
		var body shareCreateBody
		if err := c.ShouldBindJSON(&body); err != nil {
			// empty body is fine — defaults apply (but legalAck stays false → 422)
			body = shareCreateBody{}
		}
		share, err := d.Share.CreateShare(uid, f.ID, body.Code, body.ExpiresInDays, body.MaxDownloads, body.LegalAck, body.ContentReviewAck)
		if err != nil {
			if errors.Is(err, service.ErrLegalAckRequired) || errors.Is(err, service.ErrContentReviewAckRequired) {
				apiErr(c, http.StatusUnprocessableEntity, err.Error())
				return
			}
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

// createFolderShare — POST /cloud/folders/{folder_id}/share (1.0.16):
// same body/semantics as the file share, target = the caller's folder.
func createFolderShare(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		folderID, ok := parseShareFolderID(c)
		if !ok {
			return
		}
		var body shareCreateBody
		if err := c.ShouldBindJSON(&body); err != nil {
			body = shareCreateBody{}
		}
		share, err := d.Share.CreateFolderShare(uid, folderID, body.Code, body.ExpiresInDays, body.MaxDownloads, body.LegalAck, body.ContentReviewAck)
		if err != nil {
			if errors.Is(err, service.ErrLegalAckRequired) || errors.Is(err, service.ErrContentReviewAckRequired) {
				apiErr(c, http.StatusUnprocessableEntity, err.Error())
				return
			}
			if errors.Is(err, service.ErrNotFound) {
				apiErr(c, http.StatusNotFound, "文件夹不存在")
				return
			}
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		code := ""
		if body.Code != "" {
			code = d.Share.ViewCode(share)
		}
		c.JSON(http.StatusCreated, shareView(share, true, code))
	}
}

// listFolderShares — GET /cloud/folders/{folder_id}/shares (1.0.16).
func listFolderShares(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		folderID, ok := parseShareFolderID(c)
		if !ok {
			return
		}
		if folder, err := d.Folders.GetByID(d.DB, folderID, uid); err != nil {
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		} else if folder == nil {
			apiErr(c, http.StatusNotFound, "文件夹不存在")
			return
		}
		rows, err := d.Share.ListFolderShares(uid, folderID)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		out := make([]gin.H, 0, len(rows))
		for i := range rows {
			out = append(out, shareView(&rows[i], true, d.Share.ViewCode(&rows[i])))
		}
		c.JSON(http.StatusOK, gin.H{"shares": out, "total": len(out)})
	}
}

// parseShareFolderID — path param for the folder share endpoints.
func parseShareFolderID(c *gin.Context) (int64, bool) {
	id, err := strconv.ParseInt(c.Param("folder_id"), 10, 64)
	if err != nil || id <= 0 {
		apiErr(c, http.StatusUnprocessableEntity, "folder_id 不合法")
		return 0, false
	}
	return id, true
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
// required. Invalid shares read as 404 (no state enumeration). 1.0.16: the
// shape gains targetType; folder shares add folderName + files[] (all live
// members of the subtree, path-labeled, capped at SharedFilesLimit with
// truncated: true).
func shareInfo(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		sf, err := d.Share.ResolveShare(c.Param("token"), true)
		if err != nil {
			apiErr(c, http.StatusNotFound, "分享不存在或已失效")
			return
		}
		out := gin.H{
			"targetType":   shareTargetType(sf.Share),
			"requiresCode": sf.Share.ExtractionCode != nil,
			"createdAt":    sf.Share.CreatedAt,
			"expiresAt":    sf.Share.ExpiresAt,
			// 浏览器设备证明挑战（签名 + token 绑定 + 10 分钟时效）
			"challenge": d.Attestor.Issue(c.Param("token"), time.Now()),
		}
		if sf.Folder != nil {
			out["folderName"] = sf.Folder.Name
			entries, truncated, ferr := d.Share.SharedFolderFiles(sf.Share, service.SharedFilesLimit)
			if ferr != nil {
				apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
				return
			}
			files := make([]gin.H, 0, len(entries))
			for i := range entries {
				files = append(files, gin.H{
					"fileId":   entries[i].File.ID,
					"name":     entries[i].File.OriginalName,
					"size":     entries[i].File.FileSize,
					"mimeType": entries[i].File.MimeType,
					"path":     entries[i].Path,
				})
			}
			out["files"] = files
			out["truncated"] = truncated
		} else if sf.File != nil {
			out["fileName"] = sf.File.OriginalName
			out["fileSize"] = sf.File.FileSize
			out["mimeType"] = sf.File.MimeType
		}
		c.JSON(http.StatusOK, out)
	}
}

// shareTargetType — legacy rows (empty target_type) read as "file".
func shareTargetType(sh *model.CloudShare) string {
	if sh.IsFolderShare() {
		return "folder"
	}
	return "file"
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
			FileID   *int64 `json:"fileId"` // folder shares: pick one member
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
		var target *model.CloudFile
		if sf.Folder != nil {
			// Folder share: the caller picks a member. A missing/out-of-tree
			// fileId reads uniformly as 404 — no tree enumeration.
			if body.FileID == nil {
				apiErr(c, http.StatusNotFound, "分享不存在或已失效")
				return
			}
			target, err = d.Share.FolderShareFile(sf.Share, *body.FileID)
			if err != nil {
				if errors.Is(err, service.ErrShareNotFound) {
					apiErr(c, http.StatusNotFound, "分享不存在或已失效")
					return
				}
				apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
				return
			}
		} else {
			target = sf.File // file share ignores fileId
		}
		res, err := d.Share.BuildAccessFor(c.Request.Context(), sf, target, body.Download)
		if err != nil {
			if errors.Is(err, service.ErrShareDownloadCap) || errors.Is(err, service.ErrShareNotFound) {
				// The cap was exhausted between resolve and access, or the
				// picked member vanished — uniform 404 keeps the
				// no-state-enumeration stance.
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
// 1.0.16 增补：target_type/folder_id/legal_ack + moderation 三元组（属主
// 可见审核态；公开端点不暴露）。
func shareView(s *model.CloudShare, withToken bool, code string) gin.H {
	out := gin.H{
		"id":                            s.ID,
		"file_id":                       s.FileID,
		"has_code":                      s.ExtractionCode != nil,
		"extraction_code":               code,
		"expires_at":                    s.ExpiresAt,
		"max_downloads":                 s.MaxDownloads,
		"view_count":                    s.ViewCount,
		"download_count":                s.DownloadCount,
		"is_revoked":                    s.IsRevoked,
		"created_at":                    s.CreatedAt,
		"target_type":                   shareTargetType(s),
		"folder_id":                     s.FolderID,
		"legal_ack":                     s.LegalAck,
		"content_review_ack":            s.ContentReviewAck,
		"content_review_policy_version": s.ContentReviewPolicyVersion,
		"content_review_ack_at":         s.ContentReviewAckAt,
		"moderation_status":             s.ModerationStatus,
		"moderation_reason":             s.ModerationReason,
		"moderation_time":               s.ModerationTime,
		"moderation_by":                 s.ModerationBy,
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

// adminReviewPreview — GET /internal/cloud/admin-review/shares/{share_id}/
// files/{file_id}/preview (app-admin-only). Bearer token = shared secret
// (APPCLOUD__ADMIN_REVIEW__TOKEN); empty config = fail closed (503).
//
// The reviewer may inspect ANY recorded share — banned / revoked / expired /
// pre-disclosure legacy shares included — because moderation often happens
// after the owner removed the share. Only the share's own target scope is
// enforced (file-share target or live member of the shared folder tree), and
// every grant is audited by app-admin before it is minted. Response = the same
// short-lived inline preview grant as public sharing — no download URL, the
// public download counter is untouched.
func adminReviewPreview(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		token := strings.TrimSpace(strings.TrimPrefix(c.GetHeader("Authorization"), "Bearer "))
		if strings.TrimSpace(d.Cfg.AdminReview.Token) == "" {
			apiErr(c, http.StatusServiceUnavailable, "content review preview disabled")
			return
		}
		if subtle.ConstantTimeCompare([]byte(token), []byte(d.Cfg.AdminReview.Token)) != 1 {
			apiErr(c, http.StatusUnauthorized, "invalid review token")
			return
		}
		shareID, err := strconv.ParseInt(c.Param("share_id"), 10, 64)
		if err != nil || shareID <= 0 {
			apiErr(c, http.StatusUnprocessableEntity, "share_id 不合法")
			return
		}
		fileID, err := strconv.ParseInt(c.Param("file_id"), 10, 64)
		if err != nil || fileID <= 0 {
			apiErr(c, http.StatusUnprocessableEntity, "file_id 不合法")
			return
		}
		share, file, err := d.Share.AdminReviewFile(shareID, fileID)
		if err != nil {
			adminReviewError(c, err)
			return
		}
		res, err := d.Share.BuildAdminReviewAccess(c.Request.Context(), share, file)
		if err != nil {
			adminReviewError(c, err)
			return
		}
		c.JSON(http.StatusOK, res)
	}
}

// adminReviewError maps share-review failures to precise console messages so
// the operator sees WHY a file cannot be reviewed (revoked/expired vs missing
// disclosure vs unsupported type) instead of a generic 500.
func adminReviewError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, service.ErrShareNotFound):
		apiErr(c, http.StatusNotFound, "分享或文件不存在")
	case errors.Is(err, service.ErrPreviewUnsupported),
		errors.Is(err, service.ErrPreviewNoText),
		errors.Is(err, service.ErrPreviewFailed):
		apiErr(c, http.StatusUnprocessableEntity, err.Error())
	case errors.Is(err, service.ErrPreviewTooLarge):
		apiErr(c, http.StatusRequestEntityTooLarge, err.Error())
	default:
		apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
	}
}
