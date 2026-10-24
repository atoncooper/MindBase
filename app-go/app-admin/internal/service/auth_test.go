// Auth service guard tests: the login throttle (10 failed logins / minute /
// IP, plan/1.0.16 section 5) and the change-password gates. All memory-only —
// no DB connection involved (the length gate short-circuits before bcrypt /
// repo, and a zero-value bcrypt comparison fails without touching the DB).
package service

import (
	"errors"
	"testing"

	"app-admin/internal/model"
	"app-admin/internal/repo"
)

func TestLoginThrottleTenFailsPerIPPerMinute(t *testing.T) {
	a := NewAuthService(0)
	ip := "10.0.0.1"
	for i := 0; i < 10; i++ {
		a.Fail(ip)
	}
	if a.Allow(ip) {
		t.Fatal("after 10 failures the IP must be throttled")
	}
	// Another IP is unaffected.
	if !a.Allow("10.0.0.2") {
		t.Fatal("throttle must be per-IP")
	}
	// A success resets the counter.
	a.Reset(ip)
	if !a.Allow(ip) {
		t.Fatal("Reset must clear the failure budget")
	}
}

func TestChangePasswordGatesBeforeDB(t *testing.T) {
	a := NewAuthService(0)
	user := &model.AdminUser{Username: "admin", PasswordHash: "$2a$10$0123456789012345678901u"}

	// The weak-password gate must fire BEFORE the old-password check.
	err := a.ChangePassword(user, "anything", "short")
	if !errors.Is(err, repo.ErrWeakPassword) {
		t.Fatalf("short new password must be rejected with ErrWeakPassword, got %v", err)
	}

	// A wrong old password fails without any DB write (no side effects here:
	// SetUserPassword is only reached after bcrypt passes).
	err = a.ChangePassword(user, "wrong-old", "long-enough-pass")
	if !errors.Is(err, repo.ErrWrongOldPass) {
		t.Fatalf("wrong old password must be rejected with ErrWrongOldPass, got %v", err)
	}
}
