package service

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"app-sandbox/internal/model"
	"app-sandbox/internal/repo"
	"app-sandbox/internal/runtime"

	"github.com/google/uuid"
)

// run is the worker: it upgrades the lease, executes the code, collects
// artifacts and persists the terminal state (even when the caller canceled).
func (s *ExecutionService) run(exec *model.SandboxExecution, req CreateRequest, timeout time.Duration, release func()) {
	defer s.wg.Done()
	defer release()
	defer s.active.Add(-1)
	defer s.unregisterInflight(exec.ID)
	// A panic in the worker must not take down the whole control plane: fail the
	// execution, publish a terminal event and let the sweeper/lease bookkeeping
	// catch up. (Runtime/adapter bugs are otherwise process-fatal.)
	defer func() {
		if recovered := recover(); recovered != nil {
			slog.Error("[EXEC] worker panic", "execution", exec.ID, "panic", recovered)
			dbCtx, cancel := context.WithTimeout(context.WithoutCancel(s.baseCtx), 5*time.Second)
			defer cancel()
			if _, err := s.executions.Finish(dbCtx, exec.ID, repo.Finish{
				Status:     model.ExecStatusFailed,
				ErrorCode:  "internal_error",
				FinishedAt: s.now(),
			}); err != nil {
				slog.Error("[EXEC] persist panic state failed", "execution", exec.ID, "err", err)
			}
			// The worker died mid-flight: reclaim its lease so the sandbox does not
			// stay "busy" until the TTL sweeper notices.
			if exec.LeaseID != "" {
				releaseCtx, releaseCancel := context.WithTimeout(context.WithoutCancel(s.baseCtx), 5*time.Second)
				if _, err := s.leases.Release(releaseCtx, exec.LeaseID, "worker_panic", req.RequestID); err != nil {
					slog.Warn("[EXEC] lease release after panic failed", "lease", exec.LeaseID, "err", err)
				}
				releaseCancel()
			}
			if s.metrics != nil {
				s.metrics.Inc("sandbox_executions_total", map[string]string{"status": model.ExecStatusFailed})
			}
			s.publishDone(exec.ID, model.ExecStatusFailed, "internal_error")
		}
	}()

	runCtx, cancel := context.WithCancel(s.baseCtx)
	defer cancel()
	s.registerInflight(exec.ID, cancel)

	started := s.now()
	deadline := started.Add(timeout)
	ok, err := s.executions.MarkRunning(runCtx, exec.ID, started, deadline)
	if err != nil {
		slog.Error("[EXEC] mark running failed", "execution", exec.ID, "err", err)
		return
	}
	if !ok {
		// Canceled or swept between create and start; the terminal row exists.
		return
	}
	exec.Status = model.ExecStatusRunning
	exec.StartedAt = &started
	exec.DeadlineAt = &deadline
	s.auditExec(exec, req, "agent", model.AuditExecutionStart, "running", "", 0, nil)
	s.publishStatus(exec)

	lease, leaseErr := s.leases.Acquire(runCtx, LeaseRequest{
		UID:       exec.UID,
		ProjectID: exec.ProjectID,
		Purpose:   exec.Purpose,
		RequestID: req.RequestID,
	})
	if leaseErr != nil {
		code := "lease_error"
		var quotaErr *QuotaExceededError
		if errors.As(leaseErr, &quotaErr) {
			code = "concurrency_limit"
		}
		s.finishFailure(exec, req, started, code, leaseErr.Error())
		return
	}
	exec.LeaseID = lease.ID
	if err := s.executions.SetLease(runCtx, exec.ID, lease.ID); err != nil {
		slog.Warn("[EXEC] persist lease id failed", "execution", exec.ID, "err", err)
	}
	claimed, claimErr := s.leases.MarkBusy(runCtx, lease.ID)
	if claimErr != nil || !claimed {
		s.finishFailure(exec, req, started, "lease_busy", "lease could not be claimed for execution")
		_, _ = s.leases.Release(context.WithoutCancel(runCtx), lease.ID, "claim_failed", req.RequestID)
		return
	}

	result, execErr := s.execute(runCtx, lease, req, timeout)
	finished := s.now()

	status := model.ExecStatusSucceeded
	errorCode := ""
	detail := ""
	var exitCode *int
	var stdout, stderr string
	switch {
	case execErr != nil:
		timedOut := errors.Is(execErr, context.DeadlineExceeded) ||
			errors.Is(execErr, runtime.ErrTimeout) ||
			(result != nil && result.TimedOut)
		switch {
		case timedOut:
			status, errorCode = model.ExecStatusTimeout, "execution_timeout"
		case errors.Is(execErr, context.Canceled):
			status, errorCode = model.ExecStatusCanceled, "canceled"
		case errors.Is(execErr, runtime.ErrNotFound):
			status, errorCode = model.ExecStatusFailed, "runtime_missing"
		default:
			status, errorCode = model.ExecStatusFailed, "exec_error"
			detail = execErr.Error()
			slog.Error("[EXEC] runtime error", "execution", exec.ID, "language", req.Language, "err", execErr)
		}
	case result != nil:
		exitCode = &result.ExitCode
		stdout, stderr = result.Stdout, result.Stderr
		if result.TimedOut {
			status, errorCode = model.ExecStatusTimeout, "execution_timeout"
		} else if result.ExitCode != 0 {
			status, errorCode = model.ExecStatusFailed, "nonzero_exit"
		}
	default:
		status, errorCode = model.ExecStatusFailed, "no_result"
	}

	dbCtx, dbCancel := context.WithTimeout(context.WithoutCancel(s.baseCtx), 10*time.Second)
	defer dbCancel()

	// Artifacts: only when the runtime actually produced a result.
	artifactRows, _ := s.collectArtifacts(runCtx, dbCtx, exec, lease, req, result)

	preview := s.cfg.Execution.PreviewBytes
	if preview <= 0 {
		preview = 4096
	}
	stdoutBytes, stderrBytes := int64(len(stdout)), int64(len(stderr))
	if result != nil {
		if result.StdoutBytes > 0 {
			stdoutBytes = result.StdoutBytes
		}
		if result.StderrBytes > 0 {
			stderrBytes = result.StderrBytes
		}
	}
	fin := repo.Finish{
		Status:         status,
		ExitCode:       exitCode,
		StdoutBytes:    stdoutBytes,
		StderrBytes:    stderrBytes,
		StdoutPreview:  truncateText(stdout, preview),
		StderrPreview:  truncateText(stderr, preview),
		ArtifactPrefix: exec.ArtifactPrefix,
		ErrorCode:      errorCode,
		FinishedAt:     finished,
	}
	accepted, finishErr := s.executions.Finish(dbCtx, exec.ID, fin)
	if finishErr != nil {
		slog.Error("[EXEC] persist terminal state failed", "execution", exec.ID, "err", finishErr)
	}

	// Lease bookkeeping: a vanished runtime resource must be reclaimed, a healthy
	// one goes back to idle with a renewed TTL for the next execution.
	if errorCode == "runtime_missing" {
		_, _ = s.leases.Release(dbCtx, lease.ID, "runtime_missing", req.RequestID)
	} else {
		if err := s.leases.Renew(dbCtx, lease.ID); err != nil {
			slog.Warn("[EXEC] lease renew failed", "lease", lease.ID, "err", err)
		}
	}

	if result != nil {
		elapsed := finished.Sub(started)
		cpuMillis := int64(elapsed.Milliseconds()) * s.cfg.CPUMilli() / 1000
		s.incrementUsage(dbCtx, exec.UID, finished, repo.UsageDelta{CPUMillis: cpuMillis})
	}
	if accepted {
		exec.Status = status
		exec.ExitCode = exitCode
		exec.ErrorCode = errorCode
		exec.StartedAt = &started
		exec.FinishedAt = &finished
		exec.StdoutBytes = fin.StdoutBytes
		exec.StderrBytes = fin.StderrBytes
		exec.StdoutPreview = fin.StdoutPreview
		exec.StderrPreview = fin.StderrPreview
		exec.LeaseID = lease.ID
		s.metrics.Inc("sandbox_executions_total", map[string]string{"status": status})
	}
	elapsedMS := finished.Sub(started).Milliseconds()
	s.auditExec(exec, req, "agent", model.AuditExecutionFinish, status, detail, elapsedMS, exitCode)
	s.publishStatus(exec)
	s.publishStream(exec.ID, stdout, stderr, preview)
	s.publishArtifacts(exec.ID, artifactRows)
	s.publishDone(exec.ID, status, errorCode)
}

func (s *ExecutionService) execute(ctx context.Context, lease *model.SandboxLease, req CreateRequest, timeout time.Duration) (*runtime.ExecResult, error) {
	execCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	return s.rt.Exec(execCtx, runtime.ExecRequest{
		SandboxID: lease.RuntimeID,
		Language:  req.Language,
		Code:      req.Code,
		Files:     req.Files,
		Timeout:   timeout,
	})
}

// collectArtifacts lists declared outputs, enforces size/quota limits, persists
// the metadata rows and returns them. Best effort: artifact problems never turn a
// successful execution into a failure.
func (s *ExecutionService) collectArtifacts(collectCtx, dbCtx context.Context, exec *model.SandboxExecution, lease *model.SandboxLease, req CreateRequest, result *runtime.ExecResult) ([]model.SandboxArtifact, int64) {
	if s.artifactStore == nil || result == nil {
		return nil, 0
	}
	globs := req.ArtifactGlobs
	if len(globs) == 0 {
		globs = s.cfg.Artifacts.DefaultGlobs
	}
	candidates, err := s.artifactStore.Collect(collectCtx, lease.RuntimeID, globs)
	if err != nil {
		slog.Warn("[EXEC] artifact collect failed", "execution", exec.ID, "err", err)
		return nil, 0
	}
	var total int64
	kept := make([]ArtifactCandidate, 0, len(candidates))
	for _, cand := range candidates {
		if lim := s.cfg.Artifacts.MaxFileBytes; lim > 0 && cand.SizeBytes > lim {
			continue
		}
		if lim := s.cfg.Artifacts.MaxTotalBytes; lim > 0 && total+cand.SizeBytes > lim {
			continue
		}
		total += cand.SizeBytes
		kept = append(kept, cand)
	}
	if len(kept) == 0 {
		return nil, 0
	}
	if err := s.quota.CheckArtifact(dbCtx, exec.UID, total); err != nil {
		if s.metrics != nil {
			s.metrics.Inc("sandbox_quota_denied_total", map[string]string{"kind": quotaKindOf(err)})
		}
		s.auditExec(exec, req, "agent", model.AuditArtifactDeny, "quota_exceeded", err.Error(), 0, nil)
		return nil, 0
	}
	now := s.now()
	rows := make([]model.SandboxArtifact, 0, len(kept))
	for _, cand := range kept {
		rows = append(rows, model.SandboxArtifact{
			ID:          uuid.NewString(),
			ExecutionID: exec.ID,
			UID:         exec.UID,
			Name:        cand.Name,
			ObjectKey:   s.artifactObjectKey(exec, cand),
			SizeBytes:   cand.SizeBytes,
			SHA256:      cand.SHA256,
			ContentType: cand.ContentType,
			CreatedAt:   now,
		})
	}
	if err := s.artifacts.CreateArtifacts(dbCtx, rows); err != nil {
		slog.Error("[EXEC] persist artifacts failed", "execution", exec.ID, "err", err)
		return nil, 0
	}
	s.incrementUsage(dbCtx, exec.UID, now, repo.UsageDelta{ArtifactBytes: total})
	s.auditExec(exec, req, "agent", model.AuditArtifactUpload, "uploaded", "", 0, nil)
	return rows, total
}

func (s *ExecutionService) artifactObjectKey(exec *model.SandboxExecution, cand ArtifactCandidate) string {
	if cand.ObjectKey != "" {
		return cand.ObjectKey
	}
	return exec.ArtifactPrefix + "/" + cand.Name
}
