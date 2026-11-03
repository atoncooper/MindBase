package tests

import (
	. "app-sandbox/internal/service"
	"context"
	"errors"
	"testing"
	"time"

	"app-sandbox/internal/config"
	"app-sandbox/internal/repo"
	"app-sandbox/internal/runtime"
)

func TestLeaseManagerReusesSameIdentity(t *testing.T) {
	env := newTestEnv(t, RuntimeDefaults(), nil)
	req := LeaseRequest{UID: 7, ProjectID: "p1", Purpose: "academic", RequestID: "r1"}

	first, err := env.leases.Acquire(context.Background(), req)
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	second, err := env.leases.Acquire(context.Background(), req)
	if err != nil {
		t.Fatalf("second acquire: %v", err)
	}
	if first.ID != second.ID {
		t.Fatalf("expected reuse of lease %s, got %s", first.ID, second.ID)
	}
	if creates, _, _ := env.rt.Calls(); creates != 1 {
		t.Fatalf("runtime created %d sandboxes, want 1 (reuse)", creates)
	}
	if second.State != "ready" && second.State != "idle" {
		t.Fatalf("reused lease state = %s, want ready/idle", second.State)
	}
}

func TestLeaseManagerDoesNotShareAcrossProjectOrPurpose(t *testing.T) {
	env := newTestEnv(t, RuntimeDefaults(), nil)
	first, err := env.leases.Acquire(context.Background(), LeaseRequest{UID: 7, ProjectID: "p1", Purpose: "academic"})
	if err != nil {
		t.Fatalf("acquire p1: %v", err)
	}
	second, err := env.leases.Acquire(context.Background(), LeaseRequest{UID: 7, ProjectID: "p2", Purpose: "academic"})
	if err != nil {
		t.Fatalf("acquire p2: %v", err)
	}
	if first.ID == second.ID {
		t.Fatal("leases with different projectIds must not be shared")
	}
}

func TestLeaseManagerExpiresAndRecreates(t *testing.T) {
	env := newTestEnv(t, RuntimeDefaults(), nil)
	base := time.Now()
	current := base
	env.leases.Now = func() time.Time { return current }

	req := LeaseRequest{UID: 7, ProjectID: "p1", Purpose: "academic"}
	first, err := env.leases.Acquire(context.Background(), req)
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	// Jump past the TTL: the stored lease is expired and must not be reused.
	current = base.Add(env.cfg.LeaseTTL() + time.Minute)
	second, err := env.leases.Acquire(context.Background(), req)
	if err != nil {
		t.Fatalf("second acquire: %v", err)
	}
	if first.ID == second.ID {
		t.Fatalf("expired lease %s must not be reused", first.ID)
	}
	if creates, _, _ := env.rt.Calls(); creates != 2 {
		t.Fatalf("runtime created %d sandboxes, want 2", creates)
	}
}

func TestLeaseManagerRejectsOverConcurrencyCap(t *testing.T) {
	env := newTestEnv(t, RuntimeDefaults(), func(cfg *config.Config, _ *runtime.Fake) {
		cfg.Lease.MaxPerUID = 1
		cfg.Quota.Enabled = false
	})
	if _, err := env.leases.Acquire(context.Background(), LeaseRequest{UID: 7, ProjectID: "p1", Purpose: "academic"}); err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	_, err := env.leases.Acquire(context.Background(), LeaseRequest{UID: 7, ProjectID: "p2", Purpose: "academic"})
	if err == nil {
		t.Fatal("expected a concurrency-limit error")
	}
	var quotaErr *QuotaExceededError
	if !errors.As(err, &quotaErr) || quotaErr.Kind != config.QuotaConcurrent {
		t.Fatalf("want QuotaExceededError kind %s, got %v", config.QuotaConcurrent, err)
	}
}

func TestLeaseManagerReleaseTerminatesAndDeletesRuntime(t *testing.T) {
	env := newTestEnv(t, RuntimeDefaults(), nil)
	lease, err := env.leases.Acquire(context.Background(), LeaseRequest{UID: 7, ProjectID: "p1", Purpose: "academic"})
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	released, err := env.leases.Release(context.Background(), lease.ID, "manual", "r1")
	if err != nil {
		t.Fatalf("release: %v", err)
	}
	if released.State != "terminated" {
		t.Fatalf("released lease state = %s, want terminated", released.State)
	}
	if _, _, deletes := env.rt.Calls(); deletes != 1 {
		t.Fatalf("runtime deletes = %d, want 1", deletes)
	}
	// Idempotent: a second release is a no-op.
	if _, err := env.leases.Release(context.Background(), lease.ID, "manual", "r1"); err != nil {
		t.Fatalf("idempotent release: %v", err)
	}
	// Unknown lease -> repo.ErrNotFound.
	if _, err := env.leases.Release(context.Background(), "missing", "manual", "r1"); !errors.Is(err, repo.ErrNotFound) {
		t.Fatalf("want repo.ErrNotFound, got %v", err)
	}
}

func TestLeaseManagerReleaseCancelsInFlightExecutions(t *testing.T) {
	env := newTestEnv(t, runtime.FakeOptions{Stdout: "slow\n", ExecDelay: 2 * time.Second}, nil)
	exec := env.mustCreate(t, CreateRequest{UID: 9, ProjectID: "p1", Purpose: "academic", Language: "python", Code: "print(1)", TimeoutMS: 10000})
	env.waitStatus(t, exec.ID, "running")
	if _, err := env.leases.Release(context.Background(), exec.LeaseID, "manual", "r1"); err != nil {
		t.Fatalf("release: %v", err)
	}
	terminal := env.waitTerminal(t, 9, exec.ID)
	if terminal.Status != "canceled" {
		t.Fatalf("execution status = %s, want canceled", terminal.Status)
	}
}
