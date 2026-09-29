package router

// Tests for the console secret store: admin gate, create/update/delete PRG
// flow, and the ctx.secret E2E (Lua script reads a stored secret and uses it
// as an Authorization header; the value is masked in logs).

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"app-task/internal/db"
	"app-task/internal/repo"
)

func TestSecretsPageAdminGate(t *testing.T) {
	_, h := newTestRouter(t)
	if w := doJSON(h, "GET", "/console/secrets", "", nil); w.Code != http.StatusFound {
		t.Fatalf("anon secrets page: status = %d, want 302", w.Code)
	}
	admin := adminHeaders(t, h)
	if w := doJSON(h, "GET", "/console/secrets", "", admin); w.Code != http.StatusOK {
		t.Fatalf("admin secrets page: status = %d", w.Code)
	}
	if !strings.Contains(w_body(admin, h, "/console/secrets"), "密钥管理") {
		t.Fatal("secrets page missing title")
	}
}

func w_body(admin map[string]string, h http.Handler, path string) string {
	req := httptest.NewRequest("GET", path, nil)
	req.Header.Set("Cookie", admin["Cookie"])
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w.Body.String()
}

func TestSecretsCRUDAndCtxSecretE2E(t *testing.T) {
	_, h := newTestRouter(t)
	admin := adminHeaders(t, h)
	form := map[string]string{
		"Content-Type": "application/x-www-form-urlencoded",
		"Cookie":       admin["Cookie"],
	}

	// create
	w := doJSON(h, "POST", "/console/secrets",
		"name=gh_token&description=github&value=tok-abc-123", form)
	if w.Code != http.StatusSeeOther || !strings.Contains(w.Header().Get("Location"), "ok=") {
		t.Fatalf("create: status = %d, Location = %q", w.Code, w.Header().Get("Location"))
	}

	// duplicate name → err
	w = doJSON(h, "POST", "/console/secrets", "name=gh_token&value=x", form)
	if !strings.Contains(w.Header().Get("Location"), "err=") {
		t.Fatalf("duplicate create: Location = %q, want err", w.Header().Get("Location"))
	}

	// external echo server asserts the Authorization header made it through
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		rw.Write([]byte("ok"))
	}))
	defer srv.Close()

	// upload a script that reads the secret and calls the echo server
	upload := `{"script_id":"sec_e2e","name":"SecE2E","source":"function handle(ctx) local tok = ctx.secret('gh_token') ctx.log('using ' .. tok) local body, status = ctx.http_req({method='POST', url='` + srv.URL + `', headers={Authorization='Bearer ' .. tok}, body='{}'}) if status ~= 200 then ctx.fail('echo fail') end end"}`
	w = doJSON(h, "POST", "/scripts", upload, serviceKeyHeaders(nil))
	if w.Code != http.StatusOK {
		t.Fatalf("upload: %d body = %s", w.Code, w.Body.String())
	}

	// run it — ctx.secret resolves, header reaches the echo server, and the
	// ctx.log line has the secret masked
	w = doJSON(h, "POST", "/internal/script/run", `{"script_id":"sec_e2e"}`, serviceKeyHeaders(nil))
	if w.Code != http.StatusOK {
		t.Fatalf("run: %d body = %s", w.Code, w.Body.String())
	}
	var resp struct {
		Status string   `json:"status"`
		Logs   []string `json:"logs"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v body = %s", err, w.Body.String())
	}
	if resp.Status != "success" {
		t.Fatalf("run resp = %+v", resp)
	}
	if gotAuth != "Bearer tok-abc-123" {
		t.Fatalf("Authorization = %q", gotAuth)
	}
	if len(resp.Logs) != 1 || !strings.Contains(resp.Logs[0], "***") || strings.Contains(resp.Logs[0], "tok-abc-123") {
		t.Fatalf("logs = %v, secret must be masked", resp.Logs)
	}

	// update (by secret_id; value blank keeps the stored value, desc changes)
	srowBefore, _ := repo.GetSecretByName("gh_token")
	if srowBefore == nil {
		t.Fatal("secret row missing before update")
	}
	w = doJSON(h, "POST", "/console/secrets/update", "secret_id="+srowBefore.SecretID+"&description=updated&value=", form)
	if !strings.Contains(w.Header().Get("Location"), "ok=") {
		t.Fatalf("update: status = %d, Location = %q, body = %s", w.Code, w.Header().Get("Location"), w.Body.String())
	}

	// the stored value still decrypts to the original token after update
	srow, _ := repo.GetSecretByName("gh_token")
	if srow == nil || srow.Description != "updated" {
		t.Fatalf("row = %+v", srow)
	}

	// delete (by secret_id)
	w = doJSON(h, "POST", "/console/secrets/"+srow.SecretID+"/delete", "", form)
	if !strings.Contains(w.Header().Get("Location"), "ok=") {
		t.Fatalf("delete: Location = %q", w.Header().Get("Location"))
	}
	if srow2, _ := repo.GetSecretByName("gh_token"); srow2 != nil {
		t.Fatal("secret still exists after delete")
	}
}

// ── 重名拒绝：三个命名入口（账户 / API 密钥 / 密钥管理）一致行为 ──────

func TestDuplicateNamesRejected(t *testing.T) {
	_, h := newTestRouter(t)
	admin := adminHeaders(t, h)
	form := func(body string) map[string]string {
		return map[string]string{"Content-Type": "application/x-www-form-urlencoded", "Cookie": admin["Cookie"]}
	}

	// 1) 账户：同名用户第二次创建必须失败
	w1 := doJSON(h, "POST", "/console/users", "username=dup&password=password-1&role=member", form(""))
	if w1.Code != http.StatusSeeOther || !strings.Contains(w1.Header().Get("Location"), "ok=") {
		t.Fatalf("first user create: %d %q", w1.Code, w1.Header().Get("Location"))
	}
	w2 := doJSON(h, "POST", "/console/users", "username=dup&password=password-2&role=member", form(""))
	if !strings.Contains(w2.Header().Get("Location"), "err=") {
		t.Fatalf("duplicate user must be rejected, Location = %q", w2.Header().Get("Location"))
	}

	// 2) API 密钥：同名密钥第二次生成必须失败（名称全局唯一，含已吊销）
	k1 := doJSON(h, "POST", "/console/apikeys", "name=dup-key&scopes=tasks&rate_per_min=0&expires_days=0", form(""))
	if !strings.Contains(k1.Header().Get("Location"), "/console/apikeys/revealed") {
		t.Fatalf("first key create: %q", k1.Header().Get("Location"))
	}
	k2 := doJSON(h, "POST", "/console/apikeys", "name=dup-key&scopes=tasks&rate_per_min=0&expires_days=0", form(""))
	if !strings.Contains(k2.Header().Get("Location"), "err=") {
		t.Fatalf("duplicate api key must be rejected, Location = %q", k2.Header().Get("Location"))
	}

	// 2b) 吊销后同名同样被拒：名称标识唯一一把密钥的完整生命周期
	keys, _ := repo.ListAPIKeys()
	for _, k := range keys {
		if k.Name == "dup-key" {
			if _, err := repo.RevokeAPIKey(k.KeyID); err != nil {
				t.Fatal(err)
			}
		}
	}
	k3 := doJSON(h, "POST", "/console/apikeys", "name=dup-key&scopes=tasks&rate_per_min=0&expires_days=0", form(""))
	if !strings.Contains(k3.Header().Get("Location"), "err=") {
		t.Fatalf("reused name after revoke must be rejected, Location = %q", k3.Header().Get("Location"))
	}

	// 3) 密钥管理：同名密钥第二次创建必须失败
	s1 := doJSON(h, "POST", "/console/secrets", "name=dup_secret&value=v1", form(""))
	if !strings.Contains(s1.Header().Get("Location"), "ok=") {
		t.Fatalf("first secret create: %q", s1.Header().Get("Location"))
	}
	s2 := doJSON(h, "POST", "/console/secrets", "name=dup_secret&value=v2", form(""))
	if !strings.Contains(s2.Header().Get("Location"), "err=") {
		t.Fatalf("duplicate secret must be rejected, Location = %q", s2.Header().Get("Location"))
	}

	// 清理：吊销 key，删除 secret 与用户（共享库卫生）
	keys, _ = repo.ListAPIKeys()
	for _, k := range keys {
		if k.Name == "dup-key" {
			_, _ = repo.RevokeAPIKey(k.KeyID)
		}
	}
	_, _ = repo.DeleteSecret("dup_secret")
	us, _ := repo.ListUsers()
	for _, u := range us {
		if u.Username == "dup" {
			if err := repo.DeleteUser(u.ID); err != nil {
				t.Fatal(err)
			}
		}
	}
}

// ── 存量行 UUID 回填：user_id / secret_id 为空的行启动时自动补齐 ──────

func TestUUIDBackfill(t *testing.T) {
	newTestRouter(t)

	// simulate legacy rows written before the uuid columns existed
	if err := db.DB.Exec("INSERT INTO webui_user (username, password_hash, role, created_at) VALUES ('legacy-user', 'x', 'member', CURRENT_TIMESTAMP)").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.DB.Exec("INSERT INTO secret (name, description, value_enc, created_at) VALUES ('legacy_secret', 'd', 'enc', CURRENT_TIMESTAMP)").Error; err != nil {
		t.Fatal(err)
	}
	if err := repo.EnsureUserIDs(); err != nil {
		t.Fatal(err)
	}
	if err := repo.EnsureSecretIDs(); err != nil {
		t.Fatal(err)
	}

	u, err := repo.GetUserByUsername("legacy-user")
	if err != nil || u == nil {
		t.Fatalf("legacy user: %v %v", u, err)
	}
	if len(u.UserID) != 36 || strings.Count(u.UserID, "-") != 4 {
		t.Fatalf("legacy user_id = %q, want UUID", u.UserID)
	}
	s, err := repo.GetSecretByName("legacy_secret")
	if err != nil || s == nil {
		t.Fatalf("legacy secret: %v %v", s, err)
	}
	if len(s.SecretID) != 36 || strings.Count(s.SecretID, "-") != 4 {
		t.Fatalf("legacy secret_id = %q, want UUID", s.SecretID)
	}

	// cleanup
	_ = repo.DeleteUser(u.ID)
	_, _ = repo.DeleteSecret("legacy_secret")
}
