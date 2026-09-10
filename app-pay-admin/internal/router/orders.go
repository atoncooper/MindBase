// Package router: order query endpoints (pay_order / pay_callback_log).
package router

import (
	"net/http"
	"strconv"
	"time"

	"app-pay-admin/internal/model"
	"app-pay-admin/internal/repo"

	"github.com/gin-gonic/gin"
)

// parseFlexibleTime accepts RFC3339 ("2026-09-09T20:00:00+08:00"), naive
// datetime-local ("2026-09-09T20:00"), space-separated ("2026-09-09 20:00:05"),
// and plain dates ("2026-09-09"). Values without an offset are interpreted in
// time.Local, which main.go pins to app-pay's Asia/Shanghai wall-clock convention.
func parseFlexibleTime(s string) (time.Time, bool) {
	for _, layout := range []string{
		time.RFC3339, "2006-01-02T15:04", "2006-01-02T15:04:05",
		"2006-01-02 15:04:05", "2006-01-02 15:04", "2006-01-02",
	} {
		if t, err := time.ParseInLocation(layout, s, time.Local); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

// apiListOrders GET /api/orders?uid=&status=&channel=&sku=&order_no=&trade_no=
// &created_from=&created_to=&limit=&offset=
func (r *Router) apiListOrders(c *gin.Context) {
	limit, offset := pagination(c, 50, 200)
	f := repo.OrderFilter{
		Status:  c.Query("status"),
		Channel: c.Query("channel"),
		SkuCode: c.Query("sku"),
		OrderNo: c.Query("order_no"),
		TradeNo: c.Query("trade_no"),
		Limit:   limit,
		Offset:  offset,
	}
	if v := c.Query("uid"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < 0 {
			c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid uid"})
			return
		}
		f.UID, f.UIDSet = n, true
	}
	if v := c.Query("created_from"); v != "" {
		t, ok := parseFlexibleTime(v)
		if !ok {
			c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid created_from (expect RFC3339 / date)"})
			return
		}
		f.CreatedFrom = &t
	}
	if v := c.Query("created_to"); v != "" {
		t, ok := parseFlexibleTime(v)
		if !ok {
			c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid created_to (expect RFC3339 / date)"})
			return
		}
		f.CreatedTo = &t
	}

	orders, total, err := repo.ListOrders(f)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": err.Error()})
		return
	}
	items := make([]gin.H, 0, len(orders))
	for i := range orders {
		items = append(items, orderView(&orders[i]))
	}
	c.JSON(http.StatusOK, gin.H{"total": total, "limit": limit, "offset": offset, "items": items})
}

// apiOrderDetail GET /api/orders/:order_no
func (r *Router) apiOrderDetail(c *gin.Context) {
	order, err := repo.GetOrderByNo(c.Param("order_no"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": err.Error()})
		return
	}
	if order == nil {
		// Fall back to the channel trade number so a callback trace can land
		// on the order even when the caller only has the trade no.
		if trade := c.Query("trade_no"); trade != "" {
			if order, err = repo.GetOrderByTradeNo(trade); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"detail": err.Error()})
				return
			}
		}
	}
	if order == nil {
		c.JSON(http.StatusNotFound, gin.H{"detail": "order not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"order": orderView(order)})
}

// apiOrderCallbacks GET /api/orders/:order_no/callbacks — the callback ledger
// for one order (signature/handle verdicts, masked payloads).
func (r *Router) apiOrderCallbacks(c *gin.Context) {
	limit, offset := pagination(c, 50, 200)
	logs, total, err := repo.ListCallbacks(c.Param("order_no"), limit, offset)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": err.Error()})
		return
	}
	items := make([]gin.H, 0, len(logs))
	for i := range logs {
		items = append(items, callbackView(&logs[i]))
	}
	c.JSON(http.StatusOK, gin.H{"total": total, "limit": limit, "offset": offset, "items": items})
}

func orderView(o *model.PayOrder) gin.H {
	return gin.H{
		"order_no":         o.OrderNo,
		"uid":              o.UID,
		"sku_code":         o.SkuCode,
		"product_title":    o.ProductTitle,
		"duration_days":    o.DurationDays,
		"amount_cents":     o.AmountCents,
		"channel":          o.Channel,
		"status":           o.Status,
		"version":          o.Version,
		"channel_trade_no": o.ChannelTradeNo,
		"idempotency_key":  o.IdempotencyKey,
		"fail_reason":      o.FailReason,
		"expires_at":       o.ExpiresAt.Format(time.RFC3339),
		"paid_at":          timePtr(o.PaidAt),
		"closed_at":        timePtr(o.ClosedAt),
		"created_at":       o.CreatedAt.Format(time.RFC3339),
		"updated_at":       o.UpdatedAt.Format(time.RFC3339),
	}
}

func callbackView(l *model.PayCallbackLog) gin.H {
	return gin.H{
		"order_no":         l.OrderNo,
		"channel":          l.Channel,
		"payload_masked":   l.PayloadMasked,
		"signature_result": l.SignatureResult,
		"handle_result":    l.HandleResult,
		"message":          l.Message,
		"created_at":       l.CreatedAt.Format(time.RFC3339),
	}
}
