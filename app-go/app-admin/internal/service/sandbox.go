// Sandbox service: the console proxy's thin layer between the router and the
// app-sandbox client.
//
// Reads are pure pass-through — the control plane owns filters, pagination and
// view shapes, and app-admin must not develop a second query semantics. The two
// writes (cancel an execution, force-release a lease) are audited in app-admin
// AFTER the control plane confirms them: the ledger records what actually
// happened, app-sandbox writes its own audit row for the same action, and a
// failed app-admin audit surfaces as an error instead of a silent gap (an
// untraceable admin write is unacceptable — same rule as the moderation ledger).
package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"app-admin/internal/repo"
	"app-admin/internal/sandbox"
)

// Audit actions for sandbox writes — dotted domain names, so the shared ledger
// can be filtered by domain (the console /audit page shows them like any other
// admin action).
const (
	AuditSandboxExecutionCancel = "sandbox.execution.cancel"
	AuditSandboxLeaseRelease    = "sandbox.lease.release"
)

// Ledger target_type values for sandbox writes.
const (
	sandboxTargetExecution = "sandbox_execution"
	sandboxTargetLease     = "sandbox_lease"
)

// AuditRecorder appends one admin_audit row. Injectable so the router tests can
// exercise the write path without MySQL; production wiring is repo.RecordAudit.
type AuditRecorder func(adminName, action, targetType, targetID, detail string) error

// SandboxService proxies the sandbox console plane.
type SandboxService struct {
	client *sandbox.Client
	audit  AuditRecorder
}

// NewSandboxService wires the production audit recorder.
func NewSandboxService(client *sandbox.Client) *SandboxService {
	return &SandboxService{client: client, audit: repo.RecordAudit}
}

// NewSandboxServiceWithAudit is the test seam: unit tests have no MySQL, so they
// inject a recording audit function instead of the ledger writer. Production
// wiring must use NewSandboxService.
func NewSandboxServiceWithAudit(client *sandbox.Client, audit AuditRecorder) *SandboxService {
	return &SandboxService{client: client, audit: audit}
}

// Enabled reports whether the proxy is wired; false makes the router answer 503
// for every /api/sandbox/* route.
func (s *SandboxService) Enabled() bool { return s != nil && s.client.Enabled() }

// Overview returns the control-plane dashboard counters.
func (s *SandboxService) Overview(ctx context.Context) (json.RawMessage, error) {
	return s.client.Overview(ctx)
}

// Executions returns one page of execution records (filters are forwarded, see
// the router).
func (s *SandboxService) Executions(ctx context.Context, query url.Values) (json.RawMessage, error) {
	return s.client.Executions(ctx, query)
}

// Execution returns one execution's detail view.
func (s *SandboxService) Execution(ctx context.Context, id string) (json.RawMessage, error) {
	return s.client.Execution(ctx, id)
}

// CancelExecution cancels a queued/running execution and audits the operator
// action. The reason is optional (console confirm dialog) and only feeds the
// ledger: the upstream cancel carries no body by contract.
func (s *SandboxService) CancelExecution(ctx context.Context, adminName, id, reason string) (json.RawMessage, error) {
	body, err := s.client.CancelExecution(ctx, id)
	if err != nil {
		return nil, err
	}
	if err := s.record(adminName, AuditSandboxExecutionCancel, sandboxTargetExecution, id,
		fmt.Sprintf("execution_id=%s result=ok reason=%s", id, reasonOrNone(reason))); err != nil {
		return nil, err
	}
	return body, nil
}

// Leases returns one page of live/terminated leases.
func (s *SandboxService) Leases(ctx context.Context, query url.Values) (json.RawMessage, error) {
	return s.client.Leases(ctx, query)
}

// ReleaseLease force-releases a lease (cancel in-flight execution, delete the
// runtime sandbox) and audits the operator action.
func (s *SandboxService) ReleaseLease(ctx context.Context, adminName, id, reason string) (json.RawMessage, error) {
	body, err := s.client.ReleaseLease(ctx, id)
	if err != nil {
		return nil, err
	}
	if err := s.record(adminName, AuditSandboxLeaseRelease, sandboxTargetLease, id,
		fmt.Sprintf("lease_id=%s result=ok reason=%s", id, reasonOrNone(reason))); err != nil {
		return nil, err
	}
	return body, nil
}

// Quota returns one user's daily usage plus tier limits.
func (s *SandboxService) Quota(ctx context.Context, query url.Values) (json.RawMessage, error) {
	return s.client.Quota(ctx, query)
}

// AuditLog searches the control-plane audit trail.
func (s *SandboxService) AuditLog(ctx context.Context, query url.Values) (json.RawMessage, error) {
	return s.client.AuditLog(ctx, query)
}

// RuntimeConfig returns the read-only runtime summary.
func (s *SandboxService) RuntimeConfig(ctx context.Context) (json.RawMessage, error) {
	return s.client.RuntimeConfig(ctx)
}

// record appends the ledger row for a confirmed write. A missing recorder is a
// wiring bug, not a no-op: silently skipping would make the write untraceable.
func (s *SandboxService) record(adminName, action, targetType, targetID, detail string) error {
	if s.audit == nil {
		return errors.New("sandbox audit recorder is not configured")
	}
	if err := s.audit(adminName, action, targetType, targetID, detail); err != nil {
		return fmt.Errorf("audit %s: %w", action, err)
	}
	return nil
}

// reasonOrNone renders an absent console reason so the ledger detail stays
// parseable ("reason=" with nothing behind it reads like a truncation bug).
func reasonOrNone(reason string) string {
	reason = strings.TrimSpace(reason)
	if reason == "" {
		return "(no reason given)"
	}
	return truncateRunes(reason, 200)
}
