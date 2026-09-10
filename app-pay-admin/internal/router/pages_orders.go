// Package router: order list + order detail pages.
package router

import (
	"log/slog"
	"net/http"
	"strconv"

	"app-pay-admin/internal/model"
	"app-pay-admin/internal/repo"

	"github.com/gin-gonic/gin"
)

type orderRow struct {
	OrderNo      string
	UID          int64
	ProductTitle string
	SkuCode      string
	Amount       string
	Channel      string
	StatusText   string
	StatusClass  string
	PaidAt       string
	CreatedAt    string
}

func shapeOrder(o *model.PayOrder) orderRow {
	return orderRow{
		OrderNo:      o.OrderNo,
		UID:          o.UID,
		ProductTitle: o.ProductTitle,
		SkuCode:      o.SkuCode,
		Amount:       fmtMoney(o.AmountCents),
		Channel:      o.Channel,
		StatusText:   orderStatusText[o.Status],
		StatusClass:  orderStatusClass[o.Status],
		PaidAt:       fmtTimePtr(o.PaidAt),
		CreatedAt:    fmtTime(o.CreatedAt),
	}
}

type ordersFilterView struct {
	UID         string
	Status      string
	Channel     string
	Sku         string
	OrderNo     string
	TradeNo     string
	CreatedFrom string
	CreatedTo   string
}

// readOrderFilters parses GET filters into repo predicates + the raw strings
// the template re-fills the form with. A parse failure is reported for the
// flash (the query still runs with the valid parts).
//
// Time fields render as <input type="datetime-local">: the picker submits
// "2006-01-02T15:04" (T separator), and a hand-typed space-separated value is
// normalized to "T" so the form refills into the picker correctly.
func readOrderFilters(c *gin.Context) (f repo.OrderFilter, v ordersFilterView, parseErr string) {
	v = ordersFilterView{
		UID:         c.Query("uid"),
		Status:      c.Query("status"),
		Channel:     c.Query("channel"),
		Sku:         c.Query("sku"),
		OrderNo:     c.Query("order_no"),
		TradeNo:     c.Query("trade_no"),
		CreatedFrom: normalizeLocalDT(c.Query("created_from")),
		CreatedTo:   normalizeLocalDT(c.Query("created_to")),
	}
	f = repo.OrderFilter{
		Status:  v.Status,
		Channel: v.Channel,
		SkuCode: v.Sku,
		OrderNo: v.OrderNo,
		TradeNo: v.TradeNo,
	}
	if v.UID != "" {
		uid, err := strconv.ParseInt(v.UID, 10, 64)
		if err != nil || uid < 0 {
			parseErr = "uid 必须为非负整数"
			return f, v, parseErr
		}
		f.UID, f.UIDSet = uid, true
	}
	if raw := c.Query("created_from"); raw != "" {
		t, ok := parseFlexibleTime(raw)
		if !ok {
			parseErr = "「创建时间起」格式不正确（示例 2026-09-01 00:00）"
			return f, v, parseErr
		}
		f.CreatedFrom = &t
	}
	if raw := c.Query("created_to"); raw != "" {
		t, ok := parseFlexibleTime(raw)
		if !ok {
			parseErr = "「创建时间止」格式不正确（示例 2026-09-30 23:59）"
			return f, v, parseErr
		}
		f.CreatedTo = &t
	}
	return f, v, ""
}

// normalizeLocalDT converts a space-separated datetime to the T-separated
// form datetime-local inputs expect ("2026-09-01 20:00" -> "2026-09-01T20:00").
func normalizeLocalDT(s string) string {
	if len(s) > 10 && s[10] == ' ' {
		return s[:10] + "T" + s[11:]
	}
	return s
}

// filterValues collects the current filters for pagination links.
func (v ordersFilterView) values() map[string]string {
	return map[string]string{
		"uid": v.UID, "status": v.Status, "channel": v.Channel, "sku": v.Sku,
		"order_no": v.OrderNo, "trade_no": v.TradeNo,
		"created_from": v.CreatedFrom, "created_to": v.CreatedTo,
	}
}

func (r *Router) pageOrders(c *gin.Context) {
	b := newBase(c, "orders", "订单", "订单检索、状态追踪与回调流水（app_pay 库只读）")
	f, fv, parseErr := readOrderFilters(c)
	if parseErr != "" {
		b.Flash = &flashData{Kind: "warn", Msg: parseErr}
	}
	page := queryPage(c)
	f.Limit, f.Offset = pageSize, (page-1)*pageSize

	orders, total, err := repo.ListOrders(f)
	if err != nil {
		slog.Error("[PAGE] list orders failed", "err", err)
		http.Error(c.Writer, "查询失败", http.StatusInternalServerError)
		return
	}
	items := make([]orderRow, 0, len(orders))
	for i := range orders {
		items = append(items, shapeOrder(&orders[i]))
	}
	renderPage(c.Writer, "orders", struct {
		BaseData
		F              ordersFilterView
		StatusOptions  []selectOpt
		ChannelOptions []selectOpt
		Items          []orderRow
		pageNav
	}{
		BaseData:       b,
		F:              fv,
		StatusOptions:  statusOptions(fv.Status),
		ChannelOptions: channelOptions(fv.Channel),
		Items:          items,
		pageNav:        buildPageNav(c, "/orders", urlValues(fv.values()), page, total),
	})
}

type callbackRow struct {
	CreatedAt       string
	Channel         string
	SignatureResult string
	SigClass        string
	HandleResult    string
	HandleClass     string
	Message         string
	Payload         string
}

type orderDetailPage struct {
	BaseData
	Order     orderDetailRow
	Callbacks []callbackRow
}

type orderDetailRow struct {
	OrderNo        string
	UID            int64
	ProductTitle   string
	SkuCode        string
	DurationDays   int
	Amount         string
	Channel        string
	ChannelTradeNo string
	IdempotencyKey string
	FailReason     string
	StatusText     string
	StatusClass    string
	Version        int
	CreatedAt      string
	PaidAt         string
	ClosedAt       string
	ExpiresAt      string
	UpdatedAt      string
}

func (r *Router) pageOrderDetail(c *gin.Context) {
	order, err := repo.GetOrderByNo(c.Param("order_no"))
	if err != nil {
		slog.Error("[PAGE] get order failed", "err", err)
		http.Error(c.Writer, "查询失败", http.StatusInternalServerError)
		return
	}
	if order == nil {
		render404(c, "订单不存在："+c.Param("order_no"))
		return
	}

	callbacks, _, err := repo.ListCallbacks(order.OrderNo, 100, 0)
	if err != nil {
		slog.Error("[PAGE] list callbacks failed", "err", err)
		http.Error(c.Writer, "查询失败", http.StatusInternalServerError)
		return
	}
	cbRows := make([]callbackRow, 0, len(callbacks))
	for i := range callbacks {
		l := &callbacks[i]
		cbRows = append(cbRows, callbackRow{
			CreatedAt:       fmtTime(l.CreatedAt),
			Channel:         l.Channel,
			SignatureResult: l.SignatureResult,
			SigClass:        signatureClass[l.SignatureResult],
			HandleResult:    l.HandleResult,
			HandleClass:     handleResultClass[l.HandleResult],
			Message:         fmtStrPtr(l.Message),
			Payload:         fmtStrPtr(l.PayloadMasked),
		})
	}

	renderPage(c.Writer, "order_detail", orderDetailPage{
		BaseData: newBase(c, "orders", "订单详情", ""),
		Order: orderDetailRow{
			OrderNo:        order.OrderNo,
			UID:            order.UID,
			ProductTitle:   order.ProductTitle,
			SkuCode:        order.SkuCode,
			DurationDays:   order.DurationDays,
			Amount:         fmtMoney(order.AmountCents),
			Channel:        order.Channel,
			ChannelTradeNo: fmtStrPtr(order.ChannelTradeNo),
			IdempotencyKey: fmtStrPtr(order.IdempotencyKey),
			FailReason:     fmtStrPtr(order.FailReason),
			StatusText:     orderStatusText[order.Status],
			StatusClass:    orderStatusClass[order.Status],
			Version:        order.Version,
			CreatedAt:      fmtTime(order.CreatedAt),
			PaidAt:         fmtTimePtr(order.PaidAt),
			ClosedAt:       fmtTimePtr(order.ClosedAt),
			ExpiresAt:      fmtTime(order.ExpiresAt),
			UpdatedAt:      fmtTime(order.UpdatedAt),
		},
		Callbacks: cbRows,
	})
}
