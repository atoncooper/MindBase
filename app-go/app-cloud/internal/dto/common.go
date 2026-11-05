// Package dto holds the wire representations served by app-cloud handlers.
// Domain models (model.*) and service results stay internal: handlers map them
// to these structs so JSON field names, nullability and empty-array behavior
// are defined in one place instead of ad-hoc gin.H maps.
package dto

// ErrorResponse is the uniform error envelope ({"detail": "..."}). Every
// non-2xx JSON response uses it.
type ErrorResponse struct {
	Detail string `json:"detail"`
}

// HealthResponse is the liveness probe payload.
type HealthResponse struct {
	Status  string `json:"status"`
	Service string `json:"service"`
}
