package repo

import (
	"context"
	"time"

	"app-sandbox/internal/model"
)

// Pagination defaults shared by every admin query ( page is
// 1-based, pageSize 1..100 with a default of 20).
const (
	DefaultPageSize = 20
	MaxPageSize     = 100
)

// NormalizePagination clamps the caller-supplied page/pageSize. It is applied in
// the service and again in the repositories so a direct repo caller cannot ask
// for an unbounded page.
func NormalizePagination(page, pageSize int) (int, int) {
	if page < 1 {
		page = 1
	}
	if pageSize <= 0 {
		pageSize = DefaultPageSize
	}
	if pageSize > MaxPageSize {
		pageSize = MaxPageSize
	}
	return page, pageSize
}

// PageOffset is the SQL OFFSET for an already normalized page.
func PageOffset(page, pageSize int) int {
	return (page - 1) * pageSize
}

// LeaseFilter is the optional filter set of GET /internal/admin/leases.
type LeaseFilter struct {
	UID      *int64
	States   []string
	Page     int
	PageSize int
}

// ExecutionFilter is the optional filter set of GET /internal/admin/executions.
type ExecutionFilter struct {
	UID       *int64
	ProjectID string
	Statuses  []string
	From      *time.Time
	To        *time.Time
	Page      int
	PageSize  int
}

// AuditFilter is the optional filter set of GET /internal/admin/audit.
type AuditFilter struct {
	UID      *int64
	Action   string
	From     *time.Time
	To       *time.Time
	Page     int
	PageSize int
}

// ArtifactStat aggregates one execution's artifact metadata (admin list views
// need count/bytes without loading artifact rows).
type ArtifactStat struct {
	Count int64
	Bytes int64
}

// adminQueries are the read-only queries the internal admin API needs. They are
// separate from the hot-path interfaces so a repository implementation can opt
// in explicitly; both MySQL and Memory implement them.
type adminQueries interface {
	// ListLeasesFiltered returns one page plus the total matching count.
	ListLeasesFiltered(ctx context.Context, filter LeaseFilter) ([]model.SandboxLease, int64, error)
	CountLeasesByState(ctx context.Context) (map[string]int64, error)
	ListExecutionsFiltered(ctx context.Context, filter ExecutionFilter) ([]model.SandboxExecution, int64, error)
	CountExecutionsByStatus(ctx context.Context) (map[string]int64, error)
	// CountExecutionsSince returns (total, failures) created at/after since;
	// failures = status failed + timeout (a user cancel is not a failure).
	CountExecutionsSince(ctx context.Context, since time.Time) (int64, int64, error)
	ListAuditFiltered(ctx context.Context, filter AuditFilter) ([]model.SandboxAudit, int64, error)
	StatsByExecutionIDs(ctx context.Context, ids []string) (map[string]ArtifactStat, error)
}

// AdminQueries is the exported handle the admin service depends on.
type AdminQueries interface {
	adminQueries
}

var (
	_ AdminQueries = (*MySQL)(nil)
	_ AdminQueries = (*Memory)(nil)
)
