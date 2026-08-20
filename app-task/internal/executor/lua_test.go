package executor

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"app-task/internal/db"
	"app-task/internal/model"
	"app-task/internal/repo"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

// setupLuaTestDB wires an in-memory SQLite with the script table so
// UpsertScript (which persists + caches) works hermetically.
func setupLuaTestDB(t *testing.T) {
	t.Helper()
	gdb, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := gdb.AutoMigrate(&model.Script{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	db.DB = gdb
}

func luaTask(payload string) Task {
	return Task{ID: "t1", Payload: []byte(payload)}
}

func mustUpsert(t *testing.T, e *LuaExecutor, scriptID, name, src string) int {
	t.Helper()
	v, err := e.UpsertScript(ScriptInput{ScriptID: scriptID, Name: name, Source: src, Enabled: true})
	if err != nil {
		t.Fatalf("UpsertScript %q: %v", scriptID, err)
	}
	return v
}

func TestLuaUpsertFields(t *testing.T) {
	setupLuaTestDB(t)
	e := NewLuaExecutor(LuaOptions{Timeout: 5 * time.Second})
	v, err := e.UpsertScript(ScriptInput{
		ScriptID:    "s",
		Name:        "N",
		Description: "desc",
		Source:      `function handle(ctx) end`,
		Enabled:     false,
	})
	if err != nil {
		t.Fatal(err)
	}
	if v != 1 {
		t.Fatalf("version = %d, want 1", v)
	}
	got, err := repo.GetLatestScript("s")
	if err != nil {
		t.Fatal(err)
	}
	if got.Description != "desc" || got.Enabled {
		t.Fatalf("persisted script = %+v, want desc + disabled", got)
	}
}

func TestLuaSuccess(t *testing.T) {
	setupLuaTestDB(t)
	e := NewLuaExecutor(LuaOptions{Timeout: 5 * time.Second})
	mustUpsert(t, e, "push-notify", "PushNotify", `function handle(ctx) ctx.log("hi") end`)
	if err := e.Execute(context.Background(), "push-notify", luaTask(`{"to":"a@x.com"}`)); err != nil {
		t.Fatalf("Execute = %v, want nil", err)
	}
}

func TestLuaRetry(t *testing.T) {
	setupLuaTestDB(t)
	e := NewLuaExecutor(LuaOptions{Timeout: 5 * time.Second})
	mustUpsert(t, e, "r", "Retry", `function handle(ctx) ctx.retry("busy") end`)
	err := e.Execute(context.Background(), "r", luaTask(""))
	if !errors.Is(err, ErrRetry) {
		t.Fatalf("err = %v, want ErrRetry", err)
	}
}

func TestLuaFail(t *testing.T) {
	setupLuaTestDB(t)
	e := NewLuaExecutor(LuaOptions{Timeout: 5 * time.Second})
	mustUpsert(t, e, "f", "Fail", `function handle(ctx) ctx.fail("boom") end`)
	err := e.Execute(context.Background(), "f", luaTask(""))
	if err == nil || errors.Is(err, ErrRetry) {
		t.Fatalf("err = %v, want hard error (not ErrRetry)", err)
	}
}

func TestLuaTimeoutDiscardsVM(t *testing.T) {
	setupLuaTestDB(t)
	e := NewLuaExecutor(LuaOptions{Timeout: 200 * time.Millisecond, MaxIdleVM: 2})
	mustUpsert(t, e, "spin", "Spin", `function handle(ctx) while true do end end`)
	start := time.Now()
	err := e.Execute(context.Background(), "spin", luaTask(""))
	if err == nil {
		t.Fatal("want timeout error")
	}
	if time.Since(start) > 5*time.Second {
		t.Fatal("timeout was not enforced")
	}
	if got := len(e.pool); got != 0 {
		t.Fatalf("pool = %d, want 0 (timed-out VM must be discarded)", got)
	}
}

func TestLuaSandboxBlocksOS(t *testing.T) {
	setupLuaTestDB(t)
	e := NewLuaExecutor(LuaOptions{Timeout: 5 * time.Second})
	mustUpsert(t, e, "evil", "Evil", `function handle(ctx) os.execute("rm -rf /") end`)
	if err := e.Execute(context.Background(), "evil", luaTask("")); err == nil {
		t.Fatal("want error (os library must not be available)")
	}
}

func TestLuaGlobalIsolationAcrossScripts(t *testing.T) {
	setupLuaTestDB(t)
	e := NewLuaExecutor(LuaOptions{Timeout: 5 * time.Second, MaxIdleVM: 2})
	// s1 sets a global; s2 must NOT see it when sharing a pooled VM.
	mustUpsert(t, e, "s1", "S1", `g = "secret" function handle(ctx) end`)
	mustUpsert(t, e, "s2", "S2", `function handle(ctx) if g ~= nil then ctx.fail("global leaked") end end`)

	if err := e.Execute(context.Background(), "s1", luaTask("")); err != nil {
		t.Fatalf("s1: %v", err)
	}
	if got := len(e.pool); got != 1 {
		t.Fatalf("pool = %d, want 1 (s1 VM returned)", got)
	}
	if err := e.Execute(context.Background(), "s2", luaTask("")); err != nil {
		t.Fatalf("s2 saw s1's global: %v (env isolation broken)", err)
	}
}

func TestLuaCompileCacheAndVMReuse(t *testing.T) {
	setupLuaTestDB(t)
	e := NewLuaExecutor(LuaOptions{Timeout: 5 * time.Second, MaxIdleVM: 2})
	mustUpsert(t, e, "c", "C", `function handle(ctx) end`)

	e.mu.Lock()
	_, cached := e.cache["c"]
	e.mu.Unlock()
	if !cached {
		t.Fatal("compile cache miss after UpsertScript")
	}

	if err := e.Execute(context.Background(), "c", luaTask("")); err != nil {
		t.Fatal(err)
	}
	if got := len(e.pool); got != 1 {
		t.Fatalf("pool = %d, want 1 (VM reused after first run)", got)
	}
	if err := e.Execute(context.Background(), "c", luaTask("")); err != nil {
		t.Fatal(err)
	}
	if got := len(e.pool); got != 1 {
		t.Fatalf("pool = %d, want 1 (acquire from pool on second run)", got)
	}
}

func TestLuaPayloadAndCJSON(t *testing.T) {
	setupLuaTestDB(t)
	e := NewLuaExecutor(LuaOptions{Timeout: 5 * time.Second})
	src := `function handle(ctx)
    local p = ctx.payload()
    if p.to ~= "a@x.com" or p.count ~= 3 then ctx.fail("payload mismatch") end
    local j = cjson.encode({ok = true, n = 3})
    local d = cjson.decode(j)
    if not d.ok or d.n ~= 3 then ctx.fail("cjson broken") end
end`
	mustUpsert(t, e, "pay", "Payload", src)
	if err := e.Execute(context.Background(), "pay", luaTask(`{"to":"a@x.com","count":3}`)); err != nil {
		t.Fatalf("Execute = %v", err)
	}
}

func TestLuaHTTP(t *testing.T) {
	setupLuaTestDB(t)
	var gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Write([]byte("pong"))
	}))
	defer srv.Close()

	e := NewLuaExecutor(LuaOptions{Timeout: 5 * time.Second})
	src := fmt.Sprintf(`function handle(ctx)
    local body, status = ctx.http_get(%q)
    if status ~= 200 or body ~= "pong" then ctx.fail("get fail: " .. tostring(status)) end
    local b2, s2 = ctx.http_post(%q, "hello")
    if s2 ~= 200 then ctx.fail("post fail") end
end`, srv.URL, srv.URL)
	mustUpsert(t, e, "http", "HTTP", src)
	if err := e.Execute(context.Background(), "http", luaTask("")); err != nil {
		t.Fatalf("Execute = %v", err)
	}
	if gotBody != "hello" {
		t.Fatalf("post body = %q, want hello", gotBody)
	}
}

func TestLuaMissingHandle(t *testing.T) {
	setupLuaTestDB(t)
	e := NewLuaExecutor(LuaOptions{Timeout: 5 * time.Second})
	mustUpsert(t, e, "nohandle", "NoHandle", `x = 1`)
	if err := e.Execute(context.Background(), "nohandle", luaTask("")); err == nil || !strings.Contains(err.Error(), "handle") {
		t.Fatalf("err = %v, want missing handle error", err)
	}
}

func TestLuaCompileErrorRejected(t *testing.T) {
	setupLuaTestDB(t)
	e := NewLuaExecutor(LuaOptions{Timeout: 5 * time.Second})
	if _, err := e.UpsertScript(ScriptInput{ScriptID: "bad", Name: "Bad", Source: `function handle( ctx)`, Enabled: true}); err == nil {
		t.Fatal("syntax error must be rejected at upload time")
	}
}

func TestLuaScriptTooLarge(t *testing.T) {
	setupLuaTestDB(t)
	e := NewLuaExecutor(LuaOptions{MaxSourceLen: 100})
	big := strings.Repeat("a", 200)
	if _, err := e.UpsertScript(ScriptInput{ScriptID: "big", Name: "Big", Source: big, Enabled: true}); err == nil {
		t.Fatal("oversized script must be rejected")
	}
}

func TestLuaHandlerReadsScriptIDFromPayload(t *testing.T) {
	setupLuaTestDB(t)
	e := NewLuaExecutor(LuaOptions{Timeout: 5 * time.Second})
	var called bool
	mustUpsert(t, e, "via-handler", "ViaHandler", `function handle(ctx) end`)
	h := e.Handler()
	// payload references script_id via-handler
	task := luaTask(`{"script_id":"via-handler"}`)
	err := h(context.Background(), task)
	_ = called
	if err != nil {
		t.Fatalf("handler err = %v, want nil", err)
	}

	// missing script_id in payload -> error
	if err := h(context.Background(), luaTask(`{"x":1}`)); err == nil || !strings.Contains(err.Error(), "script_id") {
		t.Fatalf("err = %v, want missing script_id error", err)
	}
}
