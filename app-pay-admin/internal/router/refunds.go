// Package router: 退款复核工作台（承接 app-pay 的 maker-checker）。
//
// 列表 = 直连 pay_refund_approval 表；approve/reject = 经 appops 客户端调
// app-pay 的 internal 端点 —— 资金写只发生在 app-pay（审计 JSONL / 状态机 /
// 审批表一致性），本控制台只携带登录身份作为 operator（checker），替代
// curl 自报身份。整组功能 admin only，且 PAYADMIN__APP_PAY__OPS_KEY 未配置
// 时整组隐藏（404），不可被探测。
package router

import (
	"log/slog"
	"net/http"
	"strings"

	"app-pay-admin/internal/repo"

	"github.com/gin-gonic/gin"
)

// refundReviewEnabled reports whether the workbench is wired (ops key present
// + master switch on).
func (r *Router) refundReviewEnabled() bool {
	return r.appops != nil && r.appops.Enabled() && r.cfg.AppPay.RefundReviewEnabled
}

// refundGate aborts with 404 when the workbench is not wired (stealth, same
// posture as app-pay's disabled test endpoints).
func (r *Router) refundGate() gin.HandlerFunc {
	return func(c *gin.Context) {
		if !r.refundReviewEnabled() {
			c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"detail": "refund review not configured"})
			return
		}
		c.Next()
	}
}

// ── API（scripts / master-token callers）────────────────────────────

// GET /api/refunds?status=PENDING（直读审批表）
func (r *Router) apiListRefunds(c *gin.Context) {
	status := strings.ToUpper(strings.TrimSpace(c.DefaultQuery("status", "PENDING")))
	if status == "ALL" {
		status = ""
	}
	limit, offset := pagination(c, 50, 200)
	rows, total, err := repo.ListRefundApprovals(repo.RefundApprovalFilter{
		Status: status, Limit: limit, Offset: offset,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "query failed: " + err.Error()})
		return
	}
	items := make([]gin.H, 0, len(rows))
	for i := range rows {
		items = append(items, gin.H{
			"order_no":     rows[i].OrderNo,
			"maker":        rows[i].Maker,
			"maker_reason": rows[i].MakerReason,
			"status":       rows[i].Status,
			"created_at":   timePtr(&rows[i].CreatedAt),
		})
	}
	c.JSON(http.StatusOK, gin.H{"total": total, "items": items})
}

// POST /api/refunds/:order_no/approve {"reason": "..."} — checker = 登录身份
func (r *Router) apiApproveRefund(c *gin.Context) {
	r.apiRefundAction(c, true)
}

// POST /api/refunds/:order_no/reject
func (r *Router) apiRejectRefund(c *gin.Context) {
	r.apiRefundAction(c, false)
}

func (r *Router) apiRefundAction(c *gin.Context, confirm bool) {
	orderNo := c.Param("order_no")
	var req struct {
		Reason string `json:"reason"`
	}
	_ = c.ShouldBindJSON(&req)
	operator := operatorOf(c)
	if err := r.appops.ConfirmRefundOrReject(c.Request.Context(), orderNo, operator, req.Reason, confirm); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"detail": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "order_no": orderNo, "confirmed": confirm, "checker": operator})
}

// ── SSR page + forms ────────────────────────────────────────────────

type refundRow struct {
	OrderNo     string
	Maker       string
	MakerReason string
	Status      string
	CreatedAt   string
}

func (r *Router) pageRefunds(c *gin.Context) {
	b := newBase(c, "refunds", "退款复核",
		"退款双人复核（maker-checker）：列表为审批单；确认/驳回经 app-pay 执行（checker != maker 由服务端强制）")

	status := strings.ToUpper(strings.TrimSpace(c.DefaultQuery("status", "PENDING")))
	if status == "ALL" {
		status = ""
	}
	rows, total, err := repo.ListRefundApprovals(repo.RefundApprovalFilter{Status: status, Limit: 50, Offset: 0})
	if err != nil {
		slog.Error("[PAGE] list refund approvals failed", "err", err)
		http.Error(c.Writer, "查询失败", http.StatusInternalServerError)
		return
	}
	items := make([]refundRow, 0, len(rows))
	for i := range rows {
		items = append(items, refundRow{
			OrderNo:     rows[i].OrderNo,
			Maker:       rows[i].Maker,
			MakerReason: rows[i].MakerReason,
			Status:      rows[i].Status,
			CreatedAt:   fmtTime(rows[i].CreatedAt),
		})
	}
	renderPage(c.Writer, "refunds", struct {
		BaseData
		Items    []refundRow
		Total    int64
		Status   string
		Statuses []string
	}{
		BaseData: b,
		Items:    items,
		Total:    total,
		Status:   status,
		Statuses: []string{"PENDING", "APPROVED", "REJECTED"},
	})
}

// handleRefundApproveForm — SSR 表单：approve（confirm=true）
func (r *Router) handleRefundApproveForm(c *gin.Context) {
	orderNo := c.PostForm("order_no")
	reason := strings.TrimSpace(c.PostForm("reason"))
	if reason == "" {
		reason = "复核通过"
	}
	operator := operatorOf(c)
	if err := r.appops.ConfirmRefundOrReject(c.Request.Context(), orderNo, operator, reason, true); err != nil {
		redirectFlash(c, "/refunds", "err", "复核失败：%v", err)
		return
	}
	redirectFlash(c, "/refunds", "ok", "已复核通过并执行退款：%s", orderNo)
}

// handleRefundRejectForm — SSR 表单：reject
func (r *Router) handleRefundRejectForm(c *gin.Context) {
	orderNo := c.PostForm("order_no")
	operator := operatorOf(c)
	if err := r.appops.RejectRefund(c.Request.Context(), orderNo, operator); err != nil {
		redirectFlash(c, "/refunds", "err", "驳回失败：%v", err)
		return
	}
	redirectFlash(c, "/refunds", "ok", "已驳回退款申请：%s", orderNo)
}
