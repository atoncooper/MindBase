package service

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"app-sandbox/internal/config"
	"app-sandbox/internal/metrics"
	"app-sandbox/internal/repo"
	"app-sandbox/internal/runtime"
)

// SweepReport summarizes one sweeper pass (also returned by SweepOnce so tests
// can assert reclamation behaviour).
type SweepReport struct {
	ExpiredLeases      int `json:"expiredLeases"`
	TimedOutExecutions int `json:"timedOutExecutions"`
	StuckCreating      int `json:"stuckCreating"`
	ReleasingRetried   int `json:"releasingRetried"`
	RuntimeMissing     int `json:"runtimeMissing"`
	Orphans            int `json:"orphans"`
}

// Sweeper reclaims everything the happy path leaves behind: expired leases,
// executions past their deadline, leases stuck in creating, failed runtime
// deletes and (dry-run configurable) leases whose runtime resource vanished.
//
// Single-replica only: leader election is not implemented, so
// this must run with exactly one control-plane instance.
type Sweeper struct {
	cfg        *config.Config
	leaseRepo  repo.LeaseRepo
	leases     *LeaseManager
	executions *ExecutionService
	audit      repo.AuditRepo
	rt         runtime.Runtime
	metrics    *metrics.Metrics
	now        func() time.Time
}

// NewSweeper wires the sweeper.
func NewSweeper(
	cfg *config.Config,
	leaseRepo repo.LeaseRepo,
	leases *LeaseManager,
	executions *ExecutionService,
	audit repo.AuditRepo,
	rt runtime.Runtime,
	m *metrics.Metrics,
) *Sweeper {
	return &Sweeper{
		cfg:        cfg,
		leaseRepo:  leaseRepo,
		leases:     leases,
		executions: executions,
		audit:      audit,
		rt:         rt,
		metrics:    m,
		now:        time.Now,
	}
}

// Run blocks until ctx is canceled, sweeping every configured interval.
func (s *Sweeper) Run(ctx context.Context) {
	interval := s.cfg.SweeperInterval()
	if interval <= 0 {
		interval = 15 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if _, err := s.SweepOnce(ctx); err != nil {
				slog.Warn("[SWEEPER] pass failed", "err", err)
			}
		}
	}
}

// SweepOnce performs one reclaim pass and returns what it changed.
func (s *Sweeper) SweepOnce(ctx context.Context) (SweepReport, error) {
	report := SweepReport{}
	now := s.now()

	// 1) Executions past their deadline: cancel (idempotent) and mark timeout.
	timedOut, err := s.executions.listTimedOut(ctx, now, 200)
	if err != nil {
		return report, err
	}
	for _, row := range timedOut {
		if s.executions.CancelExecution(ctx, row.ID, "execution_timeout", "sweeper") {
			report.TimedOutExecutions++
			s.count("timed_out_executions")
		}
	}

	// 2) Expired leases: cancel in-flight work, delete the runtime sandbox, mark
	// terminated (release handles all three and stays idempotent).
	expired, err := s.leaseRepo.ListExpired(ctx, now, 200)
	if err != nil {
		return report, err
	}
	for _, lease := range expired {
		if _, rerr := s.leases.Release(ctx, lease.ID, "expired", "sweeper"); rerr != nil {
			slog.Warn("[SWEEPER] expired lease release failed", "lease", lease.ID, "err", rerr)
			continue
		}
		report.ExpiredLeases++
		s.count("expired_leases")
	}

	// 3) Leases stuck in creating (runtime never confirmed): fail them.
	stuckBefore := now.Add(-time.Duration(s.cfg.Sweeper.CreateTimeoutMS) * time.Millisecond)
	if s.cfg.Sweeper.CreateTimeoutMS <= 0 {
		stuckBefore = now.Add(-s.cfg.CreateTimeout())
	}
	stuck, err := s.leaseRepo.ListStuckCreating(ctx, stuckBefore, 100)
	if err != nil {
		return report, err
	}
	for _, lease := range stuck {
		if _, ferr := s.leases.MarkFailed(ctx, lease.ID, "create_timeout", "sweeper"); ferr != nil {
			slog.Warn("[SWEEPER] failed lease could not be marked", "lease", lease.ID, "err", ferr)
			continue
		}
		report.StuckCreating++
		s.count("stuck_creating")
	}

	// 4) Leases whose runtime delete failed on a previous pass: retry the delete.
	releasing, err := s.leaseRepo.ListReleasing(ctx, 100)
	if err != nil {
		return report, err
	}
	for _, lease := range releasing {
		if _, rerr := s.leases.RetryRelease(ctx, lease.ID, "releasing_retry", "sweeper"); rerr != nil {
			slog.Warn("[SWEEPER] releasing retry failed", "lease", lease.ID, "err", rerr)
			continue
		}
		report.ReleasingRetried++
		s.count("releasing_retried")
	}

	// 5) Runtime resource missing (or orphan): active leases whose sandbox cannot
	// be found. Dry-run only logs (orphanDryRun); otherwise fail the lease and
	// cancel its executions. Runtime-side orphans (sandbox present, row missing)
	// need a runtime List API.
	active, err := s.leaseRepo.ListActive(ctx, 200)
	if err != nil {
		return report, err
	}
	for _, lease := range active {
		if lease.RuntimeID == "" {
			continue
		}
		if _, gerr := s.rt.Get(ctx, lease.RuntimeID); gerr == nil {
			continue
		} else if !errors.Is(gerr, runtime.ErrNotFound) {
			slog.Warn("[SWEEPER] runtime get failed", "lease", lease.ID, "err", gerr)
			continue
		}
		if s.cfg.Sweeper.OrphanDryRun {
			report.Orphans++
			s.count("orphans_dry_run")
			slog.Warn("[SWEEPER] orphan lease detected (dry-run)", "lease", lease.ID, "runtimeId", lease.RuntimeID, "uid", lease.UID)
			continue
		}
		s.executions.CancelByLease(ctx, lease.ID, "runtime_missing", "sweeper")
		if _, ferr := s.leases.MarkFailed(ctx, lease.ID, "runtime_missing", "sweeper"); ferr != nil {
			slog.Warn("[SWEEPER] orphan lease could not be failed", "lease", lease.ID, "err", ferr)
			continue
		}
		report.RuntimeMissing++
		s.count("runtime_missing")
	}

	return report, nil
}

func (s *Sweeper) count(reason string) {
	if s.metrics != nil {
		s.metrics.Inc("sandbox_sweeper_actions_total", map[string]string{"reason": reason})
	}
}
