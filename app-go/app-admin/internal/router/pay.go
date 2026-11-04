// Payment-operations endpoints.
//
// Gating layers, outermost first:
//  1. session gate (every /api route);
//  2. payGate — 503 {"detail":"支付管理未配置"} when the second GORM
//     connection is absent (pay_rdbms.url unset or app_pay unreachable);
//  3. refundGate — the refund review group is INVISIBLE (404) unless
//     pay.ops.base_url + pay.ops.key are wired AND the master switch is on;
//  4. requireAdmin — grant + refund decisions are fund operations.
package router

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"app-admin/internal/dto"
	"app-admin/internal/repo"
	"app-admin/internal/service"

	"github.com/gin-gonic/gin"
)

const (
	// payEventReasonMaxRunes is pay_membership_event.reason's column width
	// (VARCHAR(200)); the "[operator] " prefix counts against it.
	payEventReasonMaxRunes = 200
	// payGrantMaxDays is a sanity cap (10 years) against fat-finger values;
	// app-pay itself only enforces days >= 1.
	payGrantMaxDays = 3650
)

// registerPayRoutes mounts the pay-domain surface. Reads are viewer+; grant and
// refund decisions sit behind requireAdmin.
func (r *Router) registerPayRoutes(api *gin.RouterGroup) {
	pay := api.Group("/pay", r.payGate())
	pay.GET("/orders", r.apiPayOrders)
	pay.GET("/orders/:orderNo", r.apiPayOrderDetail)
	pay.GET("/orders/:orderNo/callbacks", r.apiPayOrderCallbacks)
	pay.GET("/memberships", r.apiPayMemberships)
	pay.GET("/memberships/:uid/events", r.apiPayMemberEvents)
	pay.GET("/events", r.apiPayEvents)
	pay.GET("/products", r.apiPayProducts)

	// Fund write: compensation grant (admin only).
	pay.POST("/grants", requireAdmin(), r.apiPayGrant)

	// Refund review: stealth 404 when not wired (gate runs BEFORE the role
	// gate, so an unconfigured workbench is indistinguishable from a missing
	// route even for a logged-in admin).
	refunds := pay.Group("/refunds", r.refundGate(), requireAdmin())
	refunds.GET("", r.apiListRefunds)
	refunds.POST("/:orderNo/approve", r.apiApproveRefund)
	refunds.POST("/:orderNo/reject", r.apiRejectRefund)
}

// payGate answers 503 when the payment module is not configured/available; the
// rest of the console is unaffected.
func (r *Router) payGate() gin.HandlerFunc {
	return func(c *gin.Context) {
		if r.pay == nil {
			detail(c, http.StatusServiceUnavailable, "支付管理未配置")
			c.Abort()
			return
		}
		c.Next()
	}
}

// refundReviewEnabled reports whether the workbench is wired (ops key present
// + master switch on).
func (r *Router) refundReviewEnabled() bool {
	return r.ops != nil && r.ops.Enabled() && r.cfg.Pay.Ops.RefundReviewEnabled
}

// refundGate aborts with 404 when the workbench is not wired (stealth, same
// posture as app-pay's disabled test endpoints).
func (r *Router) refundGate() gin.HandlerFunc {
	return func(c *gin.Context) {
		if !r.refundReviewEnabled() {
			detail(c, http.StatusNotFound, "refund review not configured")
			c.Abort()
			return
		}
		c.Next()
	}
}

// ── queries ─────────────────────────────────────────────────────────────

// apiPayOrders GET /api/pay/orders?uid=&status=&channel=&sku=&orderNo=
// &tradeNo=&createdFrom=&createdTo=&page=&pageSize=
func (r *Router) apiPayOrders(c *gin.Context) {
	page, pageSize, ok := r.parsePage(c)
	if !ok {
		detail(c, http.StatusBadRequest, "page must be >= 1 and pageSize within 1..100")
		return
	}
	q := service.PayOrderQuery{
		Status:  strings.TrimSpace(c.Query("status")),
		Channel: strings.TrimSpace(c.Query("channel")),
		SkuCode: strings.TrimSpace(c.Query("sku")),
		OrderNo: strings.TrimSpace(c.Query("orderNo")),
		TradeNo: strings.TrimSpace(c.Query("tradeNo")),
	}
	if v := c.Query("uid"); v != "" {
		n, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
		if err != nil || n < 0 {
			detail(c, http.StatusBadRequest, "uid must be a non-negative integer")
			return
		}
		q.UID = &n
	}
	if v := c.Query("createdFrom"); v != "" {
		t, ok := parsePayTime(v, false)
		if !ok {
			detail(c, http.StatusBadRequest, "invalid createdFrom (expect RFC3339 or YYYY-MM-DD)")
			return
		}
		q.CreatedFrom = &t
	}
	if v := c.Query("createdTo"); v != "" {
		t, ok := parsePayTime(v, true)
		if !ok {
			detail(c, http.StatusBadRequest, "invalid createdTo (expect RFC3339 or YYYY-MM-DD)")
			return
		}
		q.CreatedTo = &t
	}
	result, err := r.pay.Orders(q, page, pageSize)
	if err != nil {
		serverError(c, err, "pay orders")
		return
	}
	c.JSON(http.StatusOK, result)
}

// apiPayOrderDetail GET /api/pay/orders/:orderNo?tradeNo= — orderNo first, then
// the channel trade number as a fallback trace.
func (r *Router) apiPayOrderDetail(c *gin.Context) {
	item, err := r.pay.Order(c.Param("orderNo"), strings.TrimSpace(c.Query("tradeNo")))
	if err != nil {
		serverError(c, err, "pay order detail")
		return
	}
	if item == nil {
		detail(c, http.StatusNotFound, "order not found")
		return
	}
	c.JSON(http.StatusOK, dto.PayOrderDetail{Order: *item})
}

// apiPayOrderCallbacks GET /api/pay/orders/:orderNo/callbacks
func (r *Router) apiPayOrderCallbacks(c *gin.Context) {
	page, pageSize, ok := r.parsePage(c)
	if !ok {
		detail(c, http.StatusBadRequest, "page must be >= 1 and pageSize within 1..100")
		return
	}
	result, err := r.pay.Callbacks(c.Param("orderNo"), page, pageSize)
	if err != nil {
		serverError(c, err, "pay order callbacks")
		return
	}
	c.JSON(http.StatusOK, result)
}

// apiPayMemberships GET /api/pay/memberships?uid= — uid exact lookup returns
// {"membership": item|null}; without uid it pages the full table.
func (r *Router) apiPayMemberships(c *gin.Context) {
	if v := c.Query("uid"); v != "" {
		uid, ok := parsePositiveUID(v)
		if !ok {
			detail(c, http.StatusBadRequest, "uid must be a positive integer")
			return
		}
		item, err := r.pay.Membership(uid)
		if err != nil {
			serverError(c, err, "pay membership")
			return
		}
		c.JSON(http.StatusOK, dto.PayMembershipLookup{Membership: item})
		return
	}
	page, pageSize, ok := r.parsePage(c)
	if !ok {
		detail(c, http.StatusBadRequest, "page must be >= 1 and pageSize within 1..100")
		return
	}
	result, err := r.pay.Memberships(page, pageSize)
	if err != nil {
		serverError(c, err, "pay memberships")
		return
	}
	c.JSON(http.StatusOK, result)
}

// apiPayMemberEvents GET /api/pay/memberships/:uid/events
func (r *Router) apiPayMemberEvents(c *gin.Context) {
	uid, ok := parsePositiveUID(c.Param("uid"))
	if !ok {
		detail(c, http.StatusBadRequest, "uid must be a positive integer")
		return
	}
	page, pageSize, ok := r.parsePage(c)
	if !ok {
		detail(c, http.StatusBadRequest, "page must be >= 1 and pageSize within 1..100")
		return
	}
	result, err := r.pay.MemberEvents(uid, page, pageSize)
	if err != nil {
		serverError(c, err, "pay member events")
		return
	}
	c.JSON(http.StatusOK, result)
}

// apiPayEvents GET /api/pay/events?uid=&type= — the global entitlement stream
// (feeds the ADMIN_GRANT audit review).
func (r *Router) apiPayEvents(c *gin.Context) {
	var uid *int64
	if v := c.Query("uid"); v != "" {
		n, ok := parsePositiveUID(v)
		if !ok {
			detail(c, http.StatusBadRequest, "uid must be a positive integer")
			return
		}
		uid = &n
	}
	page, pageSize, ok := r.parsePage(c)
	if !ok {
		detail(c, http.StatusBadRequest, "page must be >= 1 and pageSize within 1..100")
		return
	}
	result, err := r.pay.Events(uid, strings.TrimSpace(c.Query("type")), page, pageSize)
	if err != nil {
		serverError(c, err, "pay events")
		return
	}
	c.JSON(http.StatusOK, result)
}

// apiPayProducts GET /api/pay/products (read-only SKU catalog).
func (r *Router) apiPayProducts(c *gin.Context) {
	result, err := r.pay.Products()
	if err != nil {
		serverError(c, err, "pay products")
		return
	}
	c.JSON(http.StatusOK, result)
}

// ── compensation grant (fund write, admin only) ─────────────────────────

// apiPayGrant POST /api/pay/grants
//
// body {"uid": <number|string>, "durationDays": int, "reason": string,
// "tier"?: "VIP"|"SVIP"}. The operator identity comes from the console session
// and rides into pay_membership_event.reason as "[<username>] ..." (the
// Java-owned table has no operator column).
func (r *Router) apiPayGrant(c *gin.Context) {
	if r.grants == nil {
		detail(c, http.StatusServiceUnavailable, "支付管理未配置")
		return
	}
	var req struct {
		UID          json.RawMessage `json:"uid"`
		DurationDays int             `json:"durationDays"`
		Reason       string          `json:"reason"`
		Tier         string          `json:"tier"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		detail(c, http.StatusBadRequest, "invalid request: "+err.Error())
		return
	}
	uid, err := parseFlexibleUID(req.UID)
	if err != nil || uid <= 0 {
		detail(c, http.StatusBadRequest, "uid must be a positive integer")
		return
	}
	if req.DurationDays < 1 || req.DurationDays > payGrantMaxDays {
		detail(c, http.StatusBadRequest, "durationDays must be within 1..3650")
		return
	}
	reason := strings.TrimSpace(req.Reason)
	if reason == "" {
		detail(c, http.StatusBadRequest, "reason required")
		return
	}
	tier := strings.ToUpper(strings.TrimSpace(req.Tier))
	if tier != "" && tier != "VIP" && tier != "SVIP" {
		detail(c, http.StatusBadRequest, "tier must be VIP or SVIP")
		return
	}
	operator := operatorOf(c)
	if operator == "" {
		// Defensive: the session gate always sets an identity.
		detail(c, http.StatusUnauthorized, "operator identity missing")
		return
	}
	// Keep the audit reason within the Java column width after the operator
	// prefix is prepended.
	if utf8.RuneCountInString("["+operator+"] "+reason) > payEventReasonMaxRunes {
		detail(c, http.StatusBadRequest, "reason too long: operator prefix + reason must fit 200 chars")
		return
	}

	res, err := r.grants.Grant(c.Request.Context(), operator, uid, req.DurationDays, reason, tier)
	if err != nil {
		var quota *service.DailyQuotaError
		if errors.As(err, &quota) {
			detail(c, http.StatusTooManyRequests, quota.Msg)
			return
		}
		slog.Error("[PAY_GRANT] grant failed", "operator", operator, "uid", uid, "err", err)
		detail(c, http.StatusInternalServerError, "grant failed")
		return
	}
	c.JSON(http.StatusOK, dto.PayGrantResult{
		UID:          strconv.FormatInt(uid, 10),
		Tier:         res.Tier,
		Days:         req.DurationDays,
		ExpireBefore: payTime(res.Before),
		ExpireAfter:  payTime(res.After),
		Created:      res.Created,
		Active:       res.After.After(time.Now()),
	})
}

// ── refund review (admin only, stealth 404 when unwired) ────────────────

// apiListRefunds GET /api/pay/refunds?status=PENDING|APPROVED|REJECTED|ALL
func (r *Router) apiListRefunds(c *gin.Context) {
	status := strings.ToUpper(strings.TrimSpace(c.DefaultQuery("status", "PENDING")))
	switch status {
	case "", "ALL": // empty value = no filter (contract: 空 = 全部)
		status = ""
	case "PENDING", "APPROVED", "REJECTED":
	default:
		detail(c, http.StatusBadRequest, "status must be PENDING, APPROVED, REJECTED or ALL")
		return
	}
	page, pageSize, ok := r.parsePage(c)
	if !ok {
		detail(c, http.StatusBadRequest, "page must be >= 1 and pageSize within 1..100")
		return
	}
	result, err := r.pay.Refunds(status, page, pageSize)
	if err != nil {
		serverError(c, err, "pay refunds")
		return
	}
	c.JSON(http.StatusOK, result)
}

// apiApproveRefund POST /api/pay/refunds/:orderNo/approve {"reason"?}
func (r *Router) apiApproveRefund(c *gin.Context) {
	r.apiRefundAction(c, true)
}

// apiRejectRefund POST /api/pay/refunds/:orderNo/reject
func (r *Router) apiRejectRefund(c *gin.Context) {
	r.apiRefundAction(c, false)
}

// apiRefundAction proxies the decision to app-pay (the fund write happens
// there), then records the operator action in both local audit trails. The
// app-pay call is authoritative: its {"detail"} is passed through as 502.
func (r *Router) apiRefundAction(c *gin.Context, confirm bool) {
	orderNo := strings.TrimSpace(c.Param("orderNo"))
	if orderNo == "" || len(orderNo) > 64 {
		detail(c, http.StatusBadRequest, "invalid orderNo")
		return
	}
	var req struct {
		Reason string `json:"reason"`
	}
	_ = c.ShouldBindJSON(&req) // optional body: reject carries none
	reason := strings.TrimSpace(req.Reason)
	operator := operatorOf(c)
	if operator == "" {
		detail(c, http.StatusUnauthorized, "operator identity missing")
		return
	}

	if err := r.ops.ConfirmRefundOrReject(c.Request.Context(), orderNo, operator, reason, confirm); err != nil {
		slog.Warn("[PAY_REFUND] app-pay decision failed", "operator", operator, "order_no", orderNo, "confirm", confirm, "err", err)
		detail(c, http.StatusBadGateway, err.Error())
		return
	}

	action, event := "pay_refund_approve", "REFUND_CONFIRMED"
	if !confirm {
		action, event = "pay_refund_reject", "REFUND_REJECTED"
	}
	// The money already moved upstream: audit failures are logged loudly but do
	// not turn a confirmed refund into an error response.
	auditDetail := "orderNo=" + orderNo
	if reason != "" {
		auditDetail += " reason=" + reason
	}
	if err := repo.RecordAudit(operator, action, "pay_refund", orderNo, auditDetail); err != nil {
		slog.Error("[PAY_REFUND] admin_audit write failed after app-pay decision", "order_no", orderNo, "err", err)
	}
	if r.payAudit != nil {
		r.payAudit.Log(event, "operator", operator, "order_no", orderNo,
			"action", action, "source", "app-admin")
	}

	c.JSON(http.StatusOK, dto.PayRefundActionResult{
		OK:        true,
		OrderNo:   orderNo,
		Confirmed: confirm,
		Checker:   operator,
	})
}

// ── parsing helpers ─────────────────────────────────────────────────────

// operatorOf reads the authenticated console username.
func operatorOf(c *gin.Context) string {
	id, ok := identityOf(c)
	if !ok {
		return ""
	}
	return id.Username
}

// parsePositiveUID accepts only a positive int64 (uid > 0).
func parsePositiveUID(value string) (int64, bool) {
	n, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
	if err != nil || n <= 0 {
		return 0, false
	}
	return n, true
}

// parseFlexibleUID accepts the grant body's uid as a JSON number OR a JSON
// string (the console may pass the string form it renders).
func parseFlexibleUID(raw json.RawMessage) (int64, error) {
	value := strings.TrimSpace(string(raw))
	if value == "" || value == "null" {
		return 0, errors.New("missing uid")
	}
	if strings.HasPrefix(value, "\"") {
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return 0, err
		}
		value = strings.TrimSpace(s)
	}
	return strconv.ParseInt(value, 10, 64)
}

// parsePayTime accepts RFC3339 or a plain YYYY-MM-DD date interpreted in
// time.Local (Asia/Shanghai, pinned by main). A bare end date includes the
// whole day (createdTo=2026-11-03 matches 23:59:59 that day).
func parsePayTime(value string, endOfDay bool) (time.Time, bool) {
	value = strings.TrimSpace(value)
	if t, err := time.Parse(time.RFC3339, value); err == nil {
		return t, true
	}
	if t, err := time.ParseInLocation("2006-01-02", value, time.Local); err == nil {
		if endOfDay {
			return t.AddDate(0, 0, 1).Add(-time.Nanosecond), true
		}
		return t, true
	}
	return time.Time{}, false
}

// payTime renders a required instant in the contract's RFC3339 format.
func payTime(t time.Time) string { return t.Format(time.RFC3339) }
