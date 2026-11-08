// Internal daily-quota endpoints (app-ts AI flows call these around row
// creation). The counters live in the shared Redis under the Python backend's
// quiz_quota keys; Redis unavailable → fail-open (200).
package router

import (
	quizdto "app-content/internal/dto/quiz"
	"net/http"
	"strings"

	"app-content/internal/service/quiz"

	"github.com/gin-gonic/gin"
)

type quotaReq = quizdto.QuotaRequest

func validQuotaKind(kind string) bool {
	return kind == "generate" || kind == "grade"
}

func quotaPeekHandler(svc *service.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		var req quotaReq
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusBadRequest, "请求体格式错误")
			return
		}
		if int64(req.UID) != 0 && int64(req.UID) != uid {
			apiErr(c, http.StatusForbidden, "uid 与身份不一致")
			return
		}
		kind := strings.TrimSpace(req.Kind)
		if !validQuotaKind(kind) {
			apiErr(c, http.StatusBadRequest, "kind 须为 generate 或 grade")
			return
		}
		if apiError := svc.QuotaPeek(c.Request.Context(), uid, kind); apiError != nil {
			apiErr(c, apiError.Status, apiError.Detail)
			return
		}
		c.JSON(http.StatusOK, quizdto.QuotaStatus{OK: true, Kind: kind})
	}
}

func quotaConsumeHandler(svc *service.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		uid, ok := currentUID(c)
		if !ok {
			return
		}
		var req quotaReq
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusBadRequest, "请求体格式错误")
			return
		}
		if int64(req.UID) != 0 && int64(req.UID) != uid {
			apiErr(c, http.StatusForbidden, "uid 与身份不一致")
			return
		}
		kind := strings.TrimSpace(req.Kind)
		if !validQuotaKind(kind) {
			apiErr(c, http.StatusBadRequest, "kind 须为 generate 或 grade")
			return
		}
		if apiError := svc.QuotaConsume(c.Request.Context(), uid, kind); apiError != nil {
			apiErr(c, apiError.Status, apiError.Detail)
			return
		}
		c.JSON(http.StatusOK, quizdto.QuotaStatus{OK: true, Kind: kind})
	}
}
