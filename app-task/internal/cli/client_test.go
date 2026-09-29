package cli

// Tests for the client commands against a stub app-task /api/* server:
// table rendering, request body correctness (lua payload injection, time
// conversion), and the credential env fallback chain.

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// newStubServer spins a stub /api server recording requests and replying with
// canned JSON per path. Returns the server + a request log.
func newStubServer(t *testing.T, routes map[string]func(w http.ResponseWriter, r *http.Request)) (*httptest.Server, *[]http.Request) {
	t.Helper()
	var mu sync.Mutex
	var reqs []http.Request
	mux := http.NewServeMux()
	for path, handler := range routes {
		p := path
		mux.HandleFunc(p, func(w http.ResponseWriter, r *http.Request) {
			mu.Lock()
			reqs = append(reqs, *r)
			mu.Unlock()
			handler(w, r)
		})
	}
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, &reqs
}

// runRoot executes the root command with the given args against flagURL/flagToken
// overrides, returning stdout.
func runRoot(t *testing.T, url, token string, args ...string) (string, error) {
	t.Helper()
	root := newRootCmd([]byte("scheduler:\n  interval_seconds: 30\n"))
	if url != "" || token != "" {
		pre := []string{}
		if url != "" {
			pre = append(pre, "--url", url)
		}
		if token != "" {
			pre = append(pre, "--token", token)
		}
		args = append(pre, args...)
	}
	var out bytes.Buffer
	root.SetOut(&out)
	root.SetErr(&out)
	root.SetArgs(args)
	err := root.Execute()
	return out.String(), err
}

func TestTaskLsTable(t *testing.T) {
	srv, _ := newStubServer(t, map[string]func(w http.ResponseWriter, r *http.Request){
		"/api/tasks": func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Query().Get("status") != "failed" {
				t.Errorf("status filter = %q", r.URL.Query().Get("status"))
			}
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"total":1,"limit":50,"offset":0,"tasks":[{"task_id":"t-1","uid":7,"task_type":"lua","status":"completed","owner":"op-1","trigger_time":"2026-09-28T10:00:00+08:00","executor_url":"","async":false,"max_retry":2,"retry_count":0}]}`))
		},
	})
	out, err := runRoot(t, srv.URL, "tok-1", "task", "ls", "--status", "failed")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"TASK ID", "t-1", "lua", "completed", "op-1", "共 1 条"} {
		if !strings.Contains(out, want) {
			t.Fatalf("output missing %q:\n%s", want, out)
		}
	}
}

func TestTaskCreateBody(t *testing.T) {
	var gotBody map[string]any
	srv, _ := newStubServer(t, map[string]func(w http.ResponseWriter, r *http.Request){
		"/api/tasks": func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				t.Errorf("method = %s", r.Method)
			}
			if r.Header.Get("X-WebUI-Token") != "tok-1" {
				t.Errorf("token header = %q", r.Header.Get("X-WebUI-Token"))
			}
			_ = json.NewDecoder(r.Body).Decode(&gotBody)
			w.Write([]byte(`{"task_id":"new-1","status":"pending"}`))
		},
	})
	out, err := runRoot(t, srv.URL, "tok-1", "task", "create",
		"--type", "lua", "--script-id", "sid-1",
		"--cron", "0 23 * * *",
		"--payload", `{"a":1}`,
		"--max-retry", "3")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "new-1") {
		t.Fatalf("output missing task id: %s", out)
	}
	if gotBody["task_type"] != "lua" {
		t.Fatalf("task_type = %v", gotBody["task_type"])
	}
	payload, _ := gotBody["payload"].(map[string]any)
	if payload == nil || payload["script_id"] != "sid-1" || payload["a"] != float64(1) {
		t.Fatalf("payload = %v, want script_id injected into the JSON", gotBody["payload"])
	}
	if gotBody["max_retry"] != float64(3) || gotBody["cron_expr"] != "0 23 * * *" {
		t.Fatalf("body = %v", gotBody)
	}
	if _, has := gotBody["uid"]; has {
		t.Fatal("uid must not be sent unless --uid is given (auto ownership)")
	}
}

func TestCredentialFallbackChain(t *testing.T) {
	// 1) no credential at all → clear error
	t.Setenv("AT_TOKEN", "")
	t.Setenv("APPTASK__WEBUI__TOKEN", "")
	if _, err := runRoot(t, "http://stub", "", "info"); err == nil || !strings.Contains(err.Error(), "缺少 API 凭据") {
		t.Fatalf("err = %v, want 缺少 API 凭据", err)
	}

	// 2) APPTASK__WEBUI__TOKEN fallback
	srv, reqs := newStubServer(t, map[string]func(w http.ResponseWriter, r *http.Request){
		"/api/info": func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte(`{"service":"app-task","version":"test","status":"running"}`))
		},
		"/api/stats": func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{}`)) },
	})
	t.Setenv("AT_TOKEN", "")
	t.Setenv("APPTASK__WEBUI__TOKEN", "master-fallback")
	if _, err := runRoot(t, srv.URL, "", "info"); err != nil {
		t.Fatal(err)
	}
	if (*reqs)[0].Header.Get("X-WebUI-Token") != "master-fallback" {
		t.Fatalf("token header = %q, want APPTASK__WEBUI__TOKEN fallback", (*reqs)[0].Header.Get("X-WebUI-Token"))
	}

	// 3) --token wins over env (own server: at info issues two requests per
	// invocation, so a fresh recorder keeps the index assertions simple)
	srv3, reqs3 := newStubServer(t, map[string]func(w http.ResponseWriter, r *http.Request){
		"/api/info": func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte(`{"service":"app-task","version":"test","status":"running"}`))
		},
		"/api/stats": func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{}`)) },
	})
	t.Setenv("AT_TOKEN", "env-token")
	if _, err := runRoot(t, srv3.URL, "flag-token", "info"); err != nil {
		t.Fatal(err)
	}
	if (*reqs3)[0].Header.Get("X-WebUI-Token") != "flag-token" {
		t.Fatalf("token header = %q, want flag precedence", (*reqs3)[0].Header.Get("X-WebUI-Token"))
	}
}

func TestScriptRunSuccessAndFailure(t *testing.T) {
	srv, _ := newStubServer(t, map[string]func(w http.ResponseWriter, r *http.Request){
		"/internal/script/run": func(w http.ResponseWriter, r *http.Request) {
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["script_id"] != "s-1" {
				t.Errorf("script_id = %v", body["script_id"])
			}
			w.Write([]byte(`{"run_id":"r-1","script_id":"s-1","version":2,"status":"success","logs":["hello"],"duration_ms":5}`))
		},
	})
	out, err := runRoot(t, srv.URL, "tok-1", "script", "run", "s-1", "--payload", `{"n":1}`)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "status=success") || !strings.Contains(out, "hello") {
		t.Fatalf("output = %s", out)
	}

	// failing run → non-nil error with the status
	fail := newStubServerOnly(t, `{"run_id":"r-2","script_id":"s-1","version":2,"status":"failed","error":"boom","logs":[],"duration_ms":1}`)
	if _, err := runRoot(t, fail.URL, "tok-1", "script", "run", "s-1"); err == nil || !strings.Contains(err.Error(), "failed") {
		t.Fatalf("err = %v, want failed status error", err)
	}
}

// newStubServerOnly is a single-route helper for failure-path tests.
func newStubServerOnly(t *testing.T, body string) *httptest.Server {
	srv, _ := newStubServer(t, map[string]func(w http.ResponseWriter, r *http.Request){
		"/internal/script/run": func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(body)) },
	})
	return srv
}
