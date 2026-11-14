package service

import (
	"context"
	"time"

	"app-sandbox/internal/config"
	"app-sandbox/internal/repo"
)

// Overview aggregates state counts, the last-24h execution/failure counters and
// the quota switch.
func (s *AdminService) Overview(ctx context.Context) (OverviewCounts, error) {
	leaseCounts, err := s.queries.CountLeasesByState(ctx)
	if err != nil {
		return OverviewCounts{}, err
	}
	execCounts, err := s.queries.CountExecutionsByStatus(ctx)
	if err != nil {
		return OverviewCounts{}, err
	}
	total24h, failures, err := s.queries.CountExecutionsSince(ctx, s.now().Add(-24*time.Hour))
	if err != nil {
		return OverviewCounts{}, err
	}
	return OverviewCounts{
		LeaseCounts: leaseCounts,
		ExecCounts:  execCounts,
		Total24h:    total24h,
		Failures:    failures,
	}, nil
}

// Executions returns one page of executions with artifact aggregates.
func (s *AdminService) Executions(ctx context.Context, filter repo.ExecutionFilter) (ExecutionAdminPage, error) {
	page, pageSize := repo.NormalizePagination(filter.Page, filter.PageSize)
	filter.Page, filter.PageSize = page, pageSize
	rows, total, err := s.queries.ListExecutionsFiltered(ctx, filter)
	if err != nil {
		return ExecutionAdminPage{}, err
	}
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
	}
	stats, err := s.queries.StatsByExecutionIDs(ctx, ids)
	if err != nil {
		return ExecutionAdminPage{}, err
	}
	return ExecutionAdminPage{Rows: rows, Stats: stats, Total: total, Page: page, PageSize: pageSize}, nil
}

// ExecutionDetail returns the execution row plus artifact metadata and audit.
func (s *AdminService) ExecutionDetail(ctx context.Context, id string) (*ExecutionAdminDetail, error) {
	row, err := s.execs.GetExecution(ctx, id)
	if err != nil {
		return nil, ErrNotFound
	}
	stat, err := s.queries.StatsByExecutionIDs(ctx, []string{id})
	if err != nil {
		return nil, err
	}
	artifactRows, err := s.artifacts.ListArtifactsByExecution(ctx, id)
	if err != nil {
		return nil, err
	}
	auditRows, err := s.audit.ListAuditByExecution(ctx, id)
	if err != nil {
		return nil, err
	}
	return &ExecutionAdminDetail{Row: row, Stat: stat[id], Artifacts: artifactRows, Audit: auditRows}, nil
}

// Leases returns one page of leases.
func (s *AdminService) Leases(ctx context.Context, filter repo.LeaseFilter) (LeaseAdminPage, error) {
	page, pageSize := repo.NormalizePagination(filter.Page, filter.PageSize)
	filter.Page, filter.PageSize = page, pageSize
	rows, total, err := s.queries.ListLeasesFiltered(ctx, filter)
	if err != nil {
		return LeaseAdminPage{}, err
	}
	return LeaseAdminPage{Rows: rows, Total: total, Page: page, PageSize: pageSize}, nil
}

// Quota returns one uid's usage for a day plus the resolved tier and limits.
func (s *AdminService) Quota(ctx context.Context, uid int64, day string) (*QuotaAdminSnapshot, error) {
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
	return &QuotaAdminSnapshot{
		UID: uid, Day: day, Executions: usage.Executions, CPUMillis: usage.CPUMillis,
		ArtifactBytes: usage.ArtifactBytes, Tier: tier, Limits: limits,
	}, nil
}

// Audit returns one page of the audit trail.
func (s *AdminService) Audit(ctx context.Context, filter repo.AuditFilter) (AuditAdminPage, error) {
	page, pageSize := repo.NormalizePagination(filter.Page, filter.PageSize)
	filter.Page, filter.PageSize = page, pageSize
	rows, total, err := s.queries.ListAuditFiltered(ctx, filter)
	if err != nil {
		return AuditAdminPage{}, err
	}
	return AuditAdminPage{Rows: rows, Total: total, Page: page, PageSize: pageSize}, nil
}
