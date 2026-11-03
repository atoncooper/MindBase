package tests

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"app-sandbox/internal/config"
	"app-sandbox/internal/repo"
	"app-sandbox/internal/runtime"
)

// Internal admin API tests: auth/503, pagination clamping,
// filters, overview counts, admin cancel/release (audited with actor=admin and
// the admin request id), quota/config views and field convergence (no code body).

const adminToken = "admin-test-token"

func newAdminHarness(t *testing.T, fakeOpts runtime.FakeOptions, tweak func(*config.Config)) *harness {
	t.Helper()
	return newHarness(t, fakeOpts, func(cfg *config.Config) {
		cfg.Admin.Token = adminToken
		if tweak != nil {
			tweak(cfg)
		}
	})
}

func adminHeaders() map[string]string { return map[string]string{"X-Admin-Token": adminToken} }

func (h *harness) adminGet(t *testing.T, path string) map[string]any {
	t.Helper()
	rec := h.do(t, http.MethodGet, path, nil, adminHeaders())
	if rec.Code != http.StatusOK {
		t.Fatalf("GET %s = %d body=%s", path, rec.Code, rec.Body.String())
	}
	return decode(t, rec)
}

func (h *harness) adminList(t *testing.T, path string) (items []any, total float64, page, pageSize float64) {
	t.Helper()
	body := h.adminGet(t, path)
	items, _ = body["items"].([]any)
	total, _ = body["total"].(float64)
	page, _ = body["page"].(float64)
	pageSize, _ = body["pageSize"].(float64)
	return items, total, page, pageSize
}

// ── auth ─────────────────────────────────────────────────────────────

func TestAdminTokenAuth(t *testing.T) {
	h := newAdminHarness(t, runtime.FakeOptions{Stdout: "ok"}, nil)

	if rec := h.do(t, http.MethodGet, "/internal/admin/overview", nil, nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("missing token = %d, want 401", rec.Code)
	}
	if rec := h.do(t, http.MethodGet, "/internal/admin/overview", nil, map[string]string{"X-Admin-Token": "wrong"}); rec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong token = %d, want 401", rec.Code)
	}
	// The gateway consumer key must never authorize the admin API.
	if rec := h.do(t, http.MethodGet, "/internal/admin/overview", nil, authHeaders(1)); rec.Code != http.StatusUnauthorized {
		t.Fatalf("gateway key authorized admin API: %d", rec.Code)
	}
	if rec := h.do(t, http.MethodGet, "/internal/admin/overview", nil, adminHeaders()); rec.Code != http.StatusOK {
		t.Fatalf("correct token = %d, want 200 (body=%s)", rec.Code, rec.Body.String())
	}
}

func TestAdminDisabledWhenTokenUnset(t *testing.T) {
	// newHarness without the admin tweak leaves cfg.Admin.Token empty.
	h := newHarness(t, runtime.FakeOptions{Stdout: "ok"}, nil)
	rec := h.do(t, http.MethodGet, "/internal/admin/overview", nil, adminHeaders())
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("disabled admin = %d, want 503 (body=%s)", rec.Code, rec.Body.String())
	}
	body := decode(t, rec)
	if body["detail"] != "admin api disabled" {
		t.Fatalf("disabled detail = %v", body["detail"])
	}
}

// ── read endpoints ───────────────────────────────────────────────────

func TestAdminPaginationClamping(t *testing.T) {
	h := newAdminHarness(t, runtime.FakeOptions{Stdout: "ok"}, nil)
	for i := 0; i < 3; i++ {
		id := h.createExecution(t, 90, executionBody(nil))
		h.pollDone(t, 90, id)
	}

	// page=0 / pageSize=1000 clamp to page 1 / pageSize 100.
	body := h.adminGet(t, "/internal/admin/executions?page=0&pageSize=1000")
	if body["page"].(float64) != 1 || body["pageSize"].(float64) != 100 {
		t.Fatalf("clamped paging = %v/%v, want 1/100", body["page"], body["pageSize"])
	}
	if items, _ := body["items"].([]any); len(items) != 3 || body["total"].(float64) != 3 {
		t.Fatalf("page 1 items=%d total=%v, want 3/3", len(items), body["total"])
	}

	// pageSize=0 falls back to the default 20; page 2 of size 2 has 1 row.
	body = h.adminGet(t, "/internal/admin/executions?pageSize=0")
	if body["pageSize"].(float64) != 20 {
		t.Fatalf("default pageSize = %v, want 20", body["pageSize"])
	}
	items, total, page, pageSize := h.adminList(t, "/internal/admin/executions?page=2&pageSize=2")
	if len(items) != 1 || total != 3 || page != 2 || pageSize != 2 {
		t.Fatalf("page 2 = items %d total %v page %v size %v", len(items), total, page, pageSize)
	}

	// Out-of-range page is empty but still reports the total.
	items, total, _, _ = h.adminList(t, "/internal/admin/executions?page=9&pageSize=2")
	if len(items) != 0 || total != 3 {
		t.Fatalf("page 9 = items %d total %v, want 0/3", len(items), total)
	}

	// Invalid uid -> 400.
	if rec := h.do(t, http.MethodGet, "/internal/admin/executions?uid=abc", nil, adminHeaders()); rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid uid = %d, want 400", rec.Code)
	}
}

func TestAdminExecutionFilters(t *testing.T) {
	h := newAdminHarness(t, runtime.FakeOptions{Stdout: "ok"}, nil)
	for _, req := range []struct {
		uid     int64
		project string
	}{{91, "alpha"}, {91, "beta"}, {92, "alpha"}} {
		id := h.createExecution(t, req.uid, executionBody(map[string]any{"projectId": req.project}))
		h.pollDone(t, req.uid, id)
	}

	cases := []struct {
		query string
		want  float64
	}{
		{"uid=91", 2},
		{"projectId=alpha", 2},
		{"uid=91&projectId=alpha", 1},
		{"status=succeeded", 3},
		{"status=failed", 0},
		{"from=" + time.Now().Add(-time.Hour).UTC().Format(time.RFC3339), 3},
		{"to=" + time.Now().Add(-time.Hour).UTC().Format(time.RFC3339), 0},
	}
	for _, tc := range cases {
		_, total, _, _ := h.adminList(t, "/internal/admin/executions?"+tc.query)
		if total != tc.want {
			t.Fatalf("%s -> total %v, want %v", tc.query, total, tc.want)
		}
	}
	// Invalid time filter -> 400 rather than silently ignoring.
	if rec := h.do(t, http.MethodGet, "/internal/admin/executions?from=not-a-time", nil, adminHeaders()); rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid from = %d, want 400", rec.Code)
	}
}

func TestAdminOverviewCounts(t *testing.T) {
	h := newAdminHarness(t, runtime.FakeOptions{Stdout: "ok"}, func(cfg *config.Config) {
		cfg.Quota.Enabled = true
	})
	// Two successes.
	for i := 0; i < 2; i++ {
		id := h.createExecution(t, 93, executionBody(nil))
		h.pollDone(t, 93, id)
	}
	// One failure (nonzero exit).
	h.rt.Configure(runtime.FakeOptions{Stdout: "boom", Stderr: "err", ExitCode: 2})
	id := h.createExecution(t, 93, executionBody(nil))
	h.pollDone(t, 93, id)

	body := h.adminGet(t, "/internal/admin/overview")
	if body["quotaEnabled"] != true {
		t.Fatalf("quotaEnabled = %v, want true", body["quotaEnabled"])
	}
	executions, _ := body["executions"].(map[string]any)
	if executions["total"].(float64) != 3 || executions["succeeded"].(float64) != 2 || executions["failed"].(float64) != 1 {
		t.Fatalf("execution counts = %v, want total 3 / succeeded 2 / failed 1", executions)
	}
	last24h, _ := body["last24h"].(map[string]any)
	if last24h["executions"].(float64) != 3 || last24h["failures"].(float64) != 1 {
		t.Fatalf("last24h = %v, want 3 executions / 1 failure", last24h)
	}
	leases, _ := body["leases"].(map[string]any)
	if leases["total"].(float64) < 1 {
		t.Fatalf("lease counts = %v, want at least one lease", leases)
	}
	if leases["idle"].(float64)+leases["ready"].(float64) < 1 {
		t.Fatalf("lease idle+ready = %v, want at least one reusable lease", leases)
	}
}

func TestAdminExecutionDetailAndFieldConvergence(t *testing.T) {
	h := newAdminHarness(t, runtime.FakeOptions{Stdout: "hello\n"}, nil)
	secret := "TOPSECRET_CODE_BODY_MARKER"
	id := h.createExecution(t, 94, executionBody(map[string]any{"code": "print('" + secret + "')"}))
	h.pollDone(t, 94, id)

	rec := h.do(t, http.MethodGet, "/internal/admin/executions/"+id, nil, adminHeaders())
	if rec.Code != http.StatusOK {
		t.Fatalf("detail = %d body=%s", rec.Code, rec.Body.String())
	}
	raw := rec.Body.String()
	if strings.Contains(raw, secret) {
		t.Fatalf("admin detail leaked the code body: %s", raw)
	}
	body := decode(t, rec)
	for _, forbidden := range []string{"code", "codeSha256", "stdout", "stderr"} {
		if _, ok := body[forbidden]; ok {
			t.Fatalf("admin detail exposes %q (field convergence)", forbidden)
		}
	}
	if _, ok := body["stdoutPreview"]; !ok {
		t.Fatalf("admin detail must expose the truncated stdoutPreview")
	}
	if preview, _ := body["stdoutPreview"].(string); len(preview) > h.cfg.Execution.PreviewBytes {
		t.Fatalf("preview length %d exceeds previewBytes %d", len(preview), h.cfg.Execution.PreviewBytes)
	}
	if artifacts, _ := body["artifacts"].([]any); len(artifacts) != 0 {
		t.Fatalf("artifacts = %v, want []", body["artifacts"])
	}
	if audits, _ := body["audit"].([]any); len(audits) == 0 {
		t.Fatalf("detail must include the audit trail")
	}

	// List rows must not leak code either.
	items, _, _, _ := h.adminList(t, "/internal/admin/executions?uid=94")
	if len(items) != 1 {
		t.Fatalf("list items = %d", len(items))
	}
	row, _ := items[0].(map[string]any)
	if _, ok := row["code"]; ok {
		t.Fatalf("list row exposes code")
	}
	if strings.Contains(mustJSON(t, row), secret) {
		t.Fatalf("list row leaked the code body")
	}

	if rec := h.do(t, http.MethodGet, "/internal/admin/executions/missing", nil, adminHeaders()); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown detail = %d, want 404", rec.Code)
	}
}

// ── write endpoints ──────────────────────────────────────────────────

func TestAdminCancelExecution(t *testing.T) {
	h := newAdminHarness(t, runtime.FakeOptions{ExecDelay: 2 * time.Second}, nil)
	id := h.createExecution(t, 95, executionBody(map[string]any{"timeoutMs": 10000}))
	h.pollStatus(t, 95, id, "running")

	headers := adminHeaders()
	headers["X-Request-Id"] = "admin-cancel-req-1"
	rec := h.do(t, http.MethodPost, "/internal/admin/executions/"+id+"/cancel", nil, headers)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("admin cancel = %d body=%s", rec.Code, rec.Body.String())
	}
	body := h.pollDone(t, 95, id)
	if body["status"] != "canceled" {
		t.Fatalf("status after admin cancel = %v, want canceled", body["status"])
	}

	detail := h.adminGet(t, "/internal/admin/executions/"+id)
	audits, _ := detail["audit"].([]any)
	found := false
	for _, raw := range audits {
		audit, _ := raw.(map[string]any)
		if audit["action"] == "execution.cancel" {
			if audit["actor"] != "admin" {
				t.Fatalf("cancel audit actor = %v, want admin", audit["actor"])
			}
			if audit["requestId"] != "admin-cancel-req-1" {
				t.Fatalf("cancel audit requestId = %v", audit["requestId"])
			}
			found = true
		}
	}
	if !found {
		t.Fatalf("admin cancel did not write an execution.cancel audit row")
	}

	// Idempotent on a terminal execution; unknown id -> 404.
	if rec := h.do(t, http.MethodPost, "/internal/admin/executions/"+id+"/cancel", nil, adminHeaders()); rec.Code != http.StatusNoContent {
		t.Fatalf("second admin cancel = %d, want 204", rec.Code)
	}
	if rec := h.do(t, http.MethodPost, "/internal/admin/executions/missing/cancel", nil, adminHeaders()); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown cancel = %d, want 404", rec.Code)
	}
}

func TestAdminReleaseLease(t *testing.T) {
	h := newAdminHarness(t, runtime.FakeOptions{Stdout: "ok"}, nil)
	id := h.createExecution(t, 96, executionBody(nil))
	h.pollDone(t, 96, id)

	items, total, _, _ := h.adminList(t, "/internal/admin/leases?uid=96")
	if total < 1 || len(items) == 0 {
		t.Fatalf("leases for uid 96 = %v/%d, want at least one", items, int(total))
	}
	lease, _ := items[0].(map[string]any)
	leaseID, _ := lease["id"].(string)
	if leaseID == "" {
		t.Fatalf("lease payload has no id: %v", lease)
	}

	headers := adminHeaders()
	headers["X-Request-Id"] = "admin-release-req-1"
	rec := h.do(t, http.MethodDelete, "/internal/admin/leases/"+leaseID, nil, headers)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("admin release = %d body=%s", rec.Code, rec.Body.String())
	}
	stored, err := h.store.GetLease(context.Background(), leaseID)
	if err != nil {
		t.Fatalf("get lease: %v", err)
	}
	if stored.State != "terminated" {
		t.Fatalf("lease state after admin release = %s, want terminated", stored.State)
	}
	// The release audit records actor=admin + the admin request id.
	auditBody := h.adminGet(t, "/internal/admin/audit?uid=96&action=lease.release")
	audits, _ := auditBody["items"].([]any)
	if len(audits) == 0 {
		t.Fatalf("release audit missing")
	}
	row, _ := audits[0].(map[string]any)
	if row["actor"] != "admin" || row["requestId"] != "admin-release-req-1" {
		t.Fatalf("release audit = %v, want actor admin + request id", row)
	}

	// Terminal lease is idempotent; unknown lease -> 404.
	if rec := h.do(t, http.MethodDelete, "/internal/admin/leases/"+leaseID, nil, adminHeaders()); rec.Code != http.StatusNoContent {
		t.Fatalf("second release = %d, want 204", rec.Code)
	}
	if rec := h.do(t, http.MethodDelete, "/internal/admin/leases/missing", nil, adminHeaders()); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown release = %d, want 404", rec.Code)
	}
}

// ── quota / audit / config ───────────────────────────────────────────

func TestAdminQuotaView(t *testing.T) {
	h := newAdminHarness(t, runtime.FakeOptions{Stdout: "ok"}, nil)
	day := h.quota.Day(time.Now())
	if err := h.store.IncrementUsage(context.Background(), 97, day, repo.UsageDelta{Executions: 7, CPUMillis: 1500, ArtifactBytes: 42}); err != nil {
		t.Fatalf("seed usage: %v", err)
	}

	body := h.adminGet(t, "/internal/admin/quota?uid=97&day="+day)
	if body["executions"].(float64) != 7 || body["cpuMillis"].(float64) != 1500 || body["artifactBytes"].(float64) != 42 {
		t.Fatalf("quota usage = %v", body)
	}
	if body["tier"] != "free" {
		t.Fatalf("tier = %v, want free", body["tier"])
	}
	limits, _ := body["limits"].(map[string]any)
	for _, kind := range []string{config.QuotaAcademicRun, config.QuotaConcurrent, config.QuotaCPUSeconds, config.QuotaArtifactBytes} {
		if _, ok := limits[kind]; !ok {
			t.Fatalf("quota limits missing %s: %v", kind, limits)
		}
	}
	if limits[config.QuotaAcademicRun].(float64) != 20 {
		t.Fatalf("free academic_run limit = %v, want 20", limits[config.QuotaAcademicRun])
	}

	// day omitted -> today's key; uid missing / bad day -> 400.
	body = h.adminGet(t, "/internal/admin/quota?uid=97")
	if body["day"] != day {
		t.Fatalf("default day = %v, want %s", body["day"], day)
	}
	if rec := h.do(t, http.MethodGet, "/internal/admin/quota", nil, adminHeaders()); rec.Code != http.StatusBadRequest {
		t.Fatalf("quota without uid = %d, want 400", rec.Code)
	}
	if rec := h.do(t, http.MethodGet, "/internal/admin/quota?uid=97&day=2026-13-40", nil, adminHeaders()); rec.Code != http.StatusBadRequest {
		t.Fatalf("bad day = %d, want 400", rec.Code)
	}
}

func TestAdminAuditAndConfigViews(t *testing.T) {
	h := newAdminHarness(t, runtime.FakeOptions{Stdout: "ok"}, nil)
	id := h.createExecution(t, 98, executionBody(nil))
	h.pollDone(t, 98, id)

	body := h.adminGet(t, "/internal/admin/audit?uid=98&action=execution.create")
	items, _ := body["items"].([]any)
	if len(items) == 0 {
		t.Fatalf("audit filter returned no rows")
	}
	row, _ := items[0].(map[string]any)
	if row["action"] != "execution.create" || row["actor"] != "agent" {
		t.Fatalf("audit row = %v, want action execution.create actor agent", row)
	}
	if _, ok := row["requestId"]; !ok {
		t.Fatalf("audit row has no requestId")
	}

	cfgBody := h.adminGet(t, "/internal/admin/config")
	if cfgBody["runtime"] != "fake" || cfgBody["image"] != "python:3.12" {
		t.Fatalf("config view = %v", cfgBody)
	}
	if cfgBody["leaseTtlSeconds"].(float64) != 1800 || cfgBody["quotaEnabled"] != false {
		t.Fatalf("config view = %v", cfgBody)
	}
	admission, _ := cfgBody["admission"].(map[string]any)
	if admission["maxConcurrent"].(float64) != 8 {
		t.Fatalf("config admission = %v", admission)
	}
	// The admin token is a secret: it must never appear in the config view.
	if strings.Contains(mustJSON(t, cfgBody), adminToken) {
		t.Fatalf("config view leaked the admin token")
	}
	// Lease state filter is honored.
	leasesBody := h.adminGet(t, "/internal/admin/leases?uid=98&state=ready,idle")
	leaseItems, _ := leasesBody["items"].([]any)
	for _, raw := range leaseItems {
		lease, _ := raw.(map[string]any)
		state := lease["state"]
		if state != "ready" && state != "idle" {
			t.Fatalf("lease state filter returned %v", state)
		}
	}
}

// mustJSON marshals a JSON-ish test value for substring checks.
func mustJSON(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(encoded)
}

// TestAdminConfigFromEnv pins the SANDBOX__ADMIN__TOKEN env override and the
// disabled-by-default posture of the shipped default.yaml.
func TestAdminConfigFromEnv(t *testing.T) {
	yamlBytes, err := os.ReadFile("../default.yaml")
	if err != nil {
		t.Fatalf("read default.yaml: %v", err)
	}
	t.Setenv("SANDBOX__ADMIN__TOKEN", "env-admin-token")
	cfg, err := config.Load(yamlBytes)
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if cfg.Admin.Token != "env-admin-token" {
		t.Fatalf("admin token = %q, want the env override", cfg.Admin.Token)
	}
	if cfg.Admin.Token == "" {
		t.Fatal("admin token must come from SANDBOX__ADMIN__TOKEN")
	}
}
