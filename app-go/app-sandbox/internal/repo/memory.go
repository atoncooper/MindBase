package repo

import (
	"context"
	"errors"
	"sort"
	"sync"
	"time"

	"app-sandbox/internal/model"
)

// ErrDuplicate is returned by the memory store when an id already exists.
var ErrDuplicate = errors.New("repo: duplicate key")

// Memory is a mutex-protected in-memory implementation of every repository
// interface. It exists for unit tests (no MySQL needed) and for the local
// fake-runtime demo; rows are deep-copied on write and read so callers can never
// alias stored state.
type Memory struct {
	mu         sync.RWMutex
	leases     map[string]model.SandboxLease
	executions map[string]model.SandboxExecution
	artifacts  []model.SandboxArtifact
	usage      map[string]model.SandboxUsageDaily
	audits     []model.SandboxAudit
}

// NewMemory returns an empty in-memory store.
func NewMemory() *Memory {
	return &Memory{
		leases:     make(map[string]model.SandboxLease),
		executions: make(map[string]model.SandboxExecution),
		usage:      make(map[string]model.SandboxUsageDaily),
	}
}

var (
	_ LeaseRepo     = (*Memory)(nil)
	_ ExecutionRepo = (*Memory)(nil)
	_ ArtifactRepo  = (*Memory)(nil)
	_ UsageRepo     = (*Memory)(nil)
	_ AuditRepo     = (*Memory)(nil)
)

func intPtrCopy(p *int) *int {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}

func timePtrCopy(p *time.Time) *time.Time {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}

func cloneLease(l model.SandboxLease) model.SandboxLease { return l }

func cloneExecution(e model.SandboxExecution) model.SandboxExecution {
	e.ExitCode = intPtrCopy(e.ExitCode)
	e.StartedAt = timePtrCopy(e.StartedAt)
	e.DeadlineAt = timePtrCopy(e.DeadlineAt)
	e.FinishedAt = timePtrCopy(e.FinishedAt)
	return e
}

func inStates(state string, states []string) bool {
	for _, s := range states {
		if s == state {
			return true
		}
	}
	return false
}

func usageKey(uid int64, day string) string { return day + "|" + itoa(uid) }

func itoa(v int64) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var buf [20]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// ── leases ───────────────────────────────────────────────────────────

func (m *Memory) CreateLease(_ context.Context, lease *model.SandboxLease) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.leases[lease.ID]; ok {
		return ErrDuplicate
	}
	m.leases[lease.ID] = cloneLease(*lease)
	return nil
}

func (m *Memory) GetLease(_ context.Context, id string) (*model.SandboxLease, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	l, ok := m.leases[id]
	if !ok {
		return nil, ErrNotFound
	}
	out := cloneLease(l)
	return &out, nil
}

func (m *Memory) FindReusable(_ context.Context, uid int64, projectID, purpose, specHash string, now time.Time) (*model.SandboxLease, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var best *model.SandboxLease
	for _, l := range m.leases {
		if l.UID != uid || l.ProjectID != projectID || l.Purpose != purpose || l.SpecHash != specHash {
			continue
		}
		if !inStates(l.State, model.LeaseReusableStates) || !l.ExpiresAt.After(now) {
			continue
		}
		if best == nil || l.LastUsedAt.After(best.LastUsedAt) {
			candidate := cloneLease(l)
			best = &candidate
		}
	}
	if best == nil {
		return nil, ErrNotFound
	}
	return best, nil
}

func (m *Memory) CountActiveByUID(_ context.Context, uid int64, now time.Time) (int64, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var n int64
	for _, l := range m.leases {
		if l.UID == uid && inStates(l.State, model.LeaseActiveStates) && l.ExpiresAt.After(now) {
			n++
		}
	}
	return n, nil
}

func (m *Memory) MarkReady(_ context.Context, id, runtimeID string, now, expiresAt time.Time) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	l, ok := m.leases[id]
	if !ok || l.State != model.LeaseStateCreating {
		return false, nil
	}
	l.State = model.LeaseStateReady
	l.RuntimeID = runtimeID
	l.LastUsedAt = now
	l.ExpiresAt = expiresAt
	m.leases[id] = l
	return true, nil
}

func (m *Memory) ClaimForExec(_ context.Context, id string, now time.Time) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	l, ok := m.leases[id]
	if !ok || !inStates(l.State, model.LeaseReusableStates) {
		return false, nil
	}
	l.State = model.LeaseStateBusy
	l.LastUsedAt = now
	m.leases[id] = l
	return true, nil
}

func (m *Memory) MarkIdle(_ context.Context, id string, now, expiresAt time.Time) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	l, ok := m.leases[id]
	if !ok || l.State != model.LeaseStateBusy {
		return false, nil
	}
	l.State = model.LeaseStateIdle
	l.LastUsedAt = now
	l.ExpiresAt = expiresAt
	m.leases[id] = l
	return true, nil
}

func (m *Memory) Renew(_ context.Context, id string, now, expiresAt time.Time) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	l, ok := m.leases[id]
	if !ok || !inStates(l.State, model.LeaseReusableStates) || !l.ExpiresAt.After(now) {
		return false, nil
	}
	l.LastUsedAt = now
	l.ExpiresAt = expiresAt
	m.leases[id] = l
	return true, nil
}

func (m *Memory) SetState(_ context.Context, id string, from []string, to string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	l, ok := m.leases[id]
	if !ok || !inStates(l.State, from) {
		return false, nil
	}
	l.State = to
	m.leases[id] = l
	return true, nil
}

func (m *Memory) ListExpired(_ context.Context, now time.Time, limit int) ([]model.SandboxLease, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]model.SandboxLease, 0)
	for _, l := range m.leases {
		if inStates(l.State, model.LeaseActiveStates) && !l.ExpiresAt.After(now) {
			out = append(out, cloneLease(l))
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].ExpiresAt.Before(out[j].ExpiresAt) })
	return truncateLeases(out, limit), nil
}

func (m *Memory) ListStuckCreating(_ context.Context, before time.Time, limit int) ([]model.SandboxLease, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]model.SandboxLease, 0)
	for _, l := range m.leases {
		if l.State == model.LeaseStateCreating && !l.CreatedAt.After(before) {
			out = append(out, cloneLease(l))
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return truncateLeases(out, limit), nil
}

func (m *Memory) ListActive(ctx context.Context, limit int) ([]model.SandboxLease, error) {
	return m.ListLeasesByState(ctx, model.LeaseActiveStates, limit)
}

func (m *Memory) ListLeasesByState(_ context.Context, states []string, limit int) ([]model.SandboxLease, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]model.SandboxLease, 0)
	for _, l := range m.leases {
		if inStates(l.State, states) {
			out = append(out, cloneLease(l))
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if !out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].CreatedAt.After(out[j].CreatedAt)
		}
		return out[i].ID < out[j].ID
	})
	return truncateLeases(out, limit), nil
}

func (m *Memory) ListReleasing(ctx context.Context, limit int) ([]model.SandboxLease, error) {
	return m.ListLeasesByState(ctx, []string{model.LeaseStateReleasing}, limit)
}

func (m *Memory) ListLeasesByUID(_ context.Context, uid int64, limit int) ([]model.SandboxLease, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]model.SandboxLease, 0)
	for _, l := range m.leases {
		if l.UID == uid {
			out = append(out, cloneLease(l))
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if !out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].CreatedAt.After(out[j].CreatedAt)
		}
		return out[i].ID < out[j].ID
	})
	return truncateLeases(out, limit), nil
}

func truncateLeases(rows []model.SandboxLease, limit int) []model.SandboxLease {
	limit = clampLimit(limit)
	if len(rows) > limit {
		return rows[:limit]
	}
	return rows
}

// ── executions ───────────────────────────────────────────────────────

func (m *Memory) CreateExecution(_ context.Context, exec *model.SandboxExecution) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.executions[exec.ID]; ok {
		return ErrDuplicate
	}
	m.executions[exec.ID] = cloneExecution(*exec)
	return nil
}

func (m *Memory) GetExecution(_ context.Context, id string) (*model.SandboxExecution, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	e, ok := m.executions[id]
	if !ok {
		return nil, ErrNotFound
	}
	out := cloneExecution(e)
	return &out, nil
}

func (m *Memory) SetLease(_ context.Context, id, leaseID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.executions[id]
	if !ok {
		return ErrNotFound
	}
	e.LeaseID = leaseID
	m.executions[id] = e
	return nil
}

func (m *Memory) MarkRunning(_ context.Context, id string, startedAt, deadlineAt time.Time) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.executions[id]
	if !ok || e.Status != model.ExecStatusQueued {
		return false, nil
	}
	e.Status = model.ExecStatusRunning
	e.StartedAt = timePtrCopy(&startedAt)
	e.DeadlineAt = timePtrCopy(&deadlineAt)
	m.executions[id] = e
	return true, nil
}

func (m *Memory) Finish(_ context.Context, id string, fin Finish) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.executions[id]
	if !ok || !inStates(e.Status, model.ExecActiveStates) {
		return false, nil
	}
	e.Status = fin.Status
	e.ExitCode = intPtrCopy(fin.ExitCode)
	e.StdoutBytes = fin.StdoutBytes
	e.StderrBytes = fin.StderrBytes
	e.StdoutPreview = fin.StdoutPreview
	e.StderrPreview = fin.StderrPreview
	e.ArtifactPrefix = fin.ArtifactPrefix
	e.ErrorCode = fin.ErrorCode
	finished := fin.FinishedAt
	e.FinishedAt = timePtrCopy(&finished)
	m.executions[id] = e
	return true, nil
}

func (m *Memory) Cancel(_ context.Context, id, errorCode string, finishedAt time.Time) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.executions[id]
	if !ok || !inStates(e.Status, model.ExecActiveStates) {
		return false, nil
	}
	e.Status = model.ExecStatusCanceled
	e.ErrorCode = errorCode
	finished := finishedAt
	e.FinishedAt = timePtrCopy(&finished)
	m.executions[id] = e
	return true, nil
}

func (m *Memory) ListTimedOut(_ context.Context, now time.Time, limit int) ([]model.SandboxExecution, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]model.SandboxExecution, 0)
	for _, e := range m.executions {
		if e.Status == model.ExecStatusRunning && e.DeadlineAt != nil && !e.DeadlineAt.After(now) {
			out = append(out, cloneExecution(e))
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].DeadlineAt.Before(*out[j].DeadlineAt) })
	return truncateExecutions(out, limit), nil
}

func (m *Memory) ListExecutionsByLease(_ context.Context, leaseID string) ([]model.SandboxExecution, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]model.SandboxExecution, 0)
	for _, e := range m.executions {
		if e.LeaseID == leaseID {
			out = append(out, cloneExecution(e))
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out, nil
}

func (m *Memory) ListExecutionsByUID(_ context.Context, uid int64, limit int) ([]model.SandboxExecution, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]model.SandboxExecution, 0)
	for _, e := range m.executions {
		if e.UID == uid {
			out = append(out, cloneExecution(e))
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if !out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].CreatedAt.After(out[j].CreatedAt)
		}
		return out[i].ID < out[j].ID
	})
	return truncateExecutions(out, limit), nil
}

func truncateExecutions(rows []model.SandboxExecution, limit int) []model.SandboxExecution {
	limit = clampLimit(limit)
	if len(rows) > limit {
		return rows[:limit]
	}
	return rows
}

// ── artifacts ────────────────────────────────────────────────────────

func (m *Memory) CreateArtifacts(_ context.Context, artifacts []model.SandboxArtifact) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, a := range artifacts {
		m.artifacts = append(m.artifacts, a)
	}
	return nil
}

func (m *Memory) ListArtifactsByExecution(_ context.Context, executionID string) ([]model.SandboxArtifact, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]model.SandboxArtifact, 0)
	for _, a := range m.artifacts {
		if a.ExecutionID == executionID {
			out = append(out, a)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if !out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].CreatedAt.Before(out[j].CreatedAt)
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

// ── usage ────────────────────────────────────────────────────────────

func (m *Memory) IncrementUsage(_ context.Context, uid int64, day string, delta UsageDelta) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := usageKey(uid, day)
	row, ok := m.usage[key]
	if !ok {
		row = model.SandboxUsageDaily{UID: uid, Day: day}
	}
	row.Executions += delta.Executions
	row.CPUMillis += delta.CPUMillis
	row.ArtifactBytes += delta.ArtifactBytes
	row.LeasesCreated += delta.LeasesCreated
	row.UpdatedAt = time.Now().UTC()
	m.usage[key] = row
	return nil
}

func (m *Memory) GetUsage(_ context.Context, uid int64, day string) (model.SandboxUsageDaily, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if row, ok := m.usage[usageKey(uid, day)]; ok {
		return row, nil
	}
	return model.SandboxUsageDaily{UID: uid, Day: day}, nil
}

// ── audit ────────────────────────────────────────────────────────────

func (m *Memory) InsertAudit(_ context.Context, audit *model.SandboxAudit) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.audits = append(m.audits, *audit)
	return nil
}

func (m *Memory) ListAuditByExecution(_ context.Context, executionID string) ([]model.SandboxAudit, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]model.SandboxAudit, 0)
	for _, a := range m.audits {
		if a.ExecutionID == executionID {
			out = append(out, a)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if !out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].CreatedAt.Before(out[j].CreatedAt)
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

func (m *Memory) ListAuditByUID(_ context.Context, uid int64, limit int) ([]model.SandboxAudit, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]model.SandboxAudit, 0)
	for _, a := range m.audits {
		if a.UID == uid {
			out = append(out, a)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if !out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].CreatedAt.After(out[j].CreatedAt)
		}
		return out[i].ID > out[j].ID
	})
	limit = clampLimit(limit)
	if len(out) > limit {
		return out[:limit], nil
	}
	return out, nil
}

// ── admin queries ──────────────────────────────────

func (m *Memory) ListLeasesFiltered(_ context.Context, filter LeaseFilter) ([]model.SandboxLease, int64, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]model.SandboxLease, 0)
	for _, l := range m.leases {
		if filter.UID != nil && l.UID != *filter.UID {
			continue
		}
		if len(filter.States) > 0 && !inStates(l.State, filter.States) {
			continue
		}
		out = append(out, cloneLease(l))
	}
	sort.SliceStable(out, func(i, j int) bool {
		if !out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].CreatedAt.After(out[j].CreatedAt)
		}
		return out[i].ID > out[j].ID
	})
	page, pageSize := NormalizePagination(filter.Page, filter.PageSize)
	return paginateLeases(out, page, pageSize), int64(len(out)), nil
}

func (m *Memory) CountLeasesByState(_ context.Context) (map[string]int64, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make(map[string]int64)
	for _, l := range m.leases {
		out[l.State]++
	}
	return out, nil
}

func (m *Memory) ListExecutionsFiltered(_ context.Context, filter ExecutionFilter) ([]model.SandboxExecution, int64, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]model.SandboxExecution, 0)
	for _, e := range m.executions {
		if filter.UID != nil && e.UID != *filter.UID {
			continue
		}
		if filter.ProjectID != "" && e.ProjectID != filter.ProjectID {
			continue
		}
		if len(filter.Statuses) > 0 && !inStates(e.Status, filter.Statuses) {
			continue
		}
		if filter.From != nil && e.CreatedAt.Before(*filter.From) {
			continue
		}
		if filter.To != nil && e.CreatedAt.After(*filter.To) {
			continue
		}
		out = append(out, cloneExecution(e))
	}
	sort.SliceStable(out, func(i, j int) bool {
		if !out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].CreatedAt.After(out[j].CreatedAt)
		}
		return out[i].ID > out[j].ID
	})
	page, pageSize := NormalizePagination(filter.Page, filter.PageSize)
	return paginateExecutions(out, page, pageSize), int64(len(out)), nil
}

func (m *Memory) CountExecutionsByStatus(_ context.Context) (map[string]int64, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make(map[string]int64)
	for _, e := range m.executions {
		out[e.Status]++
	}
	return out, nil
}

func (m *Memory) CountExecutionsSince(_ context.Context, since time.Time) (int64, int64, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var total, failures int64
	for _, e := range m.executions {
		if e.CreatedAt.Before(since) {
			continue
		}
		total++
		if e.Status == model.ExecStatusFailed || e.Status == model.ExecStatusTimeout {
			failures++
		}
	}
	return total, failures, nil
}

func (m *Memory) ListAuditFiltered(_ context.Context, filter AuditFilter) ([]model.SandboxAudit, int64, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]model.SandboxAudit, 0)
	for _, a := range m.audits {
		if filter.UID != nil && a.UID != *filter.UID {
			continue
		}
		if filter.Action != "" && a.Action != filter.Action {
			continue
		}
		if filter.From != nil && a.CreatedAt.Before(*filter.From) {
			continue
		}
		if filter.To != nil && a.CreatedAt.After(*filter.To) {
			continue
		}
		out = append(out, a)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if !out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].CreatedAt.After(out[j].CreatedAt)
		}
		return out[i].ID > out[j].ID
	})
	page, pageSize := NormalizePagination(filter.Page, filter.PageSize)
	start := PageOffset(page, pageSize)
	if start > len(out) {
		return []model.SandboxAudit{}, int64(len(out)), nil
	}
	end := start + pageSize
	if end > len(out) {
		end = len(out)
	}
	return append([]model.SandboxAudit(nil), out[start:end]...), int64(len(out)), nil
}

func (m *Memory) StatsByExecutionIDs(_ context.Context, ids []string) (map[string]ArtifactStat, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	wanted := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		wanted[id] = struct{}{}
	}
	out := make(map[string]ArtifactStat, len(ids))
	for _, a := range m.artifacts {
		if _, ok := wanted[a.ExecutionID]; !ok {
			continue
		}
		stat := out[a.ExecutionID]
		stat.Count++
		stat.Bytes += a.SizeBytes
		out[a.ExecutionID] = stat
	}
	return out, nil
}

func paginateLeases(rows []model.SandboxLease, page, pageSize int) []model.SandboxLease {
	start := PageOffset(page, pageSize)
	if start > len(rows) {
		return []model.SandboxLease{}
	}
	end := start + pageSize
	if end > len(rows) {
		end = len(rows)
	}
	return rows[start:end]
}

func paginateExecutions(rows []model.SandboxExecution, page, pageSize int) []model.SandboxExecution {
	start := PageOffset(page, pageSize)
	if start > len(rows) {
		return []model.SandboxExecution{}
	}
	end := start + pageSize
	if end > len(rows) {
		end = len(rows)
	}
	return rows[start:end]
}
