// Package repo is the data-access layer for the five app-sandbox tables.
//
// Two implementations satisfy the same narrow interfaces: MySQL (production,
// shared mind_base database) and Memory (unit tests, no database required).
// State transitions are conditional updates (WHERE state IN ...) so concurrent
// callers cannot clobber each other; callers treat a false result as "someone
// else moved it first".
package repo

import (
	"context"
	"errors"
	"time"

	"app-sandbox/internal/model"
)

// ErrNotFound is returned when a row does not exist.
var ErrNotFound = errors.New("repo: not found")

// LeaseRepo is the sandbox_lease access contract.
type LeaseRepo interface {
	CreateLease(ctx context.Context, lease *model.SandboxLease) error
	GetLease(ctx context.Context, id string) (*model.SandboxLease, error)
	// FindReusable returns the newest ready/idle, unexpired lease with the same
	// (uid, project, purpose, specHash) identity, or ErrNotFound.
	FindReusable(ctx context.Context, uid int64, projectID, purpose, specHash string, now time.Time) (*model.SandboxLease, error)
	// CountActiveByUID counts unexpired active leases (concurrency quota input).
	CountActiveByUID(ctx context.Context, uid int64, now time.Time) (int64, error)
	// MarkReady persists the runtime id and moves creating -> ready.
	MarkReady(ctx context.Context, id, runtimeID string, now, expiresAt time.Time) (bool, error)
	// ClaimForExec moves a ready/idle lease to busy.
	ClaimForExec(ctx context.Context, id string, now time.Time) (bool, error)
	// MarkIdle moves a busy lease back to idle, renewing last_used_at/expires_at.
	MarkIdle(ctx context.Context, id string, now, expiresAt time.Time) (bool, error)
	// Renew extends an unexpired ready/idle lease when it is handed out again.
	Renew(ctx context.Context, id string, now, expiresAt time.Time) (bool, error)
	// SetState is a conditional transition from one of "from" to "to".
	SetState(ctx context.Context, id string, from []string, to string) (bool, error)
	// ListExpired returns active leases whose TTL elapsed.
	ListExpired(ctx context.Context, now time.Time, limit int) ([]model.SandboxLease, error)
	// ListStuckCreating returns leases stuck in creating before the given time.
	ListStuckCreating(ctx context.Context, before time.Time, limit int) ([]model.SandboxLease, error)
	// ListActive returns every creating/ready/busy/idle lease (orphan checks).
	ListActive(ctx context.Context, limit int) ([]model.SandboxLease, error)
	ListLeasesByUID(ctx context.Context, uid int64, limit int) ([]model.SandboxLease, error)
	// ListByState returns leases in the given states (admin/diagnostics).
	ListLeasesByState(ctx context.Context, states []string, limit int) ([]model.SandboxLease, error)
	// ListReleasing returns leases whose runtime delete failed and must be retried.
	ListReleasing(ctx context.Context, limit int) ([]model.SandboxLease, error)
}

// Finish carries the terminal fields of an execution.
type Finish struct {
	Status         string
	ExitCode       *int
	StdoutBytes    int64
	StderrBytes    int64
	StdoutPreview  string
	StderrPreview  string
	ArtifactPrefix string
	ErrorCode      string
	FinishedAt     time.Time
}

// ExecutionRepo is the sandbox_execution access contract.
type ExecutionRepo interface {
	CreateExecution(ctx context.Context, exec *model.SandboxExecution) error
	GetExecution(ctx context.Context, id string) (*model.SandboxExecution, error)
	SetLease(ctx context.Context, id, leaseID string) error
	// MarkRunning stamps started_at/deadline_at on a queued execution.
	MarkRunning(ctx context.Context, id string, startedAt, deadlineAt time.Time) (bool, error)
	// Finish writes the terminal state; false when it was already terminal.
	Finish(ctx context.Context, id string, fin Finish) (bool, error)
	// Cancel marks a queued/running execution canceled (idempotent).
	Cancel(ctx context.Context, id, errorCode string, finishedAt time.Time) (bool, error)
	// ListTimedOut returns running executions whose deadline passed.
	ListTimedOut(ctx context.Context, now time.Time, limit int) ([]model.SandboxExecution, error)
	ListExecutionsByLease(ctx context.Context, leaseID string) ([]model.SandboxExecution, error)
	ListExecutionsByUID(ctx context.Context, uid int64, limit int) ([]model.SandboxExecution, error)
}

// ArtifactRepo is the sandbox_artifact access contract.
type ArtifactRepo interface {
	CreateArtifacts(ctx context.Context, artifacts []model.SandboxArtifact) error
	ListArtifactsByExecution(ctx context.Context, executionID string) ([]model.SandboxArtifact, error)
}

// UsageDelta is one set of daily-counter increments.
type UsageDelta struct {
	Executions    int64
	CPUMillis     int64
	ArtifactBytes int64
	LeasesCreated int64
}

// UsageRepo is the sandbox_usage_daily access contract.
type UsageRepo interface {
	// Increment upserts the (uid, day) row, adding the deltas.
	IncrementUsage(ctx context.Context, uid int64, day string, delta UsageDelta) error
	// GetUsage returns the row; a missing row is returned as the zero value.
	GetUsage(ctx context.Context, uid int64, day string) (model.SandboxUsageDaily, error)
}

// AuditRepo is the append-only sandbox_audit access contract.
type AuditRepo interface {
	InsertAudit(ctx context.Context, audit *model.SandboxAudit) error
	ListAuditByExecution(ctx context.Context, executionID string) ([]model.SandboxAudit, error)
	ListAuditByUID(ctx context.Context, uid int64, limit int) ([]model.SandboxAudit, error)
}
