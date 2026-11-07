package main

import (
	"context"
	"log/slog"
	"time"

	"gorm.io/gorm"
)

// startCleanup runs the retention jobs shortly after boot and then once a day.
// The tables involved grow forever otherwise (sessions are issued per login,
// verification codes per send, login attempts per attempt, ASR tasks per page).
func startCleanup(ctx context.Context, authDB, biliDB *gorm.DB) {
	go func() {
		timer := time.NewTimer(10 * time.Minute)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
				runCleanup(ctx, authDB, biliDB)
				timer.Reset(24 * time.Hour)
			}
		}
	}()
}

// runCleanup deletes only rows that are clearly past their retention window:
//   - user_tokens: expired > 7d (or revoked > 30d) — PK lookups stay fast
//   - verification_codes: expired > 7d
//   - login_attempts: audit rows > 90d
//   - async_tasks: app-user-owned asr/build rows completed > 30d
//     (the shared table also holds AI-stack vec_page rows; those are untouched)
func runCleanup(ctx context.Context, authDB, biliDB *gorm.DB) {
	jobs := []struct {
		name string
		db   *gorm.DB
		sql  string
	}{
		{"user_tokens", authDB, "DELETE FROM user_tokens WHERE " +
			"(expires_at IS NOT NULL AND expires_at < UTC_TIMESTAMP() - INTERVAL 7 DAY) " +
			"OR (is_revoked = 1 AND deleted_at IS NOT NULL AND deleted_at < UTC_TIMESTAMP() - INTERVAL 30 DAY)"},
		{"verification_codes", authDB,
			"DELETE FROM verification_codes WHERE expires_at < UTC_TIMESTAMP() - INTERVAL 7 DAY"},
		{"login_attempts", authDB,
			"DELETE FROM login_attempts WHERE created_at < UTC_TIMESTAMP() - INTERVAL 90 DAY"},
		{"user_security_events", authDB,
			"DELETE FROM user_security_events WHERE created_at < UTC_TIMESTAMP() - INTERVAL 365 DAY"},
		{"user_password_history", authDB,
			"DELETE FROM user_password_history WHERE created_at < UTC_TIMESTAMP() - INTERVAL 365 DAY"},
		{"async_tasks", biliDB, "DELETE FROM async_tasks WHERE completed_at IS NOT NULL " +
			"AND completed_at < UTC_TIMESTAMP() - INTERVAL 30 DAY AND task_type IN ('asr','build')"},
	}
	for _, job := range jobs {
		res := job.db.WithContext(ctx).Exec(job.sql)
		if res.Error != nil {
			slog.Warn("[CLEANUP] delete failed", "table", job.name, "err", res.Error)
			continue
		}
		if res.RowsAffected > 0 {
			slog.Info("[CLEANUP] deleted expired rows", "table", job.name, "rows", res.RowsAffected)
		}
	}
}
