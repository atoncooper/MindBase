// Pay grant service: the ONLY fund write app-admin performs directly against
// app_pay (运营补偿开通).
//
// This REPLICATES app-pay MembershipService.extend semantics (the Java grant
// path: extend(uid, days, null, ADMIN_GRANT, reason)) against the same
// pay_membership / pay_membership_event rows:
//
//	SELECT ... FOR UPDATE the member row (serialize concurrent deliveries)
//	membership == nil  -> expireBefore = now, create row (tier=VIP or given)
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
//
// Three audit trails:
//  1. pay_membership_event.reason prefix — inside the fund transaction;
//  2. pay-audit.jsonl MEMBERSHIP_EXTENDED — durable fund trail (hash chain);
//  3. admin_audit action="pay_grant" — cross-database, best effort: the money
//     has already moved, so an audit failure is logged loudly, not returned.
package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"app-admin/internal/db"
	"app-admin/internal/model"
	"app-admin/internal/repo"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// GrantCaps mirrors app-pay GrantQuotaService 的日额度（app-admin 直写 DB，
// 必须自己执行同样的熔断，否则控制台的补偿开通绕过执行点）。0 = 不限该维度。
type GrantCaps struct {
	DailyMaxCount int
	DailyMaxDays  int
}

// PayGrantService performs the controlled membership write.
type PayGrantService struct {
	audit  *PayAudit
	caps   GrantCaps
	record AuditRecorder
}

// NewPayGrantService wires the production admin_audit recorder.
func NewPayGrantService(audit *PayAudit, caps GrantCaps) *PayGrantService {
	return &PayGrantService{audit: audit, caps: caps, record: repo.RecordAudit}
}

// NewPayGrantServiceWithAudit is the test seam: the router tests run against
// SQLite (no production ledger writer), so they inject a recorder.
func NewPayGrantServiceWithAudit(audit *PayAudit, caps GrantCaps, record AuditRecorder) *PayGrantService {
	return &PayGrantService{audit: audit, caps: caps, record: record}
}

// GrantResult reports what the grant did (for the API response + audit).
type GrantResult struct {
	Tier    string    // resulting tier (VIP when created without an explicit tier)
	Before  time.Time // expire_before snapshot (== now for a fresh member)
	After   time.Time // expire_after
	Created bool      // membership row did not exist before
}

// DailyQuotaError — the router maps it to 429 with the reason.
type DailyQuotaError struct{ Msg string }

func (e *DailyQuotaError) Error() string { return e.Msg }

// checkDailyQuota counts ADMIN_GRANT events since local midnight (the same
// table+filter app-pay GrantQuotaService uses, served by the V4 index
// idx_pay_pme_type_created). Exceeding either cap aborts the grant.
func (s *PayGrantService) checkDailyQuota(ctx context.Context, requestedDays int) error {
	if s.caps.DailyMaxCount <= 0 && s.caps.DailyMaxDays <= 0 {
		return nil
	}
	now := time.Now()
	dayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	var count, totalDays int64
	if err := db.PayDB.WithContext(ctx).Raw(
		"SELECT COUNT(*), COALESCE(SUM(days), 0) FROM pay_membership_event "+
			"WHERE type = 'ADMIN_GRANT' AND created_at >= ?", dayStart,
	).Row().Scan(&count, &totalDays); err != nil {
		// 统计失败不阻塞资金写（与 app-pay 侧 fail-open 一致），但要留痕。
		slog.Warn("[PAY_GRANT] daily quota query failed -- fail-open", "err", err)
		return nil
	}
	if s.caps.DailyMaxCount > 0 && count >= int64(s.caps.DailyMaxCount) {
		s.logAudit("GRANT_DAILY_COUNT_EXCEEDED", "count", count,
			"max", s.caps.DailyMaxCount, "requested_days", requestedDays)
		return &DailyQuotaError{Msg: fmt.Sprintf("日补偿开通次数已达上限（%d/%d）", count, s.caps.DailyMaxCount)}
	}
	if s.caps.DailyMaxDays > 0 && totalDays+int64(requestedDays) > int64(s.caps.DailyMaxDays) {
		s.logAudit("GRANT_DAILY_DAYS_EXCEEDED", "days", totalDays,
			"max", s.caps.DailyMaxDays, "requested_days", requestedDays)
		return &DailyQuotaError{Msg: fmt.Sprintf("日补偿开通天数已达上限（%d/%d）", totalDays, s.caps.DailyMaxDays)}
	}
	return nil
}

// Grant extends uid's membership by days days. Request validation (uid range,
// day cap, reason length, tier enum) happens at the router; this method is
// purely the transactional write.
func (s *PayGrantService) Grant(ctx context.Context, operator string, uid int64, days int, reason, tier string) (*GrantResult, error) {
	if err := s.checkDailyQuota(ctx, days); err != nil {
		return nil, err
	}
	var res *GrantResult
	err := db.PayDB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
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

		res = &GrantResult{Tier: m.Tier, Before: expireBefore, After: after, Created: created}
		return nil
	})
	if err != nil {
		return nil, err
	}

	uidText := strconv.FormatInt(uid, 10)
	s.logAudit("MEMBERSHIP_EXTENDED",
		"operator", operator,
		"uid", uidText,
		"days", days,
		"expire_before", res.Before.Format(time.RFC3339),
		"expire_after", res.After.Format(time.RFC3339),
		"created", res.Created,
		"source", "app-admin",
	)
	slog.Info("[PAY_GRANT] membership extended",
		"operator", operator,
		"uid", uid,
		"days", days,
		"expire_before", res.Before.Format(time.RFC3339),
		"expire_after", res.After.Format(time.RFC3339),
		"created", res.Created,
	)

	// admin_audit lives in the MAIN database: the grant transaction cannot span
	// both connections, so this is best effort — the fund write already
	// committed and must not be reported as failed because the ledger hiccuped.
	detail := fmt.Sprintf("days=%d tier=%s reason=%s", days, res.Tier, truncateRunes(reason, 200))
	if s.record == nil {
		slog.Warn("[PAY_GRANT] admin_audit recorder not configured", "uid", uid)
	} else if err := s.record(operator, "pay_grant", "membership", uidText, detail); err != nil {
		slog.Error("[PAY_GRANT] admin_audit write failed after grant committed",
			"operator", operator, "uid", uid, "err", err)
	}
	return res, nil
}

// logAudit appends one JSONL line when the sink is wired (tests may pass nil).
func (s *PayGrantService) logAudit(event string, kv ...any) {
	if s.audit == nil {
		return
	}
	s.audit.Log(event, kv...)
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
