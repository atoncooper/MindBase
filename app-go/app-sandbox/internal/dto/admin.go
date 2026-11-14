package dto

import (
	"time"

	"app-sandbox/internal/config"
	"app-sandbox/internal/model"
	"app-sandbox/internal/repo"
	"app-sandbox/internal/service"
)

// The internal admin API (/internal/admin/*) talks to app-admin. These structs
// are the wire contract: fields may be added but never renamed or removed, and
// no view ever carries a code body (the store keeps code_sha256 + truncated
// previews only).

// AdminPage is the shared pagination envelope.
type AdminPage[T any] struct {
	Items    []T   `json:"items"`
	Total    int64 `json:"total"`
	Page     int   `json:"page"`
	PageSize int   `json:"pageSize"`
}

// NewAdminPage wraps one already-normalized page.
func NewAdminPage[T any](items []T, total int64, page, pageSize int) AdminPage[T] {
	return AdminPage[T]{Items: items, Total: total, Page: page, PageSize: pageSize}
}

// ExecutionAdminView is one row of GET /internal/admin/executions. It carries
// the truncated previews only — never the source code.
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

// ExecutionStatusCounts counts executions per status.
type ExecutionStatusCounts struct {
	Queued    int64 `json:"queued"`
	Running   int64 `json:"running"`
	Succeeded int64 `json:"succeeded"`
	Failed    int64 `json:"failed"`
	TimedOut  int64 `json:"timed_out"`
	Canceled  int64 `json:"canceled"`
	Total     int64 `json:"total"`
}

// Last24hCounts is the rolling 24h execution/failure counter.
type Last24hCounts struct {
	Executions int64 `json:"executions"`
	Failures   int64 `json:"failures"`
}

// OverviewView is GET /internal/admin/overview.
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

// AdminAdmissionView is the admission-control configuration display.
type AdminAdmissionView struct {
	MaxConcurrent  int `json:"maxConcurrent"`
	MaxPerUID      int `json:"maxPerUid"`
	QueueSize      int `json:"queueSize"`
	QueueTimeoutMS int `json:"queueTimeoutMs"`
}

// AdminRuntimeConfigView is GET /internal/admin/config.
type AdminRuntimeConfigView struct {
	Runtime         string             `json:"runtime"`
	Image           string             `json:"image"`
	Resources       AdminResourcesView `json:"resources"`
	LeaseTTLSeconds int                `json:"leaseTtlSeconds"`
	Admission       AdminAdmissionView `json:"admission"`
	QuotaEnabled    bool               `json:"quotaEnabled"`
}

// NewExecutionAdminView builds the list/detail row view (no code body).
func NewExecutionAdminView(row *model.SandboxExecution, stat repo.ArtifactStat, now time.Time) ExecutionAdminView {
	return ExecutionAdminView{
		ID:            row.ID,
		UID:           row.UID,
		ProjectID:     row.ProjectID,
		Language:      row.Language,
		Status:        row.Status,
		ExitCode:      row.ExitCode,
		DurationMS:    executionDurationMS(row, now),
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

// NewExecutionAdminPage maps one repo page (items is always an array).
func NewExecutionAdminPage(page service.ExecutionAdminPage, now time.Time) AdminPage[ExecutionAdminView] {
	items := make([]ExecutionAdminView, 0, len(page.Rows))
	for i := range page.Rows {
		row := page.Rows[i]
		items = append(items, NewExecutionAdminView(&row, page.Stats[row.ID], now))
	}
	return NewAdminPage(items, page.Total, page.Page, page.PageSize)
}

// NewExecutionDetailView maps one execution plus artifact metadata and audit.
func NewExecutionDetailView(detail *service.ExecutionAdminDetail, now time.Time) *ExecutionDetailView {
	view := &ExecutionDetailView{
		ExecutionAdminView: NewExecutionAdminView(detail.Row, detail.Stat, now),
		Artifacts:          make([]ArtifactAdminView, 0, len(detail.Artifacts)),
		Audit:              make([]AuditAdminView, 0, len(detail.Audit)),
	}
	for _, a := range detail.Artifacts {
		view.Artifacts = append(view.Artifacts, ArtifactAdminView{
			ID: a.ID, Name: a.Name, SizeBytes: a.SizeBytes, SHA256: a.SHA256,
			ContentType: a.ContentType, ObjectKey: a.ObjectKey, CreatedAt: a.CreatedAt,
		})
	}
	for i := range detail.Audit {
		view.Audit = append(view.Audit, NewAuditAdminView(detail.Audit[i]))
	}
	return view
}

// NewLeaseAdminView maps one admin lease row.
func NewLeaseAdminView(row model.SandboxLease) LeaseAdminView {
	return LeaseAdminView{
		ID: row.ID, UID: row.UID, ProjectID: row.ProjectID, Purpose: row.Purpose,
		State: row.State, Runtime: row.Runtime, RuntimeID: row.RuntimeID,
		CreatedAt: row.CreatedAt, ExpiresAt: row.ExpiresAt, LastUsedAt: row.LastUsedAt,
	}
}

// NewLeaseAdminPage maps one repo page (items is always an array).
func NewLeaseAdminPage(page service.LeaseAdminPage) AdminPage[LeaseAdminView] {
	items := make([]LeaseAdminView, 0, len(page.Rows))
	for _, row := range page.Rows {
		items = append(items, NewLeaseAdminView(row))
	}
	return NewAdminPage(items, page.Total, page.Page, page.PageSize)
}

// NewAuditAdminView maps one audit row.
func NewAuditAdminView(row model.SandboxAudit) AuditAdminView {
	return AuditAdminView{
		ID: row.ID, UID: row.UID, Action: row.Action, Actor: row.Actor,
		ExecutionID: row.ExecutionID, LeaseID: row.LeaseID, ProjectID: row.ProjectID,
		Image: row.Image, Outcome: row.Outcome, DurationMS: row.DurationMS,
		ExitCode: row.ExitCode, Detail: row.Detail, RequestID: row.RequestID,
		CreatedAt: row.CreatedAt,
	}
}

// NewAuditAdminPage maps one repo page (items is always an array).
func NewAuditAdminPage(page service.AuditAdminPage) AdminPage[AuditAdminView] {
	items := make([]AuditAdminView, 0, len(page.Rows))
	for _, row := range page.Rows {
		items = append(items, NewAuditAdminView(row))
	}
	return NewAdminPage(items, page.Total, page.Page, page.PageSize)
}

// NewOverviewView aggregates the state counts, the last-24h counters and the
// quota switch.
func NewOverviewView(counts service.OverviewCounts, quotaEnabled bool) OverviewView {
	leases := LeaseStateCounts{
		Creating:   counts.LeaseCounts[model.LeaseStateCreating],
		Ready:      counts.LeaseCounts[model.LeaseStateReady],
		Busy:       counts.LeaseCounts[model.LeaseStateBusy],
		Idle:       counts.LeaseCounts[model.LeaseStateIdle],
		Releasing:  counts.LeaseCounts[model.LeaseStateReleasing],
		Terminated: counts.LeaseCounts[model.LeaseStateTerminated],
		Failed:     counts.LeaseCounts[model.LeaseStateFailed],
	}
	for _, n := range counts.LeaseCounts {
		leases.Total += n
	}
	executions := ExecutionStatusCounts{
		Queued:    counts.ExecCounts[model.ExecStatusQueued],
		Running:   counts.ExecCounts[model.ExecStatusRunning],
		Succeeded: counts.ExecCounts[model.ExecStatusSucceeded],
		Failed:    counts.ExecCounts[model.ExecStatusFailed],
		TimedOut:  counts.ExecCounts[model.ExecStatusTimeout],
		Canceled:  counts.ExecCounts[model.ExecStatusCanceled],
	}
	for _, n := range counts.ExecCounts {
		executions.Total += n
	}
	return OverviewView{
		Leases:       leases,
		Executions:   executions,
		Last24H:      Last24hCounts{Executions: counts.Total24h, Failures: counts.Failures},
		QuotaEnabled: quotaEnabled,
	}
}

// NewQuotaView maps the admin quota snapshot.
func NewQuotaView(snap *service.QuotaAdminSnapshot) *QuotaView {
	limits := make(map[string]int64, len(snap.Limits))
	for kind, limit := range snap.Limits {
		limits[kind] = limit
	}
	return &QuotaView{
		UID: snap.UID, Day: snap.Day, Executions: snap.Executions, CPUMillis: snap.CPUMillis,
		ArtifactBytes: snap.ArtifactBytes, Tier: string(snap.Tier), Limits: limits,
	}
}

// NewAdminRuntimeConfigView maps the read-only configuration display.
func NewAdminRuntimeConfigView(cfg *config.Config) AdminRuntimeConfigView {
	return AdminRuntimeConfigView{
		Runtime:         cfg.Runtime.Type,
		Image:           cfg.Runtime.Image,
		Resources:       AdminResourcesView{CPU: cfg.Runtime.Resources.CPU, Memory: cfg.Runtime.Resources.Memory},
		LeaseTTLSeconds: cfg.Lease.TTLSeconds,
		Admission: AdminAdmissionView{
			MaxConcurrent:  cfg.Admission.MaxConcurrent,
			MaxPerUID:      cfg.Admission.MaxPerUID,
			QueueSize:      cfg.Admission.QueueSize,
			QueueTimeoutMS: cfg.Admission.QueueTimeoutMS,
		},
		QuotaEnabled: cfg.Quota.Enabled,
	}
}

// executionDurationMS is the elapsed time from start to finish (or now while
// still running); zero before the execution started.
func executionDurationMS(row *model.SandboxExecution, now time.Time) int64 {
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
