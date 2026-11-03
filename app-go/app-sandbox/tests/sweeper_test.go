package tests

import (
	"context"
	"testing"
	"time"

	"app-sandbox/internal/config"
	"app-sandbox/internal/model"
	"app-sandbox/internal/runtime"

	"github.com/google/uuid"
)

func TestSweeperReclaimsExpiredLease(t *testing.T) {
	env := newTestEnv(t, RuntimeDefaults(), nil)
	ctx := context.Background()
	now := time.Now()
	sandbox, err := env.rt.Create(ctx, runtime.CreateSpec{})
	if err != nil {
		t.Fatalf("create sandbox: %v", err)
	}
	lease := &model.SandboxLease{
		ID: uuid.NewString(), UID: 30, Purpose: "academic", Runtime: "fake", RuntimeID: sandbox.ID,
		SpecHash: "spec", State: model.LeaseStateReady,
		CreatedAt: now.Add(-time.Hour), ExpiresAt: now.Add(-time.Minute), LastUsedAt: now.Add(-time.Hour),
	}
	if err := env.store.CreateLease(ctx, lease); err != nil {
		t.Fatalf("create lease: %v", err)
	}
	report, err := env.sweeper.SweepOnce(ctx)
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if report.ExpiredLeases != 1 {
		t.Fatalf("report.ExpiredLeases = %d, want 1", report.ExpiredLeases)
	}
	got, err := env.store.GetLease(ctx, lease.ID)
	if err != nil {
		t.Fatalf("get lease: %v", err)
	}
	if got.State != model.LeaseStateTerminated {
		t.Fatalf("lease state = %s, want terminated", got.State)
	}
	if _, _, deletes := env.rt.Calls(); deletes != 1 {
		t.Fatalf("runtime deletes = %d, want 1", deletes)
	}
}

func TestSweeperCancelsTimedOutExecution(t *testing.T) {
	env := newTestEnv(t, RuntimeDefaults(), nil)
	ctx := context.Background()
	now := time.Now()
	exec := &model.SandboxExecution{
		ID: uuid.NewString(), UID: 31, Language: "python", Status: model.ExecStatusQueued,
		TimeoutMS: 1000, CreatedAt: now.Add(-time.Minute),
	}
	if err := env.store.CreateExecution(ctx, exec); err != nil {
		t.Fatalf("create execution: %v", err)
	}
	if ok, err := env.store.MarkRunning(ctx, exec.ID, now.Add(-time.Minute), now.Add(-time.Second)); err != nil || !ok {
		t.Fatalf("mark running: ok=%v err=%v", ok, err)
	}
	report, err := env.sweeper.SweepOnce(ctx)
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if report.TimedOutExecutions != 1 {
		t.Fatalf("report.TimedOutExecutions = %d, want 1", report.TimedOutExecutions)
	}
	got, _ := env.store.GetExecution(ctx, exec.ID)
	if got.Status != model.ExecStatusCanceled || got.ErrorCode != "execution_timeout" {
		t.Fatalf("execution after sweep = (%s,%s), want (canceled,execution_timeout)", got.Status, got.ErrorCode)
	}
}

func TestSweeperFailsStuckCreatingLease(t *testing.T) {
	env := newTestEnv(t, RuntimeDefaults(), func(cfg *config.Config, _ *runtime.Fake) {
		cfg.Sweeper.CreateTimeoutMS = 60000
	})
	ctx := context.Background()
	now := time.Now()
	lease := &model.SandboxLease{
		ID: uuid.NewString(), UID: 32, Purpose: "academic", Runtime: "fake",
		SpecHash: "spec", State: model.LeaseStateCreating,
		CreatedAt: now.Add(-2 * time.Minute), ExpiresAt: now.Add(time.Hour), LastUsedAt: now.Add(-2 * time.Minute),
	}
	if err := env.store.CreateLease(ctx, lease); err != nil {
		t.Fatalf("create lease: %v", err)
	}
	report, err := env.sweeper.SweepOnce(ctx)
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if report.StuckCreating != 1 {
		t.Fatalf("report.StuckCreating = %d, want 1", report.StuckCreating)
	}
	got, _ := env.store.GetLease(ctx, lease.ID)
	if got.State != model.LeaseStateFailed {
		t.Fatalf("lease state = %s, want failed", got.State)
	}
}

func TestSweeperRetriesReleasingLease(t *testing.T) {
	env := newTestEnv(t, RuntimeDefaults(), nil)
	ctx := context.Background()
	now := time.Now()
	sandbox, err := env.rt.Create(ctx, runtime.CreateSpec{})
	if err != nil {
		t.Fatalf("create sandbox: %v", err)
	}
	lease := &model.SandboxLease{
		ID: uuid.NewString(), UID: 33, Purpose: "academic", Runtime: "fake", RuntimeID: sandbox.ID,
		SpecHash: "spec", State: model.LeaseStateReleasing,
		CreatedAt: now, ExpiresAt: now.Add(time.Hour), LastUsedAt: now,
	}
	if err := env.store.CreateLease(ctx, lease); err != nil {
		t.Fatalf("create lease: %v", err)
	}
	report, err := env.sweeper.SweepOnce(ctx)
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if report.ReleasingRetried != 1 {
		t.Fatalf("report.ReleasingRetried = %d, want 1", report.ReleasingRetried)
	}
	got, _ := env.store.GetLease(ctx, lease.ID)
	if got.State != model.LeaseStateTerminated {
		t.Fatalf("lease state = %s, want terminated", got.State)
	}
}

func TestSweeperOrphanDryRunKeepsLease(t *testing.T) {
	env := newTestEnv(t, RuntimeDefaults(), func(cfg *config.Config, _ *runtime.Fake) {
		cfg.Sweeper.OrphanDryRun = true
	})
	ctx := context.Background()
	now := time.Now()
	lease := &model.SandboxLease{
		ID: uuid.NewString(), UID: 34, Purpose: "academic", Runtime: "fake", RuntimeID: "ghost-sandbox",
		SpecHash: "spec", State: model.LeaseStateReady,
		CreatedAt: now, ExpiresAt: now.Add(time.Hour), LastUsedAt: now,
	}
	if err := env.store.CreateLease(ctx, lease); err != nil {
		t.Fatalf("create lease: %v", err)
	}
	report, err := env.sweeper.SweepOnce(ctx)
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if report.Orphans != 1 {
		t.Fatalf("report.Orphans = %d, want 1", report.Orphans)
	}
	got, _ := env.store.GetLease(ctx, lease.ID)
	if got.State != model.LeaseStateReady {
		t.Fatalf("dry-run must keep the lease, state = %s", got.State)
	}
}

func TestSweeperFailsOrphanWhenNotDryRun(t *testing.T) {
	env := newTestEnv(t, RuntimeDefaults(), func(cfg *config.Config, _ *runtime.Fake) {
		cfg.Sweeper.OrphanDryRun = false
	})
	ctx := context.Background()
	now := time.Now()
	lease := &model.SandboxLease{
		ID: uuid.NewString(), UID: 35, Purpose: "academic", Runtime: "fake", RuntimeID: "ghost-sandbox",
		SpecHash: "spec", State: model.LeaseStateReady,
		CreatedAt: now, ExpiresAt: now.Add(time.Hour), LastUsedAt: now,
	}
	if err := env.store.CreateLease(ctx, lease); err != nil {
		t.Fatalf("create lease: %v", err)
	}
	report, err := env.sweeper.SweepOnce(ctx)
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if report.RuntimeMissing != 1 {
		t.Fatalf("report.RuntimeMissing = %d, want 1", report.RuntimeMissing)
	}
	got, _ := env.store.GetLease(ctx, lease.ID)
	if got.State != model.LeaseStateFailed {
		t.Fatalf("orphan lease state = %s, want failed", got.State)
	}
}
