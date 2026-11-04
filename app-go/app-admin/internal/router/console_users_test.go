package router

// Console account management tests: admin-only /api/console/users
// lifecycle, validation, audit trail, forced password change + session
// invalidation, self-delete / last-admin guards, and independence from the
// payment database.

import (
	"fmt"
	"net/http"
	"strings"
	"testing"

	"app-admin/internal/db"
	"app-admin/internal/model"
)

func TestConsoleUsersLifecycle(t *testing.T) {
	// Payment DB deliberately disabled: account management must keep working.
	env := newPayTestEnv(t, payTestOptions{payDisabled: true})

	// List: the seeded admin only, username ASC, no secrets in the payload.
	w := env.do(t, http.MethodGet, "/api/console/users", "")
	if w.Code != http.StatusOK {
		t.Fatalf("list console users: got %d, body %s", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), "password") {
		t.Fatalf("console user list must never expose password material: %s", w.Body.String())
	}
	type userList struct {
		Items []struct {
			ID                 int64   `json:"id"`
			Username           string  `json:"username"`
			Role               string  `json:"role"`
			MustChangePassword bool    `json:"mustChangePassword"`
			LastLoginAt        *string `json:"lastLoginAt"`
			CreatedAt          *string `json:"createdAt"`
		} `json:"items"`
	}
	var list userList
	decodeJSON(t, w.Body.String(), &list)
	if len(list.Items) != 1 || list.Items[0].Username != "admin" || list.Items[0].Role != "admin" ||
		!list.Items[0].MustChangePassword || list.Items[0].LastLoginAt == nil {
		t.Fatalf("seeded admin list: %s", w.Body.String())
	}
	adminID := list.Items[0].ID

	// Create a viewer (role defaults to viewer when omitted).
	w = env.do(t, http.MethodPost, "/api/console/users",
		`{"username":"ops-viewer","password":"viewer-pass-123"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("create viewer: got %d, body %s", w.Code, w.Body.String())
	}
	var created struct {
		ID       int64  `json:"id"`
		Username string `json:"username"`
		Role     string `json:"role"`
	}
	decodeJSON(t, w.Body.String(), &created)
	if created.Username != "ops-viewer" || created.Role != "viewer" || created.ID <= 0 {
		t.Fatalf("create response: %s", w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"role":"viewer"`) {
		t.Fatalf("default role must be viewer: %s", w.Body.String())
	}
	var row model.AdminUser
	if err := db.DB.First(&row, created.ID).Error; err != nil {
		t.Fatalf("load created account: %v", err)
	}
	if !row.MustChangePassword {
		t.Fatal("console-created accounts must change password on first login")
	}

	// Duplicate username -> 409.
	if w := env.do(t, http.MethodPost, "/api/console/users",
		`{"username":"ops-viewer","password":"viewer-pass-123"}`); w.Code != http.StatusConflict ||
		w.Body.String() != `{"detail":"username already exists"}` {
		t.Fatalf("duplicate username: got %d %s", w.Code, w.Body.String())
	}

	// Validation errors -> 400.
	for _, body := range []string{
		`{"username":"x","password":"viewer-pass-123"}`,                               // username too short
		`{"username":"` + strings.Repeat("x", 65) + `","password":"viewer-pass-123"}`, // too long
		`{"username":"ok-user","password":"short"}`,                                   // password too short
		`{"username":"ok-user","password":"` + strings.Repeat("x", 129) + `"}`,        // too long
		`{"username":"ok-user","password":"viewer-pass-123","role":"superuser"}`,
		`{}`,
	} {
		if w := env.do(t, http.MethodPost, "/api/console/users", body); w.Code != http.StatusBadRequest {
			t.Fatalf("invalid create %q: got %d, want 400 (body %s)", body, w.Code, w.Body.String())
		}
	}

	// The viewer can log in; resetting the password invalidates that session.
	viewer := loginAs(t, env.engine, "ops-viewer", "viewer-pass-123")
	w = env.do(t, http.MethodPost, fmt.Sprintf("/api/console/users/%d/password", created.ID),
		`{"password":"new-pass-456"}`)
	if w.Code != http.StatusOK || w.Body.String() != `{"ok":true}` {
		t.Fatalf("reset password: got %d %s", w.Code, w.Body.String())
	}
	// Reset forces a password change and drops every session of the account.
	var reset model.AdminUser
	if err := db.DB.First(&reset, created.ID).Error; err != nil {
		t.Fatalf("load reset account: %v", err)
	}
	if !reset.MustChangePassword {
		t.Fatal("reset password must force must_change_password=true")
	}
	if w := apiDo(env.engine, http.MethodGet, "/api/me", "", viewer); w.Code != http.StatusUnauthorized {
		t.Fatalf("old session must be invalidated by a password reset, got %d", w.Code)
	}
	// The new password works.
	loginAs(t, env.engine, "ops-viewer", "new-pass-456")
	// Unknown account -> 404.
	if w := env.do(t, http.MethodPost, "/api/console/users/99999/password",
		`{"password":"new-pass-456"}`); w.Code != http.StatusNotFound {
		t.Fatalf("reset unknown account: got %d, want 404", w.Code)
	}
	if w := env.do(t, http.MethodPost, fmt.Sprintf("/api/console/users/%d/password", created.ID),
		`{"password":"short"}`); w.Code != http.StatusBadRequest {
		t.Fatalf("weak reset password: got %d, want 400", w.Code)
	}

	// Self-deletion is refused.
	if w := env.do(t, http.MethodDelete, fmt.Sprintf("/api/console/users/%d", adminID), ""); w.Code != http.StatusBadRequest ||
		!strings.Contains(w.Body.String(), "cannot delete your own account") {
		t.Fatalf("delete self: got %d %s", w.Code, w.Body.String())
	}

	// Delete the viewer: row and sessions both disappear.
	if w := env.do(t, http.MethodDelete, fmt.Sprintf("/api/console/users/%d", created.ID), ""); w.Code != http.StatusOK ||
		w.Body.String() != `{"ok":true}` {
		t.Fatalf("delete viewer: got %d %s", w.Code, w.Body.String())
	}
	var n int64
	if err := db.DB.Model(&model.AdminUser{}).Where("id = ?", created.ID).Count(&n).Error; err != nil {
		t.Fatalf("count deleted account: %v", err)
	}
	if n != 0 {
		t.Fatal("deleted console account must be gone")
	}
	if err := db.DB.Model(&model.AdminSession{}).Where("admin_user_id = ?", created.ID).Count(&n).Error; err != nil {
		t.Fatalf("count sessions: %v", err)
	}
	if n != 0 {
		t.Fatal("deleted console account must have no sessions left")
	}
	if w := env.do(t, http.MethodDelete, fmt.Sprintf("/api/console/users/%d", created.ID), ""); w.Code != http.StatusNotFound {
		t.Fatalf("delete missing account: got %d, want 404", w.Code)
	}

	// The ledger captured every mutation.
	var audits []model.AdminAudit
	if err := db.DB.Where("action IN ?", []string{"account_create", "account_password_reset", "account_delete"}).
		Find(&audits).Error; err != nil {
		t.Fatalf("query account audits: %v", err)
	}
	var actions []string
	for _, a := range audits {
		actions = append(actions, a.Action)
		if a.TargetType == nil || *a.TargetType != "admin_user" || a.TargetID == nil {
			t.Fatalf("account audit row shape: %+v", a)
		}
		// The ledger must attribute account changes to the ACTING admin, not
		// to the created/reset/deleted target account.
		if a.AdminName != "admin" {
			t.Fatalf("account audit admin_name = %q, want acting admin admin (%+v)", a.AdminName, a)
		}
	}
	for _, want := range []string{"account_create", "account_password_reset", "account_delete"} {
		if !contains(actions, want) {
			t.Fatalf("missing %s in account audits: %+v", want, actions)
		}
	}
}

func TestConsoleUsersAdminOnly(t *testing.T) {
	env := newPayTestEnv(t, payTestOptions{payDisabled: true})
	if w := env.do(t, http.MethodPost, "/api/console/users",
		`{"username":"plain-viewer","password":"viewer-pass-123","role":"viewer"}`); w.Code != http.StatusOK {
		t.Fatalf("seed viewer: got %d", w.Code)
	}
	viewer := loginAs(t, env.engine, "plain-viewer", "viewer-pass-123")

	for _, route := range []struct {
		method, path, body string
	}{
		{http.MethodGet, "/api/console/users", ""},
		{http.MethodPost, "/api/console/users", `{"username":"x2","password":"x2-pass-123"}`},
		{http.MethodPost, "/api/console/users/1/password", `{"password":"x2-pass-123"}`},
		{http.MethodDelete, "/api/console/users/1", ""},
	} {
		if w := apiDo(env.engine, route.method, route.path, route.body, viewer); w.Code != http.StatusForbidden {
			t.Fatalf("%s %s as viewer: got %d, want 403", route.method, route.path, w.Code)
		}
	}
}
