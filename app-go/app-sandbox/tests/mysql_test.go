package tests

import (
	. "app-sandbox/internal/repo"
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"app-sandbox/internal/model"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
)

// openTestDB connects only when SANDBOX__TEST_DSN points at a scratch MySQL
// database; otherwise the MySQL cases skip (unit tests stay DB-free).
func openTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	dsn := strings.TrimSpace(os.Getenv("SANDBOX__TEST_DSN"))
	if dsn == "" {
		t.Skip("SANDBOX__TEST_DSN not set; skipping MySQL repository test")
	}
	db, err := gorm.Open(mysql.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Skipf("cannot connect to MySQL (%v); skipping", err)
	}
	if err := db.AutoMigrate(&model.SandboxLease{}, &model.SandboxExecution{}, &model.SandboxArtifact{}, &model.SandboxUsageDaily{}, &model.SandboxAudit{}); err != nil {
		t.Fatalf("automigrate: %v", err)
	}
	return db
}

func TestMySQLConditionalTransitionsAndUsage(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	store := NewMySQL(db)
	now := time.Now().UTC().Truncate(time.Millisecond)

	lease := &model.SandboxLease{
		ID: "test-lease-" + now.Format("150405.000000"), UID: 900001, ProjectID: "p1", Purpose: "academic",
		Runtime: "fake", RuntimeID: "sb-1", SpecHash: "spec", State: model.LeaseStateCreating,
		CreatedAt: now, LastUsedAt: now, ExpiresAt: now.Add(time.Hour),
	}
	if err := store.CreateLease(ctx, lease); err != nil {
		t.Fatalf("create lease: %v", err)
	}
	t.Cleanup(func() { db.Exec("DELETE FROM sandbox_lease WHERE id = ?", lease.ID) })

	if ok, err := store.MarkReady(ctx, lease.ID, "sb-1", now, now.Add(time.Hour)); err != nil || !ok {
		t.Fatalf("mark ready: ok=%v err=%v", ok, err)
	}
	// Conditional transition only works once.
	if ok, _ := store.MarkReady(ctx, lease.ID, "sb-2", now, now.Add(time.Hour)); ok {
		t.Fatal("MarkReady must be a one-shot conditional update")
	}
	if ok, err := store.ClaimForExec(ctx, lease.ID, now); err != nil || !ok {
		t.Fatalf("claim: ok=%v err=%v", ok, err)
	}
	if ok, _ := store.ClaimForExec(ctx, lease.ID, now); ok {
		t.Fatal("ClaimForExec must not claim a busy lease")
	}
	if ok, err := store.MarkIdle(ctx, lease.ID, now, now.Add(time.Hour)); err != nil || !ok {
		t.Fatalf("mark idle: ok=%v err=%v", ok, err)
	}
	if reused, err := store.FindReusable(ctx, 900001, "p1", "academic", "spec", now); err != nil || reused.ID != lease.ID {
		t.Fatalf("find reusable: %v %v", reused, err)
	}

	exec := &model.SandboxExecution{
		ID: "test-exec-" + now.Format("150405.000000"), UID: 900001, ProjectID: "p1", Language: "python",
		Status: model.ExecStatusQueued, TimeoutMS: 1000, CreatedAt: now,
	}
	if err := store.CreateExecution(ctx, exec); err != nil {
		t.Fatalf("create execution: %v", err)
	}
	t.Cleanup(func() { db.Exec("DELETE FROM sandbox_execution WHERE id = ?", exec.ID) })
	if ok, err := store.MarkRunning(ctx, exec.ID, now, now.Add(-time.Second)); err != nil || !ok {
		t.Fatalf("mark running: ok=%v err=%v", ok, err)
	}
	// MarkRunning is queued -> running only.
	if ok, _ := store.MarkRunning(ctx, exec.ID, now, now); ok {
		t.Fatal("MarkRunning must not restart a running execution")
	}
	if timedOut, err := store.ListTimedOut(ctx, now, 10); err != nil || len(timedOut) == 0 {
		t.Fatalf("list timed out: %v %v", timedOut, err)
	}
	exit := 0
	if ok, err := store.Finish(ctx, exec.ID, Finish{Status: model.ExecStatusSucceeded, ExitCode: &exit, StdoutBytes: 3, StdoutPreview: "ok\n", FinishedAt: now}); err != nil || !ok {
		t.Fatalf("finish: ok=%v err=%v", ok, err)
	}
	if ok, _ := store.Finish(ctx, exec.ID, Finish{Status: model.ExecStatusFailed, FinishedAt: now}); ok {
		t.Fatal("Finish must not overwrite a terminal execution")
	}

	day := now.Format("2006-01-02")
	if err := store.IncrementUsage(ctx, 900001, day, UsageDelta{Executions: 1, CPUMillis: 500, ArtifactBytes: 10, LeasesCreated: 1}); err != nil {
		t.Fatalf("increment usage: %v", err)
	}
	if err := store.IncrementUsage(ctx, 900001, day, UsageDelta{Executions: 1, CPUMillis: 250}); err != nil {
		t.Fatalf("increment usage twice: %v", err)
	}
	t.Cleanup(func() { db.Exec("DELETE FROM sandbox_usage_daily WHERE uid = ? AND day = ?", 900001, day) })
	usage, err := store.GetUsage(ctx, 900001, day)
	if err != nil {
		t.Fatalf("get usage: %v", err)
	}
	if usage.Executions != 2 || usage.CPUMillis != 750 || usage.ArtifactBytes != 10 || usage.LeasesCreated != 1 {
		t.Fatalf("usage = %+v, want executions=2 cpu=750 artifacts=10 leases=1", usage)
	}
}

// Admin queries against a real MySQL: filters, pagination,
// aggregates and artifact stats. Skips without SANDBOX__TEST_DSN.
func TestMySQLAdminQueries(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	store := NewMySQL(db)
	now := time.Now().UTC().Truncate(time.Millisecond)
	uid := int64(900002)
	stamp := now.Format("150405.000000")

	exec1 := &model.SandboxExecution{
		ID: "test-admin-exec-a-" + stamp, UID: uid, ProjectID: "p1", Language: "python",
		Status: model.ExecStatusSucceeded, TimeoutMS: 1000, CreatedAt: now,
	}
	exec2 := &model.SandboxExecution{
		ID: "test-admin-exec-b-" + stamp, UID: uid, ProjectID: "p2", Language: "javascript",
		Status: model.ExecStatusFailed, TimeoutMS: 1000, CreatedAt: now.Add(-time.Minute),
	}
	for _, exec := range []*model.SandboxExecution{exec1, exec2} {
		if err := store.CreateExecution(ctx, exec); err != nil {
			t.Fatalf("create execution: %v", err)
		}
	}
	t.Cleanup(func() {
		db.Exec("DELETE FROM sandbox_execution WHERE uid = ?", uid)
		db.Exec("DELETE FROM sandbox_artifact WHERE uid = ?", uid)
		db.Exec("DELETE FROM sandbox_audit WHERE uid = ?", uid)
		db.Exec("DELETE FROM sandbox_lease WHERE uid = ?", uid)
	})

	rows, total, err := store.ListExecutionsFiltered(ctx, ExecutionFilter{UID: &uid, Page: 1, PageSize: 10})
	if err != nil {
		t.Fatalf("list executions: %v", err)
	}
	if total != 2 || len(rows) != 2 || rows[0].ID != exec1.ID {
		t.Fatalf("filtered list = total %d rows %d first %v; want 2/2/newest first", total, len(rows), rows)
	}
	if rows, total, _ = store.ListExecutionsFiltered(ctx, ExecutionFilter{UID: &uid, Statuses: []string{model.ExecStatusFailed}}); total != 1 || rows[0].ID != exec2.ID {
		t.Fatalf("status filter = %d/%v, want only the failed execution", total, rows)
	}
	if _, total, _ = store.ListExecutionsFiltered(ctx, ExecutionFilter{UID: &uid, Page: 2, PageSize: 1}); total != 2 {
		t.Fatalf("page 2 total = %d, want 2", total)
	}
	from := now.Add(-30 * time.Second)
	if _, total, _ = store.ListExecutionsFiltered(ctx, ExecutionFilter{UID: &uid, From: &from}); total != 1 {
		t.Fatalf("time filter total = %d, want 1", total)
	}

	statusCounts, err := store.CountExecutionsByStatus(ctx)
	if err != nil {
		t.Fatalf("count by status: %v", err)
	}
	if statusCounts[model.ExecStatusSucceeded] < 1 || statusCounts[model.ExecStatusFailed] < 1 {
		t.Fatalf("status counts = %v", statusCounts)
	}
	total24h, failures, err := store.CountExecutionsSince(ctx, now.Add(-24*time.Hour))
	if err != nil {
		t.Fatalf("count since: %v", err)
	}
	if total24h < 2 || failures < 1 {
		t.Fatalf("last24h = %d/%d, want >=2 executions and >=1 failure", total24h, failures)
	}

	lease := &model.SandboxLease{
		ID: "test-admin-lease-" + stamp, UID: uid, ProjectID: "p1", Purpose: "academic",
		Runtime: "fake", RuntimeID: "sb-admin", SpecHash: "spec", State: model.LeaseStateReady,
		CreatedAt: now, LastUsedAt: now, ExpiresAt: now.Add(time.Hour),
	}
	if err := store.CreateLease(ctx, lease); err != nil {
		t.Fatalf("create lease: %v", err)
	}
	leaseRows, leaseTotal, err := store.ListLeasesFiltered(ctx, LeaseFilter{UID: &uid, States: []string{model.LeaseStateReady}, Page: 1, PageSize: 10})
	if err != nil {
		t.Fatalf("list leases: %v", err)
	}
	if leaseTotal != 1 || len(leaseRows) != 1 || leaseRows[0].ID != lease.ID {
		t.Fatalf("lease filter = total %d rows %v", leaseTotal, leaseRows)
	}
	leaseCounts, err := store.CountLeasesByState(ctx)
	if err != nil {
		t.Fatalf("count leases by state: %v", err)
	}
	if leaseCounts[model.LeaseStateReady] < 1 {
		t.Fatalf("lease counts = %v", leaseCounts)
	}

	audit := &model.SandboxAudit{
		ID: "test-admin-audit-" + stamp, UID: uid, Action: model.AuditExecutionCreate,
		ExecutionID: exec1.ID, Actor: "admin", Outcome: "queued",
		Detail: "admin", RequestID: "req-admin", CreatedAt: now,
	}
	if err := store.InsertAudit(ctx, audit); err != nil {
		t.Fatalf("insert audit: %v", err)
	}
	auditRows, auditTotal, err := store.ListAuditFiltered(ctx, AuditFilter{UID: &uid, Action: model.AuditExecutionCreate, Page: 1, PageSize: 10})
	if err != nil {
		t.Fatalf("list audit: %v", err)
	}
	if auditTotal != 1 || len(auditRows) != 1 || auditRows[0].Actor != "admin" || auditRows[0].RequestID != "req-admin" {
		t.Fatalf("audit filter = total %d rows %v", auditTotal, auditRows)
	}

	artifact := model.SandboxArtifact{
		ID: "test-admin-artifact-" + stamp, ExecutionID: exec1.ID, UID: uid,
		Name: "result.csv", ObjectKey: "sandbox-artifacts/x/result.csv", SizeBytes: 120,
		SHA256: "abc", ContentType: "text/csv", CreatedAt: now,
	}
	if err := store.CreateArtifacts(ctx, []model.SandboxArtifact{artifact}); err != nil {
		t.Fatalf("create artifacts: %v", err)
	}
	stats, err := store.StatsByExecutionIDs(ctx, []string{exec1.ID, exec2.ID})
	if err != nil {
		t.Fatalf("artifact stats: %v", err)
	}
	if stat := stats[exec1.ID]; stat.Count != 1 || stat.Bytes != 120 {
		t.Fatalf("artifact stats = %+v, want count 1 bytes 120", stat)
	}
	if stat, ok := stats[exec2.ID]; ok && (stat.Count != 0 || stat.Bytes != 0) {
		t.Fatalf("unexpected stats for artifact-less execution: %+v", stat)
	}
}
