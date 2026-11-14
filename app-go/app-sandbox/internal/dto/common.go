// Package dto holds the wire representations served by app-sandbox handlers.
// Domain models (model.*) and service results stay internal: handlers map them
// to these structs so JSON field names, nullability and empty-array behavior are
// defined in one place instead of ad-hoc gin.H maps.
//
// The package may import service/model/repo/config for view types and mapping
// inputs; service must never import dto (that would invert the dependency).
package dto

import (
	"time"

	"app-sandbox/internal/service"
)

// ErrorResponse is the uniform error envelope ({"detail": "..."}). Every
// non-2xx JSON response that carries only a message uses it.
type ErrorResponse struct {
	Detail string `json:"detail"`
}

// QuotaErrorResponse is the structured 429 payload of a quota rejection
// (detail + kind + limit + used + resetAt + tier + upgradeSku).
type QuotaErrorResponse struct {
	Detail     string    `json:"detail"`
	Kind       string    `json:"kind"`
	Limit      int64     `json:"limit"`
	Used       int64     `json:"used"`
	ResetAt    time.Time `json:"resetAt"`
	Tier       string    `json:"tier"`
	UpgradeSku string    `json:"upgradeSku"`
}

// NewQuotaErrorResponse maps a service quota error onto the public 429 payload.
func NewQuotaErrorResponse(err *service.QuotaExceededError) QuotaErrorResponse {
	return QuotaErrorResponse{
		Detail:     err.Error(),
		Kind:       err.Kind,
		Limit:      err.Limit,
		Used:       err.Used,
		ResetAt:    err.ResetAt,
		Tier:       err.Tier,
		UpgradeSku: err.UpgradeSKU(),
	}
}

// QueueErrorResponse is the admission queue rejection payload (503 or 429).
type QueueErrorResponse struct {
	Detail string `json:"detail"`
	Kind   string `json:"kind"`
}

// HealthResponse is the liveness probe payload.
type HealthResponse struct {
	Status  string `json:"status"`
	Service string `json:"service"`
	Runtime string `json:"runtime"`
}

// ReadyResponse is the readiness payload when every dependency is up.
type ReadyResponse struct {
	Status  string `json:"status"`
	Runtime string `json:"runtime"`
}

// DegradedMySQLResponse reports a failing database probe (503).
type DegradedMySQLResponse struct {
	Status string `json:"status"`
	MySQL  string `json:"mysql"`
}

// DegradedRuntimeResponse reports a failing sandbox-backend probe (503).
type DegradedRuntimeResponse struct {
	Status  string `json:"status"`
	Runtime string `json:"runtime"`
}
