package dto

import (
	"time"

	"app-sandbox/internal/model"
	"app-sandbox/internal/runtime"
	"app-sandbox/internal/service"
)

// CreateExecutionRequest is the POST /v1/executions body. Identity is NOT part
// of the body: uid always comes from the gateway-injected X-Uid header.
type CreateExecutionRequest struct {
	ProjectID string         `json:"projectId"`
	Purpose   string         `json:"purpose"`
	Language  string         `json:"language"`
	Code      string         `json:"code"`
	Files     []runtime.File `json:"files"`
	Artifacts []string       `json:"artifacts"`
	TimeoutMS int            `json:"timeoutMs"`
}

// CreateExecutionResponse is the 202 payload of POST /v1/executions.
type CreateExecutionResponse struct {
	ExecutionID string `json:"executionId"`
	LeaseID     string `json:"leaseId"`
	State       string `json:"state"`
}

// NewCreateExecutionResponse maps the freshly queued execution row.
func NewCreateExecutionResponse(exec *model.SandboxExecution) CreateExecutionResponse {
	return CreateExecutionResponse{ExecutionID: exec.ID, LeaseID: exec.LeaseID, State: exec.Status}
}

// ExecutionPayload is one execution in GET /v1/executions/{id} and in the list.
// Optional fields are omitted exactly when the entity column is NULL, and
// durationMs exists only once both timestamps are set.
type ExecutionPayload struct {
	ExecutionID   string                 `json:"executionId"`
	LeaseID       string                 `json:"leaseId"`
	ProjectID     string                 `json:"projectId"`
	Purpose       string                 `json:"purpose"`
	Language      string                 `json:"language"`
	Status        string                 `json:"status"`
	TimeoutMS     int                    `json:"timeoutMs"`
	StdoutPreview string                 `json:"stdoutPreview"`
	StderrPreview string                 `json:"stderrPreview"`
	StdoutBytes   int64                  `json:"stdoutBytes"`
	StderrBytes   int64                  `json:"stderrBytes"`
	ErrorCode     string                 `json:"errorCode"`
	CreatedAt     time.Time              `json:"createdAt"`
	Artifacts     []service.ArtifactView `json:"artifacts"`
	ExitCode      *int                   `json:"exitCode,omitempty"`
	StartedAt     *time.Time             `json:"startedAt,omitempty"`
	FinishedAt    *time.Time             `json:"finishedAt,omitempty"`
	DurationMS    *int64                 `json:"durationMs,omitempty"`
	Done          bool                   `json:"done"`
}

// NewExecutionPayload flattens the entity plus artifact views into the public
// response shape (plan §4).
func NewExecutionPayload(view *service.ExecutionView) ExecutionPayload {
	exec := view.Execution
	artifacts := view.Artifacts
	if artifacts == nil {
		artifacts = []service.ArtifactView{}
	}
	payload := ExecutionPayload{
		ExecutionID:   exec.ID,
		LeaseID:       exec.LeaseID,
		ProjectID:     exec.ProjectID,
		Purpose:       exec.Purpose,
		Language:      exec.Language,
		Status:        exec.Status,
		TimeoutMS:     exec.TimeoutMS,
		StdoutPreview: exec.StdoutPreview,
		StderrPreview: exec.StderrPreview,
		StdoutBytes:   exec.StdoutBytes,
		StderrBytes:   exec.StderrBytes,
		ErrorCode:     exec.ErrorCode,
		CreatedAt:     exec.CreatedAt,
		Artifacts:     artifacts,
		Done:          model.IsExecTerminal(exec.Status),
	}
	if exec.ExitCode != nil {
		payload.ExitCode = exec.ExitCode
	}
	if exec.StartedAt != nil {
		payload.StartedAt = exec.StartedAt
	}
	if exec.FinishedAt != nil {
		payload.FinishedAt = exec.FinishedAt
	}
	if exec.StartedAt != nil && exec.FinishedAt != nil {
		ms := exec.FinishedAt.Sub(*exec.StartedAt).Milliseconds()
		payload.DurationMS = &ms
	}
	return payload
}

// ExecutionListResponse is the GET /v1/executions payload; executions is always
// an array (empty, never null).
type ExecutionListResponse struct {
	Executions []ExecutionPayload `json:"executions"`
}

// NewExecutionListResponse maps the uid-scoped list (newest first).
func NewExecutionListResponse(views []*service.ExecutionView) ExecutionListResponse {
	executions := make([]ExecutionPayload, 0, len(views))
	for _, view := range views {
		executions = append(executions, NewExecutionPayload(view))
	}
	return ExecutionListResponse{Executions: executions}
}
