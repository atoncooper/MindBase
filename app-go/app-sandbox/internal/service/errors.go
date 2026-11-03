package service

import (
	"errors"
	"fmt"
	"time"
)

// Sentinel errors mapped onto HTTP status codes by the router.
var (
	// ErrValidation -> 400
	ErrValidation = errors.New("validation failed")
	// ErrNotFound -> 404 (unknown or foreign execution/lease)
	ErrNotFound = errors.New("not found")
	// ErrForbidden -> 404 (never leak another tenant's existence)
	ErrForbidden = errors.New("forbidden")
	// ErrQueueFull -> 503 (admission queue full)
	ErrQueueFull = errors.New("admission queue full")
	// ErrQueueTimeout -> 429 (admission wait timed out)
	ErrQueueTimeout = errors.New("admission queue timeout")
)

// errValidation wraps a human-readable reason in ErrValidation.
func errValidation(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrValidation, fmt.Sprintf(format, args...))
}

// QuotaExceededError is the structured 429 payload of a quota rejection
// (plan §6: detail + kind + resetAt + tier + upgradeSku).
type QuotaExceededError struct {
	Kind      string    `json:"kind"`
	Tier      string    `json:"tier"`
	Limit     int64     `json:"limit"`
	Used      int64     `json:"used"`
	Requested int64     `json:"requested,omitempty"`
	ResetAt   time.Time `json:"resetAt"`
}

func (e *QuotaExceededError) Error() string {
	if e.Limit <= 0 {
		return fmt.Sprintf("quota exceeded: %s", e.Kind)
	}
	return fmt.Sprintf("quota exceeded: %s (used %d / limit %d, tier %s)", e.Kind, e.Used, e.Limit, e.Tier)
}

// UpgradeSKU suggests the next membership tier (empty when already highest).
func (e *QuotaExceededError) UpgradeSKU() string {
	switch e.Tier {
	case string(TierFree):
		return string(TierVIP)
	case string(TierVIP):
		return string(TierSVIP)
	default:
		return ""
	}
}

// quotaKindOf extracts the quota kind from an error (for metrics labels).
func quotaKindOf(err error) string {
	var qe *QuotaExceededError
	if errors.As(err, &qe) {
		return qe.Kind
	}
	return "unknown"
}

// isTerminalLease reports whether a lease reached a final state.
func isTerminalLease(state string) bool {
	return state == "terminated" || state == "failed"
}
