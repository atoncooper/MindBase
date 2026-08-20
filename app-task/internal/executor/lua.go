package executor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"app-task/internal/model"
	"app-task/internal/repo"

	"github.com/yuin/gopher-lua"
	"github.com/yuin/gopher-lua/parse"
)

// LuaOptions configures the Lua executor.
type LuaOptions struct {
	Timeout      time.Duration // per-script execution timeout (default 30s)
	MaxIdleVM    int           // idle VM pool size (default 4)
	MaxSourceLen int           // max script source bytes (default 64 KiB)
	HTTPTimeout  time.Duration // ctx.http_get/post timeout (default 15s)
}

// LuaExecutor runs reusable Lua scripts (xxl-task GLUE-style) inside a
// gopher-lua VM — a pure-Go Lua 5.1 VM with no CGO, so it runs on the
// distroless image unchanged.
//
// Management (why we do NOT build a fresh VM + compile per execution):
//   - compile cache: CompileString once per (script_id, version), cache the
//     *FunctionProto; execution only LoadProto (cheap). Uploads refresh it.
//   - VM pool: bounded idle pool (channel). VMs are reused only when the
//     script returned normally; timed-out / panicked VMs are discarded, so
//     no torn state ever leaks into the pool.
//   - per-script env table: every execution gets a fresh environment table
//     (restricted stdlib + ctx/cjson) as the script's _G, so global variables
//     never leak across executions or scripts on a reused VM.
type LuaExecutor struct {
	opts  LuaOptions
	mu    sync.Mutex
	cache map[string]*compiledScript // script_id → latest compiled form
	pool  chan *lua.LState
	http  *http.Client
}

type compiledScript struct {
	version int
	proto   *lua.FunctionProto
}

// NewLuaExecutor returns a Lua executor with sane defaults for zero values.
func NewLuaExecutor(opts LuaOptions) *LuaExecutor {
	if opts.Timeout <= 0 {
		opts.Timeout = 30 * time.Second
	}
	if opts.MaxIdleVM <= 0 {
		opts.MaxIdleVM = 4
	}
	if opts.MaxSourceLen <= 0 {
		opts.MaxSourceLen = 64 << 10
	}
	if opts.HTTPTimeout <= 0 {
		opts.HTTPTimeout = 15 * time.Second
	}
	return &LuaExecutor{
		opts:  opts,
		cache: make(map[string]*compiledScript),
		pool:  make(chan *lua.LState, opts.MaxIdleVM),
		http:  &http.Client{Timeout: opts.HTTPTimeout},
	}
}

// Handler returns the executor.Handler for task_type="lua". It reads the
// script_id from the task payload and runs the script; the result semantics
// match Go handlers (nil=success, ErrRetry, or a hard error). The handler
// only sees the generic Task view — never a concrete business model.
func (e *LuaExecutor) Handler() Handler {
	return func(ctx context.Context, task Task) error {
		var payload map[string]any
		if len(task.Payload) > 0 {
			if err := json.Unmarshal(task.Payload, &payload); err != nil {
				return fmt.Errorf("lua payload decode: %w", err)
			}
		}
		scriptID, _ := payload["script_id"].(string)
		if scriptID == "" {
			return errors.New("lua task payload missing script_id")
		}
		return e.Execute(ctx, scriptID, task)
	}
}

// ScriptInput carries the fields of a script upload. Operator/SourceIP/
// RequestID are audit metadata recorded by the caller (router); the executor
// only cares about identity + source, but keeps them for the audit log.
type ScriptInput struct {
	ScriptID    string
	Name        string
	Description string
	Source      string
	Enabled     bool
}

// UpsertScript compiles and caches a script version. The script is also
// persisted (version+1) so a restart re-loads it from the DB. Returns the
// new version number.
func (e *LuaExecutor) UpsertScript(in ScriptInput) (int, error) {
	if in.ScriptID == "" {
		return 0, errors.New("script_id required")
	}
	if len(in.Source) > e.opts.MaxSourceLen {
		return 0, fmt.Errorf("script too large (%d bytes, max %d)", len(in.Source), e.opts.MaxSourceLen)
	}
	proto, err := compileSource(in.Source)
	if err != nil {
		return 0, fmt.Errorf("compile script: %w", err)
	}
	version, err := repo.NextScriptVersion(in.ScriptID)
	if err != nil {
		return 0, err
	}
	if err := repo.CreateScript(&model.Script{
		ScriptID:    in.ScriptID,
		Version:     version,
		Name:        in.Name,
		Description: in.Description,
		Source:      in.Source,
		Enabled:     in.Enabled,
	}); err != nil {
		return 0, err
	}
	e.mu.Lock()
	e.cache[in.ScriptID] = &compiledScript{version: version, proto: proto}
	e.mu.Unlock()
	slog.Info("[LUA] script upserted", "script_id", in.ScriptID, "version", version)
	return version, nil
}

// Execute runs the latest version of scriptID against a generic Task. Returns
// nil on success, ErrRetry (wrapped) when the script called ctx.retry, or an
// error otherwise (hard failure or ctx.fail / timeout / script error). The
// script sees task.ID and task.Meta via ctx.task(), payload via ctx.payload().
func (e *LuaExecutor) Execute(ctx context.Context, scriptID string, task Task) error {
	c, err := e.compiled(scriptID)
	if err != nil {
		return err
	}
	ls := e.acquire()
	clean := false
	defer func() {
		if clean {
			e.release(ls)
		} else {
			ls.Close() // timed out / errored: discard, never reuse
		}
	}()

	execCtx, cancel := context.WithTimeout(ctx, e.opts.Timeout)
	defer cancel()
	ls.SetContext(execCtx)
	defer ls.RemoveContext()

	// Compile the top-level chunk (defines handle) and give it a fresh env so
	// globals stay per-execution (safe to reuse the VM afterwards).
	fn := ls.NewFunctionFromProto(c.proto)
	env := ls.NewTable()
	ls.SetFEnv(fn, env)
	e.installEnv(ls, env)

	if err := ls.CallByParam(lua.P{Fn: fn, NRet: 0, Protect: true}); err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return fmt.Errorf("lua %q timed out after %s", scriptID, e.opts.Timeout)
		}
		return fmt.Errorf("lua %q load: %w", scriptID, err)
	}

	h := env.RawGetString("handle")
	if h == lua.LNil {
		return fmt.Errorf("lua %q: missing function handle(ctx)", scriptID)
	}

	var res execResult
	ctxTbl := ls.NewTable()
	e.installCtx(ls, ctxTbl, task, &res)
	if err := ls.CallByParam(lua.P{Fn: h, NRet: 0, Protect: true}, ctxTbl); err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return fmt.Errorf("lua %q timed out after %s", scriptID, e.opts.Timeout)
		}
		return fmt.Errorf("lua %q handle: %w", scriptID, err)
	}
	clean = true

	switch res.kind {
	case resultRetry:
		return fmt.Errorf("%w: %s", ErrRetry, res.msg)
	case resultFail:
		if res.msg == "" {
			res.msg = "failed by script"
		}
		return errors.New(res.msg)
	default:
		return nil
	}
}

// ── compile cache + VM pool ──────────────────────────────────────────

func (e *LuaExecutor) compiled(scriptID string) (*compiledScript, error) {
	e.mu.Lock()
	if c, ok := e.cache[scriptID]; ok {
		e.mu.Unlock()
		return c, nil
	}
	e.mu.Unlock()

	s, err := repo.GetLatestScript(scriptID)
	if err != nil {
		return nil, err
	}
	proto, err := compileSource(s.Source)
	if err != nil {
		return nil, fmt.Errorf("compile script %q: %w", scriptID, err)
	}
	c := &compiledScript{version: s.Version, proto: proto}
	e.mu.Lock()
	e.cache[scriptID] = c
	e.mu.Unlock()
	return c, nil
}

func (e *LuaExecutor) acquire() *lua.LState {
	select {
	case ls := <-e.pool:
		return ls
	default:
		return newSafeState()
	}
}

func (e *LuaExecutor) release(ls *lua.LState) {
	select {
	case e.pool <- ls:
	default:
		ls.Close()
	}
}

// compileSource parses + compiles a Lua source string into a FunctionProto
// (cached per script version; execution only LoadProto afterwards).
func compileSource(src string) (*lua.FunctionProto, error) {
	chunk, err := parse.Parse(strings.NewReader(src), "script")
	if err != nil {
		return nil, err
	}
	proto, err := lua.Compile(chunk, "script")
	if err != nil {
		return nil, err
	}
	return proto, nil
}

// newSafeState builds a VM with only computation-safe stdlib libraries
// (no os/io/package/debug/channel), so scripts can only act through ctx.
func newSafeState() *lua.LState {
	ls := lua.NewState(lua.Options{SkipOpenLibs: true})
	lua.OpenBase(ls)
	lua.OpenTable(ls)
	lua.OpenString(ls)
	lua.OpenMath(ls)
	return ls
}

// ── script environment (ctx + cjson) ────────────────────────────────

type resultKind int

const (
	resultSuccess resultKind = iota
	resultRetry
	resultFail
)

type execResult struct {
	kind resultKind
	msg  string
}

func (e *LuaExecutor) installEnv(ls *lua.LState, env *lua.LTable) {
	// cjson: encode/decode between Lua values and JSON strings.
	cjson := ls.NewTable()
	cjson.RawSetString("encode", ls.NewFunction(func(L *lua.LState) int {
		b, err := json.Marshal(luaToGo(L, L.CheckAny(1)))
		if err != nil {
			L.RaiseError("cjson.encode: %v", err)
			return 0
		}
		L.Push(lua.LString(string(b)))
		return 1
	}))
	cjson.RawSetString("decode", ls.NewFunction(func(L *lua.LState) int {
		var v any
		if err := json.Unmarshal([]byte(L.CheckString(1)), &v); err != nil {
			L.RaiseError("cjson.decode: %v", err)
			return 0
		}
		L.Push(goToLua(L, v))
		return 1
	}))
	env.RawSetString("cjson", cjson)
}

func (e *LuaExecutor) installCtx(ls *lua.LState, tbl *lua.LTable, task Task, res *execResult) {
	tbl.RawSetString("log", ls.NewFunction(func(L *lua.LState) int {
		slog.Info("[LUA] script log", "task_id", task.ID, "msg", L.OptString(1, ""))
		return 0
	}))
	tbl.RawSetString("payload", ls.NewFunction(func(L *lua.LState) int {
		if len(task.Payload) == 0 {
			L.Push(lua.LNil)
			return 1
		}
		var v any
		if err := json.Unmarshal(task.Payload, &v); err != nil {
			L.RaiseError("payload decode: %v", err)
			return 0
		}
		L.Push(goToLua(L, v))
		return 1
	}))
	tbl.RawSetString("task", ls.NewFunction(func(L *lua.LState) int {
		t := L.NewTable()
		t.RawSetString("id", lua.LString(task.ID))
		if task.Meta != nil {
			t.RawSetString("meta", goToLua(L, task.Meta))
		}
		L.Push(t)
		return 1
	}))
	tbl.RawSetString("retry", ls.NewFunction(func(L *lua.LState) int {
		res.kind = resultRetry
		res.msg = L.OptString(1, "retry requested by script")
		return 0
	}))
	tbl.RawSetString("fail", ls.NewFunction(func(L *lua.LState) int {
		res.kind = resultFail
		res.msg = L.OptString(1, "failed by script")
		return 0
	}))
	tbl.RawSetString("http_get", ls.NewFunction(func(L *lua.LState) int {
		body, status, errMsg := e.httpCall("GET", L.CheckString(1), nil, "")
		if errMsg != "" {
			L.Push(lua.LNil)
			L.Push(lua.LString(errMsg))
			return 2
		}
		L.Push(lua.LString(body))
		L.Push(lua.LNumber(status))
		return 2
	}))
	tbl.RawSetString("http_post", ls.NewFunction(func(L *lua.LState) int {
		body, status, errMsg := e.httpCall("POST", L.CheckString(1), []byte(L.OptString(2, "")), L.OptString(3, "application/json"))
		if errMsg != "" {
			L.Push(lua.LNil)
			L.Push(lua.LString(errMsg))
			return 2
		}
		L.Push(lua.LString(body))
		L.Push(lua.LNumber(status))
		return 2
	}))
}

func (e *LuaExecutor) httpCall(method, url string, body []byte, contentType string) (string, int, string) {
	var req *http.Request
	var err error
	if method == "POST" {
		req, err = http.NewRequest(method, url, bytesReader(body))
	} else {
		req, err = http.NewRequest(method, url, nil)
	}
	if err != nil {
		return "", 0, err.Error()
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := e.http.Do(req)
	if err != nil {
		return "", 0, err.Error()
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", resp.StatusCode, err.Error()
	}
	return string(respBody), resp.StatusCode, ""
}

// ── Lua <-> Go value conversion ─────────────────────────────────────

func goToLua(L *lua.LState, v any) lua.LValue {
	switch t := v.(type) {
	case nil:
		return lua.LNil
	case bool:
		return lua.LBool(t)
	case float64:
		return lua.LNumber(t)
	case string:
		return lua.LString(t)
	case []any:
		tbl := L.NewTable()
		for i, item := range t {
			tbl.RawSetInt(i+1, goToLua(L, item))
		}
		return tbl
	case map[string]any:
		tbl := L.NewTable()
		for k, item := range t {
			tbl.RawSetString(k, goToLua(L, item))
		}
		return tbl
	default:
		return lua.LNil
	}
}

func luaToGo(L *lua.LState, v lua.LValue) any {
	switch t := v.(type) {
	case *lua.LTable:
		if t.Len() > 0 { // array part: contiguous 1..n numeric keys
			arr := make([]any, 0, t.Len())
			for i := 1; i <= t.Len(); i++ {
				arr = append(arr, luaToGo(L, t.RawGetInt(i)))
			}
			return arr
		}
		m := map[string]any{}
		t.ForEach(func(k, v lua.LValue) {
			m[k.String()] = luaToGo(L, v)
		})
		return m
	case lua.LBool:
		return bool(t)
	case lua.LNumber:
		return float64(t)
	case lua.LString:
		return string(t)
	default:
		return nil
	}
}

// bytesReader wraps a byte slice as an io.Reader without an extra import.
type byteReader struct{ b []byte }

func (r *byteReader) Read(p []byte) (int, error) {
	if len(r.b) == 0 {
		return 0, io.EOF
	}
	n := copy(p, r.b)
	r.b = r.b[n:]
	return n, nil
}

func bytesReader(b []byte) io.Reader {
	if len(b) == 0 {
		return nil
	}
	return &byteReader{b: b}
}
