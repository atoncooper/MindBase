package service

import (
	"context"

	"app-sandbox/internal/repo"
)

// CancelExecution cancels any uid's queued/running execution (admin action,
// audit actor=admin). Idempotent for terminal executions.
func (s *AdminService) CancelExecution(ctx context.Context, id, requestID string) error {
	return s.execSvc.CancelAdmin(ctx, id, requestID)
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
