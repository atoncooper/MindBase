// Pay query service: assembles the payment-operations DTOs from the read-only
// pay-domain repos (order / callback / membership / entitlement event / SKU).
//
// Contract notes encoded here:
//   - every payment uid is serialised as a STRING (bigint precision safety);
//   - money stays integer cents;
//   - membership "active" is the lazy-expiry flag (expire_at > now), same as
//     app-pay's isActive — no background job flips it.
package service

import (
	"strconv"
	"time"

	"app-admin/internal/dto"
	"app-admin/internal/model"
	"app-admin/internal/repo"
)

// PayQueryService is stateless; wires pay-domain repo reads into DTOs.
type PayQueryService struct{}

func NewPayQueryService() *PayQueryService { return &PayQueryService{} }

// PayOrderQuery is the parsed GET /api/pay/orders filter set. Nil timestamps
// and empty strings mean "no filter".
type PayOrderQuery struct {
	UID         *int64
	Status      string
	Channel     string
	SkuCode     string
	OrderNo     string
	TradeNo     string
	CreatedFrom *time.Time
	CreatedTo   *time.Time
}

// Orders returns one order page, newest first (ORDER BY id DESC).
func (s *PayQueryService) Orders(q PayOrderQuery, page, pageSize int) (*dto.PayOrderPage, error) {
	if err := validatePage(page, pageSize); err != nil {
		return nil, err
	}
	limit, offset := pageWindow(page, pageSize)
	f := repo.OrderFilter{
		Status:      q.Status,
		Channel:     q.Channel,
		SkuCode:     q.SkuCode,
		OrderNo:     q.OrderNo,
		TradeNo:     q.TradeNo,
		CreatedFrom: q.CreatedFrom,
		CreatedTo:   q.CreatedTo,
		Limit:       limit,
		Offset:      offset,
	}
	if q.UID != nil {
		f.UID, f.UIDSet = *q.UID, true
	}
	orders, total, err := repo.ListOrders(f)
	if err != nil {
		return nil, err
	}
	items := make([]dto.PayOrderItem, 0, len(orders))
	for i := range orders {
		items = append(items, payOrderItem(&orders[i]))
	}
	return &dto.PayOrderPage{Items: items, Total: total, Page: page, PageSize: pageSize}, nil
}

// Order resolves one order by order number, falling back to the channel trade
// number when the caller only has that. (nil, nil) = unknown order -> 404.
func (s *PayQueryService) Order(orderNo, tradeNo string) (*dto.PayOrderItem, error) {
	order, err := repo.GetOrderByNo(orderNo)
	if err != nil {
		return nil, err
	}
	if order == nil && tradeNo != "" {
		if order, err = repo.GetOrderByTradeNo(tradeNo); err != nil {
			return nil, err
		}
	}
	if order == nil {
		return nil, nil
	}
	item := payOrderItem(order)
	return &item, nil
}

// Callbacks returns the channel callback ledger for one order, newest first.
func (s *PayQueryService) Callbacks(orderNo string, page, pageSize int) (*dto.PayCallbackPage, error) {
	if err := validatePage(page, pageSize); err != nil {
		return nil, err
	}
	limit, offset := pageWindow(page, pageSize)
	rows, total, err := repo.ListCallbacks(orderNo, limit, offset)
	if err != nil {
		return nil, err
	}
	items := make([]dto.PayCallbackItem, 0, len(rows))
	for i := range rows {
		items = append(items, dto.PayCallbackItem{
			OrderNo:         rows[i].OrderNo,
			Channel:         rows[i].Channel,
			PayloadMasked:   rows[i].PayloadMasked,
			SignatureResult: rows[i].SignatureResult,
			HandleResult:    rows[i].HandleResult,
			Message:         rows[i].Message,
			CreatedAt:       rfc3339Time(rows[i].CreatedAt),
		})
	}
	return &dto.PayCallbackPage{Items: items, Total: total, Page: page, PageSize: pageSize}, nil
}

// Membership resolves one uid's membership; (nil, nil) = no row (the contract
// says the API answers {"membership": null}, never 404).
func (s *PayQueryService) Membership(uid int64) (*dto.PayMembershipItem, error) {
	m, err := repo.GetMembershipByUID(uid)
	if err != nil || m == nil {
		return nil, err
	}
	item := payMembershipItem(m)
	return &item, nil
}

// Memberships returns one page of memberships (PK order, newest first).
func (s *PayQueryService) Memberships(page, pageSize int) (*dto.PayMembershipPage, error) {
	if err := validatePage(page, pageSize); err != nil {
		return nil, err
	}
	limit, offset := pageWindow(page, pageSize)
	rows, total, err := repo.ListMemberships(limit, offset)
	if err != nil {
		return nil, err
	}
	items := make([]dto.PayMembershipItem, 0, len(rows))
	for i := range rows {
		items = append(items, payMembershipItem(&rows[i]))
	}
	return &dto.PayMembershipPage{Items: items, Total: total, Page: page, PageSize: pageSize}, nil
}

// MemberEvents returns one member's entitlement audit stream (ACTIVATE /
// RENEW / ADMIN_GRANT), newest first.
func (s *PayQueryService) MemberEvents(uid int64, page, pageSize int) (*dto.PayMembershipEventPage, error) {
	if err := validatePage(page, pageSize); err != nil {
		return nil, err
	}
	limit, offset := pageWindow(page, pageSize)
	rows, total, err := repo.ListEventsByUID(uid, limit, offset)
	if err != nil {
		return nil, err
	}
	return payEventPage(rows, total, page, pageSize), nil
}

// Events returns the global entitlement event stream (serves the ADMIN_GRANT
// audit review), optionally filtered by uid / type.
func (s *PayQueryService) Events(uid *int64, typ string, page, pageSize int) (*dto.PayMembershipEventPage, error) {
	if err := validatePage(page, pageSize); err != nil {
		return nil, err
	}
	limit, offset := pageWindow(page, pageSize)
	f := repo.EventFilter{Type: typ, Limit: limit, Offset: offset}
	if uid != nil {
		f.UID, f.UIDSet = *uid, true
	}
	rows, total, err := repo.ListEvents(f)
	if err != nil {
		return nil, err
	}
	return payEventPage(rows, total, page, pageSize), nil
}

// Products returns the SKU catalog ordered for display (sort ASC, id ASC).
func (s *PayQueryService) Products() (*dto.PayProductList, error) {
	rows, err := repo.ListProducts()
	if err != nil {
		return nil, err
	}
	items := make([]dto.PayProductItem, 0, len(rows))
	for _, p := range rows {
		items = append(items, dto.PayProductItem{
			Code:         p.Code,
			Title:        p.Title,
			DurationDays: p.DurationDays,
			PriceCents:   p.PriceCents,
			Status:       p.Status,
			Sort:         p.Sort,
			CreatedAt:    rfc3339Time(p.CreatedAt),
			UpdatedAt:    rfc3339Time(p.UpdatedAt),
		})
	}
	return &dto.PayProductList{Items: items}, nil
}

// Refunds returns one page of maker-checker refund approvals (status "" =
// all), newest id first. Reads pay_refund_approval directly; approve/reject go
// through app-pay (see the router / payops client).
func (s *PayQueryService) Refunds(status string, page, pageSize int) (*dto.PayRefundApprovalPage, error) {
	if err := validatePage(page, pageSize); err != nil {
		return nil, err
	}
	limit, offset := pageWindow(page, pageSize)
	rows, total, err := repo.ListRefundApprovals(repo.RefundApprovalFilter{
		Status: status, Limit: limit, Offset: offset,
	})
	if err != nil {
		return nil, err
	}
	items := make([]dto.PayRefundApprovalItem, 0, len(rows))
	for i := range rows {
		items = append(items, dto.PayRefundApprovalItem{
			OrderNo:     rows[i].OrderNo,
			Maker:       rows[i].Maker,
			MakerReason: rows[i].MakerReason,
			Status:      rows[i].Status,
			CreatedAt:   rfc3339Time(rows[i].CreatedAt),
			DecidedAt:   rfc3339Ptr(rows[i].DecidedAt),
			Checker:     rows[i].Checker,
			CheckReason: rows[i].CheckReason,
		})
	}
	return &dto.PayRefundApprovalPage{Items: items, Total: total, Page: page, PageSize: pageSize}, nil
}

// ── row → DTO mappers ────────────────────────────────────────────────────

func payOrderItem(o *model.PayOrder) dto.PayOrderItem {
	return dto.PayOrderItem{
		OrderNo:        o.OrderNo,
		UID:            strconv.FormatInt(o.UID, 10),
		SkuCode:        o.SkuCode,
		ProductTitle:   o.ProductTitle,
		DurationDays:   o.DurationDays,
		AmountCents:    o.AmountCents,
		Channel:        o.Channel,
		Status:         o.Status,
		Version:        o.Version,
		ChannelTradeNo: o.ChannelTradeNo,
		IdempotencyKey: o.IdempotencyKey,
		FailReason:     o.FailReason,
		ExpiresAt:      rfc3339Time(o.ExpiresAt),
		PaidAt:         rfc3339Ptr(o.PaidAt),
		ClosedAt:       rfc3339Ptr(o.ClosedAt),
		CreatedAt:      rfc3339Time(o.CreatedAt),
		UpdatedAt:      rfc3339Time(o.UpdatedAt),
	}
}

func payMembershipItem(m *model.PayMembership) dto.PayMembershipItem {
	return dto.PayMembershipItem{
		UID:         strconv.FormatInt(m.UID, 10),
		Tier:        m.Tier,
		Active:      m.ExpireAt.After(time.Now()),
		ExpireAt:    rfc3339Time(m.ExpireAt),
		AutoRenew:   m.AutoRenew,
		LastOrderNo: m.LastOrderNo,
		CreatedAt:   rfc3339Time(m.CreatedAt),
		UpdatedAt:   rfc3339Time(m.UpdatedAt),
	}
}

func payEventPage(rows []model.PayMembershipEvent, total int64, page, pageSize int) *dto.PayMembershipEventPage {
	items := make([]dto.PayMembershipEventItem, 0, len(rows))
	for i := range rows {
		items = append(items, dto.PayMembershipEventItem{
			ID:           rows[i].ID,
			UID:          strconv.FormatInt(rows[i].UID, 10),
			Type:         rows[i].Type,
			OrderNo:      rows[i].OrderNo,
			Days:         rows[i].Days,
			ExpireBefore: rfc3339Time(rows[i].ExpireBefore),
			ExpireAfter:  rfc3339Time(rows[i].ExpireAfter),
			Reason:       rows[i].Reason,
			CreatedAt:    rfc3339Time(rows[i].CreatedAt),
		})
	}
	return &dto.PayMembershipEventPage{Items: items, Total: total, Page: page, PageSize: pageSize}
}
