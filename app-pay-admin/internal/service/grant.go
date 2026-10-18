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
	"fmt"
	"log/slog"
	"time"

	"app-pay-admin/internal/db"
	"app-pay-admin/internal/model"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// GrantCaps mirrors app-pay GrantQuotaService 的日额度（pay-admin 直写 DB，
// 必须自己执行同样的熔断，否则控制台的补偿开通绕过执行点）。0 = 不限该维度。
type GrantCaps struct {
	DailyMaxCount int
	DailyMaxDays  int
}

// GrantService performs the controlled membership write.
type GrantService struct {
	audit *Audit
	caps  GrantCaps
}

func NewGrantService(audit *Audit, caps GrantCaps) *GrantService {
	return &GrantService{audit: audit, caps: caps}
}

// GrantResult reports what the grant did (for the API response + audit).
type GrantResult struct {
	Membership *model.PayMembership
	Before     time.Time // expire_before snapshot (== now for a fresh member)
	After      time.Time // expire_after
	Created    bool      // membership row did not exist before
}

// DailyQuotaError — router maps to 429 with the reason.
type DailyQuotaError struct{ Msg string }

func (e *DailyQuotaError) Error() string { return e.Msg }

// checkDailyQuota counts ADMIN_GRANT events since local midnight (the same
// table+filter app-pay GrantQuotaService uses, served by the V4 index
// idx_pay_pme_type_created). Exceeding either cap aborts the grant.
func (g *GrantService) checkDailyQuota(ctx context.Context, requestedDays int) error {
	if g.caps.DailyMaxCount <= 0 && g.caps.DailyMaxDays <= 0 {
		return nil
	}
	now := time.Now()
	dayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	var count, totalDays int64
	if err := db.DB.WithContext(ctx).Raw(
		"SELECT COUNT(*), COALESCE(SUM(days), 0) FROM pay_membership_event "+
			"WHERE type = 'ADMIN_GRANT' AND created_at >= ?", dayStart,
	).Row().Scan(&count, &totalDays); err != nil {
		// 统计失败不阻塞资金写（与 app-pay 侧 fail-open 一致），但要留痕
		slog.Warn("[GRANT] daily quota query failed -- fail-open", "err", err)
		return nil
	}
	if g.caps.DailyMaxCount > 0 && count >= int64(g.caps.DailyMaxCount) {
		g.audit.Log("GRANT_DAILY_COUNT_EXCEEDED", "count", count, "max", g.caps.DailyMaxCount, "requested_days", requestedDays)
		return &DailyQuotaError{Msg: fmt.Sprintf("日补偿开通次数已达上限（%d/%d）", count, g.caps.DailyMaxCount)}
	}
	if g.caps.DailyMaxDays > 0 && totalDays+int64(requestedDays) > int64(g.caps.DailyMaxDays) {
		g.audit.Log("GRANT_DAILY_DAYS_EXCEEDED", "days", totalDays, "max", g.caps.DailyMaxDays, "requested_days", requestedDays)
		return &DailyQuotaError{Msg: fmt.Sprintf("日补偿开通天数已达上限（%d/%d）", totalDays, g.caps.DailyMaxDays)}
	}
	return nil
}

// Grant extends uid's membership by days days. Validation of the request
// happens at the router; this method is purely the transactional write.
func (g *GrantService) Grant(ctx context.Context, operator string, uid int64, days int, reason string, tier string) (*GrantResult, error) {
	if err := g.checkDailyQuota(ctx, days); err != nil {
		return nil, err
	}
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
