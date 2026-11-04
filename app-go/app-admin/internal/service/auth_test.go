// Auth service guard tests: the login throttle (10 failed logins / minute /
// IP) and the change-password gates. All memory-only —
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

// The account budget is independent of the IP budget: rotating addresses does
// not reset it, and exhausting it does not block other accounts or unused IPs.
func TestAccountThrottleIsIndependentOfIP(t *testing.T) {
	a := NewAuthServiceWithLimits(0, LoginLimits{IPMax: 100, AccountMax: 3, AccountWindowSeconds: 900})

	for i, ip := range []string{"10.0.0.1", "10.0.0.2", "10.0.0.3"} {
		if !a.AllowAccount("Admin") {
			t.Fatalf("account budget exhausted too early at attempt %d", i)
		}
		a.Fail(ip)
		a.FailAccount("Admin")
	}
	// The account key is normalized (trim + lower), so the same account stays
	// throttled regardless of how the username is typed.
	if a.AllowAccount("  admin  ") {
		t.Fatal("account must be throttled after 3 failures across different IPs")
	}
	// Other accounts and unused addresses keep their own budgets.
	if !a.AllowAccount("other-admin") {
		t.Fatal("account throttle must be per-account")
	}
	if !a.Allow("10.0.0.4") {
		t.Fatal("IPs that never failed must keep their budget")
	}

	// ResetAccount clears only the account budget.
	a.ResetAccount("admin")
	if !a.AllowAccount("admin") {
		t.Fatal("ResetAccount must clear the account budget")
	}
	for i := 0; i < 100; i++ {
		a.Fail("10.0.0.9")
	}
	if a.Allow("10.0.0.9") {
		t.Fatal("IP budget must still stop a single address")
	}
}

// Zero / negative LoginLimits fall back to the documented defaults; explicit
// values replace them.
func TestLoginLimitsZeroValuesFallBackToDefaults(t *testing.T) {
	a := NewAuthServiceWithLimits(0, LoginLimits{})
	for i := 0; i < 10; i++ {
		a.Fail("192.0.2.1")
	}
	if a.Allow("192.0.2.1") {
		t.Fatal("default IP budget must block after 10 failures")
	}
	for i := 0; i < 10; i++ {
		a.FailAccount("admin")
	}
	if a.AllowAccount("admin") {
		t.Fatal("default account budget must block after 10 failures")
	}

	b := NewAuthServiceWithLimits(0, LoginLimits{IPMax: 2, AccountMax: 1, IPWindowSeconds: 30, AccountWindowSeconds: 60})
	b.Fail("ip")
	b.Fail("ip")
	if b.Allow("ip") {
		t.Fatal("explicit IPMax must replace the default")
	}
	b.FailAccount("root")
	if b.AllowAccount("ROOT") {
		t.Fatal("explicit AccountMax must replace the default")
	}

	c := NewAuthServiceWithLimits(0, LoginLimits{IPMax: -5, AccountMax: -1})
	for i := 0; i < 10; i++ {
		c.Fail("ip")
	}
	if c.Allow("ip") {
		t.Fatal("negative limits must fall back to the defaults")
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
