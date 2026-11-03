package tests

import (
	. "app-sandbox/internal/router"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"app-sandbox/internal/config"
	"app-sandbox/internal/logger"
	"app-sandbox/internal/metrics"
	"app-sandbox/internal/repo"
	"app-sandbox/internal/runtime"
	"app-sandbox/internal/service"
)

const testAPIKey = "test-key"

func TestMain(m *testing.M) {
	logger.Init(logger.Options{Level: "error", Format: "text", Output: "stdout"})
	m.Run()
}

func routerTestConfig() *config.Config {
	return &config.Config{
		App:      config.AppConfig{Name: "app-sandbox"},
		Server:   config.ServerConfig{Host: "127.0.0.1", Port: 8017},
		Log:      config.LogConfig{Level: "error", Format: "text", Output: "stdout"},
		Timezone: "UTC",
		Database: config.DatabaseConfig{DSN: "memory"},
		Auth:     config.AuthConfig{APIKey: testAPIKey},
		Runtime: config.RuntimeConfig{
			Type:      config.RuntimeFake,
			Image:     "python:3.12",
			Resources: config.ResourceConfig{CPU: "500m", Memory: "512Mi"},
		},
		Execution: config.ExecutionConfig{MaxTimeoutMS: 600000, PreviewBytes: 128, MaxCodeBytes: 262144, IdempotencyTTLSeconds: 300},
		Lease:     config.LeaseConfig{TTLSeconds: 1800, MaxPerUID: 3},
		Admission: config.AdmissionConfig{MaxConcurrent: 8, MaxPerUID: 4, QueueSize: 32, QueueTimeoutMS: 30000},
		Quota: config.QuotaConfig{
			Enabled: false,
			Limits: map[string]config.TierLimit{
				config.QuotaAcademicRun:   {Free: 20, VIP: 200, SVIP: 600},
				config.QuotaConcurrent:    {Free: 1, VIP: 3, SVIP: 5},
				config.QuotaCPUSeconds:    {Free: 300, VIP: 3600, SVIP: 10800},
				config.QuotaArtifactBytes: {Free: 50 << 20, VIP: 500 << 20, SVIP: 2 << 30},
			},
		},
		Artifacts: config.ArtifactsConfig{PresignTTLSeconds: 900, MaxFileBytes: 20 << 20, MaxTotalBytes: 100 << 20, DefaultGlobs: []string{"/workspace/analysis/outputs/**"}},
		Sweeper:   config.SweeperConfig{IntervalMS: 15000, OrphanDryRun: true, CreateTimeoutMS: 60000},
	}
}

type harness struct {
	engine  http.Handler
	store   *repo.Memory
	rt      *runtime.Fake
	cfg     *config.Config
	execSvc *service.ExecutionService
	leases  *service.LeaseManager
	quota   *service.QuotaService
	pingErr error
}

func newHarness(t *testing.T, fakeOpts runtime.FakeOptions, tweak func(*config.Config)) *harness {
	t.Helper()
	cfg := routerTestConfig()
	if tweak != nil {
		tweak(cfg)
	}
	store := repo.NewMemory()
	m := metrics.New()
	rt := runtime.NewFakeWith(fakeOpts)
	quota := service.NewQuotaService(cfg, store, m)
	leases := service.NewLeaseManager(cfg, rt, store, store, store, quota, m)
	admission := service.NewAdmission(cfg, m)
	execSvc := service.NewExecutionService(service.ExecutionDeps{
		Config:        cfg,
		Executions:    store,
		Artifacts:     store,
		Usage:         store,
		Audit:         store,
		Leases:        leases,
		Quota:         quota,
		Admission:     admission,
		Runtime:       rt,
		ArtifactStore: service.NewFakeArtifactStore(),
		Metrics:       m,
	})
	leases.SetCanceler(execSvc)
	admin := service.NewAdminService(service.AdminDeps{
		Config:       cfg,
		Leases:       store,
		Executions:   store,
		Artifacts:    store,
		Usage:        store,
		Audit:        store,
		Queries:      store,
		ExecService:  execSvc,
		LeaseManager: leases,
		Quota:        quota,
	})
	h := &harness{store: store, rt: rt, cfg: cfg, execSvc: execSvc, leases: leases, quota: quota}
	h.engine = New(Deps{
		Cfg:         cfg,
		Executions:  execSvc,
		Leases:      leases,
		Admin:       admin,
		Metrics:     m,
		RuntimeName: rt.Name(),
		PingDB:      func(context.Context) error { return h.pingErr },
	})
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		execSvc.Shutdown(ctx)
	})
	return h
}

func (h *harness) do(t *testing.T, method, path string, body any, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
		reader = bytes.NewReader(encoded)
	}
	req := httptest.NewRequest(method, path, reader)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.engine.ServeHTTP(rec, req)
	return rec
}

func authHeaders(uid int64) map[string]string {
	return map[string]string{"X-API-Key": testAPIKey, "X-Uid": strconv.FormatInt(uid, 10)}
}

func decode(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
	return body
}

func (h *harness) createExecution(t *testing.T, uid int64, body map[string]any) string {
	t.Helper()
	rec := h.do(t, http.MethodPost, "/v1/executions", body, authHeaders(uid))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("create status = %d body=%s", rec.Code, rec.Body.String())
	}
	payload := decode(t, rec)
	id, _ := payload["executionId"].(string)
	if id == "" {
		t.Fatalf("create response has no executionId: %s", rec.Body.String())
	}
	return id
}

func (h *harness) pollDone(t *testing.T, uid int64, id string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		rec := h.do(t, http.MethodGet, "/v1/executions/"+id, nil, authHeaders(uid))
		if rec.Code != http.StatusOK {
			t.Fatalf("get status = %d body=%s", rec.Code, rec.Body.String())
		}
		body := decode(t, rec)
		if done, _ := body["done"].(bool); done {
			return body
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("execution %s never finished", id)
	return nil
}

func (h *harness) pollStatus(t *testing.T, uid int64, id, status string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		rec := h.do(t, http.MethodGet, "/v1/executions/"+id, nil, authHeaders(uid))
		body := decode(t, rec)
		if got, _ := body["status"].(string); got == status {
			return body
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("execution %s never reached %s", id, status)
	return nil
}

func executionBody(overrides map[string]any) map[string]any {
	body := map[string]any{"language": "python", "code": "print(1)", "projectId": "p1", "purpose": "academic"}
	for k, v := range overrides {
		body[k] = v
	}
	return body
}

// ── tests ────────────────────────────────────────────────────────────

func TestHealthAndMetricsArePublic(t *testing.T) {
	h := newHarness(t, runtime.FakeOptions{Stdout: "ok"}, nil)
	rec := h.do(t, http.MethodGet, "/health", nil, nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "app-sandbox") {
		t.Fatalf("health: %d %s", rec.Code, rec.Body.String())
	}
	rec = h.do(t, http.MethodGet, "/metrics", nil, nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "sandbox_") {
		t.Fatalf("metrics: %d %s", rec.Code, rec.Body.String())
	}
}

func TestAuthIsRequired(t *testing.T) {
	h := newHarness(t, runtime.FakeOptions{Stdout: "ok"}, nil)
	cases := []struct {
		name    string
		method  string
		path    string
		body    any
		headers map[string]string
		want    int
	}{
		{"no api key", http.MethodPost, "/v1/executions", executionBody(nil), map[string]string{"X-Uid": "1"}, http.StatusUnauthorized},
		{"wrong api key", http.MethodPost, "/v1/executions", executionBody(nil), map[string]string{"X-API-Key": "nope", "X-Uid": "1"}, http.StatusUnauthorized},
		{"missing uid", http.MethodPost, "/v1/executions", executionBody(nil), map[string]string{"X-API-Key": testAPIKey}, http.StatusUnauthorized},
		{"invalid uid", http.MethodPost, "/v1/executions", executionBody(nil), map[string]string{"X-API-Key": testAPIKey, "X-Uid": "abc"}, http.StatusUnauthorized},
		{"internal without key", http.MethodGet, "/internal/leases", nil, nil, http.StatusUnauthorized},
		{"internal with key", http.MethodGet, "/internal/leases", nil, map[string]string{"X-API-Key": testAPIKey}, http.StatusOK},
		{"apikey header alias", http.MethodGet, "/internal/leases", nil, map[string]string{"apikey": testAPIKey}, http.StatusOK},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := h.do(t, tc.method, tc.path, tc.body, tc.headers)
			if rec.Code != tc.want {
				t.Fatalf("status = %d, want %d (body=%s)", rec.Code, tc.want, rec.Body.String())
			}
		})
	}
}

func TestEmptyConfiguredAPIKeyFailsClosed(t *testing.T) {
	h := newHarness(t, runtime.FakeOptions{Stdout: "ok"}, func(cfg *config.Config) {
		cfg.Auth.APIKey = ""
	})
	rec := h.do(t, http.MethodGet, "/internal/leases", nil, map[string]string{"X-API-Key": ""})
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("empty configured key must fail closed, got %d", rec.Code)
	}
}

func TestCreateExecutionAndPollToTerminal(t *testing.T) {
	h := newHarness(t, runtime.FakeOptions{Stdout: "hello from sandbox\n"}, nil)
	id := h.createExecution(t, 71, executionBody(nil))

	body := h.pollDone(t, 71, id)
	if body["status"] != "succeeded" {
		t.Fatalf("status = %v (%v)", body["status"], body["errorCode"])
	}
	if exit, _ := body["exitCode"].(float64); exit != 0 {
		t.Fatalf("exitCode = %v, want 0", body["exitCode"])
	}
	if preview, _ := body["stdoutPreview"].(string); !strings.Contains(preview, "hello from sandbox") {
		t.Fatalf("stdoutPreview = %q", preview)
	}
	if artifacts, ok := body["artifacts"].([]any); !ok || len(artifacts) != 0 {
		t.Fatalf("artifacts = %v, want []", body["artifacts"])
	}
}

func TestCreateExecutionValidation(t *testing.T) {
	h := newHarness(t, runtime.FakeOptions{Stdout: "ok"}, nil)
	rec := h.do(t, http.MethodPost, "/v1/executions", executionBody(map[string]any{"language": "ruby"}), authHeaders(72))
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "language") {
		t.Fatalf("bad language: %d %s", rec.Code, rec.Body.String())
	}
	rec = h.do(t, http.MethodPost, "/v1/executions", executionBody(map[string]any{"code": "  "}), authHeaders(72))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("empty code: %d %s", rec.Code, rec.Body.String())
	}
}

func TestForeignExecutionIsHidden(t *testing.T) {
	h := newHarness(t, runtime.FakeOptions{Stdout: "ok"}, nil)
	id := h.createExecution(t, 73, executionBody(nil))
	h.pollDone(t, 73, id)

	rec := h.do(t, http.MethodGet, "/v1/executions/"+id, nil, authHeaders(74))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("foreign get = %d, want 404", rec.Code)
	}
	rec = h.do(t, http.MethodGet, "/v1/executions/"+id+"/events", nil, authHeaders(74))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("foreign events = %d, want 404", rec.Code)
	}
	rec = h.do(t, http.MethodPost, "/v1/executions/"+id+"/cancel", nil, authHeaders(74))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("foreign cancel = %d, want 404", rec.Code)
	}
}

func TestCancelExecution(t *testing.T) {
	h := newHarness(t, runtime.FakeOptions{ExecDelay: 2 * time.Second}, nil)
	id := h.createExecution(t, 75, executionBody(map[string]any{"timeoutMs": 10000}))
	h.pollStatus(t, 75, id, "running")

	rec := h.do(t, http.MethodPost, "/v1/executions/"+id+"/cancel", nil, authHeaders(75))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("cancel = %d, want 204 (body=%s)", rec.Code, rec.Body.String())
	}
	body := h.pollDone(t, 75, id)
	if body["status"] != "canceled" {
		t.Fatalf("status after cancel = %v, want canceled", body["status"])
	}
	// Idempotent.
	rec = h.do(t, http.MethodPost, "/v1/executions/"+id+"/cancel", nil, authHeaders(75))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("second cancel = %d, want 204", rec.Code)
	}
}

func TestInternalLeaseAdmin(t *testing.T) {
	h := newHarness(t, runtime.FakeOptions{Stdout: "ok"}, nil)
	id := h.createExecution(t, 76, executionBody(nil))
	h.pollDone(t, 76, id)

	// A lease must exist for the uid.
	rec := h.do(t, http.MethodGet, "/internal/leases?uid=76", nil, map[string]string{"X-API-Key": testAPIKey})
	if rec.Code != http.StatusOK {
		t.Fatalf("list leases = %d body=%s", rec.Code, rec.Body.String())
	}
	body := decode(t, rec)
	leases, ok := body["leases"].([]any)
	if !ok || len(leases) == 0 {
		t.Fatalf("leases = %v, want at least one", body["leases"])
	}
	first, _ := leases[0].(map[string]any)
	leaseID, _ := first["id"].(string)
	if leaseID == "" {
		t.Fatalf("lease payload has no id: %v", first)
	}

	rec = h.do(t, http.MethodGet, "/internal/leases?state=ready,idle", nil, map[string]string{"X-API-Key": testAPIKey})
	if rec.Code != http.StatusOK {
		t.Fatalf("list by state = %d", rec.Code)
	}

	rec = h.do(t, http.MethodDelete, "/internal/leases/"+leaseID, nil, map[string]string{"X-API-Key": testAPIKey})
	if rec.Code != http.StatusNoContent {
		t.Fatalf("force release = %d body=%s", rec.Code, rec.Body.String())
	}
	lease, err := h.store.GetLease(context.Background(), leaseID)
	if err != nil {
		t.Fatalf("get lease: %v", err)
	}
	if lease.State != "terminated" {
		t.Fatalf("lease state = %s, want terminated", lease.State)
	}
}

func TestReadyReflectsDatabase(t *testing.T) {
	h := newHarness(t, runtime.FakeOptions{Stdout: "ok"}, nil)
	if rec := h.do(t, http.MethodGet, "/ready", nil, nil); rec.Code != http.StatusOK {
		t.Fatalf("ready (db up) = %d", rec.Code)
	}
	h.pingErr = errors.New("mysql down")
	if rec := h.do(t, http.MethodGet, "/ready", nil, nil); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("ready (db down) = %d, want 503", rec.Code)
	}
}

func TestSSEStreamDeliversStatusAndDone(t *testing.T) {
	h := newHarness(t, runtime.FakeOptions{Stdout: "streamed\n"}, nil)
	id := h.createExecution(t, 77, executionBody(nil))

	rec := h.do(t, http.MethodGet, "/v1/executions/"+id+"/events", nil, authHeaders(77))
	body := rec.Body.String()
	if rec.Code != http.StatusOK {
		t.Fatalf("events status = %d body=%s", rec.Code, body)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "text/event-stream") {
		t.Fatalf("content type = %q", ct)
	}
	for _, want := range []string{"event: status", "event: done"} {
		if !strings.Contains(body, want) {
			t.Fatalf("SSE body missing %q:\n%s", want, body)
		}
	}
}

func TestQuotaRejectionMapsTo429(t *testing.T) {
	h := newHarness(t, runtime.FakeOptions{Stdout: "ok"}, func(cfg *config.Config) {
		cfg.Quota.Enabled = true
	})
	ctx := context.Background()
	day := h.quota.Day(time.Now())
	if err := h.store.IncrementUsage(ctx, 79, day, repo.UsageDelta{Executions: 20}); err != nil {
		t.Fatalf("seed usage: %v", err)
	}
	rec := h.do(t, http.MethodPost, "/v1/executions", executionBody(nil), authHeaders(79))
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("quota rejection = %d, want 429 (body=%s)", rec.Code, rec.Body.String())
	}
	body := decode(t, rec)
	if body["kind"] != "academic_run" || body["tier"] != "free" || body["upgradeSku"] != "vip" {
		t.Fatalf("quota body = %v", body)
	}
	if _, ok := body["resetAt"].(string); !ok {
		t.Fatalf("quota body has no resetAt: %v", body)
	}
	if _, ok := body["detail"].(string); !ok {
		t.Fatalf("quota body has no detail: %v", body)
	}
}

func TestAdmissionQueueFullMapsTo503(t *testing.T) {
	h := newHarness(t, runtime.FakeOptions{ExecDelay: 2 * time.Second}, func(cfg *config.Config) {
		cfg.Admission.MaxConcurrent = 1
		cfg.Admission.MaxPerUID = 1
		cfg.Admission.QueueSize = 0
	})
	first := h.createExecution(t, 80, executionBody(map[string]any{"timeoutMs": 5000}))
	rec := h.do(t, http.MethodPost, "/v1/executions", executionBody(nil), authHeaders(80))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("queue full = %d, want 503 (body=%s)", rec.Code, rec.Body.String())
	}
	if body := decode(t, rec); body["kind"] != "sandbox_queue" {
		t.Fatalf("queue-full body = %v", body)
	}
	// Cleanup the long-running first execution.
	rec = h.do(t, http.MethodPost, "/v1/executions/"+first+"/cancel", nil, authHeaders(80))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("cancel first = %d", rec.Code)
	}
}

func TestAdmissionQueueTimeoutMapsTo429(t *testing.T) {
	h := newHarness(t, runtime.FakeOptions{ExecDelay: 2 * time.Second}, func(cfg *config.Config) {
		cfg.Admission.MaxConcurrent = 1
		cfg.Admission.MaxPerUID = 1
		cfg.Admission.QueueSize = 4
		cfg.Admission.QueueTimeoutMS = 30
	})
	first := h.createExecution(t, 81, executionBody(map[string]any{"timeoutMs": 5000}))
	rec := h.do(t, http.MethodPost, "/v1/executions", executionBody(nil), authHeaders(81))
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("queue timeout = %d, want 429 (body=%s)", rec.Code, rec.Body.String())
	}
	if body := decode(t, rec); body["kind"] != "sandbox_queue" {
		t.Fatalf("queue-timeout body = %v", body)
	}
	rec = h.do(t, http.MethodPost, "/v1/executions/"+first+"/cancel", nil, authHeaders(81))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("cancel first = %d", rec.Code)
	}
}
