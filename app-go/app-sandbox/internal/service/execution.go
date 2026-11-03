package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"path"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"app-sandbox/internal/config"
	"app-sandbox/internal/metrics"
	"app-sandbox/internal/model"
	"app-sandbox/internal/repo"
	"app-sandbox/internal/runtime"

	"github.com/google/uuid"
)

// defaultExecTimeout applies when the caller omits timeoutMs.
const defaultExecTimeout = 120 * time.Second

// CreateRequest is the validated shape of POST /v1/executions.
type CreateRequest struct {
	UID            int64
	ProjectID      string
	Purpose        string
	Language       string
	Code           string
	Files          []runtime.File
	ArtifactGlobs  []string
	TimeoutMS      int
	RequestID      string
	IdempotencyKey string
}

// ArtifactView is one artifact in an execution response.
type ArtifactView struct {
	Name        string `json:"name"`
	SizeBytes   int64  `json:"size"`
	SHA256      string `json:"sha256"`
	ContentType string `json:"contentType,omitempty"`
	URL         string `json:"url,omitempty"`
}

// ExecutionView is the GET /v1/executions/{id} payload.
type ExecutionView struct {
	Execution *model.SandboxExecution
	Artifacts []ArtifactView
}

type idemEntry struct {
	executionID string
	expiresAt   time.Time
}

// ExecutionDeps carries the wired dependencies of the execution service.
type ExecutionDeps struct {
	Config        *config.Config
	Executions    repo.ExecutionRepo
	Artifacts     repo.ArtifactRepo
	Usage         repo.UsageRepo
	Audit         repo.AuditRepo
	Leases        *LeaseManager
	Quota         *QuotaService
	Admission     *Admission
	Runtime       runtime.Runtime
	ArtifactStore ArtifactStore
	Metrics       *metrics.Metrics
}

// ExecutionService owns the asynchronous execution lifecycle: admission ->
// queue row -> lease -> runtime exec -> artifacts -> terminal state, with SSE
// events, cancellation, timeouts and audit on every transition.
type ExecutionService struct {
	cfg           *config.Config
	executions    repo.ExecutionRepo
	artifacts     repo.ArtifactRepo
	usage         repo.UsageRepo
	audit         repo.AuditRepo
	leases        *LeaseManager
	quota         *QuotaService
	admission     *Admission
	rt            runtime.Runtime
	artifactStore ArtifactStore
	metrics       *metrics.Metrics
	hub           *eventHub
	now           func() time.Time
	tz            *time.Location

	baseCtx    context.Context
	baseCancel context.CancelFunc
	wg         sync.WaitGroup
	active     atomic.Int64

	mu       sync.Mutex
	inflight map[string]context.CancelFunc
	idem     map[string]idemEntry
}

// NewExecutionService wires the service.
func NewExecutionService(d ExecutionDeps) *ExecutionService {
	baseCtx, cancel := context.WithCancel(context.Background())
	tz := time.Local
	if loc, err := time.LoadLocation(d.Config.Timezone); err == nil {
		tz = loc
	}
	s := &ExecutionService{
		cfg:           d.Config,
		executions:    d.Executions,
		artifacts:     d.Artifacts,
		usage:         d.Usage,
		audit:         d.Audit,
		leases:        d.Leases,
		quota:         d.Quota,
		admission:     d.Admission,
		rt:            d.Runtime,
		artifactStore: d.ArtifactStore,
		metrics:       d.Metrics,
		hub:           newEventHub(),
		now:           time.Now,
		tz:            tz,
		baseCtx:       baseCtx,
		baseCancel:    cancel,
		inflight:      make(map[string]context.CancelFunc),
		idem:          make(map[string]idemEntry),
	}
	if s.metrics != nil {
		s.metrics.AddGauge("sandbox_executions_running", nil, func() int64 { return s.active.Load() })
	}
	return s
}

// Create validates the request, applies quota + admission, persists a queued
// execution row and starts the worker goroutine. It returns as soon as the row
// exists (202); results are fetched by polling or SSE.
func (s *ExecutionService) Create(ctx context.Context, req CreateRequest) (*model.SandboxExecution, error) {
	language := strings.ToLower(strings.TrimSpace(req.Language))
	if language != "python" && language != "javascript" {
		return nil, errValidation("language must be python or javascript")
	}
	if strings.TrimSpace(req.Code) == "" {
		return nil, errValidation("code is required")
	}
	if max := s.cfg.Execution.MaxCodeBytes; max > 0 && len(req.Code) > max {
		return nil, errValidation("code exceeds %d bytes", max)
	}
	// Caller-supplied paths/globs are untrusted: they are used for in-sandbox
	// file writes and (later) object-storage collection, so they must stay inside
	// the documented roots instead of escaping to arbitrary filesystem paths.
	if err := s.validateInputs(&req); err != nil {
		return nil, err
	}
	timeout := time.Duration(req.TimeoutMS) * time.Millisecond
	if timeout <= 0 {
		timeout = defaultExecTimeout
	}
	if max := s.cfg.MaxExecTimeout(); timeout > max {
		timeout = max
	}
	if timeout < time.Second {
		timeout = time.Second
	}
	if existing, ok := s.idempotent(ctx, req.UID, req.IdempotencyKey); ok {
		return existing, nil
	}
	if err := s.quota.CheckExecution(ctx, req.UID); err != nil {
		if s.metrics != nil {
			s.metrics.Inc("sandbox_quota_denied_total", map[string]string{"kind": quotaKindOf(err)})
		}
		return nil, err
	}
	release, err := s.admission.Acquire(ctx, req.UID)
	if err != nil {
		return nil, err
	}
	now := s.now()
	id := uuid.NewString()
	exec := &model.SandboxExecution{
		ID:             id,
		UID:            req.UID,
		ProjectID:      req.ProjectID,
		Purpose:        req.Purpose,
		Language:       language,
		CodeSHA256:     sha256Hex(req.Code),
		Status:         model.ExecStatusQueued,
		TimeoutMS:      int(timeout.Milliseconds()),
		ArtifactPrefix: fmt.Sprintf("sandbox-artifacts/%d/%s", req.UID, id),
		CreatedAt:      now,
	}
	if err := s.executions.CreateExecution(ctx, exec); err != nil {
		release()
		return nil, err
	}
	s.incrementUsage(ctx, exec.UID, now, repo.UsageDelta{Executions: 1})
	s.auditExec(exec, req, "agent", model.AuditExecutionCreate, "queued", "", 0, nil)
	s.metrics.Inc("sandbox_executions_total", map[string]string{"status": model.ExecStatusQueued})
	s.rememberIdempotent(req.UID, req.IdempotencyKey, exec.ID)

	s.wg.Add(1)
	s.active.Add(1)
	go s.run(exec, req, timeout, release)
	return exec, nil
}

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
	rows, err := s.artifacts.ListArtifactsByExecution(ctx, id)
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
	return &ExecutionView{Execution: exec, Artifacts: views}, nil
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

// ── publishing ───────────────────────────────────────────────────────

func (s *ExecutionService) publishStatus(exec *model.SandboxExecution) {
	s.hub.Publish(exec.ID, Event{Type: "status", Data: executionEventData(exec)})
}

func (s *ExecutionService) publishStream(executionID, stdout, stderr string, preview int) {
	if stdout != "" {
		s.hub.Publish(executionID, Event{Type: "stdout", Data: map[string]any{
			"executionId": executionID,
			"preview":     truncateText(stdout, preview),
			"bytes":       len(stdout),
		}})
	}
	if stderr != "" {
		s.hub.Publish(executionID, Event{Type: "stderr", Data: map[string]any{
			"executionId": executionID,
			"preview":     truncateText(stderr, preview),
			"bytes":       len(stderr),
		}})
	}
}

func (s *ExecutionService) publishArtifacts(executionID string, rows []model.SandboxArtifact) {
	ttl := time.Duration(s.cfg.Artifacts.PresignTTLSeconds) * time.Second
	for _, row := range rows {
		url := ""
		if s.artifactStore != nil {
			presignCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			presigned, err := s.artifactStore.Presign(presignCtx, row.ObjectKey, ttl)
			cancel()
			if err == nil {
				url = presigned
			}
		}
		s.hub.Publish(executionID, Event{Type: "artifact", Data: map[string]any{
			"executionId": executionID,
			"name":        row.Name,
			"size":        row.SizeBytes,
			"sha256":      row.SHA256,
			"contentType": row.ContentType,
			"url":         url,
		}})
	}
}

func (s *ExecutionService) publishDone(executionID, status, errorCode string) {
	s.hub.Publish(executionID, Event{Type: "done", Data: map[string]any{
		"executionId": executionID,
		"status":      status,
		"errorCode":   errorCode,
	}})
	s.hub.Close(executionID)
}

func executionEventData(exec *model.SandboxExecution) map[string]any {
	data := map[string]any{
		"executionId": exec.ID,
		"status":      exec.Status,
		"leaseId":     exec.LeaseID,
		"language":    exec.Language,
		"timeoutMs":   exec.TimeoutMS,
		"errorCode":   exec.ErrorCode,
	}
	if exec.ExitCode != nil {
		data["exitCode"] = *exec.ExitCode
	}
	if exec.StartedAt != nil {
		data["startedAt"] = *exec.StartedAt
	}
	if exec.FinishedAt != nil {
		data["finishedAt"] = *exec.FinishedAt
	}
	return data
}

// validateInputs normalizes file paths and restricts artifact globs to the
// configured output roots. Rejects escaping paths, oversized inputs and globs
// that could collect arbitrary sandbox files.
func (s *ExecutionService) validateInputs(req *CreateRequest) error {
	if strings.TrimSpace(req.ProjectID) != "" && len(req.ProjectID) > 64 {
		return errValidation("projectId exceeds 64 characters")
	}
	if strings.TrimSpace(req.Purpose) != "" && len(req.Purpose) > 32 {
		return errValidation("purpose exceeds 32 characters")
	}
	if len(req.Files) > 20 {
		return errValidation("at most 20 input files are allowed")
	}
	for i := range req.Files {
		clean, err := sanitizeSandboxPath(req.Files[i].Path)
		if err != nil {
			return err
		}
		req.Files[i].Path = clean
		if len(req.Files[i].Content) > 1<<20 {
			return errValidation("input file %q exceeds 1MB", clean)
		}
	}
	roots := s.artifactRoots()
	if len(req.ArtifactGlobs) > 10 {
		return errValidation("at most 10 artifact globs are allowed")
	}
	for _, pattern := range req.ArtifactGlobs {
		clean := path.Clean(strings.TrimSpace(pattern))
		if clean == "." || !strings.HasPrefix(clean, "/") || strings.Contains(clean, "..") {
			return errValidation("artifact glob %q must be an absolute path inside the output root", pattern)
		}
		allowed := false
		for _, root := range roots {
			if clean == root || strings.HasPrefix(clean, root+"/") {
				allowed = true
				break
			}
		}
		if !allowed {
			return errValidation("artifact glob %q is outside the allowed output root", pattern)
		}
	}
	return nil
}

// artifactRoots derives the allowed collection roots from the configured
// default globs (e.g. /workspace/analysis/outputs/** -> /workspace/analysis/outputs).
func (s *ExecutionService) artifactRoots() []string {
	roots := make([]string, 0, len(s.cfg.Artifacts.DefaultGlobs))
	for _, pattern := range s.cfg.Artifacts.DefaultGlobs {
		root := strings.TrimSpace(pattern)
		root = strings.TrimSuffix(root, "/**")
		root = strings.TrimSuffix(root, "/*")
		root = strings.TrimSuffix(root, "/")
		if root != "" {
			roots = append(roots, path.Clean(root))
		}
	}
	if len(roots) == 0 {
		roots = append(roots, "/workspace/analysis/outputs")
	}
	return roots
}

// sanitizeSandboxPath keeps in-sandbox writes inside /workspace or /tmp/osb-*.
func sanitizeSandboxPath(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || strings.ContainsAny(trimmed, "\x00\n\r") {
		return "", errValidation("input file path is empty or contains control characters")
	}
	if !strings.HasPrefix(trimmed, "/") {
		trimmed = "/workspace/" + trimmed
	}
	clean := path.Clean(trimmed)
	if clean == "/" || strings.Contains(clean, "..") || !strings.HasPrefix(clean, "/") {
		return "", errValidation("input file path %q escapes the sandbox workspace", raw)
	}
	allowed := strings.HasPrefix(clean, "/workspace/") || strings.HasPrefix(clean, "/tmp/osb-")
	if !allowed {
		return "", errValidation("input file path %q must live under /workspace or /tmp/osb-*", raw)
	}
	return clean, nil
}

// ── helpers ──────────────────────────────────────────────────────────

func (s *ExecutionService) registerInflight(id string, cancel context.CancelFunc) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.inflight[id] = cancel
}

func (s *ExecutionService) unregisterInflight(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.inflight, id)
}

func (s *ExecutionService) cancelInflight(id string) {
	s.mu.Lock()
	cancel := s.inflight[id]
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (s *ExecutionService) incrementUsage(ctx context.Context, uid int64, at time.Time, delta repo.UsageDelta) {
	if s.usage == nil {
		return
	}
	bg, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if err := s.usage.IncrementUsage(bg, uid, s.day(at), delta); err != nil {
		slog.Warn("[EXEC] usage increment failed", "uid", uid, "err", err)
	}
}

func (s *ExecutionService) day(at time.Time) string {
	if s.quota != nil {
		return s.quota.Day(at)
	}
	return at.In(s.tz).Format("2006-01-02")
}

func (s *ExecutionService) auditExec(exec *model.SandboxExecution, req CreateRequest, actor, action, outcome, detail string, durationMS int64, exitCode *int) {
	if s.audit == nil {
		return
	}
	row := &model.SandboxAudit{
		ID:          uuid.NewString(),
		UID:         exec.UID,
		Action:      action,
		ExecutionID: exec.ID,
		LeaseID:     exec.LeaseID,
		ProjectID:   exec.ProjectID,
		Image:       s.cfg.Runtime.Image,
		Outcome:     outcome,
		DurationMS:  durationMS,
		ExitCode:    exitCode,
		Detail:      truncateText(detail, 512),
		RequestID:   req.RequestID,
		Actor:       actor,
		CreatedAt:   s.now(),
	}
	bg, cancel := context.WithTimeout(context.WithoutCancel(s.baseCtx), 5*time.Second)
	defer cancel()
	if err := s.audit.InsertAudit(bg, row); err != nil {
		slog.Warn("[EXEC] audit insert failed", "execution", exec.ID, "err", err)
	}
}

func (s *ExecutionService) idempotent(ctx context.Context, uid int64, key string) (*model.SandboxExecution, bool) {
	key = strings.TrimSpace(key)
	if key == "" {
		return nil, false
	}
	now := s.now()
	idemKey := fmt.Sprintf("%d|%s", uid, key)
	s.mu.Lock()
	entry, ok := s.idem[idemKey]
	if ok && !now.Before(entry.expiresAt) {
		delete(s.idem, idemKey)
		ok = false
	}
	s.mu.Unlock()
	if !ok {
		return nil, false
	}
	exec, err := s.executions.GetExecution(ctx, entry.executionID)
	if err != nil {
		return nil, false
	}
	return exec, true
}

func (s *ExecutionService) rememberIdempotent(uid int64, key, executionID string) {
	key = strings.TrimSpace(key)
	if key == "" {
		return
	}
	ttl := time.Duration(s.cfg.Execution.IdempotencyTTLSeconds) * time.Second
	if ttl <= 0 {
		ttl = 5 * time.Minute
	}
	now := s.now()
	idemKey := fmt.Sprintf("%d|%s", uid, key)
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.idem) > 10000 {
		for k, v := range s.idem {
			if !now.Before(v.expiresAt) {
				delete(s.idem, k)
			}
		}
	}
	s.idem[idemKey] = idemEntry{executionID: executionID, expiresAt: now.Add(ttl)}
}

func sha256Hex(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

// truncateText cuts a string to at most n bytes on a UTF-8 boundary.
func truncateText(text string, n int) string {
	if n <= 0 || len(text) <= n {
		return text
	}
	cut := n
	for cut > 0 && (text[cut]&0xC0) == 0x80 {
		cut--
	}
	return text[:cut]
}
