// Package service: membership grant (运营补偿开通).
//
// This REPLICATES app-pay MembershipService.extend semantics (the Java grant
// path: extend(uid, days, null, ADMIN_GRANT, reason)) against the same
// pay_membership / pay_membership_event rows, because app-pay-admin writes the
// app_pay database directly:
//
//	SELECT ... FOR UPDATE the member row (serialize concurrent deliveries)
//	membership == nil  -> expireBefore = now, create row (tier=VIP)
//	else               -> expireBefore = expire_at
//	base   = expireBefore > now ? expireBefore : now   (未到期顺延 / 已过期从 now 起算)
//	after  = base + days
//	write pay_membership + pay_membership_event(type=ADMIN_GRANT) in ONE tx
//
// Deviations from the Java write path (both deliberate, both documented):
//   - last_order_no is preserved on update (MyBatis-Plus updateById ignores
//     null fields, so Java's setLastOrderNo(null) never actually clears it —
//     this service matches that observable behavior).
//   - the operator identity rides inside event.reason as "[<username>] ..."
//     (the table has no operator column and the Java schema must not drift).
package service

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"app-pay-admin/internal/db"
	"app-pay-admin/internal/model"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// GrantService performs the controlled membership write.
type GrantService struct {
	audit *Audit
}

func NewGrantService(audit *Audit) *GrantService {
	return &GrantService{audit: audit}
}

// GrantResult reports what the grant did (for the API response + audit).
type GrantResult struct {
	Membership *model.PayMembership
	Before     time.Time // expire_before snapshot (== now for a fresh member)
	After      time.Time // expire_after
	Created    bool      // membership row did not exist before
}

// Grant extends uid's membership by days days. Validation of the request
// happens at the router; this method is purely the transactional write.
func (g *GrantService) Grant(ctx context.Context, operator string, uid int64, days int, reason string, tier string) (*GrantResult, error) {
	var res *GrantResult
	err := db.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var m model.PayMembership
		err := withRowLock(tx).Where("uid = ?", uid).First(&m).Error
		now := time.Now()
		expireBefore := now
		created := false
		if errors.Is(err, gorm.ErrRecordNotFound) {
			created = true
			if tier == "" {
				tier = "VIP"
			}
			m = model.PayMembership{UID: uid, Tier: tier, CreatedAt: now, UpdatedAt: now}
		} else if err != nil {
			return err
		} else {
			expireBefore = m.ExpireAt
		}

		base := expireBefore
		if !expireBefore.After(now) {
			base = now
		}
		after := base.AddDate(0, 0, days)

		if created {
			m.ExpireAt = after
			if err := tx.Create(&m).Error; err != nil {
				return err
			}
		} else {
			// Preserve last_order_no: Java's grant never clears it either.
			// tier: explicit value overrides (SVIP grants on existing VIPs).
			updates := map[string]any{"expire_at": after, "updated_at": now}
			if tier != "" {
				updates["tier"] = tier
			}
			if err := tx.Model(&m).Updates(updates).Error; err != nil {
				return err
			}
			m.ExpireAt = after
			if tier != "" {
				m.Tier = tier
			}
		}

		finalReason := "[" + operator + "] " + reason
		ev := model.PayMembershipEvent{
			UID:          uid,
			Type:         "ADMIN_GRANT",
			Days:         days,
			ExpireBefore: expireBefore,
			ExpireAfter:  after,
			Reason:       &finalReason,
			CreatedAt:    now,
		}
		if err := tx.Create(&ev).Error; err != nil {
			return err
		}

		res = &GrantResult{Membership: &m, Before: expireBefore, After: after, Created: created}
		return nil
	})
	if err != nil {
		return nil, err
	}

	g.audit.Log("MEMBERSHIP_EXTENDED",
		"operator", operator,
		"uid", uid,
		"days", days,
		"expire_before", res.Before.Format(time.RFC3339),
		"expire_after", res.After.Format(time.RFC3339),
		"created", res.Created,
		"source", "app-pay-admin",
	)
	slog.Info("[GRANT] membership extended",
		"operator", operator,
		"uid", uid,
		"days", days,
		"expire_before", res.Before.Format(time.RFC3339),
		"expire_after", res.After.Format(time.RFC3339),
		"created", res.Created,
	)
	return res, nil
}

// withRowLock adds SELECT ... FOR UPDATE on MySQL. SQLite (the unit-test DB)
// has no FOR UPDATE syntax and runs single-connection anyway, so the clause is
// skipped there; production is MySQL-only.
func withRowLock(tx *gorm.DB) *gorm.DB {
	if tx.Dialector != nil && tx.Dialector.Name() == "mysql" {
		return tx.Clauses(clause.Locking{Strength: "UPDATE"})
	}
	return tx
}
