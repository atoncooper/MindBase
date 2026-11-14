package dto

import (
	"strconv"
	"time"

	"app-sandbox/internal/model"
)

// LeaseItem is one row of GET /internal/leases (the legacy internal lease
// admin, distinct from the app-admin LeaseAdminView). uid is a string here for
// wire parity with the original payload.
type LeaseItem struct {
	ID         string    `json:"id"`
	UID        string    `json:"uid"`
	ProjectID  string    `json:"projectId"`
	Purpose    string    `json:"purpose"`
	Runtime    string    `json:"runtime"`
	RuntimeID  string    `json:"runtimeId"`
	SpecHash   string    `json:"specHash"`
	State      string    `json:"state"`
	ExpiresAt  time.Time `json:"expiresAt"`
	LastUsedAt time.Time `json:"lastUsedAt"`
	CreatedAt  time.Time `json:"createdAt"`
}

// LeaseListResponse is the GET /internal/leases payload.
type LeaseListResponse struct {
	Leases []LeaseItem `json:"leases"`
}

// NewLeaseItem maps one lease row.
func NewLeaseItem(row model.SandboxLease) LeaseItem {
	return LeaseItem{
		ID:         row.ID,
		UID:        strconv.FormatInt(row.UID, 10),
		ProjectID:  row.ProjectID,
		Purpose:    row.Purpose,
		Runtime:    row.Runtime,
		RuntimeID:  row.RuntimeID,
		SpecHash:   row.SpecHash,
		State:      row.State,
		ExpiresAt:  row.ExpiresAt,
		LastUsedAt: row.LastUsedAt,
		CreatedAt:  row.CreatedAt,
	}
}

// NewLeaseListResponse maps a lease page (leases is always an array).
func NewLeaseListResponse(rows []model.SandboxLease) LeaseListResponse {
	leases := make([]LeaseItem, 0, len(rows))
	for _, row := range rows {
		leases = append(leases, NewLeaseItem(row))
	}
	return LeaseListResponse{Leases: leases}
}
