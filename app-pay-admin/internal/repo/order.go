// Package repo: order + callback-log queries over app-pay's pay_order /
// pay_callback_log (read-only). Every list helper documents the index it hits
// (plan/1.0.7 §3.6 rule: a pay-domain query must be able to name its index).
package repo

import (
	"time"

	"app-pay-admin/internal/db"
	"app-pay-admin/internal/model"
)

// OrderFilter carries the admin list filters. Zero-value fields are ignored.
type OrderFilter struct {
	UID    int64 // idx_pay_order_uid_status (leftmost uid)
	UIDSet bool
	Status string // (uid,status) or idx_pay_order_status_expires/paid_at prefix
	// Channel/SkuCode have no dedicated index — they are secondary filters
	// applied on top of the above (admin-scale row counts keep this bounded;
	// time-range scans ride the primary key via the id DESC ordering).
	Channel string
	SkuCode string
	OrderNo string // uk_pay_order_no unique lookup
	TradeNo string // uk_pay_order_channel_trade_no unique lookup

	CreatedFrom *time.Time
	CreatedTo   *time.Time

	Limit  int
	Offset int
}

// ListOrders returns one page of orders (newest first, ORDER BY id DESC — the
// auto-increment PK correlates with created_at and keeps the scan index-backed)
// plus the total count matching the same predicates.
func ListOrders(f OrderFilter) ([]model.PayOrder, int64, error) {
	q := db.DB.Model(&model.PayOrder{})
	if f.OrderNo != "" {
		q = q.Where("order_no = ?", f.OrderNo)
	}
	if f.TradeNo != "" {
		q = q.Where("channel_trade_no = ?", f.TradeNo)
	}
	if f.UIDSet {
		q = q.Where("uid = ?", f.UID)
	}
	if f.Status != "" {
		q = q.Where("status = ?", f.Status)
	}
	if f.Channel != "" {
		q = q.Where("channel = ?", f.Channel)
	}
	if f.SkuCode != "" {
		q = q.Where("sku_code = ?", f.SkuCode)
	}
	if f.CreatedFrom != nil {
		q = q.Where("created_at >= ?", *f.CreatedFrom)
	}
	if f.CreatedTo != nil {
		q = q.Where("created_at <= ?", *f.CreatedTo)
	}
	var total int64
	if err := q.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var orders []model.PayOrder
	err := q.Order("id DESC").Limit(f.Limit).Offset(f.Offset).Find(&orders).Error
	if err != nil {
		return nil, 0, err
	}
	return orders, total, nil
}

// GetOrderByNo resolves one order by its unique order number (nil if absent).
func GetOrderByNo(orderNo string) (*model.PayOrder, error) {
	var o model.PayOrder
	err := db.DB.Where("order_no = ?", orderNo).First(&o).Error
	if isNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &o, nil
}

// GetOrderByTradeNo resolves an order by the channel trade number (nil if
// absent) — used to trace a callback/alipay trade back to the local order.
func GetOrderByTradeNo(tradeNo string) (*model.PayOrder, error) {
	var o model.PayOrder
	err := db.DB.Where("channel_trade_no = ?", tradeNo).First(&o).Error
	if isNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &o, nil
}

// ListCallbacks returns the callback ledger rows for one order, newest first
// (idx_pay_callback_order_no).
func ListCallbacks(orderNo string, limit, offset int) ([]model.PayCallbackLog, int64, error) {
	q := db.DB.Model(&model.PayCallbackLog{}).Where("order_no = ?", orderNo)
	var total int64
	if err := q.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var logs []model.PayCallbackLog
	err := q.Order("id DESC").Limit(limit).Offset(offset).Find(&logs).Error
	if err != nil {
		return nil, 0, err
	}
	return logs, total, nil
}
