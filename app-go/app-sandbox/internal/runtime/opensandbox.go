package runtime

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"app-sandbox/internal/config"
)

// OpenSandbox adapter: the lifecycle server owns sandbox creation/inspection/
// deletion and endpoint resolution; execd (one per sandbox) streams command
// execution. Wire shapes follow the published OpenAPI specs
// (specs/sandbox-lifecycle.yml, specs/execd-api.yaml); any behaviour that has
// not been exercised against a live instance stays behind a TODO.
type OpenSandbox struct {
	cfg       config.OpenSandboxConfig
	lifecycle *http.Client
	execd     *http.Client

	mu        sync.Mutex
	endpoints map[string]cachedEndpoint
}

type cachedEndpoint struct {
	base      string
	headers   map[string]string
	expiresAt time.Time
}

// NewOpenSandbox builds the adapter from config.
func NewOpenSandbox(cfg config.OpenSandboxConfig) *OpenSandbox {
	createTimeout := time.Duration(cfg.CreateTimeoutMS) * time.Millisecond
	if createTimeout <= 0 {
		createTimeout = 60 * time.Second
	}
	// The exec client must not impose a fixed timeout: each call carries its own
	// deadline through the request context (executions are long-lived streams).
	return &OpenSandbox{
		cfg:       cfg,
		lifecycle: &http.Client{Timeout: createTimeout},
		execd:     &http.Client{},
		endpoints: map[string]cachedEndpoint{},
	}
}

// Name implements Runtime.
func (o *OpenSandbox) Name() string { return config.RuntimeOpenSandbox }

// ── lifecycle ────────────────────────────────────────────────────────

type lifecycleStatus struct {
	State string `json:"state"`
}

type lifecycleSandbox struct {
	ID        string          `json:"id"`
	Status    lifecycleStatus `json:"status"`
	CreatedAt string          `json:"createdAt"`
}

type endpointResponse struct {
	Endpoint string            `json:"endpoint"`
	Headers  map[string]string `json:"headers"`
}

// Create implements Runtime. The sandbox starts Pending; callers poll Get (or
// resolve the endpoint later), matching the asynchronous lifecycle contract.
func (o *OpenSandbox) Create(ctx context.Context, spec CreateSpec) (*Sandbox, error) {
	payload := map[string]any{
		"image":      map[string]string{"uri": spec.Image},
		"entrypoint": []string{"tail", "-f", "/dev/null"},
		"resourceLimits": map[string]string{
			"cpu":    spec.CPU,
			"memory": spec.Memory,
		},
		"metadata": map[string]string{
			"uid":       strconv.FormatInt(spec.UID, 10),
			"projectId": metadataValue(spec.ProjectID),
			"purpose":   metadataValue(spec.Purpose),
			"specHash":  metadataValue(spec.SpecHash),
		},
	}
	if spec.Timeout > 0 {
		payload["timeout"] = int(spec.Timeout.Seconds())
	}
	if len(spec.Env) > 0 {
		payload["env"] = spec.Env
	}
	if pool := strings.TrimSpace(o.cfg.PoolRef); pool != "" {
		// Kubernetes warm-pool allocation: the pool's Pod template owns the image
		// and entrypoint, so neither may be echoed in the create request.
		payload["extensions"] = map[string]string{"poolRef": pool}
		delete(payload, "image")
		delete(payload, "entrypoint")
	}
	var out lifecycleSandbox
	if err := o.doJSON(ctx, o.lifecycle, http.MethodPost, o.lifecycleURL("/sandboxes"), payload, &out, o.lifecycleHeaders()); err != nil {
		return nil, fmt.Errorf("opensandbox create: %w", err)
	}
	if out.ID == "" {
		return nil, fmt.Errorf("opensandbox create: empty sandbox id in response")
	}
	return &Sandbox{ID: out.ID, State: out.Status.State, CreatedAt: parseTime(out.CreatedAt)}, nil
}

// Get implements Runtime.
func (o *OpenSandbox) Get(ctx context.Context, sandboxID string) (*Sandbox, error) {
	var out lifecycleSandbox
	path := "/sandboxes/" + url.PathEscape(sandboxID)
	if err := o.doJSON(ctx, o.lifecycle, http.MethodGet, o.lifecycleURL(path), nil, &out, o.lifecycleHeaders()); err != nil {
		return nil, fmt.Errorf("opensandbox get: %w", err)
	}
	return &Sandbox{ID: out.ID, State: out.Status.State, CreatedAt: parseTime(out.CreatedAt)}, nil
}

// Delete implements Runtime; a missing sandbox is not an error (idempotent
// reclaim so the sweeper can retry safely).
func (o *OpenSandbox) Delete(ctx context.Context, sandboxID string) error {
	path := "/sandboxes/" + url.PathEscape(sandboxID)
	err := o.doJSON(ctx, o.lifecycle, http.MethodDelete, o.lifecycleURL(path), nil, nil, o.lifecycleHeaders())
	if err == nil || isNotFound(err) {
		o.forgetEndpoint(sandboxID)
		return nil
	}
	return fmt.Errorf("opensandbox delete: %w", err)
}

// Probe implements runtime.Prober: lifecycle readiness gates /ready.
func (o *OpenSandbox) Probe(ctx context.Context) error {
	base := strings.TrimRight(strings.TrimSpace(o.cfg.LifecycleBaseURL), "/")
	if base == "" {
		return fmt.Errorf("opensandbox: lifecycleBaseUrl is not configured")
	}
	// /health lives at the server root, not under the /v1 API prefix.
	base = strings.TrimSuffix(base, "/v1")
	if !strings.Contains(base, "://") {
		base = "http://" + base
	}
	if err := o.doJSON(ctx, o.lifecycle, http.MethodGet, joinURL(base, "/health"), nil, nil, o.lifecycleHeaders()); err != nil {
		return fmt.Errorf("opensandbox health: %w", err)
	}
	return nil
}

// Endpoint implements Runtime: resolves the execd endpoint for the sandbox and
// caches it briefly (endpoint routes are stable for the sandbox lifetime).
func (o *OpenSandbox) Endpoint(ctx context.Context, sandboxID string) (string, error) {
	ep, err := o.execdEndpoint(ctx, sandboxID)
	if err != nil {
		return "", err
	}
	return ep.base, nil
}

func (o *OpenSandbox) execdEndpoint(ctx context.Context, sandboxID string) (cachedEndpoint, error) {
	o.mu.Lock()
	cached, ok := o.endpoints[sandboxID]
	o.mu.Unlock()
	if ok && time.Now().Before(cached.expiresAt) {
		return cached, nil
	}
	port := o.cfg.ExecdPort
	if port <= 0 {
		port = 44772
	}
	var out endpointResponse
	path := "/sandboxes/" + url.PathEscape(sandboxID) + "/endpoints/" + strconv.Itoa(port)
	if err := o.doJSON(ctx, o.lifecycle, http.MethodGet, o.lifecycleURL(path), nil, &out, o.lifecycleHeaders()); err != nil {
		return cachedEndpoint{}, fmt.Errorf("opensandbox endpoint: %w", err)
	}
	if out.Endpoint == "" {
		return cachedEndpoint{}, fmt.Errorf("opensandbox endpoint: empty endpoint for sandbox %s", sandboxID)
	}
	if !strings.Contains(out.Endpoint, "://") {
		// The Kubernetes ingress gateway returns a host/path without a scheme.
		out.Endpoint = "http://" + out.Endpoint
	}
	if !strings.HasSuffix(out.Endpoint, "/") {
		out.Endpoint = strings.TrimRight(out.Endpoint, "/")
	}
	ep := cachedEndpoint{base: out.Endpoint, headers: out.Headers, expiresAt: time.Now().Add(5 * time.Minute)}
	o.mu.Lock()
	o.endpoints[sandboxID] = ep
	o.mu.Unlock()
	return ep, nil
}

func (o *OpenSandbox) forgetEndpoint(sandboxID string) {
	o.mu.Lock()
	delete(o.endpoints, sandboxID)
	o.mu.Unlock()
}

// ── execution ────────────────────────────────────────────────────────

// Exec implements Runtime: materialize the code + input files through execd's
// file upload API, then run the interpreter command and consume its SSE stream.
// Cancellation interrupts the remote session best-effort before returning.
func (o *OpenSandbox) Exec(ctx context.Context, req ExecRequest) (*ExecResult, error) {
	ep, err := o.execdEndpoint(ctx, req.SandboxID)
	if err != nil {
		return nil, err
	}
	if req.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, req.Timeout)
		defer cancel()
	}
	if isShellLanguage(req.Language) {
		return o.execShell(ctx, ep, req)
	}
	runID := strconv.FormatInt(time.Now().UnixNano(), 36)
	codePath, err := o.uploadCode(ctx, ep, req, runID)
	if err != nil {
		return nil, err
	}
	command, err := interpreterCommand(req.Language, codePath)
	if err != nil {
		return nil, err
	}
	payload := map[string]any{
		// The base image may not ship /workspace; create it before running so
		// artifact globs under /workspace/analysis/outputs can exist.
		"command": "mkdir -p /workspace && cd /workspace && " + command,
		"cwd":     "/tmp",
		"timeout": req.Timeout.Milliseconds(),
		"envs":    map[string]string{"PYTHONUNBUFFERED": "1"},
	}
	if req.Timeout <= 0 {
		delete(payload, "timeout")
	}
	result, sessionID, err := o.runCommand(ctx, ep, payload)
	if err != nil {
		if isTimeout(err) {
			o.interrupt(ep, sessionID)
			return nil, ErrTimeout
		}
		return nil, fmt.Errorf("opensandbox exec: %w", err)
	}
	return result, nil
}

func (o *OpenSandbox) uploadCode(ctx context.Context, ep cachedEndpoint, req ExecRequest, runID string) (string, error) {
	ext := ".py"
	if req.Language == "javascript" {
		ext = ".js"
	}
	codePath := "/tmp/osb-" + runID + ext
	upload := []File{{Path: codePath, Content: req.Code}}
	for _, file := range req.Files {
		path := file.Path
		if !strings.HasPrefix(path, "/") {
			path = "/workspace/" + path
		}
		upload = append(upload, File{Path: path, Content: file.Content})
	}
	if err := o.uploadFiles(ctx, ep, upload); err != nil {
		return "", fmt.Errorf("opensandbox upload: %w", err)
	}
	return codePath, nil
}

func isShellLanguage(language string) bool {
	switch strings.ToLower(language) {
	case "bash", "sh", "pwsh":
		return true
	default:
		return false
	}
}

func shellExecCommand(language, command string) (string, error) {
	quoted := shellQuote(command)
	switch strings.ToLower(language) {
	case "bash":
		return "if command -v bash >/dev/null 2>&1; then bash -lc " + quoted + "; else sh -lc " + quoted + "; fi", nil
	case "sh":
		return "sh -lc " + quoted, nil
	case "pwsh":
		return "pwsh -NoProfile -NonInteractive -Command " + quoted, nil
	default:
		return "", fmt.Errorf("opensandbox: unsupported shell %q", language)
	}
}

// execShell runs an AI-authored shell command in the leased sandbox. The lease
// (uid+project+purpose) is reused across calls, so /workspace persists until the
// sandbox TTL expires — grep/find/git/pytest see previous files.
func (o *OpenSandbox) execShell(ctx context.Context, ep cachedEndpoint, req ExecRequest) (*ExecResult, error) {
	command, err := shellExecCommand(req.Language, req.Code)
	if err != nil {
		return nil, err
	}
	payload := map[string]any{
		"command": "mkdir -p /workspace && cd /workspace && " + command,
		"cwd":     "/tmp",
		"timeout": req.Timeout.Milliseconds(),
		"envs":    map[string]string{"PYTHONUNBUFFERED": "1"},
	}
	if req.Timeout <= 0 {
		delete(payload, "timeout")
	}
	result, sessionID, err := o.runCommand(ctx, ep, payload)
	if err != nil {
		if isTimeout(err) {
			o.interrupt(ep, sessionID)
			return nil, ErrTimeout
		}
		return nil, fmt.Errorf("opensandbox shell: %w", err)
	}
	return result, nil
}

func interpreterCommand(language, codePath string) (string, error) {
	switch strings.ToLower(language) {
	case "python", "python3":
		return "python3 " + shellQuote(codePath), nil
	case "javascript", "node", "js":
		return "node " + shellQuote(codePath), nil
	default:
		return "", fmt.Errorf("opensandbox: unsupported language %q", language)
	}
}

// uploadFiles posts one metadata+content multipart pair per file (execd reads
// form parts sequentially).
func (o *OpenSandbox) uploadFiles(ctx context.Context, ep cachedEndpoint, files []File) error {
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	for _, file := range files {
		meta, err := json.Marshal(map[string]any{"path": file.Path, "mode": 0o644})
		if err != nil {
			return err
		}
		metaPart, err := writer.CreatePart(partHeader("form-data; name=\"metadata\"; filename=\"metadata.json\"", "application/json"))
		if err != nil {
			return err
		}
		if _, err := metaPart.Write(meta); err != nil {
			return err
		}
		filePart, err := writer.CreatePart(partHeader("form-data; name=\"file\"; filename=\""+safeFilename(pathBase(file.Path))+"\"", "application/octet-stream"))
		if err != nil {
			return err
		}
		if _, err := filePart.Write([]byte(file.Content)); err != nil {
			return err
		}
	}
	if err := writer.Close(); err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, joinURL(ep.base, "/files/upload"), &buf)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())
	o.applyExecHeaders(req, ep)
	return o.do(req, o.execd, nil)
}

// runCommand posts a foreground command and folds the SSE stream into ExecResult.
// It returns the session id carried by the init event so cancellation can target
// the exact run.
func (o *OpenSandbox) runCommand(ctx context.Context, ep cachedEndpoint, payload map[string]any) (*ExecResult, string, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, joinURL(ep.base, "/command"), bytes.NewReader(body))
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	o.applyExecHeaders(req, ep)

	resp, err := o.execd.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, "", ctxError(ctx)
		}
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, "", ErrNotFound
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, "", fmt.Errorf("http %d: %.300s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}

	const maxCapture = 256 * 1024
	result := &ExecResult{}
	sessionID := ""
	completed := false
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	event := ""
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "event:") {
			event = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
			continue
		}
		// execd streams one JSON object per line (some versions also use SSE
		// "data:" frames); accept both so output/exit-code is never silently lost.
		var data string
		switch {
		case strings.HasPrefix(line, "data:"):
			data = strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		case strings.HasPrefix(strings.TrimSpace(line), "{"):
			data = strings.TrimSpace(line)
		default:
			continue
		}
		if data == "" || data == "[DONE]" {
			continue
		}
		var frame map[string]any
		if json.Unmarshal([]byte(data), &frame) != nil {
			continue
		}
		typ := stringField(frame, "type")
		if typ == "" {
			typ = event
		}
		switch typ {
		case "init":
			sessionID = firstString(frame, "id", "execution_id", "session_id")
		case "stdout":
			text := stringField(frame, "text")
			result.StdoutBytes += int64(len(text))
			result.Stdout = appendBounded(result.Stdout, text, maxCapture)
		case "stderr":
			text := stringField(frame, "text")
			result.StderrBytes += int64(len(text))
			result.Stderr = appendBounded(result.Stderr, text, maxCapture)
		case "execution_complete":
			completed = true
			if code, ok := intField(frame, "exit_code"); ok {
				result.ExitCode = code
			}
			if ms, ok := int64Field(frame, "execution_time"); ok {
				result.Duration = time.Duration(ms) * time.Millisecond
			}
		case "error":
			result.ExitCode = 1
			if errObj, ok := frame["error"].(map[string]any); ok {
				if msg := stringField(errObj, "evalue"); msg != "" {
					result.StderrBytes += int64(len(msg))
					result.Stderr = appendBounded(result.Stderr, msg, maxCapture)
				}
				if code, ok := intField(errObj, "exit_code"); ok {
					result.ExitCode = code
				}
			}
		}
		event = ""
	}
	if err := scanner.Err(); err != nil {
		if ctx.Err() != nil {
			return nil, sessionID, ctxError(ctx)
		}
		return nil, sessionID, err
	}
	if ctx.Err() != nil {
		return nil, sessionID, ctxError(ctx)
	}
	if !completed {
		// A stream that ends without execution_complete has no reliable exit
		// status; defaulting to 0 would report a false success.
		return nil, sessionID, fmt.Errorf("execd stream ended without execution_complete")
	}
	return result, sessionID, nil
}

// interrupt asks execd to terminate the running session (best effort, bounded).
func (o *OpenSandbox) interrupt(ep cachedEndpoint, sessionID string) {
	if sessionID == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, joinURL(ep.base, "/command?id="+url.QueryEscape(sessionID)), nil)
	if err != nil {
		return
	}
	o.applyExecHeaders(req, ep)
	_ = o.do(req, o.execd, nil)
}

// ── HTTP plumbing ────────────────────────────────────────────────────

func (o *OpenSandbox) lifecycleURL(path string) string {
	base := strings.TrimRight(strings.TrimSpace(o.cfg.LifecycleBaseURL), "/")
	if base != "" && !strings.Contains(base, "://") {
		base = "http://" + base
	}
	if !strings.HasSuffix(base, "/v1") {
		base += "/v1"
	}
	return joinURL(base, path)
}

func (o *OpenSandbox) lifecycleHeaders() map[string]string {
	headers := map[string]string{}
	if o.cfg.APIKey != "" {
		headers["OPEN-SANDBOX-API-KEY"] = o.cfg.APIKey
	}
	return headers
}

func (o *OpenSandbox) applyExecHeaders(req *http.Request, ep cachedEndpoint) {
	for key, value := range ep.headers {
		req.Header.Set(key, value)
	}
	if o.cfg.APIKey != "" {
		req.Header.Set("OPEN-SANDBOX-API-KEY", o.cfg.APIKey)
	}
}

func (o *OpenSandbox) doJSON(ctx context.Context, client *http.Client, method, target string, payload, out any, headers map[string]string) error {
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		body = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		return err
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	return o.do(req, client, out)
}

func (o *OpenSandbox) do(req *http.Request, client *http.Client, out any) error {
	resp, err := client.Do(req)
	if err != nil {
		if req.Context().Err() != nil {
			return ErrTimeout
		}
		return err
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusNotFound:
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<14))
		return ErrNotFound
	case resp.StatusCode == http.StatusRequestTimeout || resp.StatusCode == http.StatusGatewayTimeout:
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<14))
		return ErrTimeout
	case resp.StatusCode < 200 || resp.StatusCode >= 300:
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("http %d: %.300s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	if out == nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
		return nil
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(out)
}

// ── small helpers ────────────────────────────────────────────────────

// appendBounded appends text up to cap bytes so a chatty program cannot grow
// the control-plane heap without bound (the true size is tracked separately).
func appendBounded(dst, text string, cap int) string {
	if len(dst) >= cap {
		return dst
	}
	room := cap - len(dst)
	if len(text) > room {
		return dst + text[:room]
	}
	return dst + text
}

// ctxError distinguishes user cancellation from a timeout.
func ctxError(ctx context.Context) error {
	if ctx.Err() == context.Canceled {
		return context.Canceled
	}
	return ErrTimeout
}

// metadataValue keeps OpenSandbox/Kubernetes label metadata valid: values are
// at most 63 characters, only [A-Za-z0-9._-], and start/end alphanumeric.
// The control plane's specHash is a 64-char sha256, so it must be truncated.
func metadataValue(raw string) string {
	value := strings.TrimSpace(raw)
	if value == "" {
		return ""
	}
	if len(value) > 63 {
		value = value[:63]
	}
	var b strings.Builder
	for i := 0; i < len(value); i++ {
		ch := value[i]
		if (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '-' || ch == '_' || ch == '.' {
			b.WriteByte(ch)
		} else {
			b.WriteByte('_')
		}
	}
	value = strings.TrimFunc(b.String(), func(r rune) bool {
		return !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9'))
	})
	if value == "" {
		return ""
	}
	return value
}

func joinURL(base, path string) string {
	return strings.TrimRight(base, "/") + "/" + strings.TrimLeft(path, "/")
}

func parseTime(raw string) time.Time {
	if raw == "" {
		return time.Time{}
	}
	if t, err := time.Parse(time.RFC3339, raw); err == nil {
		return t
	}
	return time.Time{}
}

func shellQuote(value string) string {
	// Wrap in single quotes; an embedded single quote becomes '\'' .
	sq := string(rune(39))
	escaped := sq + "\\" + sq + sq
	return sq + strings.ReplaceAll(value, sq, escaped) + sq
}

// partHeader builds the MIME headers for one multipart form part.
func partHeader(disposition, contentType string) textproto.MIMEHeader {
	header := textproto.MIMEHeader{}
	header.Set("Content-Disposition", disposition)
	header.Set("Content-Type", contentType)
	return header
}

// safeFilename keeps multipart headers well-formed: only a conservative ASCII
// subset survives (quotes/CRLF/control characters are replaced).
func safeFilename(name string) string {
	out := make([]byte, 0, len(name))
	for i := 0; i < len(name) && i < 100; i++ {
		ch := name[i]
		if (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '.' || ch == '-' || ch == '_' {
			out = append(out, ch)
		} else {
			out = append(out, '_')
		}
	}
	if len(out) == 0 || string(out) == "." || string(out) == ".." {
		return "file"
	}
	return string(out)
}

func pathBase(path string) string {
	if i := strings.LastIndex(path, "/"); i >= 0 {
		return path[i+1:]
	}
	return path
}

func isNotFound(err error) bool {
	return err == ErrNotFound || (err != nil && strings.Contains(err.Error(), ErrNotFound.Error()))
}

func isTimeout(err error) bool {
	if err == nil {
		return false
	}
	return err == ErrTimeout ||
		strings.Contains(err.Error(), ErrTimeout.Error()) ||
		strings.Contains(err.Error(), context.DeadlineExceeded.Error())
}

func stringField(m map[string]any, key string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

func firstString(m map[string]any, keys ...string) string {
	for _, key := range keys {
		if v := stringField(m, key); v != "" {
			return v
		}
	}
	return ""
}

func intField(m map[string]any, key string) (int, bool) {
	switch v := m[key].(type) {
	case float64:
		return int(v), true
	case int:
		return v, true
	}
	return 0, false
}

func int64Field(m map[string]any, key string) (int64, bool) {
	switch v := m[key].(type) {
	case float64:
		return int64(v), true
	case int64:
		return v, true
	}
	return 0, false
}
