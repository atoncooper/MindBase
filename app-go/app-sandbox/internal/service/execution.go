package service

import (
	"context"
	"fmt"
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
	switch language {
	case "python", "javascript", "bash", "sh", "pwsh":
		// ok
	default:
		return nil, errValidation("language must be python, javascript, bash, sh or pwsh")
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
