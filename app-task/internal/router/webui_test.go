package router

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"app-task/internal/config"
	"app-task/internal/db"
	"app-task/internal/executor"
	"app-task/internal/model"
	"app-task/internal/repo"
	"app-task/internal/service"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

func setupWebUITestDB(t *testing.T) {
	t.Helper()
	gdb, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	sqlDB, _ := gdb.DB()
	sqlDB.SetMaxOpenConns(1)
	if err := gdb.AutoMigrate(&model.Task{}, &model.TaskLog{}, &model.EmailMessage{}, &model.Script{}, &model.ScriptLog{}, &model.WebUIUser{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	db.DB = gdb
}

// newWebUITestRouter builds a router with the webui enabled; set token to
// exercise the master-token API key. The console is always login-gated, so the
// default admin account is seeded on the (fresh) test DB.
func newWebUITestRouter(t *testing.T, token string) http.Handler {
	t.Helper()
	setupWebUITestDB(t)
	if err := repo.EnsureDefaultAdmin(); err != nil {
		t.Fatalf("seed admin: %v", err)
	}
	taskSvc := service.NewTaskService()
	cfg := &config.Config{}
	cfg.WebUI.Enabled = true
	cfg.WebUI.Token = token
	cfg.Security.CORS.AllowOrigins = []string{"*"}
	luaExec := executor.NewLuaExecutor(executor.LuaOptions{})
	emailSvc := service.NewEmailService(cfg)
	return New(taskSvc, emailSvc, luaExec, cfg)
}

func doJSON(h http.Handler, method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w
}

// adminHeaders returns a session-cookie header for the default admin account,
// logged in against the given router (each test router has its own session
// store, so the login must happen per instance).
func adminHeaders(t *testing.T, h http.Handler) map[string]string {
	t.Helper()
	w := doJSON(h, "POST", "/api/login", `{"username":"admin","password":"app-task-admin"}`, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("admin login: got %d, body %s", w.Code, w.Body.String())
	}
	sid := sessionFromCookie(w)
	if sid == "" {
		t.Fatal("admin login returned no session cookie")
	}
	return map[string]string{"Cookie": webuiSessionCookie + "=" + sid}
}

// sessionFromCookie extracts the session id from a login Set-Cookie header.
func sessionFromCookie(w *httptest.ResponseRecorder) string {
	ck := w.Header().Get("Set-Cookie")
	prefix := webuiSessionCookie + "="
	i := bytes.Index([]byte(ck), []byte(prefix))
	if i < 0 {
		return ""
	}
	rest := ck[i+len(prefix):]
	if j := bytes.IndexByte([]byte(rest), ';'); j >= 0 {
		rest = rest[:j]
	}
	return rest
}

// ── 静态页面 + 页面门禁 ────────────────────────────────────

func TestWebUIIndexServed(t *testing.T) {
	h := newWebUITestRouter(t, "")

	// Unauthenticated: redirect to /login; no app shell.
	if w := doJSON(h, "GET", "/", "", nil); w.Code != http.StatusFound {
		t.Fatalf("unauthenticated GET / status = %d, want 302", w.Code)
	}
	// Authenticated: app shell served.
	w := doJSON(h, "GET", "/", "", adminHeaders(t, h))
	if w.Code != http.StatusOK {
		t.Fatalf("GET / status = %d", w.Code)
	}
	if !bytes.Contains(w.Body.Bytes(), []byte("app-task")) {
		t.Fatalf("index.html does not mention app-task: %s", w.Body.String()[:200])
	}
	// static asset reachable (public)
	w2 := doJSON(h, "GET", "/assets/app.js", "", nil)
	if w2.Code != http.StatusOK || !bytes.Contains(w2.Body.Bytes(), []byte("renderDashboard")) {
		t.Fatalf("GET /assets/app.js status = %d", w2.Code)
	}
}

// ── 用户名 + 密码登录 ──────────────────────────────────────

func TestWebUILoginUserPass(t *testing.T) {
	h := newWebUITestRouter(t, "")

	// Default admin login.
	w := doJSON(h, "POST", "/api/login", `{"username":"admin","password":"app-task-admin"}`, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("admin login: status = %d, body = %s", w.Code, w.Body.String())
	}
	var loginResp struct {
		OK      bool `json:"ok"`
		Session string
		User    struct {
			Username string `json:"username"`
			Role     string `json:"role"`
			IsAdmin  bool   `json:"is_admin"`
		} `json:"user"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &loginResp)
	if !loginResp.OK || loginResp.Session == "" {
		t.Fatalf("login response = %s", w.Body.String())
	}
	if loginResp.User.Username != "admin" || loginResp.User.Role != "admin" || !loginResp.User.IsAdmin {
		t.Fatalf("login user = %+v", loginResp.User)
	}

	// Wrong password rejected.
	if w := doJSON(h, "POST", "/api/login", `{"username":"admin","password":"wrong-pass"}`, nil); w.Code != http.StatusUnauthorized {
		t.Fatalf("wrong password: status = %d, want 401", w.Code)
	}
	// Unknown user rejected.
	if w := doJSON(h, "POST", "/api/login", `{"username":"nobody","password":"whatever123"}`, nil); w.Code != http.StatusUnauthorized {
		t.Fatalf("unknown user: status = %d, want 401", w.Code)
	}
}

// ── master token（API 密钥）────────────────────────────────

func TestWebUITokenAuth(t *testing.T) {
	h := newWebUITestRouter(t, "s3cret")

	w := doJSON(h, "GET", "/api/stats", "", nil)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("no token: status = %d, want 401", w.Code)
	}
	w2 := doJSON(h, "GET", "/api/stats", "", map[string]string{"X-WebUI-Token": "wrong"})
	if w2.Code != http.StatusUnauthorized {
		t.Fatalf("wrong token: status = %d, want 401", w2.Code)
	}
	w3 := doJSON(h, "GET", "/api/stats", "", map[string]string{"Authorization": "Bearer s3cret"})
	if w3.Code != http.StatusOK {
		t.Fatalf("bearer token: status = %d, want 200", w3.Code)
	}
}

// ── 账户管理：admin 可增删改，member 无权限 ─────────────────

func TestWebUIUserAdmin(t *testing.T) {
	h := newWebUITestRouter(t, "")
	ah := adminHeaders(t, h)

	// admin lists users (at least the seeded admin).
	w := doJSON(h, "GET", "/api/users", "", ah)
	if w.Code != http.StatusOK {
		t.Fatalf("list users: status = %d", w.Code)
	}
	var lst struct {
		Users []struct {
			ID       int64  `json:"id"`
			Username string `json:"username"`
			Role     string `json:"role"`
		} `json:"users"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &lst)
	if len(lst.Users) != 1 || lst.Users[0].Username != "admin" || lst.Users[0].Role != "admin" {
		t.Fatalf("users = %s", w.Body.String())
	}

	// create a member.
	w = doJSON(h, "POST", "/api/users", `{"username":"zhang","password":"member-pass-1","role":"member"}`, ah)
	if w.Code != http.StatusOK {
		t.Fatalf("create user: status = %d, body = %s", w.Code, w.Body.String())
	}
	// duplicate username -> 409.
	if w := doJSON(h, "POST", "/api/users", `{"username":"zhang","password":"member-pass-2","role":"member"}`, ah); w.Code != http.StatusConflict {
		t.Fatalf("duplicate user: status = %d, want 409", w.Code)
	}
	// short password -> 400.
	if w := doJSON(h, "POST", "/api/users", `{"username":"li","password":"short","role":"member"}`, ah); w.Code != http.StatusBadRequest {
		t.Fatalf("short password: status = %d, want 400", w.Code)
	}

	// member logs in, is NOT admin, cannot manage users.
	authz := map[string]string{}
	mw := doJSON(h, "POST", "/api/login", `{"username":"zhang","password":"member-pass-1"}`, nil)
	authz["Cookie"] = webuiSessionCookie + "=" + sessionFromCookie(mw)
	w = doJSON(h, "GET", "/api/stats", "", authz)
	if w.Code != http.StatusOK {
		t.Fatalf("member stats: status = %d", w.Code)
	}
	w = doJSON(h, "GET", "/api/info", "", authz)
	var info struct {
		User struct {
			Role    string `json:"role"`
			IsAdmin bool   `json:"is_admin"`
		} `json:"user"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &info)
	if info.User.Role != "member" || info.User.IsAdmin {
		t.Fatalf("member info = %s", w.Body.String())
	}
	if w := doJSON(h, "GET", "/api/users", "", authz); w.Code != http.StatusForbidden {
		t.Fatalf("member list users: status = %d, want 403", w.Code)
	}
	if w := doJSON(h, "POST", "/api/users", `{"username":"x","password":"passw0rd1","role":"member"}`, authz); w.Code != http.StatusForbidden {
		t.Fatalf("member create user: status = %d, want 403", w.Code)
	}

	// admin cannot delete self; cannot delete the last admin.
	adminID := lst.Users[0].ID
	if w := doJSON(h, "DELETE", "/api/users/"+itoa(adminID), "", ah); w.Code != http.StatusBadRequest {
		t.Fatalf("delete self: status = %d, want 400", w.Code)
	}

	// admin deletes the member.
	w = doJSON(h, "GET", "/api/users", "", ah)
	lst2 := struct {
		Users []struct {
			ID       int64  `json:"id"`
			Username string `json:"username"`
			Role     string `json:"role"`
		} `json:"users"`
	}{}
	_ = json.Unmarshal(w.Body.Bytes(), &lst2)
	var memberID int64
	for _, u := range lst2.Users {
		if u.Username == "zhang" {
			memberID = u.ID
		}
	}
	if memberID == 0 {
		t.Fatal("member not found")
	}
	if w := doJSON(h, "DELETE", "/api/users/"+itoa(memberID), "", ah); w.Code != http.StatusOK {
		t.Fatalf("delete member: status = %d", w.Code)
	}
}

func itoa(n int64) string {
	return strconv.FormatInt(n, 10)
}

// ── /api/stats 统计 ────────────────────────────────────────

func TestWebUIStats(t *testing.T) {
	h := newWebUITestRouter(t, "")
	ah := adminHeaders(t, h)
	svc := service.NewTaskService()

	// 1 completed + 1 pending task
	taskID, err := svc.RegisterTask(1, "http", []byte(`{"k":"v"}`), "http://exec", false, "", time.Now().UTC().Add(time.Minute), 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.RegisterTask(2, "http", []byte(`{}`), "http://exec2", false, "", time.Now().UTC().Add(time.Minute), 0, 1); err != nil {
		t.Fatal(err)
	}
	_, _ = repo.ConditionalUpdate(taskID, "pending", "completed", map[string]any{"last_result": "ok"})
	_ = repo.CreateTaskLog(&model.TaskLog{LogID: "l1", TaskID: taskID, Status: "success"})

	// 1 sent + 1 failed email
	_ = repo.CreateEmail(&model.EmailMessage{
		EmailID: "e1", To: []byte(`["a@x.com"]`), Subject: "s", BodyHTML: "<p>x</p>", Status: "sent",
	})
	_ = repo.CreateEmail(&model.EmailMessage{
		EmailID: "e2", To: []byte(`["b@x.com"]`), Subject: "s", BodyHTML: "<p>x</p>", Status: "failed",
	})

	// 1 script
	_ = repo.CreateScript(&model.Script{ScriptID: "sc1", Version: 1, Name: "n", Source: "return", Enabled: true})

	w := doJSON(h, "GET", "/api/stats", "", ah)
	if w.Code != http.StatusOK {
		t.Fatalf("stats status = %d", w.Code)
	}
	var s struct {
		Tasks   map[string]int64 `json:"tasks"`
		Logs    int64            `json:"logs_total"`
		Emails  map[string]int64 `json:"emails"`
		Scripts int64            `json:"scripts"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &s); err != nil {
		t.Fatalf("stats decode: %v", err)
	}
	if s.Tasks["completed"] != 1 || s.Tasks["pending"] != 1 || s.Tasks["total"] != 2 {
		t.Fatalf("tasks stats = %v", s.Tasks)
	}
	if s.Logs != 1 {
		t.Fatalf("logs_total = %d, want 1", s.Logs)
	}
	if s.Emails["sent"] != 1 || s.Emails["failed"] != 1 || s.Emails["total"] != 2 {
		t.Fatalf("emails stats = %v", s.Emails)
	}
	if s.Scripts != 1 {
		t.Fatalf("scripts = %d, want 1", s.Scripts)
	}
}

// ── /api/tasks（管理员视角，跨 uid）────────────────────────

func TestWebUITasksAdminView(t *testing.T) {
	h := newWebUITestRouter(t, "")
	ah := adminHeaders(t, h)
	svc := service.NewTaskService()
	if _, err := svc.RegisterTask(1, "http", []byte(`{"a":1}`), "http://e1", false, "", time.Now().UTC().Add(time.Minute), 0, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.RegisterTask(2, "lua", []byte(`{"script_id":"s"}`), "", false, "", time.Now().UTC().Add(time.Minute), 2, 3); err != nil {
		t.Fatal(err)
	}

	// create via admin API
	w := doJSON(h, "POST", "/api/tasks", `{"uid":9,"task_type":"http","executor_url":"http://e9","trigger_time":"2030-01-01T00:00:00Z","max_retry":1}`, ah)
	if w.Code != http.StatusOK {
		t.Fatalf("create task status = %d, body = %s", w.Code, w.Body.String())
	}
	var created struct {
		TaskID string `json:"task_id"`
	}
	json.Unmarshal(w.Body.Bytes(), &created)
	if created.TaskID == "" {
		t.Fatal("no task_id returned")
	}

	// list across all uids (no X-Uid needed on the admin API)
	w2 := doJSON(h, "GET", "/api/tasks", "", ah)
	if w2.Code != http.StatusOK {
		t.Fatalf("list tasks status = %d", w2.Code)
	}
	var list struct {
		Total int64 `json:"total"`
		Tasks []struct {
			TaskID string `json:"task_id"`
			UID    int64  `json:"uid"`
		} `json:"tasks"`
	}
	json.Unmarshal(w2.Body.Bytes(), &list)
	if list.Total != 3 {
		t.Fatalf("task total = %d, want 3", list.Total)
	}

	// detail includes logs
	_ = repo.CreateTaskLog(&model.TaskLog{LogID: "l9", TaskID: created.TaskID, Status: "success"})
	w3 := doJSON(h, "GET", "/api/tasks/"+created.TaskID, "", ah)
	if w3.Code != http.StatusOK {
		t.Fatalf("task detail status = %d", w3.Code)
	}
	var detail struct {
		Task map[string]any   `json:"task"`
		Logs []map[string]any `json:"logs"`
	}
	json.Unmarshal(w3.Body.Bytes(), &detail)
	if detail.Task["uid"].(float64) != 9 || len(detail.Logs) != 1 {
		t.Fatalf("detail = %s", w3.Body.String())
	}

	// status filter
	w4 := doJSON(h, "GET", "/api/tasks?status=failed", "", ah)
	var fl struct {
		Total int64 `json:"total"`
	}
	json.Unmarshal(w4.Body.Bytes(), &fl)
	if fl.Total != 0 {
		t.Fatalf("failed filter total = %d, want 0", fl.Total)
	}
}

// ── /api/emails + retry ────────────────────────────────────

func TestWebUIEmailsRetry(t *testing.T) {
	h := newWebUITestRouter(t, "")
	ah := adminHeaders(t, h)
	_ = repo.CreateEmail(&model.EmailMessage{
		EmailID: "ef", To: []byte(`["a@x.com"]`), Subject: "s", BodyHTML: "<p>x</p>", Status: "failed",
		LastError: ptr("smtp 500"), RetryCount: 5,
	})
	_ = repo.CreateEmail(&model.EmailMessage{
		EmailID: "es", To: []byte(`["a@x.com"]`), Subject: "s", BodyHTML: "<p>x</p>", Status: "sent",
	})

	// retry a failed email -> pending
	w := doJSON(h, "POST", "/api/emails/ef/retry", `{}`, ah)
	if w.Code != http.StatusOK {
		t.Fatalf("retry status = %d, body = %s", w.Code, w.Body.String())
	}
	e, _ := repo.GetEmailByID("ef")
	if e == nil || e.Status != "pending" || e.RetryCount != 0 || e.LastError != nil {
		t.Fatalf("email after retry = %+v", e)
	}

	// retry a sent email -> 409
	w2 := doJSON(h, "POST", "/api/emails/es/retry", `{}`, ah)
	if w2.Code != http.StatusConflict {
		t.Fatalf("retry sent status = %d, want 409", w2.Code)
	}

	// list with status filter
	w3 := doJSON(h, "GET", "/api/emails?status=sent", "", ah)
	var lst struct {
		Total int64 `json:"total"`
	}
	json.Unmarshal(w3.Body.Bytes(), &lst)
	if lst.Total != 1 {
		t.Fatalf("sent emails = %d, want 1", lst.Total)
	}
}

// ── /api/scripts（创建 / 列表 / 详情 / 启停）────────────────

func TestWebUIScripts(t *testing.T) {
	h := newWebUITestRouter(t, "")
	ah := adminHeaders(t, h)

	// create
	body := `{"script_id":"notify","name":"通知脚本","description":"d","source":"function handle(ctx) ctx.log('hi') end","enabled":true}`
	w := doJSON(h, "POST", "/api/scripts", body, ah)
	if w.Code != http.StatusOK {
		t.Fatalf("create script status = %d, body = %s", w.Code, w.Body.String())
	}
	var created struct {
		ScriptID string `json:"script_id"`
		Version  int    `json:"version"`
	}
	json.Unmarshal(w.Body.Bytes(), &created)
	if created.Version != 1 {
		t.Fatalf("version = %d, want 1", created.Version)
	}

	// update -> v2
	w1 := doJSON(h, "POST", "/api/scripts", `{"script_id":"notify","name":"通知脚本","source":"function handle(ctx) ctx.log('v2') end"}`, ah)
	json.Unmarshal(w1.Body.Bytes(), &created)
	if created.Version != 2 {
		t.Fatalf("version after update = %d, want 2", created.Version)
	}

	// list
	w2 := doJSON(h, "GET", "/api/scripts", "", ah)
	var lst struct {
		Scripts []struct {
			ScriptID string `json:"script_id"`
			Version  int    `json:"version"`
			Enabled  bool   `json:"enabled"`
		} `json:"scripts"`
	}
	json.Unmarshal(w2.Body.Bytes(), &lst)
	if len(lst.Scripts) != 1 || lst.Scripts[0].Version != 2 {
		t.Fatalf("scripts = %s", w2.Body.String())
	}

	// detail: source + versions + audit; operator should be the webui user
	w3 := doJSON(h, "GET", "/api/scripts/notify", "", ah)
	if w3.Code != http.StatusOK {
		t.Fatalf("detail status = %d", w3.Code)
	}
	var det struct {
		Version  int    `json:"version"`
		Source   string `json:"source"`
		Versions []any  `json:"versions"`
		Logs     []struct {
			Operator string `json:"operator"`
		} `json:"logs"`
	}
	json.Unmarshal(w3.Body.Bytes(), &det)
	if det.Version != 2 || len(det.Versions) != 2 || len(det.Logs) != 2 {
		t.Fatalf("detail = %s", w3.Body.String())
	}
	if det.Logs[0].Operator != "admin" {
		t.Fatalf("audit operator = %q, want admin", det.Logs[0].Operator)
	}

	// toggle off (no version bump)
	w4 := doJSON(h, "POST", "/api/scripts/notify/toggle", `{"enabled":false}`, ah)
	if w4.Code != http.StatusOK {
		t.Fatalf("toggle status = %d", w4.Code)
	}
	var tog struct {
		Version int  `json:"version"`
		Enabled bool `json:"enabled"`
	}
	json.Unmarshal(w4.Body.Bytes(), &tog)
	if tog.Enabled || tog.Version != 2 {
		t.Fatalf("toggle = %+v", tog)
	}

	// not found
	w5 := doJSON(h, "GET", "/api/scripts/nope", "", ah)
	if w5.Code != http.StatusNotFound {
		t.Fatalf("missing script status = %d, want 404", w5.Code)
	}
}

func ptr(s string) *string { return &s }
