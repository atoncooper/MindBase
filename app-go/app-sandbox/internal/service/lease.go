package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"app-sandbox/internal/config"
	"app-sandbox/internal/metrics"
	"app-sandbox/internal/model"
	"app-sandbox/internal/repo"
	"app-sandbox/internal/runtime"

	"github.com/google/uuid"
)

// ExecutionCanceler is implemented by ExecutionService. LeaseManager uses it to
// stop in-flight executions before a sandbox is reclaimed, without importing the
// execution service (no dependency cycle).
type ExecutionCanceler interface {
	CancelByLease(ctx context.Context, leaseID, reason, requestID string) int
}

// SpecHash is the deterministic sandbox identity component of the lease key:
// only same-image/same-resource requests may reuse a sandbox.
func SpecHash(image, cpu, memory string) string {
	sum := sha256.Sum256([]byte(strings.Join([]string{image, cpu, memory}, "|")))
	return hex.EncodeToString(sum[:])
}

// LeaseRequest is one acquisition attempt for the (uid, project, purpose, spec)
// identity.
type LeaseRequest struct {
	UID       int64
	ProjectID string
	Purpose   string
	RequestID string
}

// LeaseManager owns the lease lifecycle: reuse an unexpired ready/idle lease
// with the same identity, otherwise create one (bounded by the tier concurrency
// quota and the hard lease.maxPerUid ceiling), and reclaim leases on expiry or
// demand.
type LeaseManager struct {
	cfg      *config.Config
	rt       runtime.Runtime
	leases   repo.LeaseRepo
	usage    repo.UsageRepo
	audit    repo.AuditRepo
	quota    *QuotaService
	metrics  *metrics.Metrics
	canceler ExecutionCanceler
	Now      func() time.Time
}

// NewLeaseManager wires the manager.
func NewLeaseManager(
	cfg *config.Config,
	rt runtime.Runtime,
	leases repo.LeaseRepo,
	usage repo.UsageRepo,
	audit repo.AuditRepo,
	quota *QuotaService,
	m *metrics.Metrics,
) *LeaseManager {
	return &LeaseManager{cfg: cfg, rt: rt, leases: leases, usage: usage, audit: audit, quota: quota, metrics: m, Now: time.Now}
}

// SetCanceler wires the execution canceller (main does this after constructing
// the execution service).
func (m *LeaseManager) SetCanceler(c ExecutionCanceler) { m.canceler = c }

// Get loads one lease.
func (m *LeaseManager) Get(ctx context.Context, id string) (*model.SandboxLease, error) {
	return m.leases.GetLease(ctx, id)
}

// ListByUID lists a user's leases (admin/diagnostics).
func (m *LeaseManager) ListByUID(ctx context.Context, uid int64, limit int) ([]model.SandboxLease, error) {
	return m.leases.ListLeasesByUID(ctx, uid, limit)
}

// Acquire returns a lease that is ready for execution: a reused ready/idle lease
// (TTL renewed) or a freshly created one. Concurrency limit -> *QuotaExceededError
// with kind sandbox_concurrent.
func (m *LeaseManager) Acquire(ctx context.Context, req LeaseRequest) (*model.SandboxLease, error) {
	now := m.Now()
	specHash := SpecHash(m.cfg.Runtime.Image, m.cfg.Runtime.Resources.CPU, m.cfg.Runtime.Resources.Memory)
	ttl := m.cfg.LeaseTTL()

	// 1) Reuse: the cheapest path (no runtime create, no cold start).
	leased, err := m.leases.FindReusable(ctx, req.UID, req.ProjectID, req.Purpose, specHash, now)
	if err == nil {
		renewed, rerr := m.leases.Renew(ctx, leased.ID, now, now.Add(ttl))
		if rerr == nil && renewed {
			leased.LastUsedAt = now
			leased.ExpiresAt = now.Add(ttl)
			m.metrics.Inc("sandbox_lease_operations_total", map[string]string{"action": "reuse"})
			m.auditLease(ctx, "agent", model.AuditLeaseReuse, leased, req, "reused", "")
			return leased, nil
		}
	} else if !errors.Is(err, repo.ErrNotFound) {
		return nil, err
	}

	// 2) Concurrency quota: tier limit capped by lease.maxPerUid.
	limit, tier := int64(m.cfg.Lease.MaxPerUID), TierFree
	if m.quota != nil {
		limit, tier = m.quota.ConcurrentLimit(ctx, req.UID)
	}
	active, err := m.leases.CountActiveByUID(ctx, req.UID, now)
	if err != nil {
		return nil, err
	}
	if active >= limit {
		m.metrics.Inc("sandbox_quota_denied_total", map[string]string{"kind": config.QuotaConcurrent})
		return nil, &QuotaExceededError{
			Kind:    config.QuotaConcurrent,
			Tier:    string(tier),
			Limit:   limit,
			Used:    active,
			ResetAt: m.resetAt(now),
		}
	}

	// 3) Create: persist the creating row first so concurrent acquisitions of the
	// same identity count against the quota while the runtime works.
	lease := &model.SandboxLease{
		ID:         uuid.NewString(),
		UID:        req.UID,
		ProjectID:  req.ProjectID,
		Purpose:    req.Purpose,
		Runtime:    m.rt.Name(),
		SpecHash:   specHash,
		State:      model.LeaseStateCreating,
		CreatedAt:  now,
		ExpiresAt:  now.Add(ttl),
		LastUsedAt: now,
	}
	if err := m.leases.CreateLease(ctx, lease); err != nil {
		return nil, err
	}
	createCtx, cancel := context.WithTimeout(ctx, m.cfg.CreateTimeout())
	defer cancel()
	sandbox, err := m.rt.Create(createCtx, runtime.CreateSpec{
		UID:       req.UID,
		ProjectID: req.ProjectID,
		Purpose:   req.Purpose,
		SpecHash:  specHash,
		Image:     m.cfg.Runtime.Image,
		CPU:       m.cfg.Runtime.Resources.CPU,
		Memory:    m.cfg.Runtime.Resources.Memory,
		// Ask the backend for a lifetime slightly longer than the lease so a
		// reclaim race never kills a busy sandbox before the sweeper releases it.
		Timeout: ttl + 5*time.Minute,
	})
	if err != nil {
		_, _ = m.leases.SetState(context.WithoutCancel(ctx), lease.ID, []string{model.LeaseStateCreating}, model.LeaseStateFailed)
		m.metrics.Inc("sandbox_lease_operations_total", map[string]string{"action": "fail"})
		m.auditLease(ctx, "agent", model.AuditLeaseCreate, lease, req, "failed", err.Error())
		return nil, fmt.Errorf("runtime create: %w", err)
	}
	ready := now.Add(ttl)
	ok, err := m.leases.MarkReady(context.WithoutCancel(ctx), lease.ID, sandbox.ID, now, ready)
	if err != nil {
		return nil, err
	}
	if !ok {
		// Sweeper failed the creating row meanwhile; clean the runtime resource.
		_ = m.rt.Delete(context.WithoutCancel(ctx), sandbox.ID)
		return nil, fmt.Errorf("lease %s left creating state before it became ready", lease.ID)
	}
	lease.RuntimeID = sandbox.ID
	lease.State = model.LeaseStateReady
	lease.ExpiresAt = ready
	m.metrics.Inc("sandbox_lease_operations_total", map[string]string{"action": "create"})
	m.auditLease(ctx, "agent", model.AuditLeaseCreate, lease, req, "ready", "")
	if m.usage != nil {
		day := now.In(m.quotaLocation()).Format("2006-01-02")
		bg, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if err := m.usage.IncrementUsage(bg, req.UID, day, repo.UsageDelta{LeasesCreated: 1}); err != nil {
			// Best effort: quota accounting must not fail an otherwise healthy lease.
			_ = err
		}
	}
	return lease, nil
}

// Release reclaims a lease on the system/user path (sweeper, runtime_missing,
// legacy internal endpoint).
func (m *LeaseManager) Release(ctx context.Context, leaseID, reason, requestID string) (*model.SandboxLease, error) {
	return m.release(ctx, leaseID, reason, requestID, "system")
}

// ReleaseByAdmin is the internal admin API path: same lifecycle, but the audit
// row records actor=admin with the admin request id.
func (m *LeaseManager) ReleaseByAdmin(ctx context.Context, leaseID, requestID string) (*model.SandboxLease, error) {
	return m.release(ctx, leaseID, "admin_release", requestID, "admin")
}

// release cancels in-flight executions, deletes the runtime sandbox and marks the
// lease terminated. Idempotent: an already finished lease is returned untouched.
// A runtime delete failure leaves the lease in "releasing" so the sweeper retries.
func (m *LeaseManager) release(ctx context.Context, leaseID, reason, requestID, actor string) (*model.SandboxLease, error) {
	lease, err := m.leases.GetLease(ctx, leaseID)
	if err != nil {
		return nil, err
	}
	if isTerminalLease(lease.State) {
		return lease, nil
	}
	ok, err := m.leases.SetState(ctx, leaseID, model.LeaseActiveStates, model.LeaseStateReleasing)
	if err != nil {
		return nil, err
	}
	if !ok {
		// Someone else already moved it (sweeper/release race): report the truth.
		return m.leases.GetLease(ctx, leaseID)
	}
	lease.State = model.LeaseStateReleasing
	if m.canceler != nil {
		m.canceler.CancelByLease(ctx, leaseID, reason, requestID)
	}
	if lease.RuntimeID != "" && m.rt != nil {
		if derr := m.rt.Delete(ctx, lease.RuntimeID); derr != nil && !errors.Is(derr, runtime.ErrNotFound) {
			m.auditLease(ctx, actor, model.AuditLeaseRelease, lease, LeaseRequest{UID: lease.UID, ProjectID: lease.ProjectID, RequestID: requestID}, "delete_failed", derr.Error())
			return lease, fmt.Errorf("runtime delete: %w", derr)
		}
	}
	_, _ = m.leases.SetState(ctx, leaseID, []string{model.LeaseStateReleasing}, model.LeaseStateTerminated)
	lease.State = model.LeaseStateTerminated
	m.metrics.Inc("sandbox_lease_operations_total", map[string]string{"action": "release"})
	m.auditLease(ctx, actor, model.AuditLeaseRelease, lease, LeaseRequest{UID: lease.UID, ProjectID: lease.ProjectID, RequestID: requestID}, reason, "")
	return lease, nil
}

// MarkFailed moves an active lease to the failed terminal state (sweeper:
// stuck creating / vanished runtime resource).
func (m *LeaseManager) MarkFailed(ctx context.Context, leaseID, reason, requestID string) (*model.SandboxLease, error) {
	lease, err := m.leases.GetLease(ctx, leaseID)
	if err != nil {
		return nil, err
	}
	if isTerminalLease(lease.State) {
		return lease, nil
	}
	ok, err := m.leases.SetState(ctx, leaseID, model.LeaseActiveStates, model.LeaseStateFailed)
	if err != nil {
		return nil, err
	}
	if !ok {
		return m.leases.GetLease(ctx, leaseID)
	}
	lease.State = model.LeaseStateFailed
	m.auditLease(ctx, "system", model.AuditLeaseRelease, lease, LeaseRequest{UID: lease.UID, ProjectID: lease.ProjectID, RequestID: requestID}, "failed:"+reason, "")
	return lease, nil
}

// RetryRelease finishes a lease left in releasing by a failed runtime delete.
func (m *LeaseManager) RetryRelease(ctx context.Context, leaseID, reason, requestID string) (*model.SandboxLease, error) {
	lease, err := m.leases.GetLease(ctx, leaseID)
	if err != nil {
		return nil, err
	}
	if lease.State != model.LeaseStateReleasing {
		return lease, nil
	}
	if lease.RuntimeID != "" && m.rt != nil {
		if derr := m.rt.Delete(ctx, lease.RuntimeID); derr != nil && !errors.Is(derr, runtime.ErrNotFound) {
			m.auditLease(ctx, "system", model.AuditLeaseRelease, lease, LeaseRequest{UID: lease.UID, ProjectID: lease.ProjectID, RequestID: requestID}, "delete_failed", derr.Error())
			return lease, fmt.Errorf("runtime delete: %w", derr)
		}
	}
	m.leases.SetState(ctx, leaseID, []string{model.LeaseStateReleasing}, model.LeaseStateTerminated)
	lease.State = model.LeaseStateTerminated
	m.metrics.Inc("sandbox_lease_operations_total", map[string]string{"action": "release"})
	m.auditLease(ctx, "system", model.AuditLeaseRelease, lease, LeaseRequest{UID: lease.UID, ProjectID: lease.ProjectID, RequestID: requestID}, reason, "")
	return lease, nil
}

// ListByStates lists leases in the given states (internal admin endpoint).
func (m *LeaseManager) ListByStates(ctx context.Context, states []string, limit int) ([]model.SandboxLease, error) {
	return m.leases.ListLeasesByState(ctx, states, limit)
}

// Renew extends a lease TTL after a successful execution.
func (m *LeaseManager) Renew(ctx context.Context, leaseID string) error {
	now := m.Now()
	_, err := m.leases.MarkIdle(ctx, leaseID, now, now.Add(m.cfg.LeaseTTL()))
	return err
}

// MarkBusy claims a lease for one execution (ready/idle -> busy).
func (m *LeaseManager) MarkBusy(ctx context.Context, leaseID string) (bool, error) {
	return m.leases.ClaimForExec(ctx, leaseID, m.Now())
}

func (m *LeaseManager) quotaLocation() *time.Location {
	if loc, err := time.LoadLocation(m.cfg.Timezone); err == nil {
		return loc
	}
	return time.UTC
}

func (m *LeaseManager) resetAt(now time.Time) time.Time {
	local := now.In(m.quotaLocation())
	return time.Date(local.Year(), local.Month(), local.Day()+1, 0, 0, 0, 0, m.quotaLocation())
}

func (m *LeaseManager) auditLease(ctx context.Context, actor, action string, lease *model.SandboxLease, req LeaseRequest, outcome, detail string) {
	if m.audit == nil {
		return
	}
	row := &model.SandboxAudit{
		ID:        uuid.NewString(),
		UID:       lease.UID,
		Action:    action,
		LeaseID:   lease.ID,
		ProjectID: lease.ProjectID,
		Image:     m.cfg.Runtime.Image,
		Outcome:   outcome,
		Detail:    truncateDetail(detail),
		RequestID: req.RequestID,
		Actor:     actor,
		CreatedAt: m.Now(),
	}
	bg, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if err := m.audit.InsertAudit(bg, row); err != nil {
		_ = err // audit is best-effort; never fail the request on an audit write
	}
}

// truncateDetail bounds free-form detail strings to the audit column width.
func truncateDetail(s string) string {
	const max = 512
	if len(s) <= max {
		return s
	}
	return s[:max]
}
