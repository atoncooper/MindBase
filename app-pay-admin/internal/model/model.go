// Package model maps the app_pay tables owned by app-pay (Java,
// app-pay/src/main/resources/schema.sql) plus the admin's own account table.
//
// pay_* models are plain row mappings: nullable columns are pointers, money is
// long cents, time is DATETIME(6) read with loc=Local (Asia/Shanghai, matching
// app-pay's pinned JVM timezone). They are deliberately EXCLUDED from
// db.Migrate — the Java service owns that schema.
package model

import "time"

// PayOrder maps pay_order. Read-only for this service.
//
// State machine (Java PayOrder): CREATED -> PAID -> DELIVERED;
// CREATED -> CLOSED; CLOSED -> PAID (reopen); REFUNDING/REFUNDED reserved M4.
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
// (service.GrantService), which mirrors app-pay MembershipService.extend.
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
// audit stream (ACTIVATE / RENEW / ADMIN_GRANT / REFUND_REVOKE[M4]).
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

// PayProduct maps pay_product (SKU catalog, read-only in phase 1).
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

// PayAdminUser is the admin console's own account store (bcrypt; seeded with a
// default admin on first boot). This is the ONLY table this service migrates.
type PayAdminUser struct {
	ID           int64     `gorm:"column:id;primaryKey;autoIncrement" json:"-"`
	Username     string    `gorm:"column:username;type:varchar(64);not null;uniqueIndex"`
	PasswordHash string    `gorm:"column:password_hash;type:varchar(100);not null" json:"-"`
	Role         string    `gorm:"column:role;type:varchar(20);not null;default:viewer"` // admin / viewer
	CreatedAt    time.Time `gorm:"column:created_at;not null;autoCreateTime"`
}

func (PayAdminUser) TableName() string { return "payadmin_user" }
