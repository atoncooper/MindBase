package service

// Console account-management rule tests: self-delete / last-admin guards,
// duplicate handling, password reset side effects (forced change + session
// invalidation) and validation windows. In-memory SQLite, no MySQL.

import (
	"errors"
	"testing"
	"time"

	"app-admin/internal/db"
	"app-admin/internal/model"
	"app-admin/internal/repo"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

func setupConsoleTestDB(t *testing.T) {
	t.Helper()
	prev := db.DB
	gdb, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	sqlDB, err := gdb.DB()
	if err != nil {
		t.Fatalf("sqlite handle: %v", err)
	}
	sqlDB.SetMaxOpenConns(1)
	if err := gdb.AutoMigrate(&model.AdminUser{}, &model.AdminSession{}, &model.AdminAudit{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	db.DB = gdb
	t.Cleanup(func() { db.DB = prev })
}

func seedConsoleUser(t *testing.T, username, password, role string) *model.AdminUser {
	t.Helper()
	u, err := repo.CreateAdminUser(username, password, role)
	if err != nil {
		t.Fatalf("seed console user %s: %v", username, err)
	}
	return u
}

func TestConsoleDeleteGuards(t *testing.T) {
	setupConsoleTestDB(t)
	admin := seedConsoleUser(t, "root-admin", "root-pass-123", repo.RoleAdmin)
	svc := NewConsoleUserService()

	// Last-admin guard: an actor id that is not the target (defensive path —
	// the HTTP route is admin-only, so this protects role transitions/races).
	// Only ONE admin exists at this point, so deletion must be refused.
	if err := svc.Delete(999, "root-admin", admin.ID); !errors.Is(err, ErrLastAdmin) {
		t.Fatalf("delete last admin: got %v, want ErrLastAdmin", err)
	}

	// Self-deletion refused even when several admins exist.
	other := seedConsoleUser(t, "second-admin", "second-pass-123", repo.RoleAdmin)
	if err := svc.Delete(other.ID, "root-admin", other.ID); !errors.Is(err, ErrCannotDeleteSelf) {
		t.Fatalf("self delete: got %v, want ErrCannotDeleteSelf", err)
	}

	// Deleting one of two admins is allowed.
	if err := svc.Delete(admin.ID, "root-admin", other.ID); err != nil {
		t.Fatalf("delete second admin: %v", err)
	}
	if u, _ := repo.GetUserByID(other.ID); u != nil {
		t.Fatal("deleted admin still present")
	}

	// Unknown account -> repo.ErrUserNotFound (404 at the boundary).
	if err := svc.Delete(admin.ID, "root-admin", 123456); !errors.Is(err, repo.ErrUserNotFound) {
		t.Fatalf("delete unknown: got %v, want ErrUserNotFound", err)
	}
}

func TestConsoleCreateAndResetRules(t *testing.T) {
	setupConsoleTestDB(t)
	svc := NewConsoleUserService()
	seedConsoleUser(t, "admin", "admin-pass-123", repo.RoleAdmin)

	// Default role is viewer; must_change_password is forced.
	created, err := svc.Create("root-admin", "ops-user", "ops-pass-123", "")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if created.Role != repo.RoleViewer {
		t.Fatalf("default role = %q, want viewer", created.Role)
	}
	row, _ := repo.GetUserByID(created.ID)
	if row == nil || !row.MustChangePassword {
		t.Fatal("created account must require a password change")
	}

	// Duplicate username -> repo.ErrUserExists.
	if _, err := svc.Create("root-admin", "ops-user", "ops-pass-123", ""); !errors.Is(err, repo.ErrUserExists) {
		t.Fatalf("duplicate create: got %v, want ErrUserExists", err)
	}

	// Validation windows (contract: username 2..64, password 8..128).
	cases := []struct {
		name, username, password, role string
		want                           error
	}{
		{"short username", "x", "ops-pass-123", "", ErrConsoleInvalidUsername},
		{"blank username", "   ", "ops-pass-123", "", ErrConsoleInvalidUsername},
		{"short password", "ok-name", "short", "", ErrConsoleInvalidPassword},
		{"long password", "ok-name", "0123456789" + "0123456789" + "0123456789" + "0123456789" +
			"0123456789" + "0123456789" + "0123456789" + "0123456789" + "0123456789" +
			"0123456789" + "0123456789" + "0123456789" + "0123456789", "", ErrConsoleInvalidPassword},
		{"bad role", "ok-name", "ops-pass-123", "superuser", ErrConsoleInvalidRole},
	}
	for _, tc := range cases {
		if _, err := svc.Create("root-admin", tc.username, tc.password, tc.role); !errors.Is(err, tc.want) {
			t.Fatalf("%s: got %v, want %v", tc.name, err, tc.want)
		}
	}

	// Reset password: forces a change and drops every session.
	if err := repo.CreateSession("tok-1", created.ID, "127.0.0.1", "ua", "", time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	if err := svc.ResetPassword("root-admin", created.ID, "brand-new-pass"); err != nil {
		t.Fatalf("reset password: %v", err)
	}
	row, _ = repo.GetUserByID(created.ID)
	if row == nil || !row.MustChangePassword {
		t.Fatal("reset must force must_change_password")
	}
	if bundle, _ := repo.GetSession("tok-1"); bundle != nil {
		t.Fatal("reset must invalidate existing sessions")
	}
	// Unknown account -> ErrUserNotFound.
	if err := svc.ResetPassword("root-admin", 424242, "brand-new-pass"); !errors.Is(err, repo.ErrUserNotFound) {
		t.Fatalf("reset unknown: got %v, want ErrUserNotFound", err)
	}
	// Weak reset password rejected before touching the row.
	if err := svc.ResetPassword("root-admin", created.ID, "short"); !errors.Is(err, ErrConsoleInvalidPassword) {
		t.Fatalf("weak reset: got %v, want ErrConsoleInvalidPassword", err)
	}
}
