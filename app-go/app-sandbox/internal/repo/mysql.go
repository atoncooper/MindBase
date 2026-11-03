package repo

import (
	"context"
	"errors"
	"time"

	"app-sandbox/internal/model"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// MySQL implements every repository interface on the shared mind_base database.
// It is safe for concurrent use (GORM pools connections); state transitions use
// conditional WHERE clauses so the first writer wins and the loser gets false.
type MySQL struct {
	db *gorm.DB
}

// NewMySQL wraps a GORM handle.
func NewMySQL(db *gorm.DB) *MySQL { return &MySQL{db: db} }

var (
	_ LeaseRepo     = (*MySQL)(nil)
	_ ExecutionRepo = (*MySQL)(nil)
	_ ArtifactRepo  = (*MySQL)(nil)
	_ UsageRepo     = (*MySQL)(nil)
	_ AuditRepo     = (*MySQL)(nil)
)

// ── leases ───────────────────────────────────────────────────────────

func (m *MySQL) CreateLease(ctx context.Context, lease *model.SandboxLease) error {
	return m.db.WithContext(ctx).Create(lease).Error
}

func (m *MySQL) GetLease(ctx context.Context, id string) (*model.SandboxLease, error) {
	var row model.SandboxLease
	err := m.db.WithContext(ctx).Where("id = ?", id).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (m *MySQL) FindReusable(ctx context.Context, uid int64, projectID, purpose, specHash string, now time.Time) (*model.SandboxLease, error) {
	var row model.SandboxLease
	err := m.db.WithContext(ctx).
		Where("uid = ? AND project_id = ? AND purpose = ? AND spec_hash = ? AND state IN ? AND expires_at > ?",
			uid, projectID, purpose, specHash, model.LeaseReusableStates, now).
		Order("last_used_at DESC, created_at DESC").
		First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (m *MySQL) CountActiveByUID(ctx context.Context, uid int64, now time.Time) (int64, error) {
	var n int64
	err := m.db.WithContext(ctx).Model(&model.SandboxLease{}).
		Where("uid = ? AND state IN ? AND expires_at > ?", uid, model.LeaseActiveStates, now).
		Count(&n).Error
	return n, err
}

func (m *MySQL) MarkReady(ctx context.Context, id, runtimeID string, now, expiresAt time.Time) (bool, error) {
	res := m.db.WithContext(ctx).Model(&model.SandboxLease{}).
		Where("id = ? AND state = ?", id, model.LeaseStateCreating).
		Updates(map[string]any{
			"state":        model.LeaseStateReady,
			"runtime_id":   runtimeID,
			"expires_at":   expiresAt,
			"last_used_at": now,
		})
	return res.RowsAffected > 0, res.Error
}

func (m *MySQL) ClaimForExec(ctx context.Context, id string, now time.Time) (bool, error) {
	res := m.db.WithContext(ctx).Model(&model.SandboxLease{}).
		Where("id = ? AND state IN ?", id, model.LeaseReusableStates).
		Updates(map[string]any{"state": model.LeaseStateBusy, "last_used_at": now})
	return res.RowsAffected > 0, res.Error
}

func (m *MySQL) MarkIdle(ctx context.Context, id string, now, expiresAt time.Time) (bool, error) {
	res := m.db.WithContext(ctx).Model(&model.SandboxLease{}).
		Where("id = ? AND state = ?", id, model.LeaseStateBusy).
		Updates(map[string]any{
			"state":        model.LeaseStateIdle,
			"last_used_at": now,
			"expires_at":   expiresAt,
		})
	return res.RowsAffected > 0, res.Error
}

func (m *MySQL) Renew(ctx context.Context, id string, now, expiresAt time.Time) (bool, error) {
	res := m.db.WithContext(ctx).Model(&model.SandboxLease{}).
		Where("id = ? AND state IN ? AND expires_at > ?", id, model.LeaseReusableStates, now).
		Updates(map[string]any{"last_used_at": now, "expires_at": expiresAt})
	return res.RowsAffected > 0, res.Error
}

func (m *MySQL) SetState(ctx context.Context, id string, from []string, to string) (bool, error) {
	res := m.db.WithContext(ctx).Model(&model.SandboxLease{}).
		Where("id = ? AND state IN ?", id, from).
		Update("state", to)
	return res.RowsAffected > 0, res.Error
}

func (m *MySQL) ListExpired(ctx context.Context, now time.Time, limit int) ([]model.SandboxLease, error) {
	var rows []model.SandboxLease
	err := m.db.WithContext(ctx).
		Where("state IN ? AND expires_at <= ?", model.LeaseActiveStates, now).
		Order("expires_at ASC").Limit(clampLimit(limit)).
		Find(&rows).Error
	return rows, err
}

func (m *MySQL) ListStuckCreating(ctx context.Context, before time.Time, limit int) ([]model.SandboxLease, error) {
	var rows []model.SandboxLease
	err := m.db.WithContext(ctx).
		Where("state = ? AND created_at <= ?", model.LeaseStateCreating, before).
		Order("created_at ASC").Limit(clampLimit(limit)).
		Find(&rows).Error
	return rows, err
}

func (m *MySQL) ListActive(ctx context.Context, limit int) ([]model.SandboxLease, error) {
	return m.ListLeasesByState(ctx, model.LeaseActiveStates, limit)
}

func (m *MySQL) ListLeasesByState(ctx context.Context, states []string, limit int) ([]model.SandboxLease, error) {
	var rows []model.SandboxLease
	err := m.db.WithContext(ctx).
		Where("state IN ?", states).
		Order("created_at DESC").Limit(clampLimit(limit)).
		Find(&rows).Error
	return rows, err
}

func (m *MySQL) ListReleasing(ctx context.Context, limit int) ([]model.SandboxLease, error) {
	return m.ListLeasesByState(ctx, []string{model.LeaseStateReleasing}, limit)
}

func (m *MySQL) ListLeasesByUID(ctx context.Context, uid int64, limit int) ([]model.SandboxLease, error) {
	var rows []model.SandboxLease
	err := m.db.WithContext(ctx).
		Where("uid = ?", uid).
		Order("created_at DESC").Limit(clampLimit(limit)).
		Find(&rows).Error
	return rows, err
}

// ── executions ───────────────────────────────────────────────────────

func (m *MySQL) CreateExecution(ctx context.Context, exec *model.SandboxExecution) error {
	return m.db.WithContext(ctx).Create(exec).Error
}

func (m *MySQL) GetExecution(ctx context.Context, id string) (*model.SandboxExecution, error) {
	var row model.SandboxExecution
	err := m.db.WithContext(ctx).Where("id = ?", id).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (m *MySQL) SetLease(ctx context.Context, id, leaseID string) error {
	return m.db.WithContext(ctx).Model(&model.SandboxExecution{}).
		Where("id = ?", id).
		Update("lease_id", leaseID).Error
}

func (m *MySQL) MarkRunning(ctx context.Context, id string, startedAt, deadlineAt time.Time) (bool, error) {
	res := m.db.WithContext(ctx).Model(&model.SandboxExecution{}).
		Where("id = ? AND status = ?", id, model.ExecStatusQueued).
		Updates(map[string]any{
			"status":      model.ExecStatusRunning,
			"started_at":  startedAt,
			"deadline_at": deadlineAt,
		})
	return res.RowsAffected > 0, res.Error
}

func (m *MySQL) Finish(ctx context.Context, id string, fin Finish) (bool, error) {
	res := m.db.WithContext(ctx).Model(&model.SandboxExecution{}).
		Where("id = ? AND status IN ?", id, model.ExecActiveStates).
		Updates(map[string]any{
			"status":          fin.Status,
			"exit_code":       fin.ExitCode,
			"stdout_bytes":    fin.StdoutBytes,
			"stderr_bytes":    fin.StderrBytes,
			"stdout_preview":  fin.StdoutPreview,
			"stderr_preview":  fin.StderrPreview,
			"artifact_prefix": fin.ArtifactPrefix,
			"error_code":      fin.ErrorCode,
			"finished_at":     fin.FinishedAt,
		})
	return res.RowsAffected > 0, res.Error
}

func (m *MySQL) Cancel(ctx context.Context, id, errorCode string, finishedAt time.Time) (bool, error) {
	res := m.db.WithContext(ctx).Model(&model.SandboxExecution{}).
		Where("id = ? AND status IN ?", id, model.ExecActiveStates).
		Updates(map[string]any{
			"status":      model.ExecStatusCanceled,
			"error_code":  errorCode,
			"finished_at": finishedAt,
		})
	return res.RowsAffected > 0, res.Error
}

func (m *MySQL) ListTimedOut(ctx context.Context, now time.Time, limit int) ([]model.SandboxExecution, error) {
	var rows []model.SandboxExecution
	err := m.db.WithContext(ctx).
		Where("status = ? AND deadline_at IS NOT NULL AND deadline_at <= ?", model.ExecStatusRunning, now).
		Order("deadline_at ASC").Limit(clampLimit(limit)).
		Find(&rows).Error
	return rows, err
}

func (m *MySQL) ListExecutionsByLease(ctx context.Context, leaseID string) ([]model.SandboxExecution, error) {
	var rows []model.SandboxExecution
	err := m.db.WithContext(ctx).Where("lease_id = ?", leaseID).
		Order("created_at ASC").Find(&rows).Error
	return rows, err
}

func (m *MySQL) ListExecutionsByUID(ctx context.Context, uid int64, limit int) ([]model.SandboxExecution, error) {
	var rows []model.SandboxExecution
	err := m.db.WithContext(ctx).Where("uid = ?", uid).
		Order("created_at DESC").Limit(clampLimit(limit)).
		Find(&rows).Error
	return rows, err
}

// ── artifacts ────────────────────────────────────────────────────────

func (m *MySQL) CreateArtifacts(ctx context.Context, artifacts []model.SandboxArtifact) error {
	if len(artifacts) == 0 {
		return nil
	}
	return m.db.WithContext(ctx).Create(&artifacts).Error
}

func (m *MySQL) ListArtifactsByExecution(ctx context.Context, executionID string) ([]model.SandboxArtifact, error) {
	var rows []model.SandboxArtifact
	err := m.db.WithContext(ctx).Where("execution_id = ?", executionID).
		Order("created_at ASC").Find(&rows).Error
	return rows, err
}

// ── usage ────────────────────────────────────────────────────────────

func (m *MySQL) IncrementUsage(ctx context.Context, uid int64, day string, delta UsageDelta) error {
	now := time.Now().UTC()
	row := model.SandboxUsageDaily{
		UID:           uid,
		Day:           day,
		Executions:    delta.Executions,
		CPUMillis:     delta.CPUMillis,
		ArtifactBytes: delta.ArtifactBytes,
		LeasesCreated: delta.LeasesCreated,
		UpdatedAt:     now,
	}
	return m.db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "uid"}, {Name: "day"}},
		DoUpdates: clause.Assignments(map[string]any{
			"executions":     gorm.Expr("executions + ?", delta.Executions),
			"cpu_millis":     gorm.Expr("cpu_millis + ?", delta.CPUMillis),
			"artifact_bytes": gorm.Expr("artifact_bytes + ?", delta.ArtifactBytes),
			"leases_created": gorm.Expr("leases_created + ?", delta.LeasesCreated),
			"updated_at":     now,
		}),
	}).Create(&row).Error
}

func (m *MySQL) GetUsage(ctx context.Context, uid int64, day string) (model.SandboxUsageDaily, error) {
	var row model.SandboxUsageDaily
	err := m.db.WithContext(ctx).Where("uid = ? AND day = ?", uid, day).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.SandboxUsageDaily{UID: uid, Day: day}, nil
	}
	return row, err
}

// ── audit ────────────────────────────────────────────────────────────

func (m *MySQL) InsertAudit(ctx context.Context, audit *model.SandboxAudit) error {
	return m.db.WithContext(ctx).Create(audit).Error
}

func (m *MySQL) ListAuditByExecution(ctx context.Context, executionID string) ([]model.SandboxAudit, error) {
	var rows []model.SandboxAudit
	err := m.db.WithContext(ctx).Where("execution_id = ?", executionID).
		Order("created_at ASC, id ASC").Find(&rows).Error
	return rows, err
}

func (m *MySQL) ListAuditByUID(ctx context.Context, uid int64, limit int) ([]model.SandboxAudit, error) {
	var rows []model.SandboxAudit
	err := m.db.WithContext(ctx).Where("uid = ?", uid).
		Order("created_at DESC").Limit(clampLimit(limit)).Find(&rows).Error
	return rows, err
}

func clampLimit(limit int) int {
	if limit <= 0 {
		return 100
	}
	if limit > 500 {
		return 500
	}
	return limit
}

// ── admin queries ──────────────────────────────────
//
// Index notes: admin lists always order by created_at DESC, id DESC. With a uid
// filter they use idx_execution_uid_created / idx_audit_uid_created; unfiltered
// pages use the created_at indexes added for the admin console. Lease pages use
// idx_lease_created_at (and idx_lease_uid_state when uid/state are given).

func (m *MySQL) leaseAdminQuery(ctx context.Context, filter LeaseFilter) *gorm.DB {
	q := m.db.WithContext(ctx).Model(&model.SandboxLease{})
	if filter.UID != nil {
		q = q.Where("uid = ?", *filter.UID)
	}
	if len(filter.States) > 0 {
		q = q.Where("state IN ?", filter.States)
	}
	return q
}

func (m *MySQL) ListLeasesFiltered(ctx context.Context, filter LeaseFilter) ([]model.SandboxLease, int64, error) {
	page, pageSize := NormalizePagination(filter.Page, filter.PageSize)
	var total int64
	if err := m.leaseAdminQuery(ctx, filter).Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var rows []model.SandboxLease
	err := m.leaseAdminQuery(ctx, filter).
		Order("created_at DESC, id DESC").
		Limit(pageSize).Offset(PageOffset(page, pageSize)).
		Find(&rows).Error
	return rows, total, err
}

func (m *MySQL) CountLeasesByState(ctx context.Context) (map[string]int64, error) {
	var rows []struct {
		State string `gorm:"column:state"`
		Count int64  `gorm:"column:count"`
	}
	if err := m.db.WithContext(ctx).Model(&model.SandboxLease{}).
		Select("state, COUNT(*) AS count").Group("state").Scan(&rows).Error; err != nil {
		return nil, err
	}
	out := make(map[string]int64, len(rows))
	for _, row := range rows {
		out[row.State] = row.Count
	}
	return out, nil
}

func (m *MySQL) executionAdminQuery(ctx context.Context, filter ExecutionFilter) *gorm.DB {
	q := m.db.WithContext(ctx).Model(&model.SandboxExecution{})
	if filter.UID != nil {
		q = q.Where("uid = ?", *filter.UID)
	}
	if filter.ProjectID != "" {
		q = q.Where("project_id = ?", filter.ProjectID)
	}
	if len(filter.Statuses) > 0 {
		q = q.Where("status IN ?", filter.Statuses)
	}
	if filter.From != nil {
		q = q.Where("created_at >= ?", *filter.From)
	}
	if filter.To != nil {
		q = q.Where("created_at <= ?", *filter.To)
	}
	return q
}

func (m *MySQL) ListExecutionsFiltered(ctx context.Context, filter ExecutionFilter) ([]model.SandboxExecution, int64, error) {
	page, pageSize := NormalizePagination(filter.Page, filter.PageSize)
	var total int64
	if err := m.executionAdminQuery(ctx, filter).Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var rows []model.SandboxExecution
	err := m.executionAdminQuery(ctx, filter).
		Order("created_at DESC, id DESC").
		Limit(pageSize).Offset(PageOffset(page, pageSize)).
		Find(&rows).Error
	return rows, total, err
}

func (m *MySQL) CountExecutionsByStatus(ctx context.Context) (map[string]int64, error) {
	var rows []struct {
		Status string `gorm:"column:status"`
		Count  int64  `gorm:"column:count"`
	}
	if err := m.db.WithContext(ctx).Model(&model.SandboxExecution{}).
		Select("status, COUNT(*) AS count").Group("status").Scan(&rows).Error; err != nil {
		return nil, err
	}
	out := make(map[string]int64, len(rows))
	for _, row := range rows {
		out[row.Status] = row.Count
	}
	return out, nil
}

func (m *MySQL) CountExecutionsSince(ctx context.Context, since time.Time) (int64, int64, error) {
	base := func() *gorm.DB {
		return m.db.WithContext(ctx).Model(&model.SandboxExecution{}).Where("created_at >= ?", since)
	}
	var total int64
	if err := base().Count(&total).Error; err != nil {
		return 0, 0, err
	}
	var failures int64
	if err := base().Where("status IN ?", []string{model.ExecStatusFailed, model.ExecStatusTimeout}).
		Count(&failures).Error; err != nil {
		return 0, 0, err
	}
	return total, failures, nil
}

func (m *MySQL) auditAdminQuery(ctx context.Context, filter AuditFilter) *gorm.DB {
	q := m.db.WithContext(ctx).Model(&model.SandboxAudit{})
	if filter.UID != nil {
		q = q.Where("uid = ?", *filter.UID)
	}
	if filter.Action != "" {
		q = q.Where("action = ?", filter.Action)
	}
	if filter.From != nil {
		q = q.Where("created_at >= ?", *filter.From)
	}
	if filter.To != nil {
		q = q.Where("created_at <= ?", *filter.To)
	}
	return q
}

func (m *MySQL) ListAuditFiltered(ctx context.Context, filter AuditFilter) ([]model.SandboxAudit, int64, error) {
	page, pageSize := NormalizePagination(filter.Page, filter.PageSize)
	var total int64
	if err := m.auditAdminQuery(ctx, filter).Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var rows []model.SandboxAudit
	err := m.auditAdminQuery(ctx, filter).
		Order("created_at DESC, id DESC").
		Limit(pageSize).Offset(PageOffset(page, pageSize)).
		Find(&rows).Error
	return rows, total, err
}

func (m *MySQL) StatsByExecutionIDs(ctx context.Context, ids []string) (map[string]ArtifactStat, error) {
	out := make(map[string]ArtifactStat, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	var rows []struct {
		ExecutionID string `gorm:"column:execution_id"`
		Count       int64  `gorm:"column:count"`
		Bytes       int64  `gorm:"column:bytes"`
	}
	err := m.db.WithContext(ctx).Model(&model.SandboxArtifact{}).
		Select("execution_id, COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes").
		Where("execution_id IN ?", ids).
		Group("execution_id").
		Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		out[row.ExecutionID] = ArtifactStat{Count: row.Count, Bytes: row.Bytes}
	}
	return out, nil
}
