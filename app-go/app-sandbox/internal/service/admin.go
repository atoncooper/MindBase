package service

import (
	"time"

	"app-sandbox/internal/config"
	"app-sandbox/internal/model"
	"app-sandbox/internal/repo"
)

// Admin API results are domain data. The wire structs live in internal/dto,
// which maps these aggregates to the JSON contract with app-admin; no aggregate
// ever carries a code body (the store keeps code_sha256 + truncated previews).

// OverviewCounts aggregates the state counts plus the last-24h counters.
type OverviewCounts struct {
	LeaseCounts map[string]int64
	ExecCounts  map[string]int64
	Total24h    int64
	Failures    int64
}

// ExecutionAdminPage is one normalized page of executions plus artifact stats.
type ExecutionAdminPage struct {
	Rows     []model.SandboxExecution
	Stats    map[string]repo.ArtifactStat
	Total    int64
	Page     int
	PageSize int
}

// ExecutionAdminDetail is one execution plus artifact metadata and audit rows.
type ExecutionAdminDetail struct {
	Row       *model.SandboxExecution
	Stat      repo.ArtifactStat
	Artifacts []model.SandboxArtifact
	Audit     []model.SandboxAudit
}

// LeaseAdminPage is one normalized page of leases.
type LeaseAdminPage struct {
	Rows     []model.SandboxLease
	Total    int64
	Page     int
	PageSize int
}

// AuditAdminPage is one normalized page of audit rows.
type AuditAdminPage struct {
	Rows     []model.SandboxAudit
	Total    int64
	Page     int
	PageSize int
}

// QuotaAdminSnapshot is one uid's usage for a day plus the resolved tier limits.
type QuotaAdminSnapshot struct {
	UID           int64
	Day           string
	Executions    int64
	CPUMillis     int64
	ArtifactBytes int64
	Tier          Tier
	Limits        map[string]int64
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
