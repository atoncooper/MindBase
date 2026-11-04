// Package model: pay-domain row mappings for the SECOND GORM connection
// (app_pay on the app-pay-mysql instance) plus the console account tables.
//
// RED LINES (pinned by internal/db's guard test):
//   - pay_* tables are owned by app-pay (Java, Flyway migrations). They are
//     plain row mappings here: NEVER AutoMigrate / ALTER them, never add them
//     to db.Migrate. The only writes app-admin performs are the controlled
//     membership grant (pay_membership + pay_membership_event) documented in
//     service.PayGrantService; everything else is read-only.
//   - money is int64 cents, nullable columns are pointers, DATETIME is read
//     with loc=Local (Asia/Shanghai, matching app-pay's pinned JVM timezone).
package model

import "time"

// PayOrder maps pay_order (read-only).
//
// State machine (Java PayOrder): CREATED -> PAID -> DELIVERED;
// CREATED -> CLOSED; CLOSED -> PAID (reopen); REFUNDING/REFUNDED for the refund flow.
type PayOrder struct {
	ID             int64      `gorm:"column:id;primaryKey;autoIncrement" json:"-"`
	OrderNo        string     `gorm:"column:order_no;type:varchar(64);not null;uniqueIndex:uk_pay_order_no"`
	UID            int64      `gorm:"column:uid;not null"`
	SkuCode        string     `gorm:"column:sku_code;type:varchar(50);not null"`
	ProductTitle   string     `gorm:"column:product_title;type:varchar(100);not null"`
	DurationDays   int        `gorm:"column:duration_days;not null"`
	AmountCents    int64      `gorm:"column:amount_cents;not null"`
	Channel        string     `gorm:"column:channel;type:varchar(20);not null"`
	Status         string     `gorm:"column:status;type:varchar(20);not null"`
	Version        int        `gorm:"column:version;not null;default:1"`
	ChannelTradeNo *string    `gorm:"column:channel_trade_no;type:varchar(128)"`
	IdempotencyKey *string    `gorm:"column:idempotency_key;type:varchar(64)"`
	FailReason     *string    `gorm:"column:fail_reason;type:varchar(200)"`
	ExpiresAt      time.Time  `gorm:"column:expires_at;not null"`
	PaidAt         *time.Time `gorm:"column:paid_at"`
	ClosedAt       *time.Time `gorm:"column:closed_at"`
	CreatedAt      time.Time  `gorm:"column:created_at;not null"`
	UpdatedAt      time.Time  `gorm:"column:updated_at;not null"`
}

func (PayOrder) TableName() string { return "pay_order" }

// PayMembership maps pay_membership. Written only by the grant transaction
// (service.PayGrantService), which mirrors app-pay MembershipService.extend.
type PayMembership struct {
	ID          int64     `gorm:"column:id;primaryKey;autoIncrement" json:"-"`
	UID         int64     `gorm:"column:uid;not null;uniqueIndex:uk_pay_membership_uid"`
	Tier        string    `gorm:"column:tier;type:varchar(20);not null;default:VIP"`
	ExpireAt    time.Time `gorm:"column:expire_at;not null"`
	AutoRenew   bool      `gorm:"column:auto_renew;not null;default:false"`
	LastOrderNo *string   `gorm:"column:last_order_no;type:varchar(64)"`
	CreatedAt   time.Time `gorm:"column:created_at;not null"`
	UpdatedAt   time.Time `gorm:"column:updated_at;not null"`
}

func (PayMembership) TableName() string { return "pay_membership" }

// PayMembershipEvent maps pay_membership_event — the structured entitlement
// audit stream (ACTIVATE / RENEW / ADMIN_GRANT / REFUND_REVOKE).
type PayMembershipEvent struct {
	ID           int64     `gorm:"column:id;primaryKey;autoIncrement" json:"-"`
	UID          int64     `gorm:"column:uid;not null;index:idx_pay_membership_event_uid"`
	Type         string    `gorm:"column:type;type:varchar(20);not null"`
	OrderNo      *string   `gorm:"column:order_no;type:varchar(64)"`
	Days         int       `gorm:"column:days;not null"`
	ExpireBefore time.Time `gorm:"column:expire_before;not null"`
	ExpireAfter  time.Time `gorm:"column:expire_after;not null"`
	Reason       *string   `gorm:"column:reason;type:varchar(200)"`
	CreatedAt    time.Time `gorm:"column:created_at;not null"`
}

func (PayMembershipEvent) TableName() string { return "pay_membership_event" }

// PayCallbackLog maps pay_callback_log — channel callback ledger (read-only).
type PayCallbackLog struct {
	ID              int64     `gorm:"column:id;primaryKey;autoIncrement" json:"-"`
	OrderNo         string    `gorm:"column:order_no;type:varchar(64);not null;index:idx_pay_callback_order_no"`
	Channel         string    `gorm:"column:channel;type:varchar(20);not null"`
	PayloadMasked   *string   `gorm:"column:payload_masked;type:text"`
	SignatureResult string    `gorm:"column:signature_result;type:varchar(20);not null"`
	HandleResult    string    `gorm:"column:handle_result;type:varchar(30);not null"`
	Message         *string   `gorm:"column:message;type:varchar(200)"`
	CreatedAt       time.Time `gorm:"column:created_at;not null"`
}

func (PayCallbackLog) TableName() string { return "pay_callback_log" }

// PayProduct maps pay_product (SKU catalog, read-only: price/status changes
// remain an app-pay-side operational task).
type PayProduct struct {
	ID           int64     `gorm:"column:id;primaryKey;autoIncrement" json:"-"`
	Code         string    `gorm:"column:code;type:varchar(50);not null;uniqueIndex:uk_pay_product_code"`
	Title        string    `gorm:"column:title;type:varchar(100);not null"`
	DurationDays int       `gorm:"column:duration_days;not null"`
	PriceCents   int64     `gorm:"column:price_cents;not null"`
	Status       string    `gorm:"column:status;type:varchar(20);not null"`
	Sort         int       `gorm:"column:sort;not null;default:0"`
	CreatedAt    time.Time `gorm:"column:created_at;not null"`
	UpdatedAt    time.Time `gorm:"column:updated_at;not null"`
}

func (PayProduct) TableName() string { return "pay_product" }

// PayRefundApproval maps pay_refund_approval (V4 migration): 退款双人复核请求
// （maker-checker）。Read-only here — approve/reject go through app-pay's
// internal endpoints so the fund write, its audit trail and the approval-table
// state machine all stay in one place.
type PayRefundApproval struct {
	ID          int64      `gorm:"column:id;primaryKey;autoIncrement"`
	OrderNo     string     `gorm:"column:order_no;type:varchar(64);not null"`
	Maker       string     `gorm:"column:maker;type:varchar(64);not null"`
	MakerReason string     `gorm:"column:maker_reason;type:varchar(200);not null"`
	Status      string     `gorm:"column:status;type:varchar(20);not null"`
	Checker     *string    `gorm:"column:checker;type:varchar(64)"`
	CheckReason *string    `gorm:"column:check_reason;type:varchar(200)"`
	CreatedAt   time.Time  `gorm:"column:created_at;not null"`
	DecidedAt   *time.Time `gorm:"column:decided_at"`
}

func (PayRefundApproval) TableName() string { return "pay_refund_approval" }
