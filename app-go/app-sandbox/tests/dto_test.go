package tests

// Wire-shape guards for the DTO layer: every app-sandbox response must keep the
// exact JSON field names, null vs [] semantics and optional-key behavior the
// black-box tests (and app-admin / the frontend) rely on.

import (
	"encoding/json"
	"sort"
	"testing"
	"time"

	"app-sandbox/internal/config"
	"app-sandbox/internal/dto"
	"app-sandbox/internal/model"
	"app-sandbox/internal/repo"
	"app-sandbox/internal/service"
)

// dtoAsJSON marshals v and decodes it back into a generic object.
func dtoAsJSON(t *testing.T, v any) map[string]any {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return out
}

// dtoAssertKeys compares the object's exact key set (no extra or missing keys).
func dtoAssertKeys(t *testing.T, obj map[string]any, want ...string) {
	t.Helper()
	got := make([]string, 0, len(obj))
	for k := range obj {
		got = append(got, k)
	}
	sort.Strings(got)
	sort.Strings(want)
	if len(got) != len(want) {
		t.Fatalf("key set = %v, want %v", got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("key set = %v, want %v", got, want)
		}
	}
}

func dtoAssertArray(t *testing.T, obj map[string]any, key string) []any {
	t.Helper()
	arr, ok := obj[key].([]any)
	if !ok {
		t.Fatalf("%s must be an array, got %T (%v)", key, obj[key], obj[key])
	}
	return arr
}

func TestCreateExecutionWireShape(t *testing.T) {
	req := dtoAsJSON(t, dto.CreateExecutionRequest{})
	dtoAssertKeys(t, req, "projectId", "purpose", "language", "code", "files", "artifacts", "timeoutMs")

	resp := dtoAsJSON(t, dto.CreateExecutionResponse{ExecutionID: "e", LeaseID: "l", State: "queued"})
	dtoAssertKeys(t, resp, "executionId", "leaseId", "state")
}

func TestExecutionPayloadWireShape(t *testing.T) {
	created := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)

	// Queued/running: no exitCode, no timestamps, no durationMs; done=false.
	running := dto.NewExecutionPayload(&service.ExecutionView{
		Execution: &model.SandboxExecution{
			ID: "e1", LeaseID: "l1", ProjectID: "p", Purpose: "academic", Language: "python",
			Status: model.ExecStatusRunning, TimeoutMS: 1000, CreatedAt: created,
		},
		Artifacts: []service.ArtifactView{},
	})
	obj := dtoAsJSON(t, running)
	dtoAssertKeys(t, obj, "executionId", "leaseId", "projectId", "purpose", "language", "status",
		"timeoutMs", "stdoutPreview", "stderrPreview", "stdoutBytes", "stderrBytes",
		"errorCode", "createdAt", "artifacts", "done")
	if obj["done"] != false {
		t.Fatalf("done = %v, want false for a running execution", obj["done"])
	}
	if len(dtoAssertArray(t, obj, "artifacts")) != 0 {
		t.Fatalf("artifacts must be [] when there are none: %v", obj["artifacts"])
	}

	// Terminal: exitCode, startedAt, finishedAt and durationMs become present.
	started, finished := created, created.Add(2500*time.Millisecond)
	exit := 3
	done := dto.NewExecutionPayload(&service.ExecutionView{
		Execution: &model.SandboxExecution{
			ID: "e2", LeaseID: "l2", Status: model.ExecStatusFailed, ExitCode: &exit,
			StartedAt: &started, FinishedAt: &finished, CreatedAt: created,
		},
		Artifacts: nil,
	})
	doneObj := dtoAsJSON(t, done)
	dtoAssertKeys(t, doneObj, "executionId", "leaseId", "projectId", "purpose", "language", "status",
		"timeoutMs", "stdoutPreview", "stderrPreview", "stdoutBytes", "stderrBytes",
		"errorCode", "createdAt", "artifacts", "exitCode", "startedAt", "finishedAt", "durationMs", "done")
	if doneObj["done"] != true {
		t.Fatalf("done = %v, want true for a terminal execution", doneObj["done"])
	}
	if doneObj["durationMs"].(float64) != 2500 {
		t.Fatalf("durationMs = %v, want 2500", doneObj["durationMs"])
	}
	if len(dtoAssertArray(t, doneObj, "artifacts")) != 0 {
		t.Fatalf("nil artifact views must still encode as []: %v", doneObj["artifacts"])
	}
}

func TestExecutionListWireShape(t *testing.T) {
	list := dtoAsJSON(t, dto.NewExecutionListResponse(nil))
	dtoAssertKeys(t, list, "executions")
	if len(dtoAssertArray(t, list, "executions")) != 0 {
		t.Fatalf("empty list must encode executions:[]: %v", list["executions"])
	}
}

func TestErrorAndHealthWireShapes(t *testing.T) {
	dtoAssertKeys(t, dtoAsJSON(t, dto.ErrorResponse{Detail: "boom"}), "detail")
	dtoAssertKeys(t, dtoAsJSON(t, dto.QueueErrorResponse{Detail: "busy", Kind: "sandbox_queue"}), "detail", "kind")

	quota := dtoAsJSON(t, dto.NewQuotaErrorResponse(&service.QuotaExceededError{
		Kind: "academic_run", Tier: "free", Limit: 20, Used: 20, ResetAt: time.Now(),
	}))
	dtoAssertKeys(t, quota, "detail", "kind", "limit", "used", "resetAt", "tier", "upgradeSku")
	if quota["upgradeSku"] != "vip" {
		t.Fatalf("upgradeSku = %v, want vip", quota["upgradeSku"])
	}

	dtoAssertKeys(t, dtoAsJSON(t, dto.HealthResponse{Status: "ok"}), "status", "service", "runtime")
	dtoAssertKeys(t, dtoAsJSON(t, dto.ReadyResponse{Status: "ready"}), "status", "runtime")
	dtoAssertKeys(t, dtoAsJSON(t, dto.DegradedMySQLResponse{Status: "degraded"}), "status", "mysql")
	dtoAssertKeys(t, dtoAsJSON(t, dto.DegradedRuntimeResponse{Status: "degraded"}), "status", "runtime")
}

func TestLeaseWireShape(t *testing.T) {
	item := dtoAsJSON(t, dto.NewLeaseListResponse([]model.SandboxLease{{ID: "l", UID: 7}}))
	dtoAssertKeys(t, item, "leases")
	rows := dtoAssertArray(t, item, "leases")
	if len(rows) != 1 {
		t.Fatalf("leases = %d, want 1", len(rows))
	}
	row := rows[0].(map[string]any)
	dtoAssertKeys(t, row, "id", "uid", "projectId", "purpose", "runtime", "runtimeId", "specHash",
		"state", "expiresAt", "lastUsedAt", "createdAt")
	if row["uid"] != "7" {
		t.Fatalf("uid = %v, want the decimal string 7", row["uid"])
	}
	if empty := dtoAsJSON(t, dto.NewLeaseListResponse(nil)); len(dtoAssertArray(t, empty, "leases")) != 0 {
		t.Fatalf("empty lease list must encode leases:[]: %v", empty)
	}
}

func TestAdminWireShapes(t *testing.T) {
	now := time.Now()
	exit := 1
	started := now.Add(-time.Second)

	row := &model.SandboxExecution{
		ID: "e", UID: 1, ProjectID: "p", Language: "python", Status: model.ExecStatusFailed,
		ExitCode: &exit, LeaseID: "l", ErrorCode: "nonzero_exit", CreatedAt: now,
		StartedAt: &started, FinishedAt: &now, StdoutPreview: "out", StderrPreview: "err",
	}
	execView := dtoAsJSON(t, dto.NewExecutionAdminView(row, repo.ArtifactStat{Count: 2, Bytes: 10}, now))
	dtoAssertKeys(t, execView, "id", "uid", "projectId", "language", "status", "exitCode",
		"durationMs", "leaseId", "errorCode", "createdAt", "startedAt", "finishedAt",
		"artifactCount", "artifactBytes", "stdoutPreview", "stderrPreview")

	detail := dtoAsJSON(t, dto.NewExecutionDetailView(&service.ExecutionAdminDetail{
		Row:       row,
		Stat:      repo.ArtifactStat{},
		Artifacts: nil,
		Audit:     nil,
	}, now))
	dtoAssertKeys(t, detail, "id", "uid", "projectId", "language", "status", "exitCode",
		"durationMs", "leaseId", "errorCode", "createdAt", "startedAt", "finishedAt",
		"artifactCount", "artifactBytes", "stdoutPreview", "stderrPreview", "artifacts", "audit")
	if len(dtoAssertArray(t, detail, "artifacts")) != 0 || len(dtoAssertArray(t, detail, "audit")) != 0 {
		t.Fatalf("detail artifacts/audit must encode as []: %v", detail)
	}

	page := dtoAsJSON(t, dto.NewExecutionAdminPage(service.ExecutionAdminPage{Page: 1, PageSize: 20}, now))
	dtoAssertKeys(t, page, "items", "total", "page", "pageSize")
	if len(dtoAssertArray(t, page, "items")) != 0 {
		t.Fatalf("empty admin page must encode items:[]: %v", page)
	}

	leaseView := dtoAsJSON(t, dto.NewLeaseAdminView(model.SandboxLease{ID: "l", UID: 2}))
	dtoAssertKeys(t, leaseView, "id", "uid", "projectId", "purpose", "state", "runtime",
		"runtimeId", "createdAt", "expiresAt", "lastUsedAt")

	auditView := dtoAsJSON(t, dto.NewAuditAdminView(model.SandboxAudit{ID: "a", UID: 2}))
	dtoAssertKeys(t, auditView, "id", "uid", "action", "actor", "executionId", "leaseId",
		"projectId", "image", "outcome", "durationMs", "detail", "requestId", "createdAt")

	quotaView := dtoAsJSON(t, dto.NewQuotaView(&service.QuotaAdminSnapshot{
		UID: 2, Day: "2026-01-02", Tier: service.TierFree,
		Limits: map[string]int64{config.QuotaAcademicRun: 20},
	}))
	dtoAssertKeys(t, quotaView, "uid", "day", "executions", "cpuMillis", "artifactBytes", "tier", "limits")

	overview := dtoAsJSON(t, dto.NewOverviewView(service.OverviewCounts{
		LeaseCounts: map[string]int64{model.LeaseStateIdle: 1},
		ExecCounts:  map[string]int64{model.ExecStatusSucceeded: 2},
	}, true))
	dtoAssertKeys(t, overview, "leases", "executions", "last24h", "quotaEnabled")
	leases := overview["leases"].(map[string]any)
	dtoAssertKeys(t, leases, "creating", "ready", "busy", "idle", "releasing", "terminated", "failed", "total")
	if leases["total"].(float64) != 1 {
		t.Fatalf("lease total = %v, want 1", leases["total"])
	}
	execCounts := overview["executions"].(map[string]any)
	dtoAssertKeys(t, execCounts, "queued", "running", "succeeded", "failed", "timed_out", "canceled", "total")
	if execCounts["total"].(float64) != 2 {
		t.Fatalf("execution total = %v, want 2", execCounts["total"])
	}

	cfg := &config.Config{
		Runtime:   config.RuntimeConfig{Type: "fake", Image: "python:3.12", Resources: config.ResourceConfig{CPU: "500m", Memory: "512Mi"}},
		Lease:     config.LeaseConfig{TTLSeconds: 1800},
		Admission: config.AdmissionConfig{MaxConcurrent: 8, MaxPerUID: 4, QueueSize: 32, QueueTimeoutMS: 30000},
	}
	cfgView := dtoAsJSON(t, dto.NewAdminRuntimeConfigView(cfg))
	dtoAssertKeys(t, cfgView, "runtime", "image", "resources", "leaseTtlSeconds", "admission", "quotaEnabled")
	dtoAssertKeys(t, cfgView["resources"].(map[string]any), "cpu", "memory")
	dtoAssertKeys(t, cfgView["admission"].(map[string]any), "maxConcurrent", "maxPerUid", "queueSize", "queueTimeoutMs")
}
