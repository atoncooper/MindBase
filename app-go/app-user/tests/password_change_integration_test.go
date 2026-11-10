package tests

import (
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"app-user/internal/config"
	authdb "app-user/internal/infra/db/auth"
	appmysql "app-user/internal/infra/mysql"
	"app-user/internal/infra/security"
	authmodel "app-user/internal/model/auth"
	authrepo "app-user/internal/repo/auth"
	authservice "app-user/internal/service/auth"
)

// TestPasswordChangeIntegration is a real-MySQL integration test for the
// credential-rotation path (history reuse, policy, persistence). It is skipped
// unless APPUSER_TEST_MYSQL_DSN is set, e.g.:
//
//	APPUSER_TEST_MYSQL_DSN='mysql://mind_base:mind-base@127.0.0.1:3306/mind_base' //	  go test ./tests -run TestPasswordChangeIntegration -v
//
// It creates and removes a unique throwaway user; do not point it at a database
// whose schema you cannot migrate.
func TestPasswordChangeIntegration(t *testing.T) {
	dsn := os.Getenv("APPUSER_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Skip("APPUSER_TEST_MYSQL_DSN not set; skipping MySQL integration test")
	}
	db, err := appmysql.Init(dsn, 5, 2, 60, 0, false)
	if err != nil {
		t.Fatalf("connect mysql: %v", err)
	}
	defer func() { _ = appmysql.Close(db) }()
	authdb.Use(db)
	if err := authdb.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	uid := time.Now().UnixNano()
	email := fmt.Sprintf("pwd-integration-%d@example.com", uid)
	oldHash, err := security.HashPassword("OldPass123")
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	status, verified := "active", true
	user := &authmodel.User{UID: uid, Status: &status, Email: &email, PasswordHash: &oldHash, EmailVerified: &verified}
	if err := authrepo.NewUserRepo().Create(db, user, nil); err != nil {
		t.Fatalf("create user: %v", err)
	}
	// Registered after the Close defer above, so it runs first (LIFO).
	defer func() {
		_ = db.Exec("DELETE FROM user_security_events WHERE uid = ?", uid).Error
		_ = db.Exec("DELETE FROM user_password_history WHERE uid = ?", uid).Error
		_ = db.Exec("DELETE FROM users WHERE uid = ?", uid).Error
	}()

	svc := authservice.NewAuthService(db, &config.AuthConfig{}, nil, nil, nil,
		authservice.NewRBACService(db), nil, nil)

	if err := svc.ChangePassword(uid, "OldPass123", "NewPass456"); err != nil {
		t.Fatalf("change password: %v", err)
	}
	u, err := authrepo.NewUserRepo().GetByUID(db, uid)
	if err != nil || u == nil || u.PasswordHash == nil {
		t.Fatalf("reload user: %v", err)
	}
	if !security.VerifyPassword("NewPass456", *u.PasswordHash) {
		t.Fatal("new password does not verify")
	}
	if security.VerifyPassword("OldPass123", *u.PasswordHash) {
		t.Fatal("old password still verifies")
	}

	// The previous hash was stored in history and must be rejected on reuse.
	err = svc.ChangePassword(uid, "NewPass456", "OldPass123")
	if !errors.Is(err, authservice.ErrPasswordReused) {
		t.Fatalf("reuse old password: want ErrPasswordReused, got %v", err)
	}

	// Reset path also applies policy + history checks and persists the hash.
	if err := svc.ResetPassword(uid, "Another789!"); err != nil {
		t.Fatalf("reset password: %v", err)
	}
	u, _ = authrepo.NewUserRepo().GetByUID(db, uid)
	if u == nil || u.PasswordHash == nil || !security.VerifyPassword("Another789!", *u.PasswordHash) {
		t.Fatal("reset password did not persist")
	}
	// Reset must also honor the history (NewPass456 was a previous password).
	if err := svc.ResetPassword(uid, "NewPass456"); !errors.Is(err, authservice.ErrPasswordReused) {
		t.Fatalf("reset to previous password: want ErrPasswordReused, got %v", err)
	}
}
