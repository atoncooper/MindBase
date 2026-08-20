package router

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"app-task/internal/repo"
)

// ── POST /scripts: 鉴权(APISIX key-auth 层)+ 审计留痕 ──────────────

func TestUploadScriptAuditTrail(t *testing.T) {
	_, h := newTestRouter(t)

	// first upload: create + audit entry (operator / request id / source ip)
	body := `{"script_id":"aud","name":"Audit","description":"d","source":"function handle(ctx) end","operator":"ops-bot"}`
	req := httptest.NewRequest("POST", "/scripts", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Request-Id", "req-123")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}

	logs, err := repo.ListScriptLogs("aud", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(logs) != 1 {
		t.Fatalf("audit logs = %d, want 1", len(logs))
	}
	l := logs[0]
	if l.Version != 1 || l.Action != "create" || l.Operator != "ops-bot" || l.RequestID != "req-123" {
		t.Fatalf("audit = %+v, want create/v1/ops-bot/req-123", l)
	}

	// second upload of the same script_id → update + version 2
	body2 := `{"script_id":"aud","name":"Audit2","source":"function handle(ctx) ctx.log(\"v2\") end"}`
	req2 := httptest.NewRequest("POST", "/scripts", bytes.NewBufferString(body2))
	req2.Header.Set("Content-Type", "application/json")
	req2.Header.Set("X-Request-Id", "req-456")
	w2 := httptest.NewRecorder()
	h.ServeHTTP(w2, req2)
	if w2.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w2.Code, w2.Body.String())
	}
	logs, err = repo.ListScriptLogs("aud", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(logs) != 2 {
		t.Fatalf("audit logs = %d, want 2", len(logs))
	}
	if logs[0].Version != 2 || logs[0].Action != "update" {
		t.Fatalf("newest audit = %+v, want update/v2", logs[0])
	}
}

func TestUploadScriptValidation(t *testing.T) {
	_, h := newTestRouter(t)

	// missing source → 400
	req := httptest.NewRequest("POST", "/scripts", bytes.NewBufferString(`{"script_id":"x","name":"X"}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (missing source)", w.Code)
	}

	// Lua syntax error → 400
	bad := `{"script_id":"y","name":"Y","source":"function handle( ctx)"}`
	req2 := httptest.NewRequest("POST", "/scripts", bytes.NewBufferString(bad))
	req2.Header.Set("Content-Type", "application/json")
	w2 := httptest.NewRecorder()
	h.ServeHTTP(w2, req2)
	if w2.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (compile error); body = %s", w2.Code, w2.Body.String())
	}
}

func TestScriptLogsEndpoint(t *testing.T) {
	_, h := newTestRouter(t)
	upload := func(version int) {
		body := `{"script_id":"aud2","name":"A","source":"function handle(ctx) end","operator":"op-` + string(rune('0'+version)) + `"}`
		req := httptest.NewRequest("POST", "/scripts", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("upload %d: status = %d", version, w.Code)
		}
	}
	upload(1)
	upload(2)

	req := httptest.NewRequest("GET", "/scripts/logs?script_id=aud2&limit=10", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	var resp struct {
		ScriptID string `json:"script_id"`
		Logs     []struct {
			Version int    `json:"version"`
			Action  string `json:"action"`
		} `json:"logs"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.ScriptID != "aud2" || len(resp.Logs) != 2 || resp.Logs[0].Version != 2 || resp.Logs[0].Action != "update" {
		t.Fatalf("response = %+v", resp)
	}

	// missing script_id → 400
	req2 := httptest.NewRequest("GET", "/scripts/logs", nil)
	w2 := httptest.NewRecorder()
	h.ServeHTTP(w2, req2)
	if w2.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (script_id required)", w2.Code)
	}
}
