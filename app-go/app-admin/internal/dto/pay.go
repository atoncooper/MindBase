package dto

// Payment-operations wire contract.
//
// Two rules from the contract are encoded in the types below:
//   - payment uid is ALWAYS a JSON string (bigint precision safety);
//   - money is integer cents (amountCents / priceCents), never floats;
//   - nullable columns stay pointers so they serialise as null, not "".

// PayOrderItem is one order row / the order detail body.
type PayOrderItem struct {
	OrderNo        string  `json:"orderNo"`
	UID            string  `json:"uid"`
	SkuCode        string  `json:"skuCode"`
	ProductTitle   string  `json:"productTitle"`
	DurationDays   int     `json:"durationDays"`
	AmountCents    int64   `json:"amountCents"`
	Channel        string  `json:"channel"`
	Status         string  `json:"status"`
	Version        int     `json:"version"`
	ChannelTradeNo *string `json:"channelTradeNo"`
	IdempotencyKey *string `json:"idempotencyKey"`
	FailReason     *string `json:"failReason"`
	ExpiresAt      string  `json:"expiresAt"`
	PaidAt         *string `json:"paidAt"`
	ClosedAt       *string `json:"closedAt"`
	CreatedAt      string  `json:"createdAt"`
	UpdatedAt      string  `json:"updatedAt"`
}

// PayOrderPage is the GET /api/pay/orders envelope.
type PayOrderPage struct {
	Items    []PayOrderItem `json:"items"`
	Total    int64          `json:"total"`
	Page     int            `json:"page"`
	PageSize int            `json:"pageSize"`
}

// PayOrderDetail is the GET /api/pay/orders/:orderNo body.
type PayOrderDetail struct {
	Order PayOrderItem `json:"order"`
}

// PayCallbackItem is one channel-callback ledger row.
type PayCallbackItem struct {
	OrderNo         string  `json:"orderNo"`
	Channel         string  `json:"channel"`
	PayloadMasked   *string `json:"payloadMasked"`
	SignatureResult string  `json:"signatureResult"`
	HandleResult    string  `json:"handleResult"`
	Message         *string `json:"message"`
	CreatedAt       string  `json:"createdAt"`
}

// PayCallbackPage is the GET /api/pay/orders/:orderNo/callbacks envelope.
type PayCallbackPage struct {
	Items    []PayCallbackItem `json:"items"`
	Total    int64             `json:"total"`
	Page     int               `json:"page"`
	PageSize int               `json:"pageSize"`
}

// PayMembershipItem is one membership row. Active is the lazy-expiry flag
// (expireAt > now), same semantics as app-pay's isActive.
type PayMembershipItem struct {
	UID         string  `json:"uid"`
	Tier        string  `json:"tier"`
	Active      bool    `json:"active"`
	ExpireAt    string  `json:"expireAt"`
	AutoRenew   bool    `json:"autoRenew"`
	LastOrderNo *string `json:"lastOrderNo"`
	CreatedAt   string  `json:"createdAt"`
	UpdatedAt   string  `json:"updatedAt"`
}

// PayMembershipLookup is the uid-exact GET /api/pay/memberships?uid= body:
// a missing row is null, never a 404.
type PayMembershipLookup struct {
	Membership *PayMembershipItem `json:"membership"`
}

// PayMembershipPage is the unfiltered GET /api/pay/memberships envelope.
type PayMembershipPage struct {
	Items    []PayMembershipItem `json:"items"`
	Total    int64               `json:"total"`
	Page     int                 `json:"page"`
	PageSize int                 `json:"pageSize"`
}

// PayMembershipEventItem is one entitlement-audit row.
type PayMembershipEventItem struct {
	ID           int64   `json:"id"`
	UID          string  `json:"uid"`
	Type         string  `json:"type"`
	OrderNo      *string `json:"orderNo"`
	Days         int     `json:"days"`
	ExpireBefore string  `json:"expireBefore"`
	ExpireAfter  string  `json:"expireAfter"`
	Reason       *string `json:"reason"`
	CreatedAt    string  `json:"createdAt"`
}

// PayMembershipEventPage is the per-member / global event envelope.
type PayMembershipEventPage struct {
	Items    []PayMembershipEventItem `json:"items"`
	Total    int64                    `json:"total"`
	Page     int                      `json:"page"`
	PageSize int                      `json:"pageSize"`
}

// PayProductItem is one SKU row (read-only catalog).
type PayProductItem struct {
	Code         string `json:"code"`
	Title        string `json:"title"`
	DurationDays int    `json:"durationDays"`
	PriceCents   int64  `json:"priceCents"`
	Status       string `json:"status"`
	Sort         int    `json:"sort"`
	CreatedAt    string `json:"createdAt"`
	UpdatedAt    string `json:"updatedAt"`
}

// PayProductList is the GET /api/pay/products body.
type PayProductList struct {
	Items []PayProductItem `json:"items"`
}

// PayGrantResult is the POST /api/pay/grants success body.
type PayGrantResult struct {
	UID          string `json:"uid"`
	Tier         string `json:"tier"`
	Days         int    `json:"days"`
	ExpireBefore string `json:"expireBefore"`
	ExpireAfter  string `json:"expireAfter"`
	Created      bool   `json:"created"`
	Active       bool   `json:"active"`
}

// PayRefundApprovalItem is one maker-checker approval row.
type PayRefundApprovalItem struct {
	OrderNo     string  `json:"orderNo"`
	Maker       string  `json:"maker"`
	MakerReason string  `json:"makerReason"`
	Status      string  `json:"status"`
	CreatedAt   string  `json:"createdAt"`
	DecidedAt   *string `json:"decidedAt"`
	Checker     *string `json:"checker"`
	CheckReason *string `json:"checkReason"`
}

// PayRefundApprovalPage is the GET /api/pay/refunds envelope.
type PayRefundApprovalPage struct {
	Items    []PayRefundApprovalItem `json:"items"`
	Total    int64                   `json:"total"`
	Page     int                     `json:"page"`
	PageSize int                     `json:"pageSize"`
}

// PayRefundActionResult is the approve/reject success body.
type PayRefundActionResult struct {
	OK        bool   `json:"ok"`
	OrderNo   string `json:"orderNo"`
	Confirmed bool   `json:"confirmed"`
	Checker   string `json:"checker"`
}
