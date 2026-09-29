package router

// Tests for the service-surface API-key auth: credential extraction formats,
// bootstrap env keys, revocation, console-session acceptance, the per-IP
// failure throttle, and the console generate→reveal→revoke flow.

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"app-task/internal/model"
	"app-task/internal/repo"
)

const registerBody = `{"uid":1,"task_type":"http","payload":{},"executor_url":"http://exec:9000","trigger_time":"2030-01-01T00:00:00Z"}`

// mkRow builds an APIKey row whose hash corresponds to the plaintext.
func mkRow(name, plaintext string) model.APIKey {
	return model.APIKey{
		KeyID:     newKeyID(),
		Name:      name,
		KeyHash:   hashAPIKey(plaintext),
		KeyPrefix: plaintext[:12] + "…",
		Scopes:    scopeTasks + "," + scopeScripts + "," + scopeInternal,
		Status:    repo.APIKeyStatusActive,
		CreatedBy: "test",
	}
}

func TestAPIKeyAuth(t *testing.T) {
	_, h := newTestRouter(t)

	// missing key → 401
	if w := doJSON(h, "POST", "/tasks/register", registerBody, nil); w.Code != http.StatusUnauthorized {
		t.Fatalf("no key: status = %d, want 401", w.Code)
	}
	// wrong key → 401
	if w := doJSON(h, "POST", "/tasks/register", registerBody, map[string]string{"apikey": "wrong-key"}); w.Code != http.StatusUnauthorized {
		t.Fatalf("wrong key: status = %d, want 401", w.Code)
	}

	// all three accepted header formats (bootstrap key seeded via cfg)
	for _, headers := range []map[string]string{
		{"apikey": testServiceKey},
		{"X-API-Key": testServiceKey},
		{"Authorization": "Bearer " + testServiceKey},
	} {
		if w := doJSON(h, "POST", "/tasks/register", registerBody, headers); w.Code != http.StatusOK {
			t.Fatalf("headers %v: status = %d, body = %s", headers, w.Code, w.Body.String())
		}
	}

	// /health stays open
	if w := doJSON(h, "GET", "/health", "", nil); w.Code != http.StatusOK {
		t.Fatalf("health: status = %d, want 200", w.Code)
	}
}

func TestAPIKeyRevocation(t *testing.T) {
	_, h := newTestRouter(t)

	plaintext := "at_revoke_me_please_0123456789abcdef"
	if err := repo.CreateAPIKey(mkRowPtr("revoke-me", plaintext)); err != nil {
		t.Fatal(err)
	}
	headers := map[string]string{"X-API-Key": plaintext}
	if w := doJSON(h, "POST", "/tasks/register", registerBody, headers); w.Code != http.StatusOK {
		t.Fatalf("fresh key: status = %d, body = %s", w.Code, w.Body.String())
	}

	keys, _ := repo.ListAPIKeys()
	var keyID string
	for _, k := range keys {
		if k.Name == "revoke-me" {
			keyID = k.KeyID
		}
	}
	if keyID == "" {
		t.Fatal("key row not found")
	}
	if ok, err := repo.RevokeAPIKey(keyID); err != nil || !ok {
		t.Fatalf("revoke: %v %v", ok, err)
	}
	if w := doJSON(h, "POST", "/tasks/register", registerBody, headers); w.Code != http.StatusUnauthorized {
		t.Fatalf("revoked key: status = %d, want 401", w.Code)
	}
}

func TestAPIKeyConsoleSessionAccepted(t *testing.T) {
	_, h := newTestRouter(t)
	session := sessionFromCookie(doJSON(h, "POST", "/api/login", `{"username":"admin","password":"app-task-admin"}`, nil))
	if session == "" {
		t.Fatal("login returned no session cookie")
	}
	headers := map[string]string{"Cookie": "apptask_session=" + session}
	if w := doJSON(h, "POST", "/tasks/register", registerBody, headers); w.Code != http.StatusOK {
		t.Fatalf("console session: status = %d, body = %s", w.Code, w.Body.String())
	}
}

func TestAPIKeyThrottle(t *testing.T) {
	_, h := newTestRouter(t)
	// webuiMaxFails (10) bad attempts → 429 on the 11th
	for i := 0; i < 10; i++ {
		if w := doJSON(h, "POST", "/tasks/register", registerBody, map[string]string{"apikey": "bad"}); w.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d: status = %d, want 401", i+1, w.Code)
		}
	}
	if w := doJSON(h, "POST", "/tasks/register", registerBody, map[string]string{"apikey": "bad"}); w.Code != http.StatusTooManyRequests {
		t.Fatalf("throttled: status = %d, want 429", w.Code)
	}
}

func TestAPIKeyConsoleGenerateFlow(t *testing.T) {
	_, h := newTestRouter(t)
	admin := adminHeaders(t, h)

	// non-admin / anonymous cannot manage keys
	if w := doJSON(h, "GET", "/console/apikeys", "", nil); w.Code != http.StatusFound {
		t.Fatalf("anon apikeys page: status = %d, want 302", w.Code)
	}

	// generate (admin form post, all scopes, rate 0 = unlimited)
	w := doJSON(h, "POST", "/console/apikeys", "name=executor-1&expires_days=30&rate_per_min=0&scopes=tasks&scopes=scripts&scopes=internal", map[string]string{
		"Content-Type": "application/x-www-form-urlencoded",
		"Cookie":       admin["Cookie"],
	})
	if w.Code != http.StatusSeeOther {
		t.Fatalf("create status = %d, body = %s", w.Code, w.Body.String())
	}

	// the reveal cookie carries a one-time token; the reveal page shows the
	// plaintext exactly once
	reveal := ""
	for _, ck := range w.Result().Cookies() {
		if ck.Name == apiKeyRevealCookie {
			reveal = ck.Value
		}
	}
	if reveal == "" {
		t.Fatal("no reveal cookie set")
	}
	w2 := doJSON(h, "GET", "/console/apikeys/revealed", "", map[string]string{
		"Cookie": admin["Cookie"] + "; " + apiKeyRevealCookie + "=" + reveal,
	})
	if w2.Code != http.StatusOK {
		t.Fatalf("reveal status = %d", w2.Code)
	}
	pageHTML := w2.Body.String()
	marker := `<pre class="code" style="font-size:15px;position:relative">`
	start := strings.Index(pageHTML, marker)
	if start < 0 {
		t.Fatal("plaintext block not found on reveal page")
	}
	start += len(marker)
	end := strings.Index(pageHTML[start:], "<button") // copy-button lives inside the pre
	plaintext := strings.TrimSpace(pageHTML[start : start+end])

	// second read of the same token must not show the key again
	w3 := doJSON(h, "GET", "/console/apikeys/revealed", "", map[string]string{
		"Cookie": admin["Cookie"] + "; " + apiKeyRevealCookie + "=" + reveal,
	})
	if w3.Code != http.StatusSeeOther {
		t.Fatalf("second reveal status = %d, want 303 redirect", w3.Code)
	}

	// the generated key authenticates the service surface
	if w := doJSON(h, "POST", "/tasks/register", registerBody, map[string]string{"X-API-Key": plaintext}); w.Code != http.StatusOK {
		t.Fatalf("generated key: status = %d, body = %s", w.Code, w.Body.String())
	}
}

// mkRowPtr is mkRow for repo.CreateAPIKey's pointer parameter.
func mkRowPtr(name, plaintext string) *model.APIKey {
	row := mkRow(name, plaintext)
	return &row
}

func TestAPIKeyScopesAndRateLimit(t *testing.T) {
	_, h := newTestRouter(t)

	// key restricted to the tasks scope only
	tasksOnly := "at_tasks_only_key_0123456789abcdef"
	if err := repo.CreateAPIKey(mkRowPtr("tasks-only", tasksOnly)); err != nil {
		t.Fatal(err)
	}
	row, _ := repo.GetAPIKeyByHash(hashAPIKey(tasksOnly))
	row.Scopes = scopeTasks
	if err := repo.UpdateAPIKeyScopesAndRate(row.KeyID, row.Scopes, 2); err != nil {
		t.Fatal(err)
	}

	hMap := map[string]string{"X-API-Key": tasksOnly}

	// tasks path: allowed
	if w := doJSON(h, "POST", "/tasks/register", registerBody, hMap); w.Code != http.StatusOK {
		t.Fatalf("tasks path: status = %d, body = %s", w.Code, w.Body.String())
	}

	// scripts path: 403 (scope denied)
	if w := doJSON(h, "POST", "/scripts", `{"script_id":"x","name":"X","source":"function handle(ctx) end"}`, hMap); w.Code != http.StatusForbidden {
		t.Fatalf("scripts path: status = %d, want 403", w.Code)
	}

	// rate limit 2/min: the register POST above already consumed 1 request,
	// so the next GET is #2 (ok) and one more hits 429 (X-Uid required on
	// user routes).
	rateHeaders := map[string]string{"X-API-Key": tasksOnly, "X-Uid": "1"}
	if w := doJSON(h, "GET", "/tasks", "", rateHeaders); w.Code != http.StatusOK {
		t.Fatalf("rate request 2: status = %d body = %s", w.Code, w.Body.String())
	}
	if w := doJSON(h, "GET", "/tasks", "", rateHeaders); w.Code != http.StatusTooManyRequests {
		t.Fatalf("rate limited: status = %d, want 429", w.Code)
	}
}

func TestSelfPasswordChange(t *testing.T) {
	_, h := newTestRouter(t)
	admin := adminHeaders(t, h)

	// wrong current password → rejected
	w := doJSON(h, "POST", "/console/password",
		"old_password=wrong&new_password=new-pass-123&new_password2=new-pass-123", map[string]string{
			"Content-Type": "application/x-www-form-urlencoded",
			"Cookie":       admin["Cookie"],
		})
	if w.Code != http.StatusSeeOther || !strings.Contains(w.Header().Get("Location"), "err=") {
		t.Fatalf("wrong old pwd: status = %d, Location = %q", w.Code, w.Header().Get("Location"))
	}

	// correct flow: change, old password stops working, new one logs in
	w = doJSON(h, "POST", "/console/password",
		"old_password=app-task-admin&new_password=new-pass-123&new_password2=new-pass-123", map[string]string{
			"Content-Type": "application/x-www-form-urlencoded",
			"Cookie":       admin["Cookie"],
		})
	if w.Code != http.StatusSeeOther || !strings.Contains(w.Header().Get("Location"), "ok=") {
		t.Fatalf("change: status = %d, Location = %q", w.Code, w.Header().Get("Location"))
	}
	if w := doJSON(h, "POST", "/api/login", `{"username":"admin","password":"app-task-admin"}`, nil); w.Code != http.StatusUnauthorized {
		t.Fatalf("old password still valid, status = %d", w.Code)
	}
	if w := doJSON(h, "POST", "/api/login", `{"username":"admin","password":"new-pass-123"}`, nil); w.Code != http.StatusOK {
		t.Fatalf("new password login failed: %d", w.Code)
	}

	// restore the default password so other tests/users are unaffected
	if err := repo.SetUserPassword(1, "app-task-admin"); err != nil {
		t.Fatal(err)
	}
}

// ── script_id 自动 UUID：控制台创建与 API 省略两条路径 ────────────────

func TestScriptIDAutoUUID(t *testing.T) {
	_, h := newTestRouter(t)
	admin := adminHeaders(t, h)
	form := map[string]string{
		"Content-Type": "application/x-www-form-urlencoded",
		"Cookie":       admin["Cookie"],
	}

	// console create without script_id → server assigns a UUID
	w := doJSON(h, "POST", "/console/scripts", "name=自动生成&source=function handle(ctx) end", form)
	if w.Code != http.StatusSeeOther {
		t.Fatalf("console create: status = %d, body = %s", w.Code, w.Body.String())
	}
	loc := w.Header().Get("Location")
	loc = strings.Split(loc, "?")[0] // strip the flash query
	parts := strings.Split(loc, "/")
	assigned := parts[len(parts)-1]
	if len(assigned) != 36 || strings.Count(assigned, "-") != 4 {
		t.Fatalf("assigned script_id = %q, want UUID", assigned)
	}

	// task mount: lua task referencing the UUID script_id passes validation
	lt := doJSON(h, "POST", "/console/tasks", "task_type=lua&trigger_time=2030-01-01T00:00&payload=%7B%22script_id%22%3A%22"+assigned+"%22%7D", form)
	if !strings.Contains(lt.Header().Get("Location"), "ok=") {
		t.Fatalf("lua task mount: status = %d, Location = %q", lt.Code, lt.Header().Get("Location"))
	}

	// console create with a client-posted script_id → still server-assigned
	// (the identifier is never a user input)
	w = doJSON(h, "POST", "/console/scripts", "script_id=user-chosen&name=忽略手填&source=function handle(ctx) end", form)
	if w.Code != http.StatusSeeOther {
		t.Fatalf("console create with posted id: status = %d", w.Code)
	}
	loc2 := strings.Split(w.Header().Get("Location"), "?")[0]
	parts2 := strings.Split(loc2, "/")
	assigned2 := parts2[len(parts2)-1]
	if len(assigned2) != 36 || strings.Count(assigned2, "-") != 4 {
		t.Fatalf("posted script_id must be ignored, got %q", assigned2)
	}
	_, _ = repo.DeleteScriptByID(assigned2)

	// API upload with omitted script_id → UUID assigned in response
	w = doJSON(h, "POST", "/scripts", `{"name":"api-no-id","source":"function handle(ctx) end"}`, serviceKeyHeaders(nil))
	if w.Code != http.StatusOK {
		t.Fatalf("api upload: %d body = %s", w.Code, w.Body.String())
	}
	var resp struct {
		ScriptID string `json:"script_id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.ScriptID) != 36 || strings.Count(resp.ScriptID, "-") != 4 {
		t.Fatalf("api script_id = %q, want UUID", resp.ScriptID)
	}

	// cleanup
	_, _ = repo.DeleteScriptByID(assigned)
	_, _ = repo.DeleteScriptByID(resp.ScriptID)
}

// ── 任务属主：控制台创建自动归属当前登录用户，不再手输 uid ────────────

func TestTaskOwnerAutoUID(t *testing.T) {
	_, h := newTestRouter(t)
	admin := adminHeaders(t, h)
	form := map[string]string{
		"Content-Type": "application/x-www-form-urlencoded",
		"Cookie":       admin["Cookie"],
	}

	// console create without uid → owned by the logged-in admin (webui_user id 1)
	w := doJSON(h, "POST", "/console/tasks", "task_type=http&executor_url=http://e1&trigger_time=2030-01-01T00:00", form)
	if !strings.Contains(w.Header().Get("Location"), "ok=") {
		t.Fatalf("console task create: Location = %q", w.Header().Get("Location"))
	}
	tasks, _ := repo.ListAllTasks("", 10, 0)
	if len(tasks) == 0 {
		t.Fatal("no task created")
	}
	var consoleTask *model.Task
	for i := range tasks {
		if tasks[i].TaskType == "http" && tasks[i].ExecutorURL == "http://e1" {
			consoleTask = &tasks[i]
		}
	}
	if consoleTask == nil {
		t.Fatal("console-created task not found")
	}
	if consoleTask.UID != 1 {
		t.Fatalf("console task uid = %d, want 1 (logged-in admin)", consoleTask.UID)
	}

	// admin API with an explicit uid keeps it; omitted uid (0) attributes to
	// the session user
	w = doJSON(h, "POST", "/api/tasks", `{"uid":9,"task_type":"http","executor_url":"http://e9","trigger_time":"2030-01-01T00:00:00Z"}`, admin)
	if w.Code != http.StatusOK {
		t.Fatalf("api task create explicit uid: %d body = %s", w.Code, w.Body.String())
	}
	w = doJSON(h, "POST", "/api/tasks", `{"task_type":"http","executor_url":"http://e2","trigger_time":"2030-01-01T00:00:00Z"}`, admin)
	if w.Code != http.StatusOK {
		t.Fatalf("api task create omitted uid: %d body = %s", w.Code, w.Body.String())
	}
	tasks, _ = repo.ListAllTasks("", 10, 0)
	var explicit, implicit *model.Task
	for i := range tasks {
		if tasks[i].ExecutorURL == "http://e9" {
			explicit = &tasks[i]
		}
		if tasks[i].ExecutorURL == "http://e2" {
			implicit = &tasks[i]
		}
	}
	if explicit == nil || explicit.UID != 9 {
		t.Fatalf("explicit uid task = %+v, want uid 9", explicit)
	}
	if implicit == nil || implicit.UID != 1 {
		t.Fatalf("omitted uid task = %+v, want uid 1 (session user)", implicit)
	}
}

// ── bootstrap 密钥按名称 upsert：重启幂等 + env 轮换生效 ─────────────

func TestBootstrapKeyUpsert(t *testing.T) {
	newTestRouter(t)

	// The router already seeded the env service key ("bootstrap-service-key");
	// exercise the upsert lifecycle on its own name here.
	row := &model.APIKey{
		KeyID: newKeyID(), Name: "bootstrap-rotation-key",
		KeyHash: hashAPIKey("env-key-v1"), KeyPrefix: "env-key-v1…",
		Scopes: scopeTasks, Status: repo.APIKeyStatusActive, CreatedBy: "bootstrap",
	}
	created, err := repo.UpsertAPIKey(row)
	if err != nil || !created {
		t.Fatalf("first seed: created=%v err=%v", created, err)
	}
	// same env key again → no-op, single row
	created, err = repo.UpsertAPIKey(&model.APIKey{
		KeyID: newKeyID(), Name: "bootstrap-rotation-key",
		KeyHash: hashAPIKey("env-key-v1"), KeyPrefix: "env-key-v1…",
		Scopes: scopeTasks, Status: repo.APIKeyStatusActive, CreatedBy: "bootstrap",
	})
	if err != nil || created {
		t.Fatalf("reseed same key: created=%v err=%v", created, err)
	}
	// rotated env key (same name, new hash) → hash refreshed in place
	created, err = repo.UpsertAPIKey(&model.APIKey{
		KeyID: newKeyID(), Name: "bootstrap-rotation-key",
		KeyHash: hashAPIKey("env-key-v2"), KeyPrefix: "env-key-v2…",
		Scopes: scopeTasks, Status: repo.APIKeyStatusActive, CreatedBy: "bootstrap",
	})
	if err != nil || created {
		t.Fatalf("rotation: created=%v err=%v", created, err)
	}
	updated, err := repo.GetAPIKeyByHash(hashAPIKey("env-key-v2"))
	if err != nil || updated == nil {
		t.Fatalf("rotated hash missing: %v %v", updated, err)
	}
	stale, _ := repo.GetAPIKeyByHash(hashAPIKey("env-key-v1"))
	if stale != nil {
		t.Fatal("stale hash still present after rotation")
	}
	// user-created rows with the same name are never touched
	if err := repo.CreateAPIKey(mkRowPtr("user-key", "user-plaintext-key")); err != nil {
		t.Fatal(err)
	}
	created, err = repo.UpsertAPIKey(&model.APIKey{
		KeyID: newKeyID(), Name: "user-key",
		KeyHash: hashAPIKey("env-override-attempt"), KeyPrefix: "x…",
		Status: repo.APIKeyStatusActive, CreatedBy: "bootstrap",
	})
	if err != nil || created {
		t.Fatalf("user-row collision: created=%v err=%v", created, err)
	}
	touched, _ := repo.GetAPIKeyByHash(hashAPIKey("env-override-attempt"))
	if touched != nil {
		t.Fatal("bootstrap seed must not overwrite user-created rows")
	}
}
