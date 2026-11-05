package router

import (
	"crypto/subtle"
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
	// unauthenticated by design).
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
		c.JSON(http.StatusOK, dto.ReconcileResponse{
			UID:            rep.UID,
			DBActiveBytes:  rep.DBActiveBytes,
			DBActiveCount:  rep.DBActiveCount,
			DBTrashBytes:   rep.DBTrashBytes,
			MinioBytes:     rep.MinioBytes,
			MinioCount:     rep.MinioCount,
			OrphanObjects:  rep.OrphanObjects,
			OrphanSample:   rep.OrphanSample,
			MissingObjects: rep.MissingObjects,
			DriftBytes:     rep.DriftBytes,
		})
	}
}

// createShare — POST /cloud/video/{uuid}/share
func createShare(d Deps) gin.HandlerFunc {
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
		var body dto.ShareCreateRequest
		if err := c.ShouldBindJSON(&body); err != nil {
			// empty body is fine — defaults apply (but legalAck stays false → 422)
			body = dto.ShareCreateRequest{}
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
		uid := middleware.UIDFrom(c)
		folderID, ok := parseShareFolderID(c)
		if !ok {
			return
		}
		var body dto.ShareCreateRequest
		if err := c.ShouldBindJSON(&body); err != nil {
			body = dto.ShareCreateRequest{}
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
		uid := middleware.UIDFrom(c)
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
		c.JSON(http.StatusOK, shareListResponse(rows, d))
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
		rows, err := d.Share.ListShares(uid, f.ID)
		if err != nil {
			apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
			return
		}
		c.JSON(http.StatusOK, shareListResponse(rows, d))
	}
}

// shareListResponse maps owner share rows onto the wire shape. withToken is
// always true here: the owner list must show share_token/share_url or the
// dialog cannot reopen an existing link.
func shareListResponse(rows []model.CloudShare, d Deps) dto.ShareListResponse {
	out := make([]dto.ShareView, 0, len(rows))
	for i := range rows {
		out = append(out, shareView(&rows[i], true, d.Share.ViewCode(&rows[i])))
	}
	return dto.ShareListResponse{Shares: out, Total: len(out)}
}

// revokeShare — DELETE /cloud/shares/{id}
func revokeShare(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		id, err := strconv.ParseInt(c.Param("share_id"), 10, 64)
		if err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "share_id 不合法")
			return
		}
		if err := d.Share.Revoke(uid, id); err != nil {
			apiErr(c, http.StatusNotFound, "分享不存在")
			return
		}
		c.JSON(http.StatusOK, dto.ShareRevokeResponse{Revoked: true})
	}
}

// shareInfo — GET /cloud/s/{token} (PUBLIC): metadata + whether a code is
// required. Invalid shares read as 404 (no state enumeration). Folder shares
// add folderName + files[] (all live members of the subtree, path-labeled,
// capped at SharedFilesLimit with truncated: true).
func shareInfo(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		sf, err := d.Share.ResolveShare(c.Param("token"), true)
		if err != nil {
			apiErr(c, http.StatusNotFound, "分享不存在或已失效")
			return
		}
		challenge := d.Attestor.Issue(c.Param("token"), time.Now())
		out := dto.ShareInfoResponse{
			TargetType:   shareTargetType(sf.Share),
			RequiresCode: sf.Share.ExtractionCode != nil,
			CreatedAt:    sf.Share.CreatedAt,
			ExpiresAt:    sf.Share.ExpiresAt,
			// 浏览器设备证明挑战（签名 + token 绑定 + 10 分钟时效）
			Challenge: challenge,
		}
		if sf.Folder != nil {
			folderName := sf.Folder.Name
			out.FolderName = &folderName
			entries, truncated, ferr := d.Share.SharedFolderFiles(sf.Share, service.SharedFilesLimit)
			if ferr != nil {
				apiErr(c, http.StatusInternalServerError, "服务异常，请稍后重试")
				return
			}
			files := make([]dto.SharePublicFile, 0, len(entries))
			for i := range entries {
				files = append(files, dto.SharePublicFile{
					FileID:   entries[i].File.ID,
					Name:     entries[i].File.OriginalName,
					Size:     entries[i].File.FileSize,
					MimeType: entries[i].File.MimeType,
					Path:     entries[i].Path,
				})
			}
			out.Files = &files
			out.Truncated = &truncated
		} else if sf.File != nil {
			name := sf.File.OriginalName
			size := sf.File.FileSize
			mime := sf.File.MimeType
			out.FileName = &name
			out.FileSize = &size
			out.MimeType = &mime
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
		var body dto.ShareAttestRequest
		if err := c.ShouldBindJSON(&body); err != nil || !service.ValidFingerprint(body.Fingerprint) {
			apiErr(c, http.StatusUnprocessableEntity, "参数不合法")
			return
		}
		if !d.Attestor.VerifyChallenge(c.Param("token"), body.Challenge, time.Now()) {
			apiErr(c, http.StatusPreconditionFailed, "设备证明已过期，请刷新页面重试")
			return
		}
		c.JSON(http.StatusOK, dto.ShareAttestResponse{
			Ticket:    d.Attestor.IssueTicket(c.Param("token"), body.Fingerprint, time.Now()),
			ExpiresIn: service.TicketTTLSecs,
		})
	}
}

// shareAccess — POST /cloud/s/{token} (PUBLIC)
// body: {code?: string, download?: bool, fileId?: number} → presigned URL
// (15 min) + counters. 设备证明闸门：需要 attest 签发的 (token, 指纹) 绑定票据。
func shareAccess(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		fp := c.GetHeader("X-Fp")
		ticket := c.GetHeader("X-Ticket")
		if !service.ValidFingerprint(fp) || !d.Attestor.VerifyTicket(c.Param("token"), fp, ticket, time.Now()) {
			apiErr(c, http.StatusPreconditionFailed, "请通过浏览器打开分享页后访问")
			return
		}
		var body dto.ShareAccessRequest
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
		grant, err := d.Share.BuildAccessFor(c.Request.Context(), sf, target, body.Download)
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
		c.JSON(http.StatusOK, shareAccessResponse(grant))
	}
}

// shareAccessResponse maps a presigned access grant onto the wire shape.
func shareAccessResponse(grant *service.AccessGrant) dto.ShareAccessResponse {
	return dto.ShareAccessResponse{
		URL:       grant.URL,
		ViewMode:  grant.ViewMode,
		MimeType:  grant.MimeType,
		FileName:  grant.FileName,
		FileSize:  grant.FileSize,
		ExpiresIn: grant.ExpiresIn,
	}
}

// shareView renders the owner-facing share shape. code（可能为空：legacy
// 哈希行不可逆）是属主可见的明文提取码 —— 公开端点不经过此函数。
// 1.0.16 增补：target_type/folder_id/legal_ack + moderation 三元组（属主
// 可见审核态；公开端点不暴露）。
func shareView(s *model.CloudShare, withToken bool, code string) dto.ShareView {
	out := dto.ShareView{
		ID:                         s.ID,
		FileID:                     s.FileID,
		HasCode:                    s.ExtractionCode != nil,
		ExtractionCode:             code,
		ExpiresAt:                  s.ExpiresAt,
		MaxDownloads:               s.MaxDownloads,
		ViewCount:                  s.ViewCount,
		DownloadCount:              s.DownloadCount,
		IsRevoked:                  s.IsRevoked,
		CreatedAt:                  s.CreatedAt,
		TargetType:                 shareTargetType(s),
		FolderID:                   s.FolderID,
		LegalAck:                   s.LegalAck,
		ContentReviewAck:           s.ContentReviewAck,
		ContentReviewPolicyVersion: s.ContentReviewPolicyVersion,
		ContentReviewAckAt:         s.ContentReviewAckAt,
		ModerationStatus:           s.ModerationStatus,
		ModerationReason:           s.ModerationReason,
		ModerationTime:             s.ModerationTime,
		ModerationBy:               s.ModerationBy,
	}
	if withToken {
		token := s.ShareToken
		url := "/cloud/s/" + s.ShareToken
		out.ShareToken = &token
		out.ShareURL = &url
	}
	return out
}

// setShareCode — PATCH /cloud/shares/{share_id}/code (owner)：重设/新增
// 提取码。链接与 token 不变，仅换码 —— 解决"忘记提取码"而无需重建分享。
func setShareCode(d Deps) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid := middleware.UIDFrom(c)
		id, err := strconv.ParseInt(c.Param("share_id"), 10, 64)
		if err != nil || id <= 0 {
			apiErr(c, http.StatusUnprocessableEntity, "share_id 不合法")
			return
		}
		var body dto.ShareSetCodeRequest
		if err := c.ShouldBindJSON(&body); err != nil {
			apiErr(c, http.StatusUnprocessableEntity, "参数不合法")
			return
		}
		if err := d.Share.SetCode(uid, id, body.Code); err != nil {
			apiErr(c, http.StatusBadRequest, err.Error())
			return
		}
		c.JSON(http.StatusOK, dto.ShareCodeResponse{Updated: true})
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
// every grant is audited by app-admin before it is minted.
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
		out := dto.AdminReviewAccessResponse{
			ViewMode:  res.Grant.ViewMode,
			MimeType:  res.Grant.MimeType,
			FileName:  res.Grant.FileName,
			FileSize:  res.Grant.FileSize,
			ExpiresIn: res.Grant.ExpiresIn,
		}
		if res.Text != "" {
			out.Text = res.Text
			truncated := res.Truncated
			out.Truncated = &truncated
		} else {
			out.URL = res.Grant.URL
		}
		c.JSON(http.StatusOK, out)
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
