package router

// Tests for the cluster join security surface: admin gating on the roster,
// node_id charset (log-injection / identifier-safety), and the weight cap.

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"app-task/internal/repo"
)

// memberHeaders registers a member-role user and returns session headers.
func memberHeaders(t *testing.T, h http.Handler, username, password string) map[string]string {
	t.Helper()
	if _, err := repo.CreateUser(username, password, "member"); err != nil {
		t.Fatal(err)
	}
	body := `{"username":"` + username + `","password":"` + password + `"}`
	w := doJSON(h, "POST", "/api/login", body, nil)
	sid := sessionFromCookie(w)
	if sid == "" {
		t.Fatal("member login returned no session cookie")
	}
	return map[string]string{"Cookie": webuiSessionCookie + "=" + sid}
}

func TestClusterRosterAdminGate(t *testing.T) {
	_, h := newTestRouter(t)
	admin := adminHeaders(t, h)

	// member 角色不能看名册（主机名/版本/拓扑是内部信息）
	member := memberHeaders(t, h, "member-1", "password-1")
	if w := doJSON(h, "GET", "/api/cluster", "", member); w.Code != http.StatusForbidden {
		t.Fatalf("member GET /api/cluster = %d, want 403", w.Code)
	}
	if w := doJSON(h, "GET", "/console/cluster", "", member); w.Code != http.StatusSeeOther {
		t.Fatalf("member cluster page = %d, want 303 (admin gate flash redirect)", w.Code)
	}
	if w := doJSON(h, "GET", "/api/cluster", "", admin); w.Code != http.StatusOK {
		t.Fatalf("admin GET /api/cluster = %d", w.Code)
	}
	// 控制台页面 admin 可见
	if w := doJSON(h, "GET", "/console/cluster", "", admin); w.Code != http.StatusOK {
		t.Fatalf("admin cluster page = %d", w.Code)
	}
}

func TestClusterJoinValidation(t *testing.T) {
	_, h := newTestRouter(t)
	admin := adminHeaders(t, h)
	form := map[string]string{
		"Content-Type": "application/json",
		"Cookie":       admin["Cookie"],
	}
	doJoin := func(body string) *httptest.ResponseRecorder {
		return doJSON(h, "POST", "/api/cluster/join", body, form)
	}

	// 非法 node_id 字符集（换行=日志注入；空格/特殊符号=标识符污染）
	for _, bad := range []string{
		`{"node_id":"bad\ninjected","weight":1}`,
		`{"node_id":"bad id with space","weight":1}`,
		`{"node_id":"-starts-dash","weight":1}`,
		`{"node_id":"n","weight":1}`,
	} {
		if w := doJoin(bad); w.Code != http.StatusBadRequest {
			t.Fatalf("bad node_id %s: status = %d, want 400", bad, w.Code)
		}
	}
	// weight 上限（防加权算术溢出）
	if w := doJoin(`{"node_id":"heavy","weight":1000000}`); w.Code != http.StatusBadRequest {
		t.Fatalf("overweight join = %d, want 400", w.Code)
	}
	// 合法加入成功
	if w := doJoin(`{"node_id":"worker-3","weight":4,"via":"cli"}`); w.Code != http.StatusOK {
		t.Fatalf("valid join = %d body %s", w.Code, w.Body.String())
	}
	// member 不能 join
	member := memberHeaders(t, h, "member-2", "password-2")
	if w := doJSON(h, "POST", "/api/cluster/join", `{"node_id":"worker-9","weight":1}`, member); w.Code != http.StatusForbidden {
		t.Fatalf("member join = %d, want 403", w.Code)
	}
}
