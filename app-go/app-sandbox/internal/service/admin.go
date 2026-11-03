package service

import (
	"context"
	"time"

	"app-sandbox/internal/config"
	"app-sandbox/internal/model"
	"app-sandbox/internal/repo"
)

// Admin API views. These structs are the wire contract with
// app-admin: fields may be added but never renamed or removed, and no view ever
// carries a code body (the store only keeps code_sha256 + truncated previews).

// AdminPage is the shared pagination envelope.
type AdminPage[T any] struct {
	Items    []T   `json:"items"`
	Total    int64 `json:"total"`
	Page     int   `json:"page"`
	PageSize int   `json:"pageSize"`
}

// ExecutionAdminView is one row of GET /internal/admin/executions. It carries the
// truncated previews only — never the source code.
type ExecutionAdminView struct {
	ID            string     `json:"id"`
	UID           int64      `json:"uid"`
	ProjectID     string     `json:"projectId"`
	Language      string     `json:"language"`
	Status        string     `json:"status"`
	ExitCode      *int       `json:"exitCode,omitempty"`
	DurationMS    int64      `json:"durationMs"`
	LeaseID       string     `json:"leaseId"`
	ErrorCode     string     `json:"errorCode"`
	CreatedAt     time.Time  `json:"createdAt"`
	StartedAt     *time.Time `json:"startedAt,omitempty"`
	FinishedAt    *time.Time `json:"finishedAt,omitempty"`
	ArtifactCount int64      `json:"artifactCount"`
	ArtifactBytes int64      `json:"artifactBytes"`
	StdoutPreview string     `json:"stdoutPreview"`
	StderrPreview string     `json:"stderrPreview"`
}

// ArtifactAdminView is artifact metadata (no object bytes, no download URL).
type ArtifactAdminView struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	SizeBytes   int64     `json:"sizeBytes"`
	SHA256      string    `json:"sha256"`
	ContentType string    `json:"contentType"`
	ObjectKey   string    `json:"objectKey"`
	CreatedAt   time.Time `json:"createdAt"`
}

// ExecutionDetailView is GET /internal/admin/executions/:id: the row view plus
// artifact metadata and the execution's audit trail.
type ExecutionDetailView struct {
	ExecutionAdminView
	Artifacts []ArtifactAdminView `json:"artifacts"`
	Audit     []AuditAdminView    `json:"audit"`
}

// LeaseAdminView is one row of GET /internal/admin/leases.
type LeaseAdminView struct {
	ID         string    `json:"id"`
	UID        int64     `json:"uid"`
	ProjectID  string    `json:"projectId"`
	Purpose    string    `json:"purpose"`
	State      string    `json:"state"`
	Runtime    string    `json:"runtime"`
	RuntimeID  string    `json:"runtimeId"`
	CreatedAt  time.Time `json:"createdAt"`
	ExpiresAt  time.Time `json:"expiresAt"`
	LastUsedAt time.Time `json:"lastUsedAt"`
}

// AuditAdminView is one row of GET /internal/admin/audit.
type AuditAdminView struct {
	ID          string    `json:"id"`
	UID         int64     `json:"uid"`
	Action      string    `json:"action"`
	Actor       string    `json:"actor"`
	ExecutionID string    `json:"executionId"`
	LeaseID     string    `json:"leaseId"`
	ProjectID   string    `json:"projectId"`
	Image       string    `json:"image"`
	Outcome     string    `json:"outcome"`
	DurationMS  int64     `json:"durationMs"`
	ExitCode    *int      `json:"exitCode,omitempty"`
	Detail      string    `json:"detail"`
	RequestID   string    `json:"requestId"`
	CreatedAt   time.Time `json:"createdAt"`
}

// QuotaView is GET /internal/admin/quota: today's ledger row plus the resolved
// tier and that tier's limits for all four quota kinds.
type QuotaView struct {
	UID           int64            `json:"uid"`
	Day           string           `json:"day"`
	Executions    int64            `json:"executions"`
	CPUMillis     int64            `json:"cpuMillis"`
	ArtifactBytes int64            `json:"artifactBytes"`
	Tier          string           `json:"tier"`
	Limits        map[string]int64 `json:"limits"`
}

// LeaseStateCounts / ExecutionStatusCounts / Last24hCounts / OverviewView feed
// GET /internal/admin/overview.
type LeaseStateCounts struct {
	Creating   int64 `json:"creating"`
	Ready      int64 `json:"ready"`
	Busy       int64 `json:"busy"`
	Idle       int64 `json:"idle"`
	Releasing  int64 `json:"releasing"`
	Terminated int64 `json:"terminated"`
	Failed     int64 `json:"failed"`
	Total      int64 `json:"total"`
}

type ExecutionStatusCounts struct {
	Queued    int64 `json:"queued"`
	Running   int64 `json:"running"`
	Succeeded int64 `json:"succeeded"`
	Failed    int64 `json:"failed"`
	TimedOut  int64 `json:"timed_out"`
	Canceled  int64 `json:"canceled"`
	Total     int64 `json:"total"`
}

type Last24hCounts struct {
	Executions int64 `json:"executions"`
	Failures   int64 `json:"failures"`
}

type OverviewView struct {
	Leases       LeaseStateCounts      `json:"leases"`
	Executions   ExecutionStatusCounts `json:"executions"`
	Last24H      Last24hCounts         `json:"last24h"`
	QuotaEnabled bool                  `json:"quotaEnabled"`
}

// AdminResourcesView / AdminAdmissionView / AdminRuntimeConfigView feed
// GET /internal/admin/config (read-only display; no secrets).
type AdminResourcesView struct {
	CPU    string `json:"cpu"`
	Memory string `json:"memory"`
}

type AdminAdmissionView struct {
	MaxConcurrent  int `json:"maxConcurrent"`
	MaxPerUID      int `json:"maxPerUid"`
	QueueSize      int `json:"queueSize"`
	QueueTimeoutMS int `json:"queueTimeoutMs"`
}

type AdminRuntimeConfigView struct {
	Runtime         string             `json:"runtime"`
	Image           string             `json:"image"`
	Resources       AdminResourcesView `json:"resources"`
	LeaseTTLSeconds int                `json:"leaseTtlSeconds"`
	Admission       AdminAdmissionView `json:"admission"`
	QuotaEnabled    bool               `json:"quotaEnabled"`
}

// AdminDeps carries the repositories/services the admin API reads and the two
// write paths it delegates to.
type AdminDeps struct {
	Config       *config.Config
	Leases       repo.LeaseRepo
	Executions   repo.ExecutionRepo
	Artifacts    repo.ArtifactRepo
	Usage        repo.UsageRepo
	Audit        repo.AuditRepo
	Queries      repo.AdminQueries
	ExecService  *ExecutionService
	LeaseManager *LeaseManager
	Quota        *QuotaService
	Now          func() time.Time
}

// AdminService serves the internal admin API: read-only queries over the
// sandbox_* tables plus cancel/release, which delegate to the live services so
// runtime state and audit stay consistent with the agent paths.
type AdminService struct {
	cfg       *config.Config
	leases    repo.LeaseRepo
	execs     repo.ExecutionRepo
	artifacts repo.ArtifactRepo
	usage     repo.UsageRepo
	audit     repo.AuditRepo
	queries   repo.AdminQueries
	execSvc   *ExecutionService
	leaseMgr  *LeaseManager
	quota     *QuotaService
	now       func() time.Time
}

// NewAdminService wires the admin service.
func NewAdminService(d AdminDeps) *AdminService {
	now := d.Now
	if now == nil {
		now = time.Now
	}
	return &AdminService{
		cfg:       d.Config,
		leases:    d.Leases,
		execs:     d.Executions,
		artifacts: d.Artifacts,
		usage:     d.Usage,
		audit:     d.Audit,
		queries:   d.Queries,
		execSvc:   d.ExecService,
		leaseMgr:  d.LeaseManager,
		quota:     d.Quota,
		now:       now,
	}
}

// Overview aggregates state counts, the last-24h execution/failure counters and
// the quota switch.
func (s *AdminService) Overview(ctx context.Context) (OverviewView, error) {
	leaseCounts, err := s.queries.CountLeasesByState(ctx)
	if err != nil {
		return OverviewView{}, err
	}
	execCounts, err := s.queries.CountExecutionsByStatus(ctx)
	if err != nil {
		return OverviewView{}, err
	}
	total24h, failures, err := s.queries.CountExecutionsSince(ctx, s.now().Add(-24*time.Hour))
	if err != nil {
		return OverviewView{}, err
	}
	leases := LeaseStateCounts{
		Creating:   leaseCounts[model.LeaseStateCreating],
		Ready:      leaseCounts[model.LeaseStateReady],
		Busy:       leaseCounts[model.LeaseStateBusy],
		Idle:       leaseCounts[model.LeaseStateIdle],
		Releasing:  leaseCounts[model.LeaseStateReleasing],
		Terminated: leaseCounts[model.LeaseStateTerminated],
		Failed:     leaseCounts[model.LeaseStateFailed],
	}
	for _, n := range leaseCounts {
		leases.Total += n
	}
	executions := ExecutionStatusCounts{
		Queued:    execCounts[model.ExecStatusQueued],
		Running:   execCounts[model.ExecStatusRunning],
		Succeeded: execCounts[model.ExecStatusSucceeded],
		Failed:    execCounts[model.ExecStatusFailed],
		TimedOut:  execCounts[model.ExecStatusTimeout],
		Canceled:  execCounts[model.ExecStatusCanceled],
	}
	for _, n := range execCounts {
		executions.Total += n
	}
	return OverviewView{
		Leases:       leases,
		Executions:   executions,
		Last24H:      Last24hCounts{Executions: total24h, Failures: failures},
		QuotaEnabled: s.cfg.Quota.Enabled,
	}, nil
}

// Executions returns one page of executions with artifact aggregates.
func (s *AdminService) Executions(ctx context.Context, filter repo.ExecutionFilter) (AdminPage[ExecutionAdminView], error) {
	page, pageSize := repo.NormalizePagination(filter.Page, filter.PageSize)
	filter.Page, filter.PageSize = page, pageSize
	rows, total, err := s.queries.ListExecutionsFiltered(ctx, filter)
	if err != nil {
		return AdminPage[ExecutionAdminView]{}, err
	}
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
	}
	stats, err := s.queries.StatsByExecutionIDs(ctx, ids)
	if err != nil {
		return AdminPage[ExecutionAdminView]{}, err
	}
	now := s.now()
	items := make([]ExecutionAdminView, 0, len(rows))
	for _, row := range rows {
		items = append(items, s.executionView(&row, stats[row.ID], now))
	}
	return AdminPage[ExecutionAdminView]{Items: items, Total: total, Page: page, PageSize: pageSize}, nil
}

// ExecutionDetail returns the execution row plus artifact metadata and audit.
func (s *AdminService) ExecutionDetail(ctx context.Context, id string) (*ExecutionDetailView, error) {
	row, err := s.execs.GetExecution(ctx, id)
	if err != nil {
		return nil, ErrNotFound
	}
	stat, err := s.queries.StatsByExecutionIDs(ctx, []string{id})
	if err != nil {
		return nil, err
	}
	view := &ExecutionDetailView{
		ExecutionAdminView: s.executionView(row, stat[id], s.now()),
		Artifacts:          []ArtifactAdminView{},
		Audit:              []AuditAdminView{},
	}
	artifactRows, err := s.artifacts.ListArtifactsByExecution(ctx, id)
	if err != nil {
		return nil, err
	}
	for _, a := range artifactRows {
		view.Artifacts = append(view.Artifacts, ArtifactAdminView{
			ID: a.ID, Name: a.Name, SizeBytes: a.SizeBytes, SHA256: a.SHA256,
			ContentType: a.ContentType, ObjectKey: a.ObjectKey, CreatedAt: a.CreatedAt,
		})
	}
	auditRows, err := s.audit.ListAuditByExecution(ctx, id)
	if err != nil {
		return nil, err
	}
	for i := range auditRows {
		view.Audit = append(view.Audit, auditView(&auditRows[i]))
	}
	return view, nil
}

// CancelExecution cancels any uid's queued/running execution (admin action,
// audit actor=admin). Idempotent for terminal executions.
func (s *AdminService) CancelExecution(ctx context.Context, id, requestID string) error {
	return s.execSvc.CancelAdmin(ctx, id, requestID)
}

// Leases returns one page of leases.
func (s *AdminService) Leases(ctx context.Context, filter repo.LeaseFilter) (AdminPage[LeaseAdminView], error) {
	page, pageSize := repo.NormalizePagination(filter.Page, filter.PageSize)
	filter.Page, filter.PageSize = page, pageSize
	rows, total, err := s.queries.ListLeasesFiltered(ctx, filter)
	if err != nil {
		return AdminPage[LeaseAdminView]{}, err
	}
	items := make([]LeaseAdminView, 0, len(rows))
	for _, row := range rows {
		items = append(items, LeaseAdminView{
			ID: row.ID, UID: row.UID, ProjectID: row.ProjectID, Purpose: row.Purpose,
			State: row.State, Runtime: row.Runtime, RuntimeID: row.RuntimeID,
			CreatedAt: row.CreatedAt, ExpiresAt: row.ExpiresAt, LastUsedAt: row.LastUsedAt,
		})
	}
	return AdminPage[LeaseAdminView]{Items: items, Total: total, Page: page, PageSize: pageSize}, nil
}

// ReleaseLease force-reclaims a lease (cancel in-flight executions + runtime
// delete). A runtime delete failure leaves the lease releasing for the sweeper.
func (s *AdminService) ReleaseLease(ctx context.Context, id, requestID string) error {
	if _, err := s.leaseMgr.ReleaseByAdmin(ctx, id, requestID); err != nil {
		if err == repo.ErrNotFound {
			return ErrNotFound
		}
		return err
	}
	return nil
}

// Quota returns one uid's usage for a day plus the resolved tier and limits.
func (s *AdminService) Quota(ctx context.Context, uid int64, day string) (*QuotaView, error) {
	if uid <= 0 {
		return nil, errValidation("uid is required")
	}
	if day == "" {
		day = s.quota.Day(s.now())
	} else if _, err := time.Parse("2006-01-02", day); err != nil {
		return nil, errValidation("day must be YYYY-MM-DD")
	}
	usage, err := s.usage.GetUsage(ctx, uid, day)
	if err != nil {
		return nil, err
	}
	tier := s.quota.TierFor(ctx, uid)
	limits := make(map[string]int64, 4)
	for _, kind := range config.QuotaKinds {
		limits[kind] = s.quota.Limit(kind, tier)
	}
	return &QuotaView{
		UID: uid, Day: day, Executions: usage.Executions, CPUMillis: usage.CPUMillis,
		ArtifactBytes: usage.ArtifactBytes, Tier: string(tier), Limits: limits,
	}, nil
}

// Audit returns one page of the audit trail.
func (s *AdminService) Audit(ctx context.Context, filter repo.AuditFilter) (AdminPage[AuditAdminView], error) {
	page, pageSize := repo.NormalizePagination(filter.Page, filter.PageSize)
	filter.Page, filter.PageSize = page, pageSize
	rows, total, err := s.queries.ListAuditFiltered(ctx, filter)
	if err != nil {
		return AdminPage[AuditAdminView]{}, err
	}
	items := make([]AuditAdminView, 0, len(rows))
	for i := range rows {
		items = append(items, auditView(&rows[i]))
	}
	return AdminPage[AuditAdminView]{Items: items, Total: total, Page: page, PageSize: pageSize}, nil
}

// RuntimeConfig is the read-only configuration display (never includes secrets).
func (s *AdminService) RuntimeConfig() AdminRuntimeConfigView {
	return AdminRuntimeConfigView{
		Runtime:         s.cfg.Runtime.Type,
		Image:           s.cfg.Runtime.Image,
		Resources:       AdminResourcesView{CPU: s.cfg.Runtime.Resources.CPU, Memory: s.cfg.Runtime.Resources.Memory},
		LeaseTTLSeconds: s.cfg.Lease.TTLSeconds,
		Admission: AdminAdmissionView{
			MaxConcurrent:  s.cfg.Admission.MaxConcurrent,
			MaxPerUID:      s.cfg.Admission.MaxPerUID,
			QueueSize:      s.cfg.Admission.QueueSize,
			QueueTimeoutMS: s.cfg.Admission.QueueTimeoutMS,
		},
		QuotaEnabled: s.cfg.Quota.Enabled,
	}
}

// executionView builds the list/detail row view (no code body, previews only).
func (s *AdminService) executionView(row *model.SandboxExecution, stat repo.ArtifactStat, now time.Time) ExecutionAdminView {
	return ExecutionAdminView{
		ID:            row.ID,
		UID:           row.UID,
		ProjectID:     row.ProjectID,
		Language:      row.Language,
		Status:        row.Status,
		ExitCode:      row.ExitCode,
		DurationMS:    durationMS(row, now),
		LeaseID:       row.LeaseID,
		ErrorCode:     row.ErrorCode,
		CreatedAt:     row.CreatedAt,
		StartedAt:     row.StartedAt,
		FinishedAt:    row.FinishedAt,
		ArtifactCount: stat.Count,
		ArtifactBytes: stat.Bytes,
		StdoutPreview: row.StdoutPreview,
		StderrPreview: row.StderrPreview,
	}
}

func durationMS(row *model.SandboxExecution, now time.Time) int64 {
	if row.StartedAt == nil {
		return 0
	}
	end := now
	if row.FinishedAt != nil {
		end = *row.FinishedAt
	}
	if end.Before(*row.StartedAt) {
		return 0
	}
	return end.Sub(*row.StartedAt).Milliseconds()
}

func auditView(row *model.SandboxAudit) AuditAdminView {
	return AuditAdminView{
		ID: row.ID, UID: row.UID, Action: row.Action, Actor: row.Actor,
		ExecutionID: row.ExecutionID, LeaseID: row.LeaseID, ProjectID: row.ProjectID,
		Image: row.Image, Outcome: row.Outcome, DurationMS: row.DurationMS,
		ExitCode: row.ExitCode, Detail: row.Detail, RequestID: row.RequestID,
		CreatedAt: row.CreatedAt,
	}
}
