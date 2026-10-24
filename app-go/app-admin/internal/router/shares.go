// Share-moderation endpoints: list / detail (viewer+) and ban / unban /
// approve (admin only, reason gate enforced here). Moderation semantics live
// in the service; the router only parses, gates and answers {"detail": ...}.
package router

import (
	"errors"
	"net/http"
	"strconv"

	"app-admin/internal/cloud"
	"app-admin/internal/service"

	"github.com/gin-gonic/gin"
)

func (r *Router) apiListShares(c *gin.Context) {
	page, pageSize, ok := r.parsePage(c)
	if !ok {
		detail(c, http.StatusBadRequest, "page must be >= 1 and pageSize within 1..100")
		return
	}
	params := service.ListSharesParams{Page: page, PageSize: pageSize, Q: c.Query("q")}
	if v := c.Query("status"); v != "" {
		params.Status = v
	}
	if v := c.Query("uid"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			detail(c, http.StatusBadRequest, "uid must be an integer")
			return
		}
		params.UID = n
		params.UIDSet = true
	}
	if v := c.Query("revoked"); v != "" && v != "0" && v != "1" {
		detail(c, http.StatusBadRequest, "revoked must be 0 or 1")
		return
	} else if v != "" {
		b := v == "1"
		params.Revoked = &b
	}
	// available=1 (default UI review queue) excludes shares whose target
	// file/folder was deleted; 0 lists those legacy rows for audit only.
	if v := c.Query("available"); v != "" && v != "0" && v != "1" {
		detail(c, http.StatusBadRequest, "available must be 0 or 1")
		return
	} else if v != "" {
		b := v == "1"
		params.Available = &b
	}
	result, err := r.shares.List(params)
	if err != nil {
		badRequest(c, err)
		return
	}
	c.JSON(http.StatusOK, result)
}

func (r *Router) apiShareDetail(c *gin.Context) {
	id, ok := r.parsePathID(c)
	if !ok {
		return // 400 already written
	}
	result, err := r.shares.Detail(id)
	if errors.Is(err, service.ErrShareNotFound) {
		detail(c, http.StatusNotFound, "share not found")
		return
	}
	if err != nil {
		badRequest(c, err)
		return
	}
	c.JSON(http.StatusOK, result)
}

// apiPreviewShareFile — GET /api/shares/:id/files/:file_id/preview (admin
// only, via the moderation group). Returns the short-lived INLINE preview
// grant (media/pdf) or extracted document text minted by app-cloud; never a
// download URL. Every granted preview is audited in the service layer.
func (r *Router) apiPreviewShareFile(c *gin.Context) {
	shareID, ok := r.parsePathID(c)
	if !ok {
		return // 400 already written
	}
	fileID, err := strconv.ParseInt(c.Param("file_id"), 10, 64)
	if err != nil || fileID <= 0 {
		detail(c, http.StatusBadRequest, "file_id must be a positive integer")
		return
	}
	admin, _ := identityOf(c)
	grant, err := r.shares.Preview(admin.Username, shareID, fileID)
	switch {
	case errors.Is(err, service.ErrShareNotFound):
		detail(c, http.StatusNotFound, "share not found")
	case errors.Is(err, service.ErrReviewTargetNotFound):
		detail(c, http.StatusNotFound, "file is not part of this share")
	case errors.Is(err, cloud.ErrDisclosureRequired): // legacy app-cloud (now allows reviewer previews)
		detail(c, http.StatusConflict, "该分享未确认内容审核告知，无法预览")
	case err != nil:
		var upstream *cloud.UpstreamError
		if errors.As(err, &upstream) {
			detail(c, upstream.Status, upstream.Detail)
			return
		}
		serverError(c, err, "preview")
	default:
		c.JSON(http.StatusOK, grant)
	}
}

// moderationRequest carries the optional / required reason.
type moderationRequest struct {
	Reason string `json:"reason"`
}

func (r *Router) apiBan(c *gin.Context) {
	id, ok := r.parsePathID(c)
	if !ok {
		return
	}
	var req moderationRequest
	_ = c.ShouldBindJSON(&req)
	admin, _ := identityOf(c)
	if err := r.shares.Ban(admin.Username, id, req.Reason); err != nil {
		r.moderateFailed(c, err)
		return
	}
	r.moderateOK(c)
}

func (r *Router) apiUnban(c *gin.Context) {
	id, ok := r.parsePathID(c)
	if !ok {
		return
	}
	var req moderationRequest
	_ = c.ShouldBindJSON(&req)
	admin, _ := identityOf(c)
	if err := r.shares.Unban(admin.Username, id, req.Reason); err != nil {
		r.moderateFailed(c, err)
		return
	}
	r.moderateOK(c)
}

func (r *Router) apiApprove(c *gin.Context) {
	id, ok := r.parsePathID(c)
	if !ok {
		return
	}
	var req moderationRequest
	_ = c.ShouldBindJSON(&req)
	admin, _ := identityOf(c)
	if err := r.shares.Approve(admin.Username, id, req.Reason); err != nil {
		r.moderateFailed(c, err)
		return
	}
	r.moderateOK(c)
}

func (r *Router) moderateOK(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (r *Router) moderateFailed(c *gin.Context, err error) {
	if errors.Is(err, service.ErrShareNotFound) {
		detail(c, http.StatusNotFound, "share not found")
		return
	}
	badRequest(c, err)
}

// parsePathID parses the :id path parameter into an int64.
func (r *Router) parsePathID(c *gin.Context) (int64, bool) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		detail(c, http.StatusBadRequest, "share id must be an integer")
		return 0, false
	}
	return id, true
}
