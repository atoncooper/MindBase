package service

import (
	"context"
	"log/slog"
	"time"

	"app-sandbox/internal/model"
	"app-sandbox/internal/repo"
)

// finishFailure persists a failure that happened before the code ran (lease or
// claim failure) and closes the event stream.
func (s *ExecutionService) finishFailure(exec *model.SandboxExecution, req CreateRequest, started time.Time, errorCode, detail string) {
	finished := s.now()
	dbCtx, cancel := context.WithTimeout(context.WithoutCancel(s.baseCtx), 10*time.Second)
	defer cancel()
	fin := repo.Finish{
		Status:     model.ExecStatusFailed,
		ErrorCode:  errorCode,
		FinishedAt: finished,
	}
	if _, err := s.executions.Finish(dbCtx, exec.ID, fin); err != nil {
		slog.Error("[EXEC] persist failure state failed", "execution", exec.ID, "err", err)
	}
	exec.Status = model.ExecStatusFailed
	exec.ErrorCode = errorCode
	exec.StartedAt = &started
	exec.FinishedAt = &finished
	s.metrics.Inc("sandbox_executions_total", map[string]string{"status": model.ExecStatusFailed})
	s.auditExec(exec, req, "agent", model.AuditExecutionDeny, "failed", detail, finished.Sub(started).Milliseconds(), nil)
	s.publishStatus(exec)
	s.publishDone(exec.ID, model.ExecStatusFailed, errorCode)
}

// Get returns the uid-scoped execution view (metadata + artifacts + URLs).
func (s *ExecutionService) Get(ctx context.Context, uid int64, id string) (*ExecutionView, error) {
	exec, err := s.executions.GetExecution(ctx, id)
	if err != nil {
		return nil, ErrNotFound
	}
	if exec.UID != uid {
		return nil, ErrForbidden
	}
	return &ExecutionView{Execution: exec, Artifacts: s.artifactViews(ctx, id)}, nil
}

// ListByUID returns the newest executions of one uid (newest first), each
// assembled like Get: metadata plus artifact views with presigned URLs. The repo
// clamps the limit; the HTTP layer applies the public 1..50 contract.
func (s *ExecutionService) ListByUID(ctx context.Context, uid int64, limit int) ([]*ExecutionView, error) {
	rows, err := s.executions.ListExecutionsByUID(ctx, uid, limit)
	if err != nil {
		return nil, err
	}
	views := make([]*ExecutionView, 0, len(rows))
	for i := range rows {
		exec := rows[i]
		views = append(views, &ExecutionView{Execution: &exec, Artifacts: s.artifactViews(ctx, exec.ID)})
	}
	return views, nil
}

// artifactViews maps one execution's artifact rows into the public view. A repo
// error degrades to "no artifacts": the metadata listing must never fail just
// because artifact lookup did.
func (s *ExecutionService) artifactViews(ctx context.Context, executionID string) []ArtifactView {
	rows, err := s.artifacts.ListArtifactsByExecution(ctx, executionID)
	if err != nil {
		rows = nil
	}
	ttl := time.Duration(s.cfg.Artifacts.PresignTTLSeconds) * time.Second
	views := make([]ArtifactView, 0, len(rows))
	for _, a := range rows {
		url := ""
		if s.artifactStore != nil {
			if presigned, perr := s.artifactStore.Presign(ctx, a.ObjectKey, ttl); perr == nil {
				url = presigned
			}
		}
		views = append(views, ArtifactView{Name: a.Name, SizeBytes: a.SizeBytes, SHA256: a.SHA256, ContentType: a.ContentType, URL: url})
	}
	return views
}

// Events subscribes to the SSE stream of one execution (uid-scoped). The returned
// cancel func must always be called.
func (s *ExecutionService) Events(ctx context.Context, uid int64, id string) ([]Event, <-chan Event, func(), error) {
	exec, err := s.executions.GetExecution(ctx, id)
	if err != nil {
		return nil, nil, nil, ErrNotFound
	}
	if exec.UID != uid {
		return nil, nil, nil, ErrForbidden
	}
	history, ch, cancel := s.hub.Subscribe(id)
	return history, ch, cancel, nil
}

// Cancel cancels a queued/running execution (idempotent; uid-scoped).
func (s *ExecutionService) Cancel(ctx context.Context, uid int64, id, requestID string) error {
	exec, err := s.executions.GetExecution(ctx, id)
	if err != nil {
		return ErrNotFound
	}
	if exec.UID != uid {
		return ErrForbidden
	}
	if model.IsExecTerminal(exec.Status) {
		return nil
	}
	s.cancelInflight(id)
	ok, err := s.executions.Cancel(ctx, id, "canceled_by_user", s.now())
	if err != nil {
		return err
	}
	if ok {
		s.notifyCanceled(exec, requestID, "canceled_by_user", "user")
	}
	return nil
}

// CancelAdmin cancels any uid's queued/running execution on behalf of an
// administrator (internal admin API). Idempotent; the audit row records
// actor=admin and the admin request id.
func (s *ExecutionService) CancelAdmin(ctx context.Context, id, requestID string) error {
	exec, err := s.executions.GetExecution(ctx, id)
	if err != nil {
		return ErrNotFound
	}
	if model.IsExecTerminal(exec.Status) {
		return nil
	}
	s.cancelInflight(id)
	ok, err := s.executions.Cancel(ctx, id, "canceled_by_admin", s.now())
	if err != nil {
		return err
	}
	if ok {
		s.notifyCanceled(exec, requestID, "canceled_by_admin", "admin")
	}
	return nil
}

// CancelByLease cancels every active execution of a lease (used by the sweeper
// and by lease release). Returns the number of executions it actually canceled.
func (s *ExecutionService) CancelByLease(ctx context.Context, leaseID, reason, requestID string) int {
	rows, err := s.executions.ListExecutionsByLease(ctx, leaseID)
	if err != nil {
		return 0
	}
	canceled := 0
	for _, row := range rows {
		if s.CancelExecution(ctx, row.ID, reason, requestID) {
			canceled++
		}
	}
	return canceled
}

// CancelExecution cancels one execution by id without a uid check (sweeper /
// lease release path). Returns true when this call performed the transition.
func (s *ExecutionService) CancelExecution(ctx context.Context, id, errorCode, requestID string) bool {
	exec, err := s.executions.GetExecution(ctx, id)
	if err != nil || model.IsExecTerminal(exec.Status) {
		return false
	}
	s.cancelInflight(id)
	ok, err := s.executions.Cancel(ctx, id, errorCode, s.now())
	if err != nil || !ok {
		return false
	}
	s.notifyCanceled(exec, requestID, errorCode, "system")
	return true
}

func (s *ExecutionService) notifyCanceled(exec *model.SandboxExecution, requestID, errorCode, actor string) {
	exec.Status = model.ExecStatusCanceled
	exec.ErrorCode = errorCode
	s.metrics.Inc("sandbox_executions_total", map[string]string{"status": model.ExecStatusCanceled})
	s.auditExec(exec, CreateRequest{UID: exec.UID, ProjectID: exec.ProjectID, RequestID: requestID}, actor, model.AuditExecutionCancel, "canceled", errorCode, 0, nil)
	s.publishStatus(exec)
	s.publishDone(exec.ID, model.ExecStatusCanceled, errorCode)
}

// listTimedOut exposes the running-past-deadline rows to the sweeper.
func (s *ExecutionService) listTimedOut(ctx context.Context, now time.Time, limit int) ([]model.SandboxExecution, error) {
	return s.executions.ListTimedOut(ctx, now, limit)
}

// ActiveCount is the number of in-flight executions (metrics gauge).
func (s *ExecutionService) ActiveCount() int { return int(s.active.Load()) }

// Shutdown cancels every in-flight execution and waits for the workers (bounded
// by ctx). Called from main's graceful shutdown.
func (s *ExecutionService) Shutdown(ctx context.Context) {
	s.baseCancel()
	done := make(chan struct{})
	go func() {
		s.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-ctx.Done():
	}
}
